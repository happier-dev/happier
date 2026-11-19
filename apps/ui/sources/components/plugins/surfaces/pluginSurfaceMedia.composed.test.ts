import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createPluginUiHostApiClient } from '@happier-dev/plugin-sdk/ui/client';
import { createActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';

import { normalizeActionsSettingsV1} from '@happier-dev/protocol/actions/actionSettings';
import {
    type ApprovalRequest} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { type SessionImageMediaReferenceV1 } from '@happier-dev/protocol/sessions/media/imageReferenceV1';
import { PluginHostedWebBridgeEnvelopeV1Schema, PluginUiJsonValueV1Schema,
    type PluginUiSurfaceContextV1 } from '@happier-dev/protocol/plugins/ui';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import * as persistence from '../../../../../cli/src/persistence';
import * as sessionsHttp from '../../../../../cli/src/session/transport/http/sessionsHttp';
import * as accountEncryption from '../../../../../cli/src/api/client/connectedServiceCredentialApi';
import { buildSessionMetadataEnvelopeFields } from '../../../../../cli/src/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { seedCurrentLocalPathPluginFixture } from '../../../../../cli/src/plugins/store/registry/currentState.testkit';
import { loadInstalledPlugins } from '../../../../../cli/src/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '../../../../../cli/src/plugins/projection/registry/resolvePluginContributions';
import { createResolvedContributionRegistry } from '../../../../../cli/src/plugins/projection/registry/createResolvedContributionRegistry';
import { registerDaemonContributionRegistryProjectionHandler } from '../../../../../cli/src/rpc/handlers/daemonContributionRegistryProjection';
import type { RpcHandler } from '../../../../../cli/src/api/rpc/types';
import { createMachineLiveStreamCaptureRegistry } from '../../../../../cli/src/daemon/peer/mediation/stream/captureRegistry';
import { unavailableMachineLiveStreamCaptureAdapter } from '../../../../../cli/src/daemon/peer/mediation/stream/captureAdapter';
import { resolveExecutablePluginRuntimeRegistry } from '../../../../../cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginSurfaceActionHostApi } from './pluginSurfaceActionDispatch';
import { createPluginSurfaceLiveStreamOwner } from './pluginSurfaceLiveStream';
import { createPluginSurfaceStoredImageOwner } from './pluginSurfaceStoredImage';
import { createPluginHostedWebHostApiBridgeHandler } from '../hostApi/hostedWebAdapter';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';

// Only the authenticated Machine transport and OS presentation are substituted.
// RPC registration, installed-plugin admission, HostAccess, media verification,
// Action policy, mounted owners, hosted bridge and public SDK client stay real.
const network = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: network.rpc,
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const { createBundledPluginPublicationFsFixture } = await import('../../../../../cli/src/plugins/projection/registry/builtIn/locators.testkit');
    return createBundledPluginPublicationFsFixture(actual);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); network.rpc.mockReset(); });

