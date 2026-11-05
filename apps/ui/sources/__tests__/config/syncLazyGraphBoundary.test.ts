import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it.each([
    ['singleton accessor', 'sync/runtime/getSyncSingleton.ts', /class Sync\b/],
    ['persisted plugin details parsing', 'components/appShell/panes/details/workspace/migrateLegacyDetailsWorkspaceState.ts', /PluginSurfacePlacementHost/],
    ['workspace body selection', 'components/appShell/workspace/workspaceRouteBodies.ts', /from ['"]expo-router\/_ctx['"]/],
    ['closed palette body', 'components/appShell/commandPalette/CommandPaletteProvider.tsx', /export function UniversalSearchModal\b/],
    ['default Action front door', 'sync/ops/actions/frontDoorRuntimeActionExecutor.ts', /export function createDefaultActionExecutor\b/],
    ['disabled voice runtime', 'realtime/RealtimeProvider.web.tsx', /export function VoiceSessionRuntime\b/],
    ['language recognition', 'components/ui/code/highlighting/resolveShikiLanguageId.ts', /from ['"]shiki\/langs['"]/],
])('keeps %s outside its presentation/runtime implementation graph', (_name, entry, forbidden) => {
    const root = resolve(process.cwd(), 'sources');
    const seen = new Set<string>();
    const queue = [resolve(root, entry)];
    const parents = new Map<string, string>();
    for (let index = 0; index < queue.length; index++) {
        const file = queue[index];
        if (seen.has(file)) continue;
        seen.add(file);
        const source = readFileSync(file, 'utf8');
        const trail = [file];
        while (parents.has(trail[0])) trail.unshift(parents.get(trail[0])!);
        expect(forbidden.test(source), `lazy sync graph reached ${trail.map(path => path.replace(root, '')).join(' → ')}`).toBe(false);
        const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        const follow = (specifier: string) => {
            const base = specifier.startsWith('@/') ? resolve(root, specifier.slice(2))
                : specifier.startsWith('.') ? resolve(dirname(file), specifier) : null;
            if (!base) return;
            // Workspace ESM imports name emitted .js files; follow their TS source.
            const sourceBase = base.endsWith('.js') ? base.slice(0, -3) : base;
            const dependency = ['', '.web.ts', '.web.tsx', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx']
                .map((suffix) => sourceBase + suffix).find((path) => existsSync(path) && statSync(path).isFile());
            expect(dependency, `unresolved dependency ${specifier} from ${file}`).toBeDefined();
            if (dependency && !parents.has(dependency) && dependency !== queue[0]) parents.set(dependency, file);
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

it('compiles language recognition with zero Shiki payload modules and preserves its runtime export', async () => {
    const result = await build({
        entryPoints: [resolve(process.cwd(), 'sources/components/ui/code/highlighting/resolveShikiLanguageId.ts')],
        bundle: true, format: 'cjs', platform: 'node', metafile: true, write: false,
    });
    expect(Object.keys(result.metafile!.inputs).filter(file => /\/(?:shiki|@shikijs)\//.test(file))).toHaveLength(0);
    const compiled = { exports: {} };
    new Function('module', 'exports', result.outputFiles![0].text)(compiled, compiled.exports);
    // Compiled JavaScript exports are an untyped compiler boundary.
    const lookup = compiled.exports as typeof import('@/components/ui/code/highlighting/resolveShikiLanguageId');
    expect(lookup.resolveShikiLanguageId('typescript')).toBe('ts');
    expect(lookup.resolveShikiLanguageId('not-a-language')).toBe('text');
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
