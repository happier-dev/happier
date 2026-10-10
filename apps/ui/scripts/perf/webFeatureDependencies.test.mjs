import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

for (const [feature, entry, dependency] of [
    ['billing', 'apps/ui/sources/sync/domains/purchases/revenueCat.web.ts', /\/node_modules\/@revenuecat\/purchases-js\//],
    ['voice', 'packages/plugins/elevenlabs/src/ui/voice/runtime/conversationHandle.ts', /\/node_modules\/(?:@elevenlabs\/client|livekit-client)\//],
]) {
    test(`${feature} adapter keeps its browser SDK outside the static entry graph`, async () => {
        const { metafile } = await build({
            absWorkingDir: repoRoot,
            entryPoints: [entry],
            bundle: true,
            splitting: true,
            format: 'esm',
            platform: 'browser',
            outdir: '.feature-dependency-probe',
            write: false,
            metafile: true,
            external: ['@happier-dev/plugin-sdk/*'],
            logLevel: 'silent',
        });
        const outputs = metafile.outputs;
        const entryOutput = Object.keys(outputs).find((file) => outputs[file].entryPoint === entry);
        assert.ok(entryOutput, 'the real adapter must produce an entry output');
        const required = new Set();
        const visit = (file) => {
            if (required.has(file)) return;
            required.add(file);
            for (const edge of outputs[file].imports) {
                if (!edge.external && edge.kind !== 'dynamic-import') visit(edge.path);
            }
        };
        visit(entryOutput);
        const matchesSdk = (file) => dependency.test('/' + file.replaceAll('\\', '/'));
        assert.ok(Object.keys(metafile.inputs).some(matchesSdk), 'the async graph must retain the real browser SDK');
        const eager = [...required].flatMap((file) => Object.keys(outputs[file].inputs)).filter(matchesSdk);
        console.log(JSON.stringify({ feature, eagerSdkModules: eager.length }));
        assert.deepEqual(eager, [], 'importing the adapter must not require downloading its browser SDK');
    });
}