it('uses the public UI client of installed external plugins for per-view consent and declared Session image reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-fx21-media-'));
    const happyHomeDir = join(root, 'home');
    const ids = ['acme.media-reader', 'acme.media-no-sessions'] as const;
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
    const imagePath = '.happier/uploads/artifacts/session-media/capture/screen.png';
    const cwd = join(root, 'workspace');
    await mkdir(dirname(join(cwd, imagePath)), { recursive: true });
    await writeFile(join(cwd, imagePath), bytes);
    const image: SessionImageMediaReferenceV1 = { mediaId: 'session-image', mediaKind: 'image', width: 1, height: 1,
        sizeBytes: bytes.byteLength, file: { sessionId: 'session-media', storage: 'session', path: imagePath,
            sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: 'image/png' } };
    let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
    try {
        const credentials = { token: 'fixture-media-account', encryption: null };
        vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
        for (const pluginId of ids) {
            const pluginRoot = join(root, pluginId);
            await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
            await writeFile(join(pluginRoot, '.happier-plugin/plugin.json'), JSON.stringify({
                schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'External media viewer',
                engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
                activation: { events: [{ kind: 'startup' }] },
                hostAccess: { required: pluginId === ids[0] ? [{ id: 'session-images', capability: 'sessions',
                    reason: 'Read Session images', scope: { access: ['read'] } }] : [], optional: [] },
                contributes: { resources: [{ id: 'ready', source: 'dynamic', kind: 'config', contentType: 'text/plain' }] },
            }));
            await writeFile(join(pluginRoot, 'daemon.mjs'),
                "export function activate(api) { api.resources.registerDynamicResource('ready', { read: async () => 'ready', observe: () => ({ dispose() {} }) }); }");
            await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: '1.0.0' });
        }
        const installed = await loadInstalledPlugins({ happyHomeDir });
        expect(installed.loadedPlugins.map(plugin => plugin.pluginId)).toEqual(expect.arrayContaining(ids));
        runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir,
            contributes: createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult: installed,
                provenance: 'external', existingAgentIds: new Set() })) });
        const handlers = new Map<string, RpcHandler>();
        const capture = createMachineLiveStreamCaptureRegistry();
        capture.register({ sourceId: 'host-screen', streamFamily: 'screen', adapter: unavailableMachineLiveStreamCaptureAdapter,
            capabilities: { v: 1, sourceId: 'host-screen', sourceKind: 'screen', supportedCodecs: ['image.mjpeg'],
                inputMode: 'none', sidebands: [], health: { status: 'available' } } });
        registerDaemonContributionRegistryProjectionHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
            resolveRuntimeRegistry: async () => runtime!, resolveCaptureRegistry: () => capture,
            resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'media-home', machineId: 'media-machine' }),
        });
        network.rpc.mockImplementation(async (request: { method: string; payload: unknown }) => {
            const handler = handlers.get(request.method);
            if (!handler) throw new Error(`Unregistered media RPC: ${request.method}`);
            return await handler(request.payload);
        });
        vi.spyOn(accountEncryption, 'fetchAccountEncryptionCurrentness').mockResolvedValue({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
        const metadata = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
            metadata: { path: cwd, machineId: 'media-machine' }, agentState: null });
        vi.spyOn(sessionsHttp, 'fetchSessionById').mockResolvedValue(V2SessionRecordSchema.parse({
            id: image.file.sessionId, seq: 0, createdAt: 0, updatedAt: 0, active: false, activeAt: 0, metadataVersion: 1, dataEncryptionKey: null,
            metadata: metadata.sharedMetadata.ciphertext, metadataLayoutVersion: metadata.metadataLayoutVersion,
            ownerMetadata: metadata.ownerMetadata, agentState: metadata.agentState, agentStateVersion: 0, encryptionMode: 'plain', share: null }));

        for (const pluginId of ids) {
            const occurrenceId = runtime.readPluginOccurrenceId?.(pluginId);
            if (!occurrenceId) throw new Error('Installed external plugin has no current occurrence');
            const sourceCustody = runtime.readPluginSourceCustody?.(pluginId);
            if (!sourceCustody || sourceCustody.kind !== 'managed') throw new Error('Expected installed managed plugin custody');
            expect(await runtime.readUiResource?.({ callerPluginId: pluginId, expectedCallerOccurrenceId: occurrenceId,
                resourceId: 'ready' })).toMatchObject({ bytes: new Uint8Array(Buffer.from('ready')) });
            const surface: PluginUiSurfaceContextV1 = { pluginId, contributionId: 'viewer', surfaceId: `${pluginId}-surface`,
                placement: 'appSurface', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] };
            const requests: ApprovalRequest[] = [];
            let decision: 'approve' | 'reject' = 'reject';
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({
                approvalsCreate: async input => { requests.push(input.request); return { artifactId: `view-${requests.length}` }; },
                approvalsUpdate: async () => ({ ok: true }),
                approvalsWaitForDecision: async ({ request }) => ({ decision, request }),
                isApprovalExecutionOriginCurrent: async () => true,
                readActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }),
            }));
            const lifetime = new AbortController();
            const admissions: unknown[] = [];
            const actionHost = createPluginSurfaceActionHostApi({ surfaceContext: surface, callerSourceCustody: sourceCustody,
                callerBinding: { pluginId, contributionLocalId: 'viewer', occurrenceId,
                    materializationRef: { pluginId, machineId: 'media-machine', materializationId: 'media-materialization' } },
                // Match the admitted Machine context stamped by boundPluginSurfaceController.
                hostAction: { execute: executor.execute, context: { serverId: 'media-home', runtimeAccountId: 'media-account',
                    executionRunTargetMachineId: 'media-machine' } },
            });
            const viewing = createPluginSurfaceLiveStreamOwner({ pluginId, occurrenceId, machineId: 'media-machine', serverId: 'media-home',
                lifetimeSignal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted, executeAction: async (request, options) => {
                    const admission = await actionHost.handleRequest(request, options);
                    admissions.push(admission);
                    return admission;
                } });
            const stored = createPluginSurfaceStoredImageOwner({ pluginId, occurrenceId, machineId: 'media-machine', serverId: 'media-home',
                lifetimeSignal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted });
            const hostApi = createPluginSurfaceActionHostApi({ surfaceContext: surface, callerSourceCustody: sourceCustody,
                callerBinding: { pluginId, contributionLocalId: 'viewer', occurrenceId,
                    materializationRef: { pluginId, machineId: 'media-machine', materializationId: 'media-materialization' } },
                hostAction: { execute: executor.execute }, mountedHostApiHandlers: { watchLiveStream: viewing.watchLiveStream,
                    readStoredImage: stored.readStoredImage, disposeHostResource: request => { viewing.disposeHostResource(request); return {}; } },
            });
            const identity = { instanceId: `${pluginId}-instance`, mountNonce: 'media-nonce' };
            const origin = 'https://media-host.test';
            const listeners = new Set<(event: unknown) => void>();
            let bridge: ReturnType<typeof createPluginHostedWebHostApiBridgeHandler>;
            const parent = { postMessage: (message: unknown) => {
                const envelope = PluginHostedWebBridgeEnvelopeV1Schema.parse(message);
                void Promise.resolve(bridge(envelope)).then(deliver);
            } };
            const deliver = (data: unknown) => queueMicrotask(() => {
                for (const listener of listeners) listener({ data, origin, source: parent });
            });
            const href = new URL('https://media-frame.test/viewer');
            href.searchParams.set('happierInstanceId', identity.instanceId);
            href.searchParams.set('happierBridgeNonce', 'media-nonce');
            href.searchParams.set('happierHostOrigin', origin);
            bridge = createPluginHostedWebHostApiBridgeHandler({ surface, identity, requestIdPrefix: pluginId,
                handleRequest: hostApi.handleRequest, canonicalHostApi: { identity, authorPlugin: { id: pluginId, version: '1.0.0' },
                    surface: PluginUiJsonValueV1Schema.parse(createPluginSurfaceContextFixture({
                        mount: { kind: 'destination', destination: { pluginId, localId: 'viewer' }, container: 'appPage' },
                        target: { kind: 'app' }, accountEncryptionMode: 'plain',
                        targetedContributions: { target: { pluginId, occurrenceId, sourceCustody }, points: [] },
                    })), methods: ['context', 'watchLiveStream', 'readStoredImage', 'disposeHostResource'] },
                postToFrame: deliver, bootstrap: { frameOrigin: href.origin },
            });
            vi.stubGlobal('window', { parent, location: { href: href.toString() },
                addEventListener: (_type: string, listener: (event: unknown) => void) => { listeners.add(listener); },
                removeEventListener: (_type: string, listener: (event: unknown) => void) => { listeners.delete(listener); } });
            let phase = 'public client bootstrap';
            try {
                const client = await createPluginUiHostApiClient();
                const reference = { kind: 'host' as const, sourceId: 'host-screen' };
                phase = 'rejected host viewing';
                await expect(client.watchLiveStream(reference, () => {})).rejects.toMatchObject({ code: 'unavailable' });
                decision = 'approve';
                phase = 'first approved host viewing';
                const first = await client.watchLiveStream(reference, () => {});
                phase = 'second approved host viewing';
                const second = await client.watchLiveStream(reference, () => {});
                expect(requests).toHaveLength(3);
                expect(requests.every(request => request.actionId === 'capture.view')).toBe(true);
                first.dispose(); second.dispose();
                phase = `stored Session image access (${image.file.storage})`;
                if (pluginId === ids[0]) {
                    const storedImage = await client.readStoredImage(image);
                    expect(storedImage).toEqual({ bytesBase64: bytes.toString('base64'),
                        mimeType: 'image/png', width: 1, height: 1 });
                    await expect(client.readStoredImage({ ...image, file: { ...image.file, sha256: '0'.repeat(64) } }))
                        .rejects.toMatchObject({ code: 'unavailable' });
                } else {
                    await expect(client.readStoredImage(image)).rejects.toMatchObject({ code: 'unavailable' });
                    await expect(runtime.readUiStoredImage?.({ callerPluginId: pluginId, expectedCallerOccurrenceId: occurrenceId, media: image }))
                        .rejects.toMatchObject({ code: 'plugin_session_scope_unavailable' });
                }
                lifetime.abort();
                await expect(client.readStoredImage(image)).rejects.toMatchObject({ code: 'stale_surface' });
            } catch (error) {
                const diagnostics = error && typeof error === 'object' && 'diagnostics' in error ? error.diagnostics : [];
                let ownerDiagnosis: string | undefined;
                if (phase.startsWith('stored Session image access')) {
                    try {
                        await runtime.readUiStoredImage?.({ callerPluginId: pluginId, expectedCallerOccurrenceId: occurrenceId, media: image });
                        ownerDiagnosis = 'canonical owner read succeeded';
                    } catch (ownerError) {
                        ownerDiagnosis = ownerError instanceof Error ? ownerError.message : 'canonical owner read failed';
                    }
                }
                throw new Error(`${phase} for ${pluginId}: ${JSON.stringify({ diagnostics,
                    approvalRequests: requests.length, admission: admissions.at(-1), ownerDiagnosis })}`, { cause: error });
            } finally {
                bridge.dispose(); viewing.dispose(); stored.dispose(); hostApi.dispose?.(); actionHost.dispose?.();
                await new Promise<void>(resolve => queueMicrotask(resolve));
            }
        }
    } finally { await runtime?.dispose(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
