import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';

/** Modal 0.11.0 SDK boundary: the provider's real SDK worker runs with only its `modal` import replaced by ./modalSdk.mjs. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { directory } = world;
    const state = join(directory, 'modal-state.json'), preload = join(directory, 'preload.mjs'), entry = join(directory, 'worker.mjs');
    writeFileSync(state, JSON.stringify({ present: false, failure: false, allocations: 0, foreignPresent: true }));
    writeFileSync(join(directory, 'loader.mjs'), `export async function resolve(specifier, context, nextResolve) { return specifier === 'modal' ? { url: ${JSON.stringify(new URL('./modalSdk.mjs', import.meta.url).href)}, shortCircuit: true } : nextResolve(specifier, context); }`);
    // Compile the current private worker; its real roles/native client are bundled unchanged.
    buildSync({ entryPoints: [new URL('../src/machine/sdkWorker.ts', import.meta.url).pathname], outfile: entry, bundle: true, platform: 'node', format: 'esm', external: ['modal'],
        banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
    writeFileSync(preload, `import { register } from 'node:module'; register(new URL('./loader.mjs', import.meta.url));`);
    const read = () => JSON.parse(readFileSync(state, 'utf8')) as { present: boolean; foreignPresent: boolean; allocations: number };
    return {
        foreignId: 'happier-foreign', launch: { appReference: 'conformance', imageReference: 'ubuntu:24.04', resources: { cpu: 0.125, memoryMb: 512 }, timeoutMs: 300000 },
        worker: { preload, state, entry },
        account: { environment: { MODAL_TOKEN_ID: 'fixture-token', MODAL_TOKEN_SECRET: world.privateBinding, MODAL_SERVER_URL: 'https://modal.example.test' } },
        external: {
            allocationCount: () => Number(read().allocations), foreignPresent: () => Boolean(read().foreignPresent), present: () => Boolean(read().present),
            owned: () => new Set<string>(read().present ? ['sandbox'] : []),
            setFailure: failure => writeFileSync(state, JSON.stringify({ ...read(), failure })), cleanup: () => {},
        },
    };
};
