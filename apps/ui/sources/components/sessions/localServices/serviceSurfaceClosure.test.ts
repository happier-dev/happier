import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const UI_ROOT = path.resolve(__dirname, '../../../..');

function read(relative: string): string {
    return readFileSync(path.join(UI_ROOT, relative), 'utf8');
}

function exists(relative: string): boolean {
    return existsSync(path.join(UI_ROOT, relative));
}

const SKIPPED_DIR_NAMES = new Set(['__tests__', '__testdata__', 'node_modules']);
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];

function productionSourceFiles(root: string): readonly string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop() as string;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIPPED_DIR_NAMES.has(entry.name)) stack.push(full);
                continue;
            }
            if (!/\.tsx?$/.test(entry.name)) continue;
            if (TEST_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
            out.push(full);
        }
    }
    return out.sort();
}

/**
 * Every production module the census must cover. `sources/` is the bulk, but it is NOT the whole
 * package: `index.ts` is the package `main` and the Expo entry (it `require()`s into `sources/`),
 * and `widgets/**` ships native widget code. Walking only `sources/` would leave the app's own
 * entry point — the most natural place for a stray barrel re-export — outside the guard, which is
 * the same narrowing mistake as the F-3 pre-filter. Test and config files are excluded because a
 * re-import there cannot reach the bundle.
 */
function censusFiles(): readonly string[] {
    const roots = ['sources', 'widgets'].map((dir) => path.join(UI_ROOT, dir)).filter(existsSync);
    const walked = roots.flatMap((root) => [...productionSourceFiles(root)]);
    const entry = path.join(UI_ROOT, 'index.ts');
    return [...(existsSync(entry) ? [entry] : []), ...walked].sort();
}

/** A statically-known module specifier: `'x'`, `"x"`, or an un-substituted `` `x` ``. */
function staticSpecifierText(node: ts.Node | undefined): string | null {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return null;
}

/**
 * Every module specifier this file imports, re-exports, or dynamically imports — read from the
 * TypeScript AST, not by substring. A rewritten import (aliased, split across lines, `export
 * … from`, `await import(...)`, `require(...)`, or a backtick specifier) is still an import here,
 * which a source-text grep would miss.
 *
 * Every production file is parsed. There is deliberately NO name-based pre-filter deciding which
 * files are worth parsing: review finding F-3 showed exactly why. A `text.includes('managed')`
 * filter added here for speed was case-sensitive, so it skipped `ManagedLocalServiceRow` and
 * `ManagedLocalServiceStatus` — and a barrel re-export of a deleted component is precisely the
 * incident (F-UI-1) that took the whole web bundle down. A filter that must be kept in sync with
 * the offender patterns below will drift out of sync; the only version that cannot is the one
 * that does not exist. The whole-tree parse costs ~23s, which is why this test carries an
 * explicit budget rather than a shortcut.
 */
