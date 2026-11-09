import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext, runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// The leak only exists in the shipped (minified) bundle: once terser inlines Legend List's
// `getGlobalResizeObserver()` into `createResizeObserver(element, ...)`, the shared observer's
// callback is created in that call's context and pins the first observed element (production
// heap snapshot: session-list content plus the whole navigation column). So this test minifies
// the installed module region with Metro's own default minifier settings.
const require = createRequire(import.meta.url);
const terser = require('terser') as typeof import('terser');
const metroConfig = require('metro-config') as { getDefaultConfig: (root: string) => Promise<{ transformer: { minifierConfig: Record<string, unknown> } }> };

setFlagsFromString('--expose-gc');
const collectGarbage = runInNewContext('gc') as () => void;

const WEB_BUILDS = ['react-native.web.js', 'react-native.web.mjs', 'react.js', 'react.mjs'] as const;

function readCreateResizeObserverRegion(build: string): string {
    // The package exports map hides the individual builds; resolve its directory through a public subpath.
    const packageDir = dirname(require.resolve('@legendapp/list/react-native'));
    const source = readFileSync(join(packageDir, build), 'utf8');
    const start = source.indexOf('// src/hooks/createResizeObserver.ts');
    const end = source.indexOf('\n// src/', start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    return source.slice(start, end);
}

class RecordingResizeObserver {
    readonly targets = new Set<object>();
    constructor(readonly callback: (entries: unknown[]) => void) {}
    observe(target: object) { this.targets.add(target); }
    unobserve(target: object) { this.targets.delete(target); }
}

describe('Legend List shared ResizeObserver (minified web build)', () => {
    it.each(WEB_BUILDS)('%s releases an observed element after its cleanup runs', async (build) => {
        const { minifierConfig } = (await metroConfig.getDefaultConfig(process.cwd())).transformer;
        const exportName = `__legendCreateResizeObserver_${build.replace(/\W/g, '_')}`;
        const wrapped = `globalThis.${exportName} = (function (batchItemSizeUpdates, ResizeObserver) {\n${readCreateResizeObserverRegion(build)}\nreturn createResizeObserver;\n});`;
        const minified = await terser.minify(wrapped, minifierConfig as import('terser').MinifyOptions);
        runInThisContext(minified.code!);
        const createResizeObserver = (globalThis as Record<string, unknown>)[exportName] as (
            batch: (run: () => void) => void, observer: typeof RecordingResizeObserver,
        ) => (element: object, callback: () => void) => () => void;
        const create = createResizeObserver((run) => run(), RecordingResizeObserver);

        let first: object | null = { element: 'first' };
        const firstRef = new WeakRef(first);
        let cleanup: (() => void) | null = create(first, () => {});
        // Later elements keep the shared observer alive, as a mounted list does.
        const later = { element: 'later' };
        const laterCleanup = create(later, () => {});
        cleanup();
        cleanup = null;
        first = null;
        for (let pass = 0; pass < 3; pass += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            collectGarbage();
        }
        expect(firstRef.deref()).toBeUndefined();
        laterCleanup();
        delete (globalThis as Record<string, unknown>)[exportName];
    });
});
