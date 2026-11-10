import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createActionExecutor, createPlainSessionOwnerMetadataEnvelopeV1, FeaturesResponseSchema,
    type ActionId, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol';
import { BrowserCommandDispatchResultV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { requesterActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createDaemonSessionMutationCustody } from '@/daemon/connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDaemonRuntimeActionExecutor } from '@/daemon/runtimeActionExecutor';
import { createBrowserRoutePublication } from '../control/routePublication';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createProductBrowserSidecarControlAdapterFactory } from '../sidecar/productSource';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from '../sidecar/launchOwner';
import type { BrowserSidecarCdpEventSubscriber } from '../sidecar/controlAdapter';
import type { BrowserDaemonControlRoutes } from '../control/routes';
import type { BrowserRecordingDaemonRuntime } from './runtime';
import { createFfmpegBrowserRecordingStreamFrameEncoderFactory } from '../../recording/ffmpegStreamEncoder';

const environment = vi.hoisted(() => ({ home: '' }));
vi.mock('@/configuration', async importOriginal => {
    const actual = await importOriginal<typeof import('@/configuration')>();
    return { ...actual, configuration: new Proxy(actual.configuration, { get(target, key, receiver) {
        if (environment.home && key === 'happyHomeDir') return environment.home;
        if (environment.home && key === 'activeServerDir') return join(environment.home, 'server');
        if (environment.home && key === 'logsDir') return join(environment.home, 'logs');
        return Reflect.get(target, key, receiver);
    } }) };
});

