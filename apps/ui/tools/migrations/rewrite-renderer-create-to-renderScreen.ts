import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const repoRoot = path.resolve(__dirname, '../../../..');
const defaultScope = path.join(repoRoot, 'apps/ui/sources');
const TEST_FILE_RE = /\.(spec|test)\.[tj]sx?$/;
const TESTKIT_MODULE = '@/dev/testkit';
const REACT_TEST_RENDERER_MODULE = 'react-test-renderer';

type Replacement = Readonly<{
    start: number;
    end: number;
    value: string;
}>;

type RewriteShape =
    | 'standaloneCreateCall'
    | 'variableCreateAssignment'
    | 'directCreateAssignment'
    | 'wrappedStandaloneCreateCall'
    | 'wrappedVariableCreateAssignment'
    | 'wrappedDirectCreateAssignment';

type CliOptions = Readonly<{
    mode: 'dry-run' | 'write';
    targets: string[];
}>;

type NamedImport = Readonly<{
    name: string;
    alias?: string | null;
}>;

type RewriteResult = Readonly<{
    text: string;
    changed: boolean;
    counts: Record<RewriteShape, number>;
}>;

const SHAPES: readonly RewriteShape[] = [
    'standaloneCreateCall',
    'variableCreateAssignment',
    'directCreateAssignment',
    'wrappedStandaloneCreateCall',
    'wrappedVariableCreateAssignment',
    'wrappedDirectCreateAssignment',
];

function createCounts(): Record<RewriteShape, number> {
    return {
        standaloneCreateCall: 0,
        variableCreateAssignment: 0,
        directCreateAssignment: 0,
        wrappedStandaloneCreateCall: 0,
        wrappedVariableCreateAssignment: 0,
        wrappedDirectCreateAssignment: 0,
    };
}

function printUsage(): void {
    console.log([
        'Usage: tsx tools/migrations/rewrite-renderer-create-to-renderScreen.ts [--dry-run|--write] [--scope <path>] [path ...]',
        '',
        'Default mode is dry-run. Paths may be files or directories, absolute, cwd-relative, or repo-relative.',
        'If no paths are provided, the script scans apps/ui/sources test files.',
    ].join('\n'));
}

function parseCliArgs(argv: readonly string[]): CliOptions {
    const targets: string[] = [];
    let mode: 'dry-run' | 'write' = 'dry-run';

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        }
        if (arg === '--dry-run') {
            mode = 'dry-run';
            continue;
        }
        if (arg === '--write') {
            mode = 'write';
            continue;
        }
        if (arg === '--scope') {
            const next = argv[index + 1];
            if (!next) {
                throw new Error('Missing value for --scope');
            }
            targets.push(next);
            index += 1;
            continue;
        }
        targets.push(arg);
    }

    return {
        mode,
        targets: targets.length > 0 ? targets : [defaultScope],
    };
}

function toPosix(inputPath: string): string {
    return inputPath.split(path.sep).join('/');
}

function resolveTargetPath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) return inputPath;
    const cwdResolved = path.resolve(process.cwd(), inputPath);
    if (fs.existsSync(cwdResolved)) return cwdResolved;
    return path.resolve(repoRoot, inputPath);
}

function shouldProcessFile(filePath: string): boolean {
    const rel = toPosix(path.relative(repoRoot, filePath));
    if (!rel.startsWith('apps/ui/sources/')) return false;
    if (!TEST_FILE_RE.test(rel)) return false;
    if (rel.includes('/node_modules/')) return false;
    if (rel.includes('/sources/dev/testkit/')) return false;
    return true;
}

function collectFiles(targetPath: string, out: Set<string>): void {
    if (!fs.existsSync(targetPath)) {
        throw new Error(`Path does not exist: ${targetPath}`);
    }
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            if (entry.name === 'node_modules') continue;
            collectFiles(path.join(targetPath, entry.name), out);
        }
        return;
    }
    if (shouldProcessFile(targetPath)) {
        out.add(targetPath);
    }
}

