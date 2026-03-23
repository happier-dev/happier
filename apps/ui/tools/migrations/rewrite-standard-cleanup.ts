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
    | 'cleanupBlock'
    | 'cleanupActWrapper'
    | 'cleanupIfGuard'
    | 'cleanupNullReset';

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
    'cleanupBlock',
    'cleanupActWrapper',
    'cleanupIfGuard',
    'cleanupNullReset',
];

function createCounts(): Record<RewriteShape, number> {
    return {
        cleanupBlock: 0,
        cleanupActWrapper: 0,
        cleanupIfGuard: 0,
        cleanupNullReset: 0,
    };
}

function printUsage(): void {
    console.log([
        'Usage: tsx tools/migrations/rewrite-standard-cleanup.ts [--dry-run|--write] [--scope <path>] [path ...]',
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

function cleanupReactTestRendererImport(text: string, filePath: string): string {
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
    const keepDefault = parsed.defaultName == null
        ? false
        : new RegExp(`\\b${escapeRegExp(parsed.defaultName)}\\.`, 'm').test(bodyWithoutImport);
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

function isNullishExpression(node: ts.Expression): boolean {
    return node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === 'undefined');
}

function isUnmountCallExpression(node: ts.Expression): boolean {
    if (!ts.isCallExpression(node)) return false;
    if (node.arguments.length !== 0) return false;
    const expression = node.expression;
    return (
        (ts.isPropertyAccessExpression(expression) || ts.isPropertyAccessChain(expression)) &&
        expression.name.text === 'unmount'
    );
}

function collectCleanupShapes(statement: ts.Statement, counts: Record<RewriteShape, number>): boolean {
    if (ts.isBlock(statement)) {
        let matched = false;
        for (const child of statement.statements) {
            if (!collectCleanupShapes(child, counts)) {
                return false;
            }
            matched = true;
        }
        if (matched) {
            counts.cleanupBlock += 1;
        }
        return matched;
    }

    if (ts.isExpressionStatement(statement)) {
        if (isUnmountCallExpression(statement.expression)) {
            return true;
        }
        if (
            ts.isBinaryExpression(statement.expression) &&
            statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            isNullishExpression(statement.expression.right)
        ) {
            counts.cleanupNullReset += 1;
            return true;
        }
        if (
            ts.isCallExpression(statement.expression) &&
            ts.isIdentifier(statement.expression.expression) &&
            statement.expression.expression.text === 'act'
        ) {
            const callback = statement.expression.arguments[0];
            if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isBlock(callback.body)) {
                const nested = createCounts();
                if (collectCleanupShapes(callback.body, nested)) {
                    counts.cleanupActWrapper += 1;
                    for (const shape of SHAPES) {
                        if (shape === 'cleanupActWrapper') continue;
                        counts[shape] += nested[shape];
                    }
                    return true;
                }
            }
        }
        return false;
    }

    if (ts.isIfStatement(statement) && statement.elseStatement == null) {
        const nested = createCounts();
        if (collectCleanupShapes(statement.thenStatement, nested)) {
            counts.cleanupIfGuard += 1;
            for (const shape of SHAPES) {
                if (shape === 'cleanupIfGuard') continue;
                counts[shape] += nested[shape];
            }
            return true;
        }
    }

    return false;
}

function resolveBlockIndent(text: string, block: ts.Block): string {
    const lineStart = text.lastIndexOf('\n', block.getStart() - 1) + 1;
    const linePrefix = text.slice(lineStart, block.getStart());
    const baseIndent = (linePrefix.match(/^[ \t]*/) ?? [''])[0];
    return `${baseIndent}    `;
}

function resolveBaseIndent(text: string, block: ts.Block): string {
    const lineStart = text.lastIndexOf('\n', block.getStart() - 1) + 1;
    const linePrefix = text.slice(lineStart, block.getStart());
    return (linePrefix.match(/^[ \t]*/) ?? [''])[0];
}

function rewriteStandardCleanup(text: string, filePath: string): RewriteResult {
    const sourceFile = parseSourceFile(filePath, text);
    const replacements: Replacement[] = [];
    const counts = createCounts();

    const visit = (node: ts.Node): void => {
        if (
            ts.isExpressionStatement(node) &&
            ts.isCallExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === 'afterEach'
        ) {
            const callback = node.expression.arguments[0];
            if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isBlock(callback.body)) {
                const callbackCounts = createCounts();
                const cleanupOnly = collectCleanupShapes(callback.body, callbackCounts);
                const blockText = text.slice(callback.body.getStart(sourceFile), callback.body.getEnd());
                if (cleanupOnly && !/\bstandardCleanup\s*\(/.test(blockText)) {
                    replacements.push({
                        start: callback.body.getStart(sourceFile) + 1,
                        end: callback.body.getEnd() - 1,
                        value: `\n${resolveBlockIndent(text, callback.body)}standardCleanup();\n${resolveBaseIndent(text, callback.body)}`,
                    });
                    for (const shape of SHAPES) {
                        counts[shape] += callbackCounts[shape];
                    }
                    return;
                }
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    if (replacements.length === 0) {
        return {
            text,
            changed: false,
            counts,
        };
    }

    let next = replaceWithRanges(text, replacements);
    next = ensureNamedImport(next, filePath, TESTKIT_MODULE, 'standardCleanup');
    next = cleanupReactTestRendererImport(next, filePath);

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
        const result = rewriteStandardCleanup(text, filePath);
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

    console.log(`${options.mode === 'write' ? 'Rewrote' : 'Would rewrite'} manual cleanup -> standardCleanup in ${changedFiles} files.`);
    const totalText = formatCounts(totalCounts);
    if (totalText) {
        console.log(`Shapes: ${totalText}`);
    }
}

main();
