import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';

import { createActionExecutor, FeaturesResponseSchema, type ActionExecuteResult, type ActionExecutorDeps, type ActionId } from '@happier-dev/protocol';
import { DaemonBrowserRecordingStopResultV1Schema } from '@happier-dev/protocol/browser/recording/v1';
import { resolveBrowserRecordingCaptureProfile } from '@happier-dev/protocol/browser/recording/captureProfiles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as persistence from '@/persistence';

import { createDaemonControlApp } from '../../controlServer';
import { createDaemonRuntimeActionExecutor } from '../../runtimeActionExecutor';
import { createCliBrowserRuntimeActionExecutor } from '../actions/controlTransport';
import { createBrowserCdpScreencastProducer } from '../capture/cdpScreencast';
import type { BrowserSidecarCdpEventSubscriber } from '../sidecar/controlAdapter';
import { createBrowserRecordingCdpScreencastTransport } from './adapters/cdpScreencastTransport';
import { createFfmpegBrowserRecordingStreamFrameEncoderFactory } from './adapters/ffmpegStreamEncoder';
import { createBrowserRecordingDaemonRuntime } from './runtime';
import { resolveBrowserRecordingStartContext } from './startContext';
import { resolveFfmpegStaticBinaryPath } from '../../runtime/ffmpegStatic';

const runFfmpeg = promisify(execFile);

const fixtureSource = new URL('../../../../../ui/sources/dev/testkit/fixtures/actionExecutorBoundary.ts', import.meta.url).href;
const { createActionExecutorBoundaryFixture }: {
    createActionExecutorBoundaryFixture(overrides: Partial<ActionExecutorDeps>): ActionExecutorDeps;
} = await import(fixtureSource);

afterEach(() => vi.restoreAllMocks());

// Only process creation and the CDP/network transports are replaced. The real Writable
// applies backpressure; the real recording owners persist and read the resulting file.
async function setup(options: { startupFrame?: boolean; missingEncoder?: boolean; encoderFails?: boolean;
    encoderAvailable?: () => Promise<boolean>; realEncoder?: boolean; encodedBytes?: number;
    nativeViewCapture?: boolean } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'happier-managed-recording-'));
    let now = 1_000;
    const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
    const commands: string[] = [];
    const encoded: Buffer[] = [];
    let sequence = 0;
    const frame = (bytes = Buffer.alloc(256 * 1024, 1)) => {
        for (const listener of listeners) listener({ method: 'Page.screencastFrame', sessionId: 'cdp',
            params: { sessionId: ++sequence, data: bytes.toString('base64') } });
    };
    const contextCapture = {
        resolvePageHandle: () => ({ targetId: 'target', sessionId: 'cdp' }),
        subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        transport: { dispatchPageCommand: async (command: { method: string }) => {
            commands.push(command.method);
            if (command.method === 'Page.startScreencast' && options.startupFrame) frame();
            if (command.method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'overlay' };
            if (command.method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
            if (command.method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
            return {};
        } },
    };
    const producer = createBrowserCdpScreencastProducer({ nowMs: () => now, contextCapture });
    const recording = createBrowserRecordingDaemonRuntime({ workingDirectory: directory, now: () => now,
        cdpScreencast: { transport: createBrowserRecordingCdpScreencastTransport({ producer, contextCapture }) },
        ...(options.nativeViewCapture ? { nativeViewCapture: {
            // The desktop reverse-IPC boundary is present in the daemon even on a
            // headless host. This test never invokes its unrelated PNG producer.
            captureCommand: async () => ({ ok: false as const, reasonCode: 'captureUnsupported' }),
        } } : {}),
        streamFrameEncoderFactory: createFfmpegBrowserRecordingStreamFrameEncoderFactory({ workingDirectory: directory,
            ...(options.realEncoder ? {} : {
            resolveFfmpegBinaryPath: async () => options.missingEncoder ? null : '/fixture/ffmpeg',
            spawnFfmpeg: (_binary: string, args: readonly string[]) => {
                const child = new EventEmitter();
                const chunks: Buffer[] = [];
                const stdin = new Writable({ highWaterMark: 16 * 1024,
                    // Stand in for compression, not raw MJPEG concatenation; retain
                    // only a frame signature while the real pipe applies pressure.
                    write: (chunk, _encoding, callback) => { chunks.push(Buffer.from(chunk.subarray(0, 4))); setImmediate(callback); },
                    final: callback => { void (async () => {
                        const bytes = options.encodedBytes === undefined
                            ? Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), ...chunks])
                            : Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(options.encodedBytes - 4, 1)]);
                        encoded.push(bytes);
                        await writeFile(args.at(-1)!, bytes);
                        callback();
                        child.emit('close', options.encoderFails ? 1 : 0, null);
                    })().catch(callback); },
                });
                queueMicrotask(() => child.emit('spawn'));
                return Object.assign(child, { stdin, kill: () => { child.emit('close', null, 'SIGKILL'); return true; } });
            },
            }),
        }),
        resolveStartContext: async input => {
            const context = resolveBrowserRecordingStartContext({ hasLiveStreamCaptureRegistry: false,
                hasNativeViewCapture: options.nativeViewCapture === true, hasCdpScreencast: true,
                hasFrameEncoder: await (options.encoderAvailable?.() ?? Promise.resolve(true)) })(input);
            return context;
        },
    });
    const runtimeActionExecute = createDaemonRuntimeActionExecutor({ env: { NODE_ENV: 'test' },
        resolveRouteOwners: () => ({ browserRecording: recording.routes }),
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
            browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, recording: { enabled: true } },
        } }) }),
    });
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine',
        stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'session' }),
        requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'fixture-control', runtimeActionExecute });
    vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({ pid: 123, httpPort: 12345,
        controlToken: 'fixture-control', startedAt: 1, startedWithCliVersion: '0.3.0' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const response = await app.inject({ method: 'POST', url: new URL(String(url)).pathname,
            headers: init?.headers as Record<string, string>, payload: String(init?.body) });
        return new Response(response.body, { status: response.statusCode });
    });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        runtimeActionExecute: createCliBrowserRuntimeActionExecutor({ sessionId: 'session' }),
    }));
    const execute = (id: ActionId, input: unknown) => executor.execute(id, input, {
        surface: 'agent', defaultSessionId: 'session', bypassApprovals: true,
    });
    return { execute, frame, commands, directory, encoded, setNow: (value: number) => { now = value; },
        dispose: async () => { recording.stop(); await producer.dispose(); await app.close(); await rm(directory, { recursive: true, force: true }); } };
}

