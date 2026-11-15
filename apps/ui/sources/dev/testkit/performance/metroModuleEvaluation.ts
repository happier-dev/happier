import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What a module costs when the app evaluates it, under the shipped transform.
 *
 * Vitest evaluates ES imports eagerly, so it cannot show what Metro defers. This runs the app's
 * Babel config and then Metro's inline-requires pass (as `metro-transform-worker` does with
 * `inlineRequires: true`), and evaluates the module body against a caller-owned `require`
 * (the module registry boundary), so a test can count which modules evaluation pulls in.
 */
export const UI_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const requireFromUi = createRequire(resolve(UI_PACKAGE_ROOT, 'package.json'));
const babel = requireFromUi('@babel/core') as typeof import('@babel/core');
const { inlineRequiresPlugin } = requireFromUi('metro-transform-plugins') as { inlineRequiresPlugin: unknown };

export function transformLikeMetro(filename: string, platform: 'ios' | 'android' | 'web' = 'ios'): string {
    const source = readFileSync(filename, 'utf8');
    const first = babel.transformSync(source, {
        filename, configFile: resolve(UI_PACKAGE_ROOT, 'babel.config.js'), babelrc: false, ast: true, code: false, sourceType: 'module',
        caller: { name: 'metro', bundler: 'metro', platform, isDev: false, isServer: false, engine: 'hermes' } as never,
    });
    const second = babel.transformFromAstSync(first!.ast!, source, {
        filename, configFile: false, babelrc: false, code: true,
        plugins: [[inlineRequiresPlugin, { ignoredRequires: [], inlineableCalls: ['_$$_IMPORT_DEFAULT', '_$$_IMPORT_ALL'] }]],
    });
    return second!.code!;
}

/** Babel helpers run for real; every other request goes to `load`. */
export function evaluateMetroModule(code: string, load: (specifier: string) => unknown): Record<string, unknown> {
    const module = { exports: {} as Record<string, unknown> };
    const metroRequire = (specifier: string): unknown => (
        specifier.startsWith('@babel/runtime/') ? requireFromUi(specifier) : load(specifier)
    );
    // eslint-disable-next-line no-new-func -- evaluates the transformed body like Metro's module factory.
    new Function('require', 'module', 'exports', code)(metroRequire, module, module.exports);
    return module.exports;
}

/** A stand-in for any module: every property, call and construction yields itself, so only the evaluated module's own top level runs. */
export const OPAQUE_MODULE: unknown = new Proxy(function opaqueModule() { return undefined; }, {
    get: (_target, key) => key === '__esModule' ? true : key === Symbol.toPrimitive ? () => '' : OPAQUE_MODULE,
    apply: () => OPAQUE_MODULE,
    construct: () => OPAQUE_MODULE as object,
});
