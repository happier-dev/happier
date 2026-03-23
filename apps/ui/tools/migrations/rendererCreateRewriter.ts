import ts from 'typescript';

export type RendererCreateRewrite = Readonly<{
    kind: 'rendererCreate' | 'standardCleanup';
    summary: string;
}>;

export type RendererCreateRewriteResult = Readonly<{
    text: string;
    rewrites: readonly RendererCreateRewrite[];
}>;

type Replacement = Readonly<{
    start: number;
    end: number;
    value: string;
    rewrite: RendererCreateRewrite;
}>;

function findLastImportInsertionPoint(sourceFile: ts.SourceFile): number {
    let lastImportEnd = 0;
    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
            lastImportEnd = statement.getEnd();
        }
    }
    return lastImportEnd;
}

function upsertDevTestkitImport(sourceFile: ts.SourceFile, text: string, specifiers: readonly string[]): string {
    const importDeclaration = sourceFile.statements.find((statement) => (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === '@/dev/testkit'
    )) as ts.ImportDeclaration | undefined;

    if (!importDeclaration) {
        const insertionPoint = findLastImportInsertionPoint(sourceFile);
        const importLine = `\nimport { ${specifiers.join(', ')} } from '@/dev/testkit';`;
        return `${text.slice(0, insertionPoint)}${importLine}${text.slice(insertionPoint)}`;
    }

    if (!importDeclaration.importClause?.namedBindings || !ts.isNamedImports(importDeclaration.importClause.namedBindings)) {
        return text;
    }

    const existing = new Set(importDeclaration.importClause.namedBindings.elements.map((element) => element.name.text));
    const missing = specifiers.filter((specifier) => !existing.has(specifier));
    if (missing.length === 0) {
        return text;
    }

    const namedBindings = importDeclaration.importClause.namedBindings;
    const updated = `import { ${[...existing, ...missing].sort().join(', ')} } from '@/dev/testkit';`;
    return `${text.slice(0, importDeclaration.getStart(sourceFile))}${updated}${text.slice(importDeclaration.getEnd())}`;
}

function getAsyncFunctionAncestor(node: ts.Node): ts.FunctionLikeDeclarationBase | null {
    let current: ts.Node | undefined = node.parent;
    while (current) {
        if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current) || ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
            return current;
        }
        current = current.parent;
    }
    return null;
}

export function rewriteRendererCreateToRenderScreen(
    text: string,
    options: Readonly<{ filePath?: string }> = {},
): RendererCreateRewriteResult {
    const filePath = options.filePath ?? 'renderer.test.tsx';
    const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const replacements: Replacement[] = [];

    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === 'renderer' &&
            node.expression.name.text === 'create' &&
            node.arguments.length === 1 &&
            getAsyncFunctionAncestor(node)
        ) {
            replacements.push({
                start: node.getStart(sourceFile),
                end: node.getEnd(),
                value: `await renderScreen(${node.arguments[0].getText(sourceFile)})`,
                rewrite: {
                    kind: 'rendererCreate',
                    summary: 'renderer.create(...) -> await renderScreen(...)',
                },
            });
        }
        ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    if (replacements.length === 0) {
        return {
            text,
            rewrites: [],
        };
    }

    let nextText = text;
    for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
        nextText = `${nextText.slice(0, replacement.start)}${replacement.value}${nextText.slice(replacement.end)}`;
    }

    const updatedSourceFile = ts.createSourceFile(filePath, nextText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    nextText = upsertDevTestkitImport(updatedSourceFile, nextText, ['renderScreen']);

    return {
        text: nextText,
        rewrites: replacements.map((replacement) => replacement.rewrite),
    };
}

export function rewriteStandardCleanup(
    text: string,
    options: Readonly<{ filePath?: string }> = {},
): RendererCreateRewriteResult {
    const filePath = options.filePath ?? 'cleanup.test.tsx';
    const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const usesRenderScreen = text.includes('renderScreen(');
    const hasStandardCleanup = text.includes('standardCleanup(');
    const hasAfterEach = /\bafterEach\(/.test(text);

    if (!usesRenderScreen || hasStandardCleanup || hasAfterEach) {
        return {
            text,
            rewrites: [],
        };
    }

    let nextText = upsertDevTestkitImport(sourceFile, text, ['renderScreen', 'standardCleanup']);
    const refreshed = ts.createSourceFile(filePath, nextText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const lastImportEnd = findLastImportInsertionPoint(refreshed);
    const cleanupBlock = `\n\nafterEach(() => {\n    standardCleanup();\n});`;

    if (!/\bafterEach\b/.test(nextText)) {
        const vitestImport = refreshed.statements.find((statement) => (
            ts.isImportDeclaration(statement) &&
            ts.isStringLiteral(statement.moduleSpecifier) &&
            statement.moduleSpecifier.text === 'vitest'
        )) as ts.ImportDeclaration | undefined;
        if (vitestImport?.importClause?.namedBindings && ts.isNamedImports(vitestImport.importClause.namedBindings)) {
            const existing = new Set(vitestImport.importClause.namedBindings.elements.map((element) => element.name.text));
            if (!existing.has('afterEach')) {
                const updated = `import { ${[...existing, 'afterEach'].sort().join(', ')} } from 'vitest';`;
                nextText = `${nextText.slice(0, vitestImport.getStart(refreshed))}${updated}${nextText.slice(vitestImport.getEnd())}`;
            }
        }
    }

    const insertionSource = ts.createSourceFile(filePath, nextText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const insertionPoint = findLastImportInsertionPoint(insertionSource);
    nextText = `${nextText.slice(0, insertionPoint)}${cleanupBlock}${nextText.slice(insertionPoint)}`;

    return {
        text: nextText,
        rewrites: [
            {
                kind: 'standardCleanup',
                summary: 'added afterEach(standardCleanup)',
            },
        ],
    };
}