function parseSourceFile(filePath: string, text: string): ts.SourceFile {
    const scriptKind = filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS;
    return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
}

function replaceWithRanges(text: string, ranges: readonly Replacement[]): string {
    if (ranges.length === 0) return text;
    let next = text;
    for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
        next = `${next.slice(0, range.start)}${range.value}${next.slice(range.end)}`;
    }
    return next;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectNamedImports(node: ts.ImportDeclaration): Readonly<{
    defaultName: string | null;
    namespaceName: string | null;
    named: NamedImport[];
    isTypeOnly: boolean;
}> {
    const clause = node.importClause;
    if (!clause) {
        return {
            defaultName: null,
            namespaceName: null,
            named: [],
            isTypeOnly: false,
        };
    }
    const defaultName = clause.name?.text ?? null;
    const isTypeOnly = clause.isTypeOnly;
    if (!clause.namedBindings) {
        return {
            defaultName,
            namespaceName: null,
            named: [],
            isTypeOnly,
        };
    }
    if (ts.isNamespaceImport(clause.namedBindings)) {
        return {
            defaultName,
            namespaceName: clause.namedBindings.name.text,
            named: [],
            isTypeOnly,
        };
    }
    return {
        defaultName,
        namespaceName: null,
        named: clause.namedBindings.elements.map((element) => ({
            name: element.propertyName?.text ?? element.name.text,
            alias: element.propertyName ? element.name.text : null,
        })),
        isTypeOnly,
    };
}

function uniqNamedImports(named: readonly NamedImport[]): NamedImport[] {
    const byKey = new Map<string, NamedImport>();
    for (const entry of named) {
        const key = `${entry.name}:${entry.alias ?? ''}`;
        if (!byKey.has(key)) {
            byKey.set(key, entry);
        }
    }
    return [...byKey.values()].sort((left, right) => (
        `${left.name}:${left.alias ?? ''}`.localeCompare(`${right.name}:${right.alias ?? ''}`)
    ));
}

function printNamedImports(named: readonly NamedImport[]): string {
    if (named.length === 0) return '';
    return `{ ${named.map((entry) => entry.alias ? `${entry.name} as ${entry.alias}` : entry.name).join(', ')} }`;
}

function buildImportLine(args: Readonly<{
    defaultName: string | null;
    namespaceName: string | null;
    named: readonly NamedImport[];
    moduleName: string;
    isTypeOnly: boolean;
}>): string | null {
    const pieces: string[] = [];
    if (args.defaultName) pieces.push(args.defaultName);
    if (args.namespaceName) pieces.push(`* as ${args.namespaceName}`);
    if (args.named.length > 0) pieces.push(printNamedImports(args.named));
    if (pieces.length === 0) return null;
    return `${args.isTypeOnly ? 'import type ' : 'import '}${pieces.join(', ')} from '${args.moduleName}';`;
}

function ensureNamedImport(text: string, filePath: string, moduleName: string, importName: string): string {
    const sourceFile = parseSourceFile(filePath, text);
    const imports = sourceFile.statements.filter(ts.isImportDeclaration);
    const existing = imports.find((statement) => (
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === moduleName
    ));

    if (existing) {
        const parsed = collectNamedImports(existing);
        if (
            parsed.namespaceName == null &&
            parsed.named.some((entry) => entry.name === importName && (entry.alias ?? null) === null)
        ) {
            return text;
        }
        if (parsed.namespaceName == null && !parsed.isTypeOnly) {
            const nextLine = buildImportLine({
                defaultName: parsed.defaultName,
                namespaceName: null,
                named: uniqNamedImports([...parsed.named, { name: importName }]),
                moduleName,
                isTypeOnly: false,
            });
            if (nextLine) {
                return replaceWithRanges(text, [{
                    start: existing.getStart(sourceFile),
                    end: existing.getEnd(),
                    value: nextLine,
                }]);
            }
        }
    }

    const lastImport = imports[imports.length - 1];
    const insertAt = lastImport ? lastImport.getEnd() : 0;
    const prefix = lastImport ? '\n' : '';
    return replaceWithRanges(text, [{
        start: insertAt,
        end: insertAt,
        value: `${prefix}import { ${importName} } from '${moduleName}';\n`,
    }]);
}

