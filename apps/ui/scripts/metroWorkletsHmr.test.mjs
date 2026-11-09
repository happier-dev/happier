import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { applyPatch, parsePatch, reversePatch } = require('diff');
const filename = require.resolve('metro-runtime/src/modules/HMRClient');
const patchPath = new URL('../../../patches/metro-runtime@0.83.5.patch', import.meta.url);
const originalPatch = parsePatch(fs.readFileSync(new URL('../../../patches/metro-runtime@0.83.5.patch', import.meta.url), 'utf8'))[0];
const installed = fs.readFileSync(filename, 'utf8');
// Test a candidate patch against the real pinned Metro implementation without
// installing dependencies. The native Worklets runtime and socket are boundaries.
const upstream = applyPatch(installed, reversePatch(originalPatch)) || installed;
const candidatePatch = parsePatch(process.env.HAPPIER_TEST_METRO_RUNTIME_PATCH ?? fs.readFileSync(patchPath, 'utf8'))[0];
const source = applyPatch(upstream, candidatePatch);
assert.equal(typeof source, 'string', 'the Metro runtime patch must apply without fuzz');

function applyUpdate(bundleMode, nativeProxy = true) {
    let socket;
    const sandbox = {
        module: { exports: {} },
        require: createRequire(filename),
        _WORKLETS_BUNDLE_MODE_ENABLED: bundleMode,
        hmrEvents: [],
        WebSocket: class {
            constructor() { socket = this; }
        },
        ...(nativeProxy ? {
            __workletsModuleProxy: {
                propagateModuleUpdate() {
                    // Non-bundle runtimes have no Metro module registry. Entering
                    // that native evaluator is the reproduced unsafe boundary.
                    if (!bundleMode) throw new Error('module registry is unavailable in this Worklets runtime');
                    sandbox.hmrEvents.push('worklet');
                },
            },
        } : {}),
    };
    sandbox.global = sandbox;
    vm.runInNewContext(source, sandbox, { filename });
    const client = new sandbox.module.exports('ws://metro.invalid/hot');
    client.enable();
    socket.onmessage({ data: JSON.stringify({
        type: 'update',
        body: {
            revisionId: 'next', isInitialUpdate: true, deleted: [], modified: [],
            added: [{ module: [1, "global.hmrEvents.push('main'); global.hmrValue = 42;"], sourceURL: 'fixture.bundle' }],
        },
    }) });
    return sandbox;
}

test('ordinary HMR updates run in React Native without entering a non-bundle Worklets runtime', () => {
    for (const mode of [undefined, false]) {
        const result = applyUpdate(mode);
        assert.equal(result.hmrValue, 42);
        assert.deepEqual(result.hmrEvents, ['main']);
    }
});

test('Bundle Mode preserves Worklets propagation before the React Native update', () => {
    const result = applyUpdate(true);
    assert.equal(result.hmrValue, 42);
    assert.deepEqual(result.hmrEvents, ['worklet', 'main']);
    assert.equal(applyUpdate(true, false).hmrValue, 42);
});
