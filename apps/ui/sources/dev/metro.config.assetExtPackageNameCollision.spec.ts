import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `config.resolver.assetExts` registers `bundle` and `map` so bundled Plugin UI artifacts
 * (`*.bundle`, `*.bundle.map`, `*.js.map`) are indexed by Metro's file map and transformed as
 * assets. Metro decides asset-ness from the trailing dot-segment of a specifier's basename
 * (`metro-resolver/src/utils/isAssetFile`), so a bare npm package whose NAME ends in one of those
 * extensions is misclassified as an asset request. `DependencyGraph.resolveAsset` keeps any file-map
 * entry with a truthy `realPath` — including a DIRECTORY — and `ModuleResolution`
 * `_getFileResolvedModule` converts it to `{ type: 'sourceFile', filePath: <package directory> }`.
 * That directory reaches `Transformer.transformFile` and fails with
 * "Failed to get the SHA-1 for: <package directory>".
 *
 * `array.prototype.map` is such a package, and it is a runtime dependency of `promise.allsettled`.
 */
describe('apps/ui/metro.config.js (package names colliding with artifact asset extensions)', () => {
    const envSnapshot = { ...process.env };

    function requireFreshMetroConfig() {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const resolved = require.resolve('../../metro.config.js');
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete require.cache[resolved];
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../../metro.config.js');
    }

    function resolveCapturingDelegatedContext(moduleName: string) {
        const config = requireFreshMetroConfig();

        // Precondition: the artifact-only extensions really are registered as asset extensions.
        expect(config.resolver.assetExts).toContain('map');
        expect(config.resolver.assetExts).toContain('bundle');

        const delegatedContexts: { assetExts?: Set<string> }[] = [];
        const passThrough = { type: 'sourceFile', filePath: '/delegated/resolution.js' };

        const result = config.resolver.resolveRequest(
            {
                assetExts: new Set<string>(config.resolver.assetExts),
                resolveRequest: (context: { assetExts?: Set<string> }) => {
                    delegatedContexts.push(context);
                    return passThrough;
                },
            },
            moduleName,
            'ios',
        );

        return { delegatedContexts, result, passThrough };
    }

    beforeEach(() => {
        vi.resetModules();
        process.env = { ...envSnapshot };
    });

    afterEach(() => {
        vi.resetModules();
        process.env = { ...envSnapshot };
    });

    it('resolves a package whose name ends in an artifact asset extension as a package, not an asset', () => {
        const { delegatedContexts, result, passThrough } = resolveCapturingDelegatedContext('array.prototype.map');

        expect(delegatedContexts.length).toBeGreaterThan(0);
        const delegatedAssetExts = delegatedContexts.at(-1)?.assetExts;

        // Without this, Metro classifies `array.prototype.map` as an asset and resolves it to the
        // package DIRECTORY, which has no SHA-1.
        expect(delegatedAssetExts?.has('map')).toBe(false);
        expect(delegatedAssetExts?.has('bundle')).toBe(false);

        // Only the artifact-only extensions are withheld; real asset extensions still apply.
        expect(delegatedAssetExts?.has('png')).toBe(true);

        // Delegation result is passed through unchanged.
        expect(result).toEqual(passThrough);
    });

    it('leaves artifact asset extensions registered for every other specifier', () => {
        const { delegatedContexts } = resolveCapturingDelegatedContext('array.prototype.at');

        expect(delegatedContexts.length).toBeGreaterThan(0);
        const delegatedAssetExts = delegatedContexts.at(-1)?.assetExts;

        expect(delegatedAssetExts?.has('map')).toBe(true);
        expect(delegatedAssetExts?.has('bundle')).toBe(true);
    });
});