function cleanupReactTestRendererImport(
    text: string,
    filePath: string,
    rendererIdentifier: string | null,
): string {
    const sourceFile = parseSourceFile(filePath, text);
    const importDecl = sourceFile.statements.find((statement) => (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === REACT_TEST_RENDERER_MODULE
    ));
    if (!importDecl || !ts.isImportDeclaration(importDecl)) return text;

    const parsed = collectNamedImports(importDecl);
    if (parsed.namespaceName) return text;

    const bodyWithoutImport = `${text.slice(0, importDecl.getStart(sourceFile))}${text.slice(importDecl.getEnd())}`;
    const keepDefault = rendererIdentifier == null
        ? false
        : new RegExp(`\\b${escapeRegExp(rendererIdentifier)}\\.`, 'm').test(bodyWithoutImport);
    const keepNamed = parsed.named.filter((entry) => {
        const bindingName = entry.alias ?? entry.name;
        if (bindingName === 'act') {
            return new RegExp(`\\b${escapeRegExp(bindingName)}\\s*\\(`, 'm').test(bodyWithoutImport);
        }
        return true;
    });

    const nextLine = buildImportLine({
        defaultName: keepDefault ? parsed.defaultName : null,
        namespaceName: null,
        named: keepNamed,
        moduleName: REACT_TEST_RENDERER_MODULE,
        isTypeOnly: parsed.isTypeOnly,
    });

    return replaceWithRanges(text, [{
        start: importDecl.getStart(sourceFile),
        end: importDecl.getEnd(),
        value: nextLine ?? '',
    }]);
}

function hasAsyncModifier(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    return ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

function findEnclosingAsyncFunction(node: ts.Node): ts.Node | null {
    let current: ts.Node | undefined = node.parent;
    while (current) {
        if (
            (ts.isArrowFunction(current) ||
                ts.isFunctionExpression(current) ||
                ts.isFunctionDeclaration(current) ||
                ts.isMethodDeclaration(current)) &&
            hasAsyncModifier(current)
        ) {
            return current;
        }
        current = current.parent;
    }
    return null;
}

function findEnclosingFunctionLike(
    node: ts.Node,
): ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration | null {
    let current: ts.Node | undefined = node.parent;
    while (current) {
        if (
            ts.isArrowFunction(current) ||
            ts.isFunctionExpression(current) ||
            ts.isFunctionDeclaration(current) ||
            ts.isMethodDeclaration(current)
        ) {
            return current;
        }
        current = current.parent;
    }
    return null;
}

function isSupportedAsyncPromotionTarget(node: ts.Node): boolean {
    const parent = node.parent;
    if (!ts.isCallExpression(parent)) return false;
    if (parent.arguments[0] !== node && parent.arguments[1] !== node) return false;
    return ts.isIdentifier(parent.expression)
        && (parent.expression.text === 'it' || parent.expression.text === 'test');
}

function isActExpression(node: ts.Expression, rendererIdentifier: string | null): node is ts.CallExpression {
    if (!ts.isCallExpression(node)) return false;
    if (ts.isIdentifier(node.expression)) {
        return node.expression.text === 'act';
    }
    return ts.isPropertyAccessExpression(node.expression)
        && rendererIdentifier != null
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === rendererIdentifier
        && node.expression.name.text === 'act';
}

function isInsideActCallback(node: ts.Node, rendererIdentifier: string | null): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current) {
        if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
            const parent = current.parent;
            if (ts.isCallExpression(parent) && isActExpression(parent, rendererIdentifier)) {
                return true;
            }
        }
        current = current.parent;
    }
    return false;
}

