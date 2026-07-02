import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * R18 (broadened, R-A16): NOTHING reachable from the native `MarkdownEditor`
 * graph may import any `@tiptap/*` package. TipTap must reach native ONLY as the
 * prebuilt bundle string inside the WebView HTML — never as an RN JS import.
 *
 * This guard reads the SOURCE TEXT of the native-graph entry points + every
 * `core/eligibility/` file + the native-reachable `bridge/` sources and asserts
 * none of them contains an `@tiptap/*` import/require statement. It is
 * intentionally simple + robust: a static text scan that catches a regression
 * (someone importing `@tiptap/...` into a native file) before it can bloat or
 * break the native bundle.
 *
 * NOTE: doc-comment MENTIONS of `@tiptap` (e.g. "PURE — no @tiptap import") are
 * fine; only actual `import .../require(...)` STATEMENTS are forbidden. The regex
 * below matches the module-specifier position of import/require/export-from, so
 * prose mentions never trip it. `richEligibility.web.ts` reaches TipTap only via
 * `../tiptap/...` (Metro resolves it for web only) — it has no DIRECT `@tiptap`
 * import, so it passes too.
 *
 * Scope note (NIT-4): the scan is a flat text scan of the entry points it lists,
 * NOT a transitive import-graph walk — it does not follow `import` edges. It
 * widens to `bridge/` because the native surface imports `bridge/tiptapWebViewHtml.ts`
 * (which inlines TipTap only as the prebuilt bundle STRING). Two `bridge/` files
 * are deliberately excluded because they are NOT in the native RN JS graph and
 * legitimately reference TipTap:
 *   - `tiptapWebViewBundle.generated.ts` — the committed bundle string (`*.generated.ts`).
 *   - `tiptapWebViewEntry.ts` — the esbuild entry; it imports `@tiptap/core` and is
 *     ONLY ever bundled into the WebView bundle, never imported by the RN surface.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// __tests__ -> eligibility -> core -> editor
const EDITOR_ROOT = resolve(HERE, '..', '..', '..');
const ELIGIBILITY_DIR = resolve(HERE, '..');
const BRIDGE_DIR = resolve(EDITOR_ROOT, 'bridge');

// `bridge/` files that are NOT in the native RN JS graph and legitimately
// reference `@tiptap/*` (see the scope note above): the committed bundle string
// and the web-only esbuild entry.
function isNativeReachableBridgeSource(name: string): boolean {
    if (!name.endsWith('.ts')) return false;
    if (name.endsWith('.test.ts')) return false;
    if (name.endsWith('.generated.ts')) return false;
    if (name === 'tiptapWebViewEntry.ts') return false;
    return true;
}

// Matches an `@tiptap/...` specifier in an import/export-from or require(...)
// position: a string literal beginning with `@tiptap`.
const TIPTAP_IMPORT_PATTERN =
    /(?:import\b[\s\S]*?from|export\b[\s\S]*?from|require\s*\(|import\s*\()\s*['"]@tiptap\//;

function readSource(path: string): string {
    return readFileSync(path, 'utf8');
}

function listEligibilitySources(): string[] {
    return readdirSync(ELIGIBILITY_DIR)
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map((name) => join(ELIGIBILITY_DIR, name));
}

function listNativeReachableBridgeSources(): string[] {
    return readdirSync(BRIDGE_DIR)
        .filter(isNativeReachableBridgeSource)
        .map((name) => join(BRIDGE_DIR, name));
}

const NATIVE_GRAPH_ENTRY_POINTS = [
    join(EDITOR_ROOT, 'MarkdownEditor.tsx'),
    join(EDITOR_ROOT, 'MarkdownEditor.native.tsx'),
    join(EDITOR_ROOT, 'surfaces', 'TiptapWebViewSurface.native.tsx'),
];

describe('no @tiptap import in the native graph (R18)', () => {
    it('the native MarkdownEditor entry points import no @tiptap package', () => {
        for (const path of NATIVE_GRAPH_ENTRY_POINTS) {
            const source = readSource(path);
            expect(
                TIPTAP_IMPORT_PATTERN.test(source),
                `Expected no @tiptap import in ${path}`,
            ).toBe(false);
        }
    });

    it('every core/eligibility source imports no @tiptap package', () => {
        const sources = listEligibilitySources();
        // Sanity: we actually scanned files (guards against a broken glob path).
        expect(sources.length).toBeGreaterThan(0);

        for (const path of sources) {
            const source = readSource(path);
            expect(
                TIPTAP_IMPORT_PATTERN.test(source),
                `Expected no @tiptap import in ${path}`,
            ).toBe(false);
        }
    });

    it('every native-reachable bridge source imports no @tiptap package', () => {
        const sources = listNativeReachableBridgeSources();
        // Sanity: we actually scanned files (the native surface imports
        // `bridge/tiptapWebViewHtml.ts`, so there is always at least one).
        expect(sources.length).toBeGreaterThan(0);
        // The web-only esbuild entry must be excluded from this scan (it does
        // import `@tiptap/core` on purpose, but is never in the native graph).
        expect(sources.some((path) => path.endsWith('tiptapWebViewEntry.ts'))).toBe(false);

        for (const path of sources) {
            const source = readSource(path);
            expect(
                TIPTAP_IMPORT_PATTERN.test(source),
                `Expected no @tiptap import in ${path}`,
            ).toBe(false);
        }
    });

    it('the regex flags a real @tiptap import (self-check)', () => {
        // Guards against the pattern silently never matching (a false-green guard).
        expect(TIPTAP_IMPORT_PATTERN.test("import { Editor } from '@tiptap/core';")).toBe(true);
        expect(TIPTAP_IMPORT_PATTERN.test('import { Markdown } from "@tiptap/markdown";')).toBe(true);
        expect(TIPTAP_IMPORT_PATTERN.test("const x = require('@tiptap/core');")).toBe(true);
        // Prose mentions must NOT match.
        expect(TIPTAP_IMPORT_PATTERN.test(' * PURE — no @tiptap/* import (R18).')).toBe(false);
    });
});
