import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it.each([
    ['singleton accessor', 'sync/runtime/getSyncSingleton.ts', /class Sync\b/],
    ['persisted plugin details parsing', 'components/appShell/panes/details/workspace/migrateLegacyDetailsWorkspaceState.ts', /PluginSurfacePlacementHost/],
    ['workspace body selection', 'components/appShell/workspace/workspaceRouteBodies.ts', /from ['"]expo-router\/_ctx['"]/],
])('keeps %s outside its presentation/runtime implementation graph', (_name, entry, forbidden) => {
    const root = resolve(process.cwd(), 'sources');
    const seen = new Set<string>();
    const queue = [resolve(root, entry)];
    for (let index = 0; index < queue.length; index++) {
        const file = queue[index];
        if (seen.has(file)) continue;
        seen.add(file);
        const source = readFileSync(file, 'utf8');
        expect(source, `lazy sync graph reached ${file}`).not.toMatch(forbidden);
        const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        const follow = (specifier: string) => {
            const base = specifier.startsWith('@/') ? resolve(root, specifier.slice(2))
                : specifier.startsWith('.') ? resolve(dirname(file), specifier) : null;
            if (!base) return;
            const dependency = ['', '.web.ts', '.web.tsx', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx']
                .map((suffix) => base + suffix).find((path) => existsSync(path) && statSync(path).isFile());
            expect(dependency, `unresolved dependency ${specifier} from ${file}`).toBeDefined();
            queue.push(dependency!);
        };
        const visit = (node: ts.Node): void => {
            if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
                const bindings = node.importClause?.namedBindings;
                if (!(bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0
                    && bindings.elements.every((binding) => binding.isTypeOnly) && !node.importClause?.name)) follow(node.moduleSpecifier.text);
            }
            if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) follow(node.moduleSpecifier.text);
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
                && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) follow(node.arguments[0].text);
            ts.forEachChild(node, visit);
        };
        visit(ast);
    }
});

it('does not allocate parallel lazy entries for Expo-owned workspace routes', () => {
    const file = resolve(process.cwd(), 'sources/components/appShell/workspace/workspaceRouteBodies.ts');
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const parallelEntries: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
            && node.arguments[0].text.startsWith('@/app/')) parallelEntries.push(node.arguments[0].text);
        ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(parallelEntries).toEqual([]);
});