function isRendererCreateCall(node: ts.Expression | undefined, rendererIdentifier: string | null): node is ts.CallExpression {
    if (!node || rendererIdentifier == null) return false;
    if (!ts.isCallExpression(node)) return false;
    if (node.arguments.length !== 1) return false;
    if (!ts.isPropertyAccessExpression(node.expression)) return false;
    if (!ts.isIdentifier(node.expression.expression)) return false;
    return node.expression.expression.text === rendererIdentifier && node.expression.name.text === 'create';
}

function buildRenderTreeExpression(
    node: ts.Expression | undefined,
    sourceFile: ts.SourceFile,
    rendererIdentifier: string | null,
): string | null {
    if (!node) return null;
    if (isRendererCreateCall(node, rendererIdentifier)) {
        const elementText = node.arguments[0].getText(sourceFile);
        return `(await renderScreen(${elementText})).tree`;
    }
    if (!ts.isCallExpression(node) || node.arguments.length !== 1) {
        return null;
    }

    const [innerArg] = node.arguments;
    const rewrittenInner = buildRenderTreeExpression(innerArg, sourceFile, rendererIdentifier);
    if (!rewrittenInner) {
        return null;
    }

    const expressionText = node.getText(sourceFile);
    const relativeArgStart = innerArg.getStart(sourceFile) - node.getStart(sourceFile);
    const relativeArgEnd = innerArg.getEnd() - node.getStart(sourceFile);

    return `${expressionText.slice(0, relativeArgStart)}${rewrittenInner}${expressionText.slice(relativeArgEnd)}`;
}

function buildReplacementForStatement(
    statement: ts.Statement,
    sourceFile: ts.SourceFile,
    text: string,
    rendererIdentifier: string | null,
    wrapped: boolean,
): Readonly<{ value: string; shape: RewriteShape }> | null {
    if (ts.isVariableStatement(statement)) {
        if (statement.declarationList.declarations.length !== 1) return null;
        const declaration = statement.declarationList.declarations[0];
        const renderedTreeExpression = buildRenderTreeExpression(declaration.initializer, sourceFile, rendererIdentifier);
        if (!renderedTreeExpression) {
            return null;
        }
        const prefix = text.slice(statement.getStart(sourceFile), declaration.initializer!.getStart(sourceFile));
        return {
            value: `${prefix}${renderedTreeExpression};`,
            shape: wrapped ? 'wrappedVariableCreateAssignment' : 'variableCreateAssignment',
        };
    }

    if (!ts.isExpressionStatement(statement)) return null;

    if (
        ts.isBinaryExpression(statement.expression) &&
        statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
        const renderedTreeExpression = buildRenderTreeExpression(
            statement.expression.right,
            sourceFile,
            rendererIdentifier,
        );
        if (renderedTreeExpression) {
            const prefix = text.slice(statement.getStart(sourceFile), statement.expression.right.getStart(sourceFile));
            return {
                value: `${prefix}${renderedTreeExpression};`,
                shape: wrapped ? 'wrappedDirectCreateAssignment' : 'directCreateAssignment',
            };
        }
    }

    if (isRendererCreateCall(statement.expression, rendererIdentifier)) {
        const elementText = statement.expression.arguments[0].getText(sourceFile);
        return {
            value: `await renderScreen(${elementText});`,
            shape: wrapped ? 'wrappedStandaloneCreateCall' : 'standaloneCreateCall',
        };
    }

    const wrappedExpression = buildRenderTreeExpression(statement.expression, sourceFile, rendererIdentifier);
    if (wrappedExpression) {
        const prefix = text.slice(statement.getStart(sourceFile), statement.expression.getStart(sourceFile));
        return {
            value: `${prefix}${wrappedExpression};`,
            shape: wrapped ? 'wrappedStandaloneCreateCall' : 'standaloneCreateCall',
        };
    }

    return null;
}

function nodeIsCovered(node: ts.Node, ranges: readonly Replacement[]): boolean {
    const start = node.getStart();
    const end = node.getEnd();
    return ranges.some((range) => start >= range.start && end <= range.end);
}

function isIgnorableFlushBlock(
    statements: readonly ts.Statement[],
    localHelperNames: ReadonlySet<string>,
): boolean {
    return statements.every((statement) => isIgnorableFlushStatement(statement, localHelperNames));
}

