import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import { resolveBrowserRecordingCaptureProfile } from '@happier-dev/protocol/browser/recording/captureProfiles';

// Only environment is substituted; installed managed Chromium, CDP, overlay and capture stay real.
const environment = vi.hoisted(() => ({ directory: '' }));
vi.mock('@/configuration', async importOriginal => {
    const actual = await importOriginal<typeof import('@/configuration')>();
    return { ...actual, configuration: new Proxy(actual.configuration, { get(target, key, receiver) {
        if (key === 'happyHomeDir') return environment.directory;
        if (key === 'logsDir') return join(environment.directory, 'logs');
        return Reflect.get(target, key, receiver);
    } }) };

});

import { createProductBrowserSidecarControlAdapterFactory } from './productSource';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { resolveManagedBrowserSidecarCandidate } from './source';
import { createBrowserCdpScreencastProducer } from '../capture/cdpScreencast';
import { createBrowserRecordingCdpScreencastTransport } from '../recording/adapters/cdpScreencastTransport';
import type { BrowserRecordingCdpScreencastSession } from '../recording/adapters/cdpScreencast';
import type { BrowserRecordingDaemonRuntime } from '../recording/runtime';
import { resolveBrowserRecordingStartContext } from '../recording/startContext';
import { resolveFfmpegStaticBinaryPath } from '../../runtime/ffmpegStatic';
import { createBrowserRoutePublication } from '../control/routePublication';
import { FeaturesResponseSchema, MachineLiveStreamStartRequestV1Schema, createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { createMachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';
import type { MachineLiveStreamCaptureSession } from '../../peer/mediation/stream/captureAdapter';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { TrackedSession } from '@/daemon/types';
import type { DaemonSessionMutationCustody } from '@/daemon/connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { SessionMediaMessageMetaV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMediaV1';

describe.skipIf(!process.env.HAPPIER_TEST_BROWSER_RUNTIME_HOME)('managed browser recording capture', () => {
    it('keeps the recorded page rendering behind a popup without stealing its foreground', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-browser-recording-'));
        environment.directory = process.env.HAPPIER_TEST_BROWSER_RUNTIME_HOME ?? root;
        const server = createServer((_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><div id="motion" style="position:absolute;background:red;width:30px;height:30px"></div><script>globalThis.ticks=0;function draw(){motion.style.left=(++ticks%300)+"px";requestAnimationFrame(draw)}draw()</script>');
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Recording fixture did not bind');
        const profiles = createBrowserProfileStore({ storageRootDirectory: root,
            partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
        let runtime: Awaited<ReturnType<ReturnType<typeof createProductBrowserSidecarControlAdapterFactory>>> | undefined;
        let producer: ReturnType<typeof createBrowserCdpScreencastProducer> | undefined;
        let recordingSession: BrowserRecordingCdpScreencastSession | null = null;
        let unsubscribe: (() => void) | undefined;
        try {
            expect((await resolveManagedBrowserSidecarCandidate())?.available, 'A preinstalled pinned managed browser is required').toBe(true);
            runtime = await createProductBrowserSidecarControlAdapterFactory({ profileStore: profiles })(
                { machineId: 'recording_machine' });
            if (!runtime.ok || !runtime.contextCapture) throw new Error('Managed browser runtime unavailable');
            const capture = runtime.contextCapture;
            const view = { browserSessionId: 'recording-session', viewId: 'recording-view' };
            expect(await runtime.adapter.dispatchCommand({ kind: 'openView', commandId: 'recording-open', focus: true, ...view,
                platform: 'web', target: { kind: 'externalUrl', targetId: 'fixture', url: `http://127.0.0.1:${address.port}/` },
            })).toMatchObject({ status: 'dispatched' });
            const handle = capture.resolvePageHandle(view);
            if (!handle) throw new Error('Recording view is not bound');
            const evaluate = (expression: string) => capture.transport.dispatchPageCommand({ ...handle, method: 'Runtime.evaluate',
                params: { expression, returnByValue: true, awaitPromise: true, userGesture: true } });
            let frames = 0;
            let rawFrames = 0;
            const visibilityEvents: unknown[] = [];
            unsubscribe = capture.subscribeCdpEvents?.(event => {
                if (event.sessionId !== handle.sessionId) return;
                if (event.method === 'Page.screencastFrame') rawFrames += 1;
                if (event.method === 'Page.screencastVisibilityChanged') visibilityEvents.push(event.params);
            });
            producer = createBrowserCdpScreencastProducer({ contextCapture: capture });
            const transport = createBrowserRecordingCdpScreencastTransport({ contextCapture: capture, producer });
            const recording = { v: 1, ...view, recordingId: 'recording-probe', profileId: 'recording-profile',
                targetKind: 'externalUrl', adapterKind: 'chromiumSidecar', renderEngineKind: 'unavailable', captureKind: 'cdpScreencast',
                fidelity: 'cdp', startedAtMs: Date.now(), status: 'recording', navigationGenerationStart: 0, durationMs: 0,
                byteSize: 0, frameCount: 0, fps: 12, mimeType: 'video/webm', retentionClass: 'preSend', redactionLevel: 'metadataOnly',
                policyState: 'allowed', actionChapters: [], relatedReferences: [],
            } satisfies BrowserRecordingSessionV1;
            recordingSession = await transport.start({ recording, onFrame: () => { frames += 1; } });
            expect(recordingSession).not.toBeNull();
            const measure = async (stage: string) => {
                const before = frames;
                const rawBefore = rawFrames;
                const state = await evaluate('new Promise(resolve=>{const before=ticks;setTimeout(()=>resolve({visibility:document.visibilityState,focused:document.hasFocus(),ticks:ticks-before}),1500)})');
                const sample = { stage, frames: frames - before, rawFrames: rawFrames - rawBefore, visibilityEvents: [...visibilityEvents], state };
                console.info('QA-R90 recording sample', JSON.stringify(sample));
                return sample;
            };
            const foreground = await measure('before-popup');
            await evaluate('void window.open("about:blank","recording-popup")');
            const background = await measure('popup-opened-during-recording');
            const views = runtime.adapter.listViews?.(view.browserSessionId);
            expect(views).toHaveLength(2);
            const popup = views?.find(candidate => candidate.viewId !== view.viewId);
            const popupHandle = popup && capture.resolvePageHandle(popup);
            if (!popupHandle) throw new Error('Popup was not adopted');
            expect(await capture.transport.dispatchPageCommand({ ...popupHandle, method: 'Runtime.evaluate',
                params: { expression: 'document.hasFocus()', returnByValue: true } }))
                .toMatchObject({ result: { value: true } });
            await recordingSession?.stop();
            const stopped = await measure('after-recording-stop');
            recordingSession = await transport.start({ recording, onFrame: () => { frames += 1; } });
            expect(recordingSession).not.toBeNull();
            const restarted = await measure('recording-started-after-popup');
            expect(await capture.transport.dispatchPageCommand({ ...popupHandle, method: 'Runtime.evaluate',
                params: { expression: 'document.hasFocus()', returnByValue: true } }))
                .toMatchObject({ result: { value: true } });
            expect(foreground.frames).toBeGreaterThan(1);
            expect(foreground.state).toMatchObject({ result: { value: { visibility: 'visible', focused: true } } });
            expect(stopped.state).toMatchObject({ result: { value: { visibility: 'hidden', focused: false, ticks: 0 } } });
            for (const sample of [foreground, background, restarted]) {
                expect(sample.frames).toBe(sample.rawFrames);
                expect(sample.frames).toBeGreaterThan(1);
            }
            await recordingSession?.stop();
            recordingSession = null;
        } finally {
            unsubscribe?.();
            try { await recordingSession?.stop(); await producer?.dispose(); }
            finally {
                try { if (runtime?.ok) await runtime.dispose?.(); }
                finally {
                    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
                    await rm(root, { recursive: true, force: true });
                }
            }
        }
    });

    it('stores decodable recording media for an untracked human Session beside its live viewer', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-human-recording-'));
        environment.directory = process.env.HAPPIER_TEST_BROWSER_RUNTIME_HOME ?? root;
        const view = { browserSessionId: 'human-session-no-agent', viewId: 'human-view' };
        const metadata = createTestMetadata({ path: root, machineId: 'recording_machine' });
        const session = { ...createSessionNotificationContextFixture(view.browserSessionId),
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: metadata }) };
        const server = createServer((request, response) => {
            if (request.url?.startsWith('/v2/sessions/')) {
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({ session }));
            } else if (request.url === '/v1/account/encryption') {
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify(AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 0 })));
            } else {
                response.setHeader('Content-Type', 'text/html');
                response.end('<!doctype html><div id="motion" style="position:absolute;background:red;width:30px;height:30px"></div><script>globalThis.ticks=0;function draw(){motion.style.left=(++ticks%300)+"px";requestAnimationFrame(draw)}draw()</script>');
            }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
        const serverBaseUrl = `http://127.0.0.1:${address.port}`;
        const profiles = createBrowserProfileStore({ storageRootDirectory: root,
            partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
        const registry = createMachineLiveStreamCaptureRegistry();
        const factory = createProductBrowserSidecarControlAdapterFactory({ profileStore: profiles });
        const owners: { sidecar?: Awaited<ReturnType<typeof factory>>; recordingRuntime?: BrowserRecordingDaemonRuntime | null } = {};
        let viewer: MachineLiveStreamCaptureSession | undefined;
        const attachments: Parameters<DaemonSessionMutationCustody['stageTranscriptMessage']>[0][] = [];
        const tracked = new Map<number, TrackedSession>();
        const params = { machineId: 'recording_machine', serverBaseUrl, credentials: { token: 'recording-fixture', encryption: null },
            currentMachineHost: metadata.host, currentMachineHomeDir: metadata.homeDir,
            pidToTrackedSession: tracked, getApiMachineForSessions: () => null, processEnv: {}, liveStreamCaptureRegistry: registry,
            daemonSessionMutationCustody: { stageTranscriptEvent: async () => { throw new Error('Unexpected transcript event'); },
                stageTranscriptMessage: async (input: Parameters<DaemonSessionMutationCustody['stageTranscriptMessage']>[0]) => {
                    attachments.push(input); return { persisted: true, delivered: true } as const;
                } },
            browserSidecarControlAdapterFactory: async (input: Parameters<typeof factory>[0]) => { owners.sidecar = await factory(input); return owners.sidecar; },
            onBrowserRecordingRuntimeReady: (runtime: BrowserRecordingDaemonRuntime | null) => { owners.recordingRuntime = runtime; },
        };
        const publication = createBrowserRoutePublication({ params, runtimeActionRouteProviderTarget: {},
            setGuardBrowserResourceOwner: () => {},
            shutdownSignal: new AbortController().signal,
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
                browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true },
                    context: { enabled: true }, diagnostics: { enabled: true }, automation: { enabled: true },
                    recording: { enabled: true, attachments: { enabled: true } } },
                attachments: { uploads: { enabled: true } },
            } }) }),
        });
        try {
            await publication.refreshBrowserRouteOwners();
            const { sidecar, recordingRuntime } = owners;
            if (!sidecar?.ok || !sidecar.contextCapture || !recordingRuntime) throw new Error('Recording owners unavailable');
            const owner = recordingRuntime;
            const capture = sidecar.contextCapture;
            expect(tracked.size).toBe(0);
            expect(await sidecar.adapter.dispatchCommand({ kind: 'openView', commandId: 'human-open', focus: true, ...view,
                platform: 'web', target: { kind: 'externalUrl', targetId: 'fixture', url: serverBaseUrl } })).toMatchObject({ status: 'dispatched' });
            const sourceId = browserViewKey(view);
            const source = registry.resolve({ sourceId, streamFamily: 'browser.streamed' });
            if (!source.ok) throw new Error('Actual viewer source unavailable');
            let images = 0;
            let firstViewerFrame: Buffer | undefined;
            let nextSequence = 0;
            const acknowledge = () => viewer?.applyControl?.({ v: 1, kind: 'ack', streamId: 'human-viewer', nextSequence });
            const live = await source.source.adapter.start({ streamId: 'human-viewer', callerAuthority: 'present_user',
                streamFamily: 'browser.streamed', sourceMachineId: 'recording_machine', targetMachineId: 'human_client', caps: {},
                startRequest: MachineLiveStreamStartRequestV1Schema.parse({ v: 1, streamId: 'human-viewer', sourceId,
                    streamFamily: 'browser.streamed', sourceMachineId: 'recording_machine', targetMachineId: 'human_client', routeKind: 'loopback_direct' }),
                startedAtMs: Date.now(), expiresAtMs: Infinity, nowMs: Date.now,
                applyControl: () => ({ ok: true }), emitReceipt: () => {},
                offerFrame: frame => { if (frame.payloadKind !== 'metadata') {
                    images += 1; firstViewerFrame ??= Buffer.from(frame.payloadBase64, 'base64');
                } nextSequence = frame.sequence + 1;
                    queueMicrotask(acknowledge); return { ok: true }; },
            });
            if (!live.ok) throw new Error(`Viewer failed: ${live.reasonCode}`);
            viewer = live.session;
            acknowledge();
            const handle = capture.resolvePageHandle(view);
            if (!handle) throw new Error('Human view not bound');
            const evaluate = (expression: string) => capture.transport.dispatchPageCommand({ ...handle, method: 'Runtime.evaluate',
                params: { expression, returnByValue: true, awaitPromise: true, userGesture: true } });
            await evaluate('new Promise(resolve=>setTimeout(resolve,500))');
            expect(images).toBeGreaterThan(1);
            const imagesBeforeRecording = images;
            const context = resolveBrowserRecordingStartContext({ hasLiveStreamCaptureRegistry: true, hasNativeViewCapture: false,
                hasCdpScreencast: true, hasFrameEncoder: true })({ ...view, profileId: 'human-profile', targetKind: 'externalUrl',
                    adapterKind: 'streamedBrowserSurface', renderEngineKind: 'streamedSurface', captureKind: 'cdpScreencast', fidelity: 'cdp',
                    navigationGeneration: 0, mimeType: 'video/webm', retentionClass: 'preSend' });
            const profile = resolveBrowserRecordingCaptureProfile({ recordingCapabilities: context.recordingCapabilities,
                adapterKind: 'streamedBrowserSurface', renderEngineKind: 'streamedSurface', captureSourceAvailable: true, retentionClass: 'preSend' });
            if (!profile) throw new Error('Recording profile unavailable');
            const started = await owner.routes.startRecording({ ...view, ...profile, profileId: 'human-profile', targetKind: 'externalUrl',
                renderEngineKind: 'streamedSurface', navigationGeneration: 0, recordingId: 'human-recording',
                captureSource: { kind: 'machineLiveStream', streamFamily: 'browser.streamed', sourceId,
                    sourceMachineId: 'recording_machine', targetMachineId: 'human_client' },
                mediaTarget: { sessionId: view.browserSessionId, messageLocalId: 'human-recording-message' } });
            console.info('QA-R90 human recording start', JSON.stringify(started));
            expect(started.status).toBe('started');
            await evaluate('void window.open("about:blank","human-popup")');
            await evaluate('new Promise(resolve=>setTimeout(resolve,1500))');
            expect(images).toBeGreaterThan(imagesBeforeRecording);
            const completed = await owner.routes.stopRecording({ recordingId: 'human-recording', navigationGenerationEnd: 0 });
            console.info('QA-R90 human recording terminal', JSON.stringify({ completed, viewerImages: images, trackedAgents: tracked.size }));
            expect(completed.status).toBe('finalized');
            if (completed.status !== 'finalized') throw new Error('Human recording did not produce media');
            expect(completed.recording.frameCount).toBeGreaterThan(1);
            expect(completed.recording.byteSize).toBeGreaterThan(0);
            expect(attachments).toHaveLength(1);
            const attached = attachments[0]?.payload.meta;
            if (!attached || typeof attached !== 'object' || !('happier' in attached)) throw new Error('Media transcript attachment unavailable');
            const media = SessionMediaMessageMetaV1Schema.parse(attached.happier).payload.media[0];
            expect(media.id).toBe(completed.recording.mediaRef?.mediaId);
            const storagePath = resolve(root, media.path);
            expect(storagePath.startsWith(root)).toBe(true);
            const bytes = await readFile(storagePath);
            expect(bytes.length).toBe(completed.recording.byteSize);
            const ffmpeg = await resolveFfmpegStaticBinaryPath();
            if (!ffmpeg) throw new Error('Installed encoder unavailable');
            if (!firstViewerFrame) throw new Error('Viewer image unavailable');
            await new Promise<void>((resolve, reject) => {
                const decoder = execFile(ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'null', '-'], error => error ? reject(error) : resolve());
                decoder.stdin?.end(firstViewerFrame);
            });
            const decoded = await promisify(execFile)(ffmpeg, ['-v', 'error', '-i', storagePath, '-progress', 'pipe:1', '-f', 'null', '-']);
            console.info('QA-R90 human stored media', JSON.stringify({ bytes: bytes.length, progress: decoded.stdout }));
            expect(decoded.stdout).toMatch(/progress=end/);
            expect(await sidecar.adapter.dispatchCommand({ kind: 'focusView', commandId: 'human-focus', ...view }))
                .toMatchObject({ status: 'dispatched' });
            const before = images;
            await evaluate('new Promise(resolve=>setTimeout(resolve,500))');
            expect(images).toBeGreaterThan(before);
            console.info('QA-R90 viewer continuity', JSON.stringify({ beforeRecording: imagesBeforeRecording,
                afterRecording: before, afterStopAndFocus: images, decodedImageBytes: firstViewerFrame.length }));
        } finally {
            try { await owners.recordingRuntime?.routes.cancelRecording({ recordingId: 'human-recording', reason: 'user_canceled' }); }
            finally {
                try { await viewer?.stop(); await publication.dispose(); }
                finally {
                    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
                    await rm(root, { recursive: true, force: true });
                }
            }
        }
    });
});