function moduleSpecifiers(file: string, text: string): readonly string[] {
    const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        // Parent pointers are not read below; skipping them is a pure cost saving that cannot
        // change which nodes are visited.
        false,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            const spec = staticSpecifierText(node.moduleSpecifier);
            if (spec !== null) specifiers.push(spec);
        }
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            const spec = staticSpecifierText(node.moduleReference.expression);
            if (spec !== null) specifiers.push(spec);
        }
        if (ts.isCallExpression(node)) {
            const isImportCall = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            const isRequireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require';
            if (isImportCall || isRequireCall) {
                const spec = staticSpecifierText(node.arguments[0]);
                if (spec !== null) specifiers.push(spec);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return specifiers;
}

describe('local-services surface single-owner closure', () => {
    it('DetectedLocalServicesPane renders via buildLocalServiceRows + ServiceRowView, not separate region builders', () => {
        const pane = read('sources/components/sessions/localServices/DetectedLocalServicesPane.tsx');
        expect(pane).toContain('buildLocalServiceRows');
        expect(pane).toContain('ServiceRowView');
        // The deleted launchpad/detected-row/fallback paths must not reappear.
        expect(pane).not.toContain('LocalServiceLaunchpad');
        expect(pane).not.toContain('DetectedLocalServiceRow');
        expect(pane).not.toContain('buildLocalServiceLauncherSnapshotFromRows');
        // No inventory-derived fallback launcher state.
        expect(pane).not.toContain('createLocalServiceLauncherState()\n            buildLocalServiceLauncherSnapshotFromRows');
    });

    it('the deleted split-brain surfaces no longer exist', () => {
        expect(exists('sources/components/sessions/localServices/LocalServiceLaunchpad.tsx')).toBe(false);
        expect(exists('sources/components/sessions/localServices/DetectedLocalServiceRow.tsx')).toBe(false);
        expect(exists('sources/sync/domains/local/services/launch/selectors.ts')).toBe(false);
        expect(exists('sources/sync/domains/local/services/inventory/loopbackLaunchTarget.ts')).toBe(false);
        // RU2 surfaces finalization / SB-B: the legacy managed render path and the managed
        // sync domain behind it. `ManagedLocalServiceRow` was reachable only through the
        // barrel and rendered by nothing; the store it read was fed by an RPC whose daemon
        // producer could never emit a row (LSV-2 / DEC-6).
        expect(exists('sources/components/sessions/localServices/ManagedLocalServiceRow.tsx')).toBe(false);
        expect(exists('sources/components/sessions/localServices/ManagedLocalServiceStatus.tsx')).toBe(false);
        expect(exists('sources/components/sessions/localServices/LocalServiceFactList.tsx')).toBe(false);
        expect(exists('sources/sync/domains/local/services/managed')).toBe(false);
    });

    it('no production module imports the removed managed local-services domain', () => {
        // AST-level, so this fails on a re-import however it is spelled — a plain import, an
        // aliased or type-only import, `export … from`, or a dynamic `import(...)`. A file
        // existence check alone would not: a contributor can re-create the module, and a
        // source-text grep would not: an import can be rewritten past a substring match.
        // Both patterns are case-insensitive and tolerate an explicit file extension, so
        // `./ManagedLocalServiceRow.tsx` and `./managedlocalservicerow` are caught alongside the
        // bare specifier (F-3, secondary holes).
        const REMOVED_SYNC_DOMAIN = /(^|\/)sync\/domains\/local\/services\/managed(\/|$)/i;
        const REMOVED_COMPONENTS =
            /(^|\/)localServices\/(ManagedLocalServiceRow|ManagedLocalServiceStatus|LocalServiceFactList)(\.(tsx?|jsx?|web|native))*$/i;

        const offenders: string[] = [];
        for (const file of censusFiles()) {
            for (const specifier of moduleSpecifiers(file, readFileSync(file, 'utf8'))) {
                const resolved = specifier.startsWith('.')
                    ? path.relative(UI_ROOT, path.resolve(path.dirname(file), specifier))
                    : specifier;
                if (REMOVED_SYNC_DOMAIN.test(resolved) || REMOVED_COMPONENTS.test(resolved)) {
                    offenders.push(`${path.relative(UI_ROOT, file)} -> ${specifier}`);
                }
            }
        }
        expect(offenders).toEqual([]);
        // Explicit budget: this parses EVERY production module in the package (~6.4k files,
        // ~23s of parse standalone, 41-93s observed under concurrent-suite load). That is the
        // price of having no pre-filter to drift out of sync with the patterns above, and the
        // shared checkout runs many suites at once — an inherited default timeout would make
        // this census flaky rather than discriminating.
        //
        // IF THIS TIMES OUT: a timeout here is a WITHDRAWN MEASUREMENT — never a pass, never
        // grounds to `it.skip` it or to shrink the corpus it walks. Note also that `testTimeout`
        // bounds the body only, not vitest's collect phase; this program has already seen a
        // sub-10ms test spend 300-480s in collect, so a slow run may not even be this budget.
        //
        // The two sanctioned remedies, if the budget genuinely bites, are (a) sharing one parse
        // across this package's censuses, or (b) parallelizing the walk. Explicitly FORBIDDEN:
        // reintroducing a content/name pre-filter, or swapping in `ts.preProcessFile`. Both were
        // tried and measured. The pre-filter was review finding F-3 — it was case-sensitive, so
        // it skipped `ManagedLocalServiceRow` and let the exact barrel re-export that took the
        // web bundle down (F-UI-1) pass green. `preProcessFile` is ~3x faster but was measured
        // to miss 7 specifiers the full parse finds, so it is not equivalent either. The
        // general rule both violate: a content pre-filter is safe ONLY when its token is
        // byte-identical to, or a case-insensitive superset of, every token the matcher can hit.
    }, 300_000);

    it('launch/index no longer exports the dead launcher-from-rows builder or browser-targets selector', () => {
        const index = read('sources/sync/domains/local/services/launch/index.ts');
        expect(index).not.toContain('buildLocalServiceLauncherSnapshotFromRows');
        expect(index).not.toContain('selectLocalServiceLauncherTargetsForBrowser');
        expect(index).not.toContain('./selectors');
    });

    it('ServiceRowView consumes the neutral surface-copy mapper, with no local reason map', () => {
        const view = read('sources/components/sessions/localServices/ServiceRowView.tsx');
        expect(view).toContain("from '@/sync/domains/surfaces/copy'");
        expect(view).toContain('resolveReasonCopy');
        // No second copy map defined in the services surface.
        expect(view).not.toMatch(/REASON_KEYS\s*=/);
    });

    it('the daemon forms loopback URLs only through the canonical loopbackServiceUrl builder (no hand-concat)', () => {
        // This closure lives in apps/cli; resolve relative to the repo root.
        const cliRoot = path.resolve(UI_ROOT, '../cli');
        const suggestions = readFileSync(
            path.join(cliRoot, 'src/daemon/local/services/launch/suggestions.ts'),
            'utf8',
        );
        expect(suggestions).toContain('function loopbackServiceUrl');
        // No hand-concatenated loopback http(s) URL template outside the builder.
        const handConcat = /`https?:\/\/\$\{[^}]*host[^}]*\}:\$\{[^}]*port[^}]*\}/i;
        const builderBody = suggestions.slice(
            suggestions.indexOf('function loopbackServiceUrl'),
            suggestions.indexOf('function loopbackExternalUrlTarget'),
        );
        const outsideBuilder = suggestions.replace(builderBody, '');
        expect(handConcat.test(outsideBuilder)).toBe(false);
    });
});