function isIgnorableFlushStatement(
    statement: ts.Statement,
    localHelperNames: ReadonlySet<string>,
): boolean {
    if (ts.isBlock(statement)) {
        return isIgnorableFlushBlock(statement.statements, localHelperNames);
    }
    if (ts.isForStatement(statement)) {
        return isIgnorableFlushStatement(statement.statement, localHelperNames);
    }
    if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) {
        return false;
    }
    return isIgnorableFlushAwaitedExpression(statement.expression.expression, localHelperNames);
}

function isIgnorableFlushAwaitedExpression(
    awaited: ts.Expression,
    localHelperNames: ReadonlySet<string>,
): boolean {
    if (isZeroTimeoutPromiseFlush(awaited)) {
        return true;
    }
    if (!ts.isCallExpression(awaited)) {
        return false;
    }
    if (ts.isIdentifier(awaited.expression)) {
        if (awaited.expression.text === 'flushEffects') {
            return true;
        }
        if (localHelperNames.has(awaited.expression.text)) {
            return true;
        }
    }
    if (awaited.arguments.length !== 0) {
        return false;
    }
    if (!ts.isPropertyAccessExpression(awaited.expression)) {
        return false;
    }
    return ts.isIdentifier(awaited.expression.expression)
        && awaited.expression.expression.text === 'Promise'
        && awaited.expression.name.text === 'resolve';
}

function collectLocalIgnorableFlushHelpers(sourceFile: ts.SourceFile): Set<string> {
    const helperBodies = new Map<string, readonly ts.Statement[]>();
    for (const statement of sourceFile.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
            helperBodies.set(statement.name.text, statement.body.statements);
        }
    }

    const ignorableHelpers = new Set<string>();
    let changed = true;
    while (changed) {
        changed = false;
        for (const [name, statements] of helperBodies) {
            if (ignorableHelpers.has(name)) {
                continue;
            }
            if (isIgnorableFlushBlock(statements, ignorableHelpers)) {
                ignorableHelpers.add(name);
                changed = true;
            }
        }
    }

    return ignorableHelpers;
}

function isIgnorableWrappedActFlush(
    statement: ts.Statement,
    localHelperNames: ReadonlySet<string>,
): boolean {
    if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) {
        return false;
    }
    const awaited = statement.expression.expression;
    return isIgnorableFlushAwaitedExpression(awaited, localHelperNames);
}

function isPreservableWrappedActFollowUp(statement: ts.Statement): boolean {
    if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) {
        return false;
    }
    const awaited = statement.expression.expression;
    return ts.isCallExpression(awaited)
        && ts.isIdentifier(awaited.expression)
        && awaited.expression.text === 'flushHookEffects';
}

function isPreservableWrappedActSetup(
    statement: ts.Statement,
    sourceFile: ts.SourceFile,
    rendererIdentifier: string | null,
): boolean {
    if (!ts.isExpressionStatement(statement) || ts.isAwaitExpression(statement.expression)) {
        return false;
    }
    return buildReplacementForStatement(statement, sourceFile, sourceFile.text, rendererIdentifier, true) == null;
}

