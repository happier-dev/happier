import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('loads policy scheduling without loading native acquisition or guest enrollment', async () => {
    // Inspect the real static bundled closure. Deferred imports are separate
    // first-use work; no internal runtime or domain implementation is mocked.
    const result = await build({
        absWorkingDir: fileURLToPath(new URL('../../..', import.meta.url)),
        entryPoints: ['src/daemon/startup/managedMachinePolicyRuntime.ts'],
        bundle: true,
        format: 'esm',
        platform: 'node',
        packages: 'external',
        write: false,
        metafile: true,
        plugins: [{
            name: 'static-startup-closure',
            setup(builder) {
                builder.onResolve({ filter: /.*/ }, args => args.kind === 'dynamic-import'
                    ? { path: args.path, external: true } : undefined);
            },
        }],
    });
    const inputs = Object.entries(result.metafile.inputs);
    // Scheduling shares only the pure retention predicate, not the native driver.
    const acquisition = inputs.filter(([path]) => /^src\/machines\/managed\//.test(path)
        && !path.endsWith('/controllerErrors.ts') && !path.endsWith('/managedRetentionPolicy.ts'));
    console.info(JSON.stringify({ staticModules: inputs.length,
        staticSourceBytes: inputs.reduce((total, [, input]) => total + input.bytes, 0),
        acquisitionModules: acquisition.map(([path]) => path),
        acquisitionSourceBytes: acquisition.reduce((total, [, input]) => total + input.bytes, 0) }));
    expect(acquisition.map(([path]) => path)).toEqual([]);
});
