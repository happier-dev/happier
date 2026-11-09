import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createWorkspaceFileDownloadHarness } from '@/dev/testkit/harness/workspaceFileDownloadHarness';
import type { PluginUiSurfaceContextV1 } from '@happier-dev/protocol/plugins/ui';
import { createPluginSurfaceActionHostApi, type PluginSurfaceContributedActionTransport } from './pluginSurfaceActionDispatch';
import { createPluginSurfaceDownloadOwner } from './pluginSurfaceDownload';
import { Modal } from '@/modal';

const fs = vi.hoisted(async () => (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock());
const platform = vi.hoisted(() => ({ saveFile: vi.fn() }));
vi.mock('expo-file-system', async () => (await fs).module);
vi.mock('expo-modules-core', async importOriginal => ({ ...await importOriginal<typeof import('expo-modules-core')>(),
    requireOptionalNativeModule: (name: string) => name === 'HappierFileActions' ? platform : null }));

const inputSchema = { type: 'object', properties: { artifactId: { type: 'string' }, destination: { type: 'object',
    properties: { destinationId: { type: 'string' } }, required: ['destinationId'], additionalProperties: false } },
    required: ['artifactId', 'destination'], additionalProperties: false };

describe('contributed download through the mounted Action dispatcher and platform destination', () => {
    let harness: Awaited<ReturnType<typeof createWorkspaceFileDownloadHarness>>;
    const originalPlatform = Platform.OS;
    beforeEach(async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        (await fs).files.clear(); platform.saveFile.mockReset().mockResolvedValue({ canceled: false });
        (await fs).writes.mockClear();
        vi.mocked(Modal.show).mockClear(); vi.mocked(Modal.confirm).mockClear();
    });
    afterEach(async () => { await harness?.reset(); vi.restoreAllMocks();
        Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform }); });

    it.each(['completed', 'mismatch', 'retired', 'originReplaced', 'accountRetired', 'cancelled', 'unknown', 'accountPlacement', 'clientPlacement'] as const)(
        'preserves exact destination, original caller and lifetime: %s', async outcome => {
            harness = await createWorkspaceFileDownloadHarness({ name: 'artifact.zip', bytes: new Uint8Array([0, 255, 42]),
                downloadActionInputSchema: inputSchema, preparedHttpResponse: (request, response) => {
                    if (outcome === 'unknown' && request.path.endsWith('/complete')) throw new Error('ACK lost');
                    return response;
                } });
            const action = PluginProjectedActionV2Schema.parse({ pluginId: 'acme.download', id: 'artifact-download',
                occurrenceId: 'provider-current', title: 'Download', scopes: ['global'], surfaces: ['ui', 'agent', 'mcp'],
                execution: outcome === 'accountPlacement' ? { target: 'account', account: { artifactId: 'account', exportName: 'download' } }
                    : outcome === 'clientPlacement' ? { target: 'client', client: { artifactId: 'client', exportName: 'download' }, platforms: ['android'] }
                    : { target: 'daemon' }, dangerLevel: 'writesLocal', confirmationWhen: { presentUserUi: false },
                confirmation: { title: 'Download?', body: 'Write the selected artifact' }, available: true });
            const surface: PluginUiSurfaceContextV1 = { pluginId: action.pluginId, contributionId: 'downloads', surfaceId: 'download-surface',
                // Session context does not select the Action's accepted Run-on Machine.
                sessionId: 'session-with-another-execution-context',
                placement: 'appSurface', platform: 'android', channel: 'internal', resourceScope: [], diagnostics: [] };
            const lifetime = new AbortController();
            let current = true; let actionCalls = 0;
            const seenDestinations: string[] = [];
            const execute: PluginSurfaceContributedActionTransport = async (_machineId, invocation) => {
                expect(_machineId).toBe(harness.scope.machineId);
                actionCalls += 1;
                const input = invocation.input;
                if (!input || typeof input !== 'object' || Array.isArray(input) || !('destination' in input)
                    || !input.destination || typeof input.destination !== 'object' || Array.isArray(input.destination)
                    || typeof input.destination.destinationId !== 'string') throw new Error('Missing host destination');
                seenDestinations.push(input.destination.destinationId);
                expect(invocation.executionSurface).toBe('ui');
                expect(invocation.presentUserIntent).toBeUndefined();
                if (outcome === 'retired') { current = false; lifetime.abort(); }
                if (outcome === 'originReplaced') current = false;
                if (outcome === 'accountRetired') await harness.switchAccount();
                if (outcome === 'cancelled') lifetime.abort();
                return { supported: true as const, result: { ok: true as const,
                    result: harness.prepareDownloadReceipt(outcome === 'mismatch' ? 'foreign-destination' : input.destination.destinationId) } };
            };
            let api: ReturnType<typeof createPluginSurfaceActionHostApi>;
            const owner = createPluginSurfaceDownloadOwner({ machineId: harness.scope.machineId, serverId: harness.scope.serverId,
                lifetimeSignal: lifetime.signal, isCurrent: () => current,
                resolveContributedAction: identity => identity.pluginId === action.pluginId && identity.localId === action.id ? action : null,
                executeAction: (request, options) => api.handleRequest(request, options) });
            api = createPluginSurfaceActionHostApi({ surfaceContext: surface, contributedAction: { ...harness.scope, execute },
                resolveContributedAction: identity => identity.pluginId === action.pluginId && identity.localId === action.id ? action : null,
                hostAction: { execute: vi.fn(), context: { authority: 'present_user', serverId: harness.scope.serverId } },
                mountedHostApiHandlers: { downloadFile: owner.downloadFile }, isCurrent: () => current,
                callerBinding: { pluginId: action.pluginId, contributionLocalId: surface.contributionId, occurrenceId: 'caller-current',
                    materializationRef: { pluginId: action.pluginId, machineId: harness.scope.machineId, materializationId: 'caller-materialization' } } });
            try {
                const result = await api.handleRequest({ version: 1, method: 'downloadFile', requestId: 'download', surface,
                    payload: { action: { pluginId: action.pluginId, localId: action.id }, input: { artifactId: 'exact-artifact' } } });
                if (outcome === 'accountPlacement' || outcome === 'clientPlacement') {
                    expect(result).toMatchObject({ code: 'unavailable', diagnostics: ['download_action_placement_unavailable'] });
                    expect(actionCalls).toBe(0); expect((await fs).writes).not.toHaveBeenCalled();
                    return;
                }
                expect(actionCalls, JSON.stringify(result)).toBe(1); expect(seenDestinations[0]).toBeTruthy();
                expect(Modal.show).not.toHaveBeenCalled(); expect(Modal.confirm).not.toHaveBeenCalled();
                expect(harness.rpcRequests.some(request => request.method === 'daemon.filesystem.download')).toBe(false);
                if (outcome === 'completed') { expect(result).toMatchObject({ success: true, status: 'completed', destinationId: seenDestinations[0], sizeBytes: 3 });
                    expect((await fs).writes).toHaveBeenCalledWith(expect.any(String), new Uint8Array([0, 255, 42]));
                    expect(platform.saveFile).toHaveBeenCalledOnce(); }
                else if (outcome === 'unknown') { expect(result).toMatchObject({ success: false, status: 'unknown' });
                    expect(platform.saveFile).not.toHaveBeenCalled(); expect((await fs).files.size).toBeGreaterThan(0); }
                else { expect(result).toMatchObject({ success: false }); expect(platform.saveFile).not.toHaveBeenCalled();
                    expect((await fs).writes).not.toHaveBeenCalled();
                    expect(harness.requests.filter(request => request.url.includes('/open'))).toEqual([]); }
            } finally { owner.dispose(); api.dispose?.(); }
        });
});