function findWrappedActReplacement(
    bodyStatements: readonly ts.Statement[],
    sourceFile: ts.SourceFile,
    text: string,
    rendererIdentifier: string | null,
    localIgnorableFlushHelpers: ReadonlySet<string>,
): Readonly<{ value: string; shape: RewriteShape }> | null {
    for (let index = 0; index < bodyStatements.length; index += 1) {
        const statement = bodyStatements[index];
        const replacement = buildReplacementForStatement(statement, sourceFile, text, rendererIdentifier, true);
        if (!replacement) {
            continue;
        }
        const leadingStatements = bodyStatements.slice(0, index);
        const trailingStatements = bodyStatements.slice(index + 1);
        const leadingSupported = leadingStatements.every((candidate) => (
            isPreservableWrappedActSetup(candidate, sourceFile, rendererIdentifier)
        ));
        if (!leadingSupported) {
            continue;
        }
        const trailingSupported = trailingStatements.every((candidate) => (
            isIgnorableWrappedActFlush(candidate, localIgnorableFlushHelpers)
            || isPreservableWrappedActFollowUp(candidate)
        ));
        if (!trailingSupported) {
            continue;
        }
        const leadingText = leadingStatements.length === 0
            ? ''
            : text.slice(leadingStatements[0].getStart(sourceFile), statement.getStart(sourceFile));
        const preservedFollowUps = trailingStatements
            .filter((candidate) => !isIgnorableWrappedActFlush(candidate, localIgnorableFlushHelpers))
            .map((candidate) => text.slice(candidate.getFullStart(), candidate.getEnd()))
            .join('');
        return {
            value: `${leadingText}${replacement.value}${preservedFollowUps}`,
            shape: replacement.shape,
        };
    }
    return null;
}

function isZeroTimeoutPromiseFlush(node: ts.Expression): boolean {
    if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'Promise') {
        return false;
    }
    if (!node.arguments || node.arguments.length !== 1) {
        return false;
    }
    const executor = node.arguments[0];
    if (!ts.isArrowFunction(executor) && !ts.isFunctionExpression(executor)) {
        return false;
    }
    if (executor.parameters.length !== 1) {
        return false;
    }
    const resolveParam = executor.parameters[0]?.name;
    if (!resolveParam || !ts.isIdentifier(resolveParam)) {
        return false;
    }
    const bodyStatements = ts.isBlock(executor.body)
        ? executor.body.statements
        : [ts.factory.createExpressionStatement(executor.body)];
    if (bodyStatements.length !== 1 || !ts.isExpressionStatement(bodyStatements[0])) {
        return false;
    }
    const call = bodyStatements[0].expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'setTimeout') {
        return false;
    }
    if (call.arguments.length !== 2) {
        return false;
    }
    return ts.isIdentifier(call.arguments[0])
        && call.arguments[0].text === resolveParam.text
        && ts.isNumericLiteral(call.arguments[1])
        && call.arguments[1].text === '0';
}

