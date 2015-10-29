/// <reference path="./typings/tsd" />
var fs = require('fs');
var mkdirp = require('mkdirp');
var os = require('os');
var pathUtil = require('path');
var Promise = require('bluebird');
var ts = require('typescript');
var filenameToMid = (function () {
    if (pathUtil.sep === '/') {
        return function (filename) {
            return filename;
        };
    }
    else {
        var separatorExpression = new RegExp(pathUtil.sep.replace('\\', '\\\\'), 'g');
        return function (filename) {
            return filename.replace(separatorExpression, '/');
        };
    }
})();
function getError(diagnostics) {
    var message = 'Declaration generation failed';
    diagnostics.forEach(function (diagnostic) {
        var position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        message +=
            ("\n" + diagnostic.file.fileName + "(" + (position.line + 1) + "," + (position.character + 1) + "): ") +
                ("error TS" + diagnostic.code + ": " + diagnostic.messageText);
    });
    var error = new Error(message);
    error.name = 'EmitterError';
    return error;
}
function getFilenames(baseDir, files) {
    return files.map(function (filename) {
        var resolvedFilename = pathUtil.resolve(filename);
        if (resolvedFilename.indexOf(baseDir) === 0) {
            return resolvedFilename;
        }
        return pathUtil.resolve(baseDir, filename);
    });
}
function processTree(sourceFile, replacer) {
    var code = '';
    var cursorPosition = 0;
    function skip(node) {
        cursorPosition = node.end;
    }
    function readThrough(node) {
        code += sourceFile.text.slice(cursorPosition, node.pos);
        cursorPosition = node.pos;
    }
    function visit(node) {
        readThrough(node);
        var replacement = replacer(node);
        if (replacement != null) {
            code += replacement;
            skip(node);
        }
        else {
            ts.forEachChild(node, visit);
        }
    }
    visit(sourceFile);
    code += sourceFile.text.slice(cursorPosition);
    return code;
}
function generate(options, sendMessage) {
    if (sendMessage === void 0) { sendMessage = function () { }; }
    var baseDir = pathUtil.resolve(options.baseDir);
    var eol = options.eol || os.EOL;
    var nonEmptyLineStart = new RegExp(eol + '(?!' + eol + '|$)', 'g');
    var indent = options.indent === undefined ? '\t' : options.indent;
    var target = options.target || 2 /* Latest */;
    var compilerOptions = {
        declaration: true,
        module: 1 /* CommonJS */,
        target: target
    };
    var filenames = getFilenames(baseDir, options.files);
    var excludesMap = {};
    options.excludes && options.excludes.forEach(function (filename) {
        excludesMap[filenameToMid(pathUtil.resolve(baseDir, filename))] = true;
    });
    mkdirp.sync(pathUtil.dirname(options.out));
    var output = fs.createWriteStream(options.out, { mode: parseInt('644', 8) });
    var host = ts.createCompilerHost(compilerOptions);
    var program = ts.createProgram(filenames, compilerOptions, host);
    var checker = ts.createTypeChecker(program, true);
    function writeFile(filename, data, writeByteOrderMark) {
        // Compiler is emitting the non-declaration file, which we do not care about
        if (filename.slice(-5) !== '.d.ts') {
            return;
        }
        writeDeclaration(ts.createSourceFile(filename, data, target, true));
    }
    return new Promise(function (resolve, reject) {
        output.on('close', function () { resolve(undefined); });
        output.on('error', reject);
        if (options.externs) {
            options.externs.forEach(function (path) {
                sendMessage("Writing external dependency " + path);
                output.write(("/// <reference path=\"" + path + "\" />") + eol);
            });
        }
        var mainExportDeclaration = false;
        var mainExportAssignment = false;
        program.getSourceFiles().some(function (sourceFile) {
            // Source file is a default library, or other dependency from another project, that should not be included in
            // our bundled output
            if (pathUtil.normalize(sourceFile.fileName).indexOf(baseDir) !== 0) {
                return;
            }
            if (excludesMap[filenameToMid(pathUtil.normalize(sourceFile.fileName))]) {
                return;
            }
            sendMessage("Processing " + sourceFile.fileName);
            // Source file is already a declaration file so should does not need to be pre-processed by the emitter
            if (sourceFile.fileName.slice(-5) === '.d.ts') {
                writeDeclaration(sourceFile);
                return;
            }
            // We can optionally output the main module if there's something to export.
            if (options.main && options.main === (options.name + filenameToMid(sourceFile.fileName.slice(baseDir.length, -3)))) {
                ts.forEachChild(sourceFile, function (node) {
                    mainExportDeclaration = mainExportDeclaration || node.kind === 215 /* ExportDeclaration */;
                    mainExportAssignment = mainExportAssignment || node.kind === 214 /* ExportAssignment */;
                });
            }
            var emitOutput = program.emit(sourceFile, writeFile);
            if (emitOutput.emitSkipped) {
                reject(getError(emitOutput.diagnostics
                    .concat(program.getSemanticDiagnostics(sourceFile))
                    .concat(program.getSyntacticDiagnostics(sourceFile))
                    .concat(program.getDeclarationDiagnostics(sourceFile))));
                return true;
            }
            else if (emitOutput.diagnostics.length > 0) {
                sendMessage(getError(emitOutput.diagnostics
                    .concat(program.getSemanticDiagnostics(sourceFile))
                    .concat(program.getSyntacticDiagnostics(sourceFile))
                    .concat(program.getDeclarationDiagnostics(sourceFile))).toString());
            }
        });
        if (options.main && (mainExportDeclaration || mainExportAssignment)) {
            output.write(("declare module '" + options.name + "' {") + eol + indent);
            if (compilerOptions.target >= 2 /* ES6 */) {
                if (mainExportAssignment) {
                    output.write(("export {default} from '" + options.main + "';") + eol + indent);
                }
                if (mainExportDeclaration) {
                    output.write(("export * from '" + options.main + "';") + eol);
                }
            }
            else {
                output.write(("import main = require('" + options.main + "');") + eol + indent);
                output.write('export = main;' + eol);
            }
            output.write('}' + eol);
            sendMessage("Aliased main module " + options.name + " to " + options.main);
        }
        output.end();
    });
    function writeDeclaration(declarationFile) {
        var filename = declarationFile.fileName;
        var sourceModuleId = options.name + filenameToMid(filename.slice(baseDir.length, -5));
        if (declarationFile.externalModuleIndicator) {
            output.write('declare module \'' + sourceModuleId + '\' {' + eol + indent);
            var content = processTree(declarationFile, function (node) {
                if (node.kind === 219 /* ExternalModuleReference */) {
                    var expression = node.expression;
                    if (expression.text.charAt(0) === '.') {
                        return ' require(\'' + filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), expression.text)) + '\')';
                    }
                }
                else if (node.kind === 115 /* DeclareKeyword */) {
                    return '';
                }
                else if (node.kind === 8 /* StringLiteral */ &&
                    (node.parent.kind === 215 /* ExportDeclaration */ || node.parent.kind === 209 /* ImportDeclaration */)) {
                    var text = node.text;
                    if (text.charAt(0) === '.') {
                        return " '" + filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), text)) + "'";
                    }
                }
            });
            output.write(content.replace(nonEmptyLineStart, '$&' + indent));
            output.write('}' + eol + eol);
        }
        else {
            output.write(declarationFile.text);
        }
    }
}
exports.generate = generate;