it.each([
    { account: 'owner', surface: 'ui', explicitTarget: true },
    { account: 'grantee', surface: 'ui', explicitTarget: true },
    { account: 'owner', surface: 'agent', explicitTarget: false },
] as const)('finalizes $account Browser frames from $surface into that Account’s own Session', async ({ account, surface, explicitTarget }) => {
    const root = await mkdtemp(join(tmpdir(), 'recording-grantee-'));
    environment.home = root;
    const sessionId = `${account}-recording-session`;
    const token = `${account}-fixture`;
    const metadata = createTestMetadata({ path: root, machineId: 'machine' });
    const session = { ...createSessionNotificationContextFixture(sessionId), encryptionMode: 'plain',
        metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: metadata }) };
    const reads: string[] = [];
    const messages: { token: string; body: Record<string, unknown> }[] = [];
    const server = createServer(async (request, response) => {
        const bearer = request.headers.authorization ?? '';
        response.setHeader('Content-Type', 'application/json');
        if (request.url?.startsWith('/v2/sessions/')) {
            reads.push(bearer);
            if (bearer !== `Bearer ${token}` || !request.url.startsWith(`/v2/sessions/${sessionId}`)) {
                response.statusCode = 404; response.end(JSON.stringify({ error: 'Session not found' })); return;
            }
            if (request.method === 'POST') {
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
                messages.push({ token: bearer, body });
                response.end(JSON.stringify({ didWrite: true, message: { id: 'message', seq: 1,
                    localId: body.localId, content: body.content, createdAt: 1, updatedAt: 1 } }));
            } else response.end(JSON.stringify({ session }));
        } else if (request.url?.includes('encryption/currentness')) {
            response.end(JSON.stringify({ mode: 'plain', version: 1, updatedAt: 0,
                signingKeyFingerprint: null, contentKeyFingerprint: null }));
        } else response.end(JSON.stringify({ mode: 'plain', updatedAt: 0 }));
    });
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
    const serverBaseUrl = `http://127.0.0.1:${address.port}`;
    const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
    let frameCount = 0;
    const profiles = createBrowserProfileStore({ storageRootDirectory: root,
        partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    const readSessionAccountId = (id: string) => id === sessionId ? account : null;
    const factory = createProductBrowserSidecarControlAdapterFactory({ profileStore: profiles, readSessionAccountId,
        resolveManagedCandidate: async () => ({ source: 'managedBrowserPackage', executablePath: '/fixture/chrome',
            discoveryKind: 'managedRuntime', available: true, provenance: { origin: 'managed_package',
                pinnedVersion: '127.0.6533.88', channel: 'stable', integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } }),
        createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({ ...input,
            // Genuine OS/process and CDP boundaries; profile selection, namespacing and recording stay real.
            spawnProcess: () => {
                const child = new EventEmitter(); const stderr = new PassThrough();
                return Object.assign(child, { pid: 4242, stderr,
                    stdio: [null, null, stderr, new PassThrough(), new PassThrough()],
                    kill: () => { child.emit('exit', 0, 'SIGTERM'); return true; } });
            },
            connectTransport: async () => ({ transport: {
                openPage: async () => ({ targetId: 'target', sessionId: 'cdp' }),
                dispatchBrowserCommand: async () => ({ success: true }),
                subscribeCdpEvents: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
                dispatchPageCommand: async command => {
                    if (command.method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
                    if (command.method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'overlay' };
                    if (command.method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
                    if (command.method === 'Page.startScreencast') for (const listener of listeners) listener({
                        method: 'Page.screencastFrame', sessionId: 'cdp', params: { sessionId: 1,
                            data: Buffer.from('fixture-jpeg').toString('base64') } });
                    return {};
                },
            } }),
        }),
    });
    const encoder = createFfmpegBrowserRecordingStreamFrameEncoderFactory({ workingDirectory: root,
        resolveFfmpegBinaryPath: async () => '/fixture/ffmpeg', spawnFfmpeg: (_binary, args) => {
            const child = new EventEmitter();
            const stdin = new Writable({ write(_bytes, _encoding, done) { frameCount++; done(); },
                final(done) { void writeFile(args.at(-1)!, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]))
                    .then(() => { done(); child.emit('close', 0, null); }, done); } });
            queueMicrotask(() => child.emit('spawn'));
            return Object.assign(child, { stdin, kill: () => { child.emit('close', null, 'SIGKILL'); return true; } });
        } });
    let recording: BrowserRecordingDaemonRuntime | null = null;
    let control: BrowserDaemonControlRoutes | null = null;
    const ownerCustody = createDaemonSessionMutationCustody({ credentials: { token: 'owner-fixture', encryption: null } });
    const features = FeaturesResponseSchema.parse({ features: { browser: { enabled: true,
        viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true },
        recording: { enabled: true, attachments: { enabled: true } } } } });
    const publication = createBrowserRoutePublication({ params: {
        machineId: 'machine', credentials: { token: 'owner-fixture', encryption: null }, serverBaseUrl,
        currentMachineHost: metadata.host, currentMachineHomeDir: metadata.homeDir,
        processEnv: {}, getApiMachineForSessions: () => null, browserSidecarControlAdapterFactory: factory,
        browserRecordingStreamFrameEncoderFactory: encoder,
        readMachineMemory: () => ({ reported: true, totalBytes: 8 * 1024 ** 3, availableBytes: 8 * 1024 ** 3,
            usedBytes: 0, pressure: { level: 'calm', source: 'none' } }),
        daemonSessionMutationCustody: ownerCustody,
        onBrowserControlRoutesReady: value => { control = value; },
        onBrowserRecordingRuntimeReady: value => { recording = value; },
    }, readSessionAccountId, runtimeActionRouteProviderTarget: {}, setGuardBrowserResourceOwner: () => {},
        shutdownSignal: new AbortController().signal, resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }) });
    let retained = 0;
    // Admitted host-private ingress fixture, never caller-authored Action input or mocked domain logic.
    const authorization = { requesterAccountProjection: { [requesterActionContext]: {
        credentials: { token, encryption: null }, serverHttpBaseUrl: serverBaseUrl,
        savedSecretOperationContext: { machineAdmission: { actorAccountId: account, custodianAccountId: 'owner', role: 'use' } },
        retain: () => { retained++; return async () => { retained--; }; },
    } } } as unknown as ExternalActionExecutionAuthorizationV1;
    const dispatch = createDaemonRuntimeActionExecutor({ env: {}, resolveRouteOwners: () => ({
        browserControl: control, browserRecording: recording?.routes,
    }), resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }) });
    const executor = createActionExecutor({ runtimeActionExecute: args => dispatch({ ...args, context: {
        ...args.context, ...(account === 'grantee' ? { externalActionExecutionAuthorization: authorization } : {}),
    } }) });
    const invoke = (id: ActionId, input: unknown) => runWithServerHttpBaseUrl(serverBaseUrl, () => executor.execute(id, input, {
        authority: surface === 'agent' ? 'account_automation' : 'present_user', surface, defaultSessionId: sessionId, bypassApprovals: true,
    }));
    try {
        await publication.refreshBrowserRouteOwners();
        const opened = await invoke('browser.view.open', { kind: 'openView', commandId: 'open', browserSessionId: sessionId,
            viewId: 'view', platform: 'web', target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://example.test' } });
        expect(opened).toMatchObject({ ok: true, result: { status: 'dispatched' } });
        if (!opened.ok) throw new Error('Browser open refused');
        const openResult = BrowserCommandDispatchResultV1Schema.parse(opened.result);
        if (openResult.status !== 'dispatched') throw new Error('Browser open unavailable');
        const profileId = openResult.events.find(event => event.kind === 'sessionCreated')?.profileId;
        if (!profileId) throw new Error('Browser open did not publish its profile');
        const startRequest = { browserSessionId: sessionId, viewId: 'view',
            profileId, targetKind: 'externalUrl', adapterKind: 'chromiumSidecar', renderEngineKind: 'streamedSurface',
            captureKind: 'cdpScreencast', fidelity: 'cdp', navigationGeneration: 0, mimeType: 'video/webm', retentionClass: 'preSend',
            recordingId: 'recording', ...(explicitTarget ? { mediaTarget: { sessionId, messageLocalId: 'recording-message' } } : {}) };
        const started = await invoke('browser.recording.start', startRequest);
        expect(started).toMatchObject({ ok: true, result: { status: 'started' } });
        await new Promise<void>(ready => setImmediate(ready));
        expect(frameCount).toBeGreaterThan(0);
        const retainedWhileRecording = retained;
        const stopped = await invoke('browser.recording.stop', { recordingId: 'recording', navigationGenerationEnd: 0 });
        expect(stopped.ok, stopped.ok ? undefined : stopped.errorCode).toBe(true);
        expect(stopped).toMatchObject({ ok: true, result: { status: 'finalized', recording: {
            frameCount: expect.any(Number), byteSize: 5, mediaRef: { mediaKind: 'video' } } } });
        expect(reads.every(value => value === `Bearer ${token}`)).toBe(true);
        expect(messages).toHaveLength(1); expect(messages[0]?.token).toBe(`Bearer ${token}`);
        expect(messages[0]?.body.localId).toBe(explicitTarget ? 'recording-message' : 'recording');
        expect(messages[0]?.body.content).toMatchObject({ t: 'plain', v: { meta: {
            happier: { payload: { media: [{ mediaKind: 'video', sizeBytes: 5 }] } },
        } } });
        if (account === 'grantee') {
            expect(retainedWhileRecording).toBe(1);
            expect(retained).toBe(0);
        }
        const files = await import('node:fs/promises').then(fs => fs.readdir(root, { recursive: true }));
        const video = files.find(file => String(file).endsWith('.webm'));
        expect(video).toBeDefined();
        expect((await readFile(resolve(root, String(video)))).length).toBe(5);
        if (account === 'grantee') {
            expect(await invoke('browser.recording.start', { ...startRequest, recordingId: 'retired' }))
                .toMatchObject({ ok: true, result: { status: 'started' } });
            expect(retained).toBe(1);
            await publication.stopRecording();
            expect(retained).toBe(0);
        }
    } finally {
        await publication.dispose();
        await ownerCustody.close();
        await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
        await rm(root, { recursive: true, force: true });
    }
});