const start = { browserSessionId: 'session', viewId: 'view', profileId: 'profile', targetKind: 'externalUrl',
    adapterKind: 'chromiumSidecar', renderEngineKind: 'streamedSurface', captureKind: 'cdpScreencast', fidelity: 'cdp',
    navigationGeneration: 0, mimeType: 'video/webm', retentionClass: 'preSend', recordingId: 'browser_recording_view_0_1000',
    mediaTarget: { sessionId: 'session', messageLocalId: 'recording' } } as const;

async function startRecording(runtime: Awaited<ReturnType<typeof setup>>) {
    const result = await runtime.execute('browser.recording.start', start);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({ ok: true, result: { status: 'started' } });
    return 'browser_recording_view_0_1000';
}

describe('managed recording Action → private daemon IPC → capture → Session media', () => {
    it('starts a no-cap managed recording using the profile published for its streamed UI view', async () => {
        const featureSource = new URL('../../../../../server/sources/app/features/browserFeature.ts', import.meta.url).href;
        const { resolveBrowserFeature } = await import(featureSource);
        const capabilities = FeaturesResponseSchema.parse(resolveBrowserFeature({})).capabilities.browser.recording;
        const profile = resolveBrowserRecordingCaptureProfile({
            recordingCapabilities: capabilities,
            adapterKind: 'streamedBrowserSurface',
            renderEngineKind: 'streamedSurface',
            captureSourceAvailable: true,
            retentionClass: 'preSend',
        });
        expect(profile).not.toBeNull();
        expect(capabilities).not.toHaveProperty('maxDurationMs');
        expect(capabilities).not.toHaveProperty('maxBytes');
        // Exercise production encoder readiness and its native-capture sibling.
        // A hard-coded `true` here hid the loaded daemon's missing ffmpeg binary:
        // the remaining PNG profile made WebM fail as adapter_unavailable.
        const runtime = await setup({ nativeViewCapture: true,
            encoderAvailable: async () => Boolean(await resolveFfmpegStaticBinaryPath()) });
        try {
            const started = await runtime.execute('browser.recording.start', {
                ...start,
                ...profile,
                targetKind: 'streamedBrowser',
                captureSource: { kind: 'machineLiveStream', streamFamily: 'browser.streamed', sourceId: 'fixture-view' },
            });
            expect(started, JSON.stringify(started)).toMatchObject({ ok: true, result: { status: 'started' } });
            runtime.frame();
            runtime.setNow(33_000);
            expect(await runtime.execute('browser.recording.stop', {
                recordingId: 'browser_recording_view_0_1000', navigationGenerationEnd: 0,
            })).toMatchObject({ ok: true, result: { status: 'finalized', recording: {
                durationMs: 32_000, outcomeReason: 'user_stopped', frameCount: 1,
            } } });
        } finally { await runtime.dispose(); }
    });

    it.each(['faster', 'sparser'] as const)('stores a real WebM on the capture clock when frames arrive %s than declared FPS', async cadence => {
        const binary = await resolveFfmpegStaticBinaryPath();
        if (!binary) throw new Error('A usable packaged ffmpeg is required for the container timing contract.');
        const { stdout: jpeg } = await runFfmpeg(binary, ['-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
        { encoding: 'buffer' });
        const runtime = await setup({ realEncoder: true });
        try {
            const recordingId = await startRecording(runtime);
            const times = cadence === 'faster' ? Array.from({ length: 49 }, (_, index) => index * 1_000 / 24) : [0, 700, 1_500];
            for (const time of times) {
                runtime.setNow(1_000 + time);
                runtime.frame(jpeg);
            }
            runtime.setNow(3_057);
            const stopped = recordingResult(await runtime.execute('browser.recording.stop', { recordingId, navigationGenerationEnd: 0 }));
            const path = join(runtime.directory, '.happier', 'uploads', 'artifacts', 'session', 'recording',
                `${stopped.mediaRef.mediaId.slice(0, 12)}-browser-recording-${recordingId}.webm`);
            const { stderr } = await runFfmpeg(binary, ['-hide_banner', '-i', path, '-f', 'null', '-']);
            const duration = /Duration: (\d+):(\d+):([\d.]+)/u.exec(stderr);
            if (!duration) throw new Error('Stored WebM did not expose a container duration.');
            const containerMs = (Number(duration[1]) * 3_600 + Number(duration[2]) * 60 + Number(duration[3])) * 1_000;
            expect(stopped.durationMs).toBe(2_057);
            expect(Math.abs(containerMs - stopped.durationMs)).toBeLessThanOrEqual(1_000 / 12);
        } finally { await runtime.dispose(); }
    });

    it('withdraws encoder readiness before capture and observes repair on the next admitted Start', async () => {
        let available = false;
        const runtime = await setup({ encoderAvailable: async () => available });
        try {
            expect(await runtime.execute('browser.recording.start', start)).toMatchObject({ ok: true, result: {
                status: 'unavailable', reason: { code: 'browser_recording_capability_unavailable' },
            } });
            expect(runtime.commands).toEqual([]);
            expect(await runtime.execute('browser.recording.listForView', { browserSessionId: 'session', viewId: 'view' })).toMatchObject({
                ok: true, result: [],
            });
            available = true;
            await startRecording(runtime);
            runtime.frame();
            expect(await runtime.execute('browser.recording.stop', {
                recordingId: 'browser_recording_view_0_1000', navigationGenerationEnd: 0,
            })).toMatchObject({ ok: true, result: { status: 'finalized' } });
        } finally { await runtime.dispose(); }
    });

    it.each([false, true])('stores an admitted large frame, including during startup=%s, and exposes terminal status/list', async startupFrame => {
        const runtime = await setup({ startupFrame });
        try {
            const recordingId = await startRecording(runtime);
            if (!startupFrame) runtime.frame();
            // A busy pipe is allowed to drain; incoming frames do not create another queue.
            runtime.frame();
            await new Promise<void>(resolve => setImmediate(resolve));
            // Fresh page changes reach the same encoder after the pipe drains.
            runtime.setNow(1_500);
            runtime.frame(Buffer.alloc(256 * 1024, 2));
            await new Promise<void>(resolve => setImmediate(resolve));
            runtime.setNow(2_000);
            const stopped = await runtime.execute('browser.recording.stop', { recordingId, navigationGenerationEnd: 0 });
            expect(stopped).toMatchObject({ ok: true, result: { status: 'finalized', recording: {
                frameCount: 2, mediaRef: { refKind: 'sessionMedia', mediaKind: 'video' },
            } } });
            const stored = recordingResult(stopped);
            expect(runtime.encoded[0]?.subarray(4)).toEqual(Buffer.concat([Buffer.alloc(24, 1), Buffer.alloc(24, 2)]));
            const mediaId = stored.mediaRef.mediaId;
            expect(await readFile(join(runtime.directory, '.happier', 'uploads', 'artifacts', 'session', 'recording',
                `${mediaId.slice(0, 12)}-browser-recording-${recordingId}.webm`))).toEqual(runtime.encoded[0]);
            expect(await runtime.execute('browser.recording.status', { recordingId })).toMatchObject({ ok: true, result: stored });
            expect(await runtime.execute('browser.recording.listForView', { browserSessionId: 'session', viewId: 'view' })).toMatchObject({ ok: true, result: [stored] });
            expect(await runtime.execute('browser.recording.stop', { recordingId, navigationGenerationEnd: 0 })).toEqual(stopped);
            expect(runtime.commands.filter(command => command === 'Page.startScreencast')).toHaveLength(1);
        } finally { await runtime.dispose(); }
    });

    it('records beyond the old duration and byte defaults when no caps are configured', async () => {
        const runtime = await setup({ encodedBytes: 16_000_001 });
        try {
            const recordingId = await startRecording(runtime);
            runtime.frame();
            await new Promise<void>(resolve => setImmediate(resolve));
            runtime.setNow(32_000);
            runtime.frame();
            runtime.setNow(33_000);
            const result = await runtime.execute('browser.recording.stop', { recordingId, navigationGenerationEnd: 0 });
            expect(result).toMatchObject({ ok: true, result: { status: 'finalized', recording: {
                durationMs: 32_000, byteSize: 16_000_001, frameCount: 2,
            } } });
            const stopped = recordingResult(result);
            expect(stopped).toMatchObject({ durationMs: 32_000, byteSize: 16_000_001, frameCount: 2 });
            expect(stopped.outcomeReason).toBe('user_stopped');
            expect(stopped).not.toHaveProperty('maxDurationMs');
            expect(stopped).not.toHaveProperty('maxBytes');
        } finally { await runtime.dispose(); }
    });

    it('keeps recording until a delayed Stop without a cap outcome', async () => {
        const runtime = await setup();
        try {
            const recordingId = await startRecording(runtime);
            runtime.frame();
            await new Promise<void>(resolve => setImmediate(resolve));
            runtime.setNow(168_000);
            runtime.frame();
            const stopped = await runtime.execute('browser.recording.stop', { recordingId, navigationGenerationEnd: 0 });
            expect(stopped).toMatchObject({ ok: true, result: { status: 'finalized', recording: {
                durationMs: 167_000, outcomeReason: 'user_stopped', frameCount: 2, mediaRef: { mediaKind: 'video' },
            } } });
        } finally { await runtime.dispose(); }
    });

    it('refuses start when the capture encoder cannot store a recording', async () => {
        const runtime = await setup({ missingEncoder: true });
        try {
            expect(await runtime.execute('browser.recording.start', start)).toMatchObject({ ok: true, result: {
                status: 'unavailable', reason: { code: 'browser_recording_capture_failed' },
            } });
            expect(runtime.commands).toEqual([]);
        } finally { await runtime.dispose(); }
    });

    it('exposes a capture failure through IPC and retains that terminal cause on retry, status and list', async () => {
        const runtime = await setup({ encoderFails: true });
        try {
            const recordingId = await startRecording(runtime);
            runtime.frame();
            runtime.setNow(2_000);
            const input = { recordingId, navigationGenerationEnd: 0 };
            const stopped = await runtime.execute('browser.recording.stop', input);
            expect(stopped).toMatchObject({ ok: true, result: { status: 'failed', reason: 'capture_failed' } });
            expect(await runtime.execute('browser.recording.stop', input)).toEqual(stopped);
            expect(await runtime.execute('browser.recording.status', { recordingId })).toMatchObject({ ok: true, result: {
                status: 'failed', outcomeReason: 'capture_failed',
            } });
            expect(await runtime.execute('browser.recording.listForView', { browserSessionId: 'session', viewId: 'view' })).toMatchObject({ ok: true, result: [{
                status: 'failed', outcomeReason: 'capture_failed',
            }] });
        } finally { await runtime.dispose(); }
    });
});

function recordingResult(result: ActionExecuteResult) {
    if (!result.ok) throw new Error('Expected successful recording Action');
    // The public Action schema is the strict consumer of the actual persisted result.
    const parsed = DaemonBrowserRecordingStopResultV1Schema.parse(result.result);
    if (parsed.status !== 'finalized' || !parsed.recording.mediaRef) throw new Error('Expected stored recording');
    return { ...parsed.recording, mediaRef: parsed.recording.mediaRef };
}
