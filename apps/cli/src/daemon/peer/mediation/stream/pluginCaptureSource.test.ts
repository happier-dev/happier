import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MachineLiveStreamFrameV1 } from '@happier-dev/protocol';

import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createDaemonMachineLiveStreamCaptureAdapter } from './captureAdapter';
import { createMachineLiveStreamCaptureRegistry } from './captureRegistry';
import { registerPluginCaptureSource } from './pluginCaptureSource';

type CaptureFixtureControl = {
    stops: number;
    signal: AbortSignal;
    offerFrame(frame: MachineLiveStreamFrameV1): Readonly<{ ok: boolean; reasonCode?: string }>;
};
declare global {
    // eslint-disable-next-line no-var
    var __HAPPIER_CAPTURE_RETIREMENT_FIXTURE__: CaptureFixtureControl | undefined;
    // eslint-disable-next-line no-var
    var __HAPPIER_CAPTURE_RETIREMENT_MODULES__: number | undefined;
}

describe('manifest capture activation and retirement', () => {
    it.each(['plugin', 'daemon'] as const)('contains an authored rejected stop at the %s retirement boundary and refuses subsequent frames', async (boundary) => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-capture-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-capture-plugin-'));
        const pluginId = 'acme.capture-retirement';
        const unhandled: unknown[] = [];
        const observeUnhandled = (reason: unknown) => { unhandled.push(reason); };
        process.on('unhandledRejection', observeUnhandled);
        try {
            globalThis.__HAPPIER_CAPTURE_RETIREMENT_MODULES__ = 0;
            await mkdir(join(pluginRoot, '.happier-plugin'));
            await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
                schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Capture retirement fixture',
                engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
                entrypoints: { daemon: './daemon.mjs' },
                hostAccess: { required: [], optional: [] },
                contributes: { captureSources: [{ id: 'screen', displayName: 'Fixture screen',
                    streamFamily: 'screen', supportedCodecs: ['image.mjpeg'] }] },
            }), 'utf8');
            // This external authored plugin is the genuine producer boundary; no runtime registry is mocked.
            await writeFile(join(pluginRoot, 'daemon.mjs'), `globalThis.__HAPPIER_CAPTURE_RETIREMENT_MODULES__ = (globalThis.__HAPPIER_CAPTURE_RETIREMENT_MODULES__ ?? 0) + 1;
            export function activate(api) {
                api.captureSources.register('screen', { async start(input) {
                    const control = { stops: 0, signal: input.signal, offerFrame: input.offerFrame };
                    globalThis.__HAPPIER_CAPTURE_RETIREMENT_FIXTURE__ = control;
                    return { async stop() { control.stops += 1; throw new Error('authored stop failure'); } };
                } });
            }`, 'utf8');
            await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: '1.0.0' });
            const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external', existingAgentIds: new Set(),
            }));
            const generationAuthority = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({ happyHomeDir }), {});
            if (!generationAuthority) throw new Error('Expected committed capture fixture generation');
            const runtime = await resolveExecutablePluginRuntimeRegistry({ contributes, happyHomeDir, generationAuthority,
                resolveDevelopmentSourceAuthority: ({ pluginId: id, rootPath }) => ({ kind: 'development',
                    registeredRootId: `capture-fixture:${id}`, canonicalRoot: rootPath, observedRevision: 1 }),
            });
            try {
                expect(globalThis.__HAPPIER_CAPTURE_RETIREMENT_MODULES__, 'Idle startup must not import a capture-only plugin').toBe(0);
                const registry = createMachineLiveStreamCaptureRegistry();
                expect(await registerPluginCaptureSource({ runtimeRegistry: runtime, captureRegistry: registry,
                    reference: { pluginId, localId: 'undeclared' } })).toBeNull();
                expect(globalThis.__HAPPIER_CAPTURE_RETIREMENT_MODULES__, 'Undeclared capture demand must not import the plugin').toBe(0);
                const source = await registerPluginCaptureSource({ runtimeRegistry: runtime, captureRegistry: registry,
                    reference: { pluginId, localId: 'screen' } });
                expect(source).not.toBeNull();
                expect(globalThis.__HAPPIER_CAPTURE_RETIREMENT_MODULES__).toBe(1);
                if (!source) throw new Error('Expected activated capture source');
                const caps = { maxBitrateBps: 64_000, maxFramesPerSecond: 12, maxFrameBytes: 8_192,
                    maxDurationMs: 60_000, maxTotalBytes: 128_000 };
                const frames: MachineLiveStreamFrameV1[] = [];
                const adapter = boundary === 'plugin' ? source.adapter : createDaemonMachineLiveStreamCaptureAdapter(registry);
                const result = await adapter.start({
                    streamId: 'stream-1', streamFamily: 'screen', sourceMachineId: 'source', targetMachineId: 'target', caps,
                    startRequest: { v: 1, streamId: 'stream-1', streamFamily: 'screen', routeKind: 'loopback_direct',
                        sourceId: source.sourceId, sourceOccurrenceId: source.sourceOccurrenceId,
                        sourceMachineId: 'source', targetMachineId: 'target', ...caps },
                    startedAtMs: 1_000, expiresAtMs: 61_000, nowMs: () => 1_000,
                    offerFrame: frame => { frames.push(frame); return { ok: true }; },
                    applyControl: () => ({ ok: true }), emitReceipt: () => undefined,
                });
                expect(result.ok).toBe(true);
                const control = globalThis.__HAPPIER_CAPTURE_RETIREMENT_FIXTURE__;
                if (!control) throw new Error('Expected external capture producer control');
                await runtime.dispose();
                await vi.waitFor(() => expect(control.stops).toBe(1));
                // Flush the process rejection boundary, not just the adapter's synchronous abort listener.
                await new Promise<void>(resolve => setImmediate(resolve));
                expect(control.signal.aborted).toBe(true);
                expect(control.offerFrame({ v: 1, streamId: 'stream-1', sequence: 1, timestampMs: 1_001,
                    payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64', payloadBase64: 'AQID', payloadSizeBytes: 3,
                })).toMatchObject({ ok: false, reasonCode: 'capture_source_unavailable' });
                expect(frames).toEqual([]);
                expect(unhandled).toEqual([]);
                await runtime.dispose();
                await new Promise<void>(resolve => setImmediate(resolve));
                expect(control.stops).toBe(1);
                expect(unhandled).toEqual([]);
            } finally { await runtime.dispose(); }
        } finally {
            process.removeListener('unhandledRejection', observeUnhandled);
            delete globalThis.__HAPPIER_CAPTURE_RETIREMENT_FIXTURE__;
            delete globalThis.__HAPPIER_CAPTURE_RETIREMENT_MODULES__;
            await rm(pluginRoot, { recursive: true, force: true });
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
});
