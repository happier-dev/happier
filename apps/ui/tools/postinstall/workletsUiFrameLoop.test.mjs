import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const packageDir = path.dirname(require.resolve('react-native-worklets/package.json'));

// The patched UI-runtime frame loop (patches/react-native-worklets@0.8.1.patch) runs with the package's
// real microtask queue. Only the native module is replaced: nothing here calls into it.
const nativeBoundary = 'export const WorkletsModule = {};';

const entries = [
    { frameLoop: 'src/runLoop/uiRuntime/requestAnimationFrame.ts', microtasks: 'src/threads.native.ts' },
    { frameLoop: 'lib/module/runLoop/uiRuntime/requestAnimationFrame.js', microtasks: 'lib/module/threads.native.js' },
];

async function loadUiRuntime(entry) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklets-frame-loop-'));
    try {
        const bundle = path.join(dir, 'uiRuntime.cjs');
        await build({
            stdin: {
                contents: `export { setupRequestAnimationFrame } from ${JSON.stringify(path.join(packageDir, entry.frameLoop))}; export { setupMicrotasks } from ${JSON.stringify(path.join(packageDir, entry.microtasks))};`,
                resolveDir: packageDir,
                loader: 'ts',
            },
            outfile: bundle,
            bundle: true,
            platform: 'node',
            format: 'cjs',
            logLevel: 'silent',
            resolveExtensions: ['.native.ts', '.ts', '.native.js', '.js'],
            plugins: [{
                name: 'native-sdk-boundary',
                setup(builder) {
                    builder.onResolve({ filter: /\/WorkletsModule\/NativeWorklets(?:\.js)?$/ }, () => ({ path: 'native', namespace: 'sdk' }));
                    builder.onLoad({ filter: /.*/, namespace: 'sdk' }, () => ({ contents: nativeBoundary, loader: 'js' }));
                    builder.onResolve({ filter: /\.js$/ }, args => {
                        if (!args.path.startsWith('.')) return;
                        const native = path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.native.js'));
                        if (fs.existsSync(native)) return { path: native };
                    });
                },
            }],
        });
        return fs.readFileSync(bundle, 'utf8');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// Boots the UI runtime the way initializeRuntime does (setupMicrotasks, then setupRequestAnimationFrame)
// over a native frame scheduler that records requests and delivers them one vsync at a time.
function bootUiRuntime(code) {
    const saved = {};
    for (const key of ['requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask', '__callMicrotasks', '_microtaskQueueFinalizers', '__flushAnimationFrame', '__frameTimestamp', '__DEV__', '_WORKLETS_BUNDLE_MODE_ENABLED']) {
        saved[key] = globalThis[key];
    }
    const nativeFrames = [];
    let requested = 0;
    globalThis.__DEV__ = false;
    globalThis._WORKLETS_BUNDLE_MODE_ENABLED = false;
    globalThis.requestAnimationFrame = (callback) => {
        requested += 1;
        nativeFrames.push(callback);
    };
    const module = { exports: {} };
    new Function('module', 'exports', 'require', code)(module, module.exports, require);
    module.exports.setupMicrotasks();
    module.exports.setupRequestAnimationFrame();
    let now = 0;
    return {
        requested: () => requested,
        // One vsync: run the frames requested before it.
        vsync() {
            now += 16;
            const due = nativeFrames.splice(0);
            for (const frame of due) frame(now);
            return due.length;
        },
        restore() {
            for (const [key, value] of Object.entries(saved)) globalThis[key] = value;
        },
    };
}

for (const entry of entries) {
    test(`${entry.frameLoop}: the UI runtime requests native frames only for queued work`, async () => {
        const runtime = bootUiRuntime(await loadUiRuntime(entry));
        try {
            assert.equal(runtime.requested(), 0, 'an idle UI runtime requests no native frame');

            // A shared-value write over JSI (no animation running) queues its mapper run as a microtask
            // outside any frame or flush: one frame applies it, then the runtime is idle again.
            let mapped = 0;
            globalThis.queueMicrotask(() => { mapped += 1; });
            globalThis.queueMicrotask(() => { mapped += 1; });
            assert.equal(runtime.requested(), 1, 'microtasks queued outside a frame request one frame');
            assert.equal(runtime.vsync(), 1);
            assert.equal(mapped, 2, 'the frame drains the queued microtasks');
            assert.equal(runtime.vsync(), 0, 'nothing queued, no next frame');
            assert.equal(runtime.requested(), 1);

            // A chain of three callbacks takes three frames; a microtask queued inside a frame runs in
            // that frame without another request.
            let steps = 0;
            let inFrameMicrotask = 0;
            const step = () => {
                steps += 1;
                globalThis.queueMicrotask(() => { inFrameMicrotask += 1; });
                if (steps < 3) globalThis.requestAnimationFrame(step);
            };
            globalThis.requestAnimationFrame(step);
            while (runtime.vsync() > 0) {
                assert.equal(inFrameMicrotask, steps, 'a microtask queued in a frame runs in that frame');
            }
            assert.equal(steps, 3);
            assert.equal(runtime.requested(), 4, 'one request per frame of the chain');

            // A throwing callback does not stop the loop for work still queued.
            globalThis.requestAnimationFrame(() => {
                globalThis.requestAnimationFrame(() => { steps += 1; });
                throw new Error('callback failure');
            });
            assert.throws(() => runtime.vsync(), /callback failure/);
            assert.equal(runtime.vsync(), 1, 'the queued callback still gets its frame');
            assert.equal(steps, 4);
            assert.equal(runtime.vsync(), 0);
        } finally {
            runtime.restore();
        }
    });
}