export function rewriteRendererCreateToRenderScreen(text: string, filePath: string): RewriteResult {
    const sourceFile = parseSourceFile(filePath, text);
    const reactRendererImport = sourceFile.statements.find((statement) => (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === REACT_TEST_RENDERER_MODULE
    ));
    const rendererIdentifier = reactRendererImport && ts.isImportDeclaration(reactRendererImport)
        ? reactRendererImport.importClause?.name?.text ?? null
        : null;

    if (!rendererIdentifier) {
        return {
            text,
            changed: false,
            counts: createCounts(),
        };
    }

    const replacements: Replacement[] = [];
    const counts = createCounts();
    const promotedAsyncFunctions = new Set<number>();
    const localIgnorableFlushHelpers = collectLocalIgnorableFlushHelpers(sourceFile);

    const visitWrapped = (node: ts.Node): void => {
        if (ts.isExpressionStatement(node)) {
            const actCall = ts.isAwaitExpression(node.expression)
                ? (isActExpression(node.expression.expression, rendererIdentifier) ? node.expression.expression : null)
                : (isActExpression(node.expression, rendererIdentifier) ? node.expression : null);
            if (actCall) {
                const callback = actCall.arguments[0];
                if (
                    callback &&
                    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
                    ts.isBlock(callback.body)
                ) {
                    const bodyStatements = callback.body.statements.filter((statement) => !ts.isEmptyStatement(statement));
                    const wrappedReplacement = hasAsyncModifier(callback)
                        ? findWrappedActReplacement(
                            bodyStatements,
                            sourceFile,
                            text,
                            rendererIdentifier,
                            localIgnorableFlushHelpers,
                        )
                        : bodyStatements.length === 1
                            ? buildReplacementForStatement(
                                bodyStatements[0],
                                sourceFile,
                                text,
                                rendererIdentifier,
                                true,
                            )
                            : null;
                    if (wrappedReplacement) {
                        if (!hasAsyncModifier(callback)) {
                            const enclosingFunction = findEnclosingFunctionLike(node);
                            if (!enclosingFunction) {
                                ts.forEachChild(node, visitWrapped);
                                return;
                            }
                            if (!hasAsyncModifier(enclosingFunction)) {
                                if (!isSupportedAsyncPromotionTarget(enclosingFunction)) {
                                    ts.forEachChild(node, visitWrapped);
                                    return;
                                }
                                if (!promotedAsyncFunctions.has(enclosingFunction.getStart(sourceFile))) {
                                    replacements.push({
                                        start: enclosingFunction.getStart(sourceFile),
                                        end: enclosingFunction.getStart(sourceFile),
                                        value: 'async ',
                                    });
                                    promotedAsyncFunctions.add(enclosingFunction.getStart(sourceFile));
                                }
                            }
                        }

                        replacements.push({
                            start: node.getStart(sourceFile),
                            end: node.getEnd(),
                            value: wrappedReplacement.value,
                        });
                        counts[wrappedReplacement.shape] += 1;
                        return;
                    }
                }
            }
        }

        ts.forEachChild(node, visitWrapped);
    };

    visitWrapped(sourceFile);

    const visitDirect = (node: ts.Node): void => {
        if ((ts.isVariableStatement(node) || ts.isExpressionStatement(node)) && !nodeIsCovered(node, replacements)) {
            if (isInsideActCallback(node, rendererIdentifier)) {
                ts.forEachChild(node, visitDirect);
                return;
            }
            if (!findEnclosingAsyncFunction(node)) {
                ts.forEachChild(node, visitDirect);
                return;
            }
            const replacement = buildReplacementForStatement(node, sourceFile, text, rendererIdentifier, false);
            if (replacement) {
                replacements.push({
                    start: node.getStart(sourceFile),
                    end: node.getEnd(),
                    value: replacement.value,
                });
                counts[replacement.shape] += 1;
                return;
            }
        }

        ts.forEachChild(node, visitDirect);
    };

    visitDirect(sourceFile);

    if (replacements.length === 0) {
        return {
            text,
            changed: false,
            counts,
        };
    }

    let next = replaceWithRanges(text, replacements);
    next = ensureNamedImport(next, filePath, TESTKIT_MODULE, 'renderScreen');
    next = cleanupReactTestRendererImport(next, filePath, rendererIdentifier);

    return {
        text: next,
        changed: next !== text,
        counts,
    };
}

function formatCounts(counts: Record<RewriteShape, number>): string {
    return SHAPES
        .map((shape) => `${shape}=${counts[shape]}`)
        .filter((entry) => !entry.endsWith('=0'))
        .join(' ');
}

function main(): void {
    const options = parseCliArgs(process.argv.slice(2));
    const files = new Set<string>();
    for (const target of options.targets) {
        collectFiles(resolveTargetPath(target), files);
    }

    let changedFiles = 0;
    const totalCounts = createCounts();

    for (const filePath of [...files].sort()) {
        const text = fs.readFileSync(filePath, 'utf8');
        const result = rewriteRendererCreateToRenderScreen(text, filePath);
        if (!result.changed) continue;

        const rel = toPosix(path.relative(repoRoot, filePath));
        const countsText = formatCounts(result.counts);
        if (options.mode === 'write') {
            fs.writeFileSync(filePath, result.text, 'utf8');
            console.log(`REWROTE: ${rel}${countsText ? ` ${countsText}` : ''}`);
        } else {
            console.log(`DRY-RUN: ${rel}${countsText ? ` ${countsText}` : ''}`);
        }

        changedFiles += 1;
        for (const shape of SHAPES) {
            totalCounts[shape] += result.counts[shape];
        }
    }

    console.log(`${options.mode === 'write' ? 'Rewrote' : 'Would rewrite'} renderer.create -> renderScreen in ${changedFiles} files.`);
    const totalText = formatCounts(totalCounts);
    if (totalText) {
        console.log(`Shapes: ${totalText}`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
    main();
}
