import { expect, it, vi } from 'vitest';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';

vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
// The browser has no native HTTP capability and no receiving Machine.
vi.mock('@/utils/platform/tauri/transferFetch', () => ({ resolveTauriRuntimeFetch: async () => null }));

const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/triage/src/manifest');
const { activate } = await import('../../../../../../packages/plugins/triage/src/accountRuntime');
const { TRIAGE_SESSION_LINKS_RESOURCE_LOCAL_ID_V1 } = await import('../../../../../../packages/plugins/triage/src/sessions/sessionLinksResource');
const { INTERNAL_TASK_SOURCE_RECORD_V1 } = await import('../../../../../../packages/plugins/triage/src/internalTasks/configuration');
const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { readPluginUiAccountExecutableOrigin } = await import('@/sync/domains/plugins/ui/projectionOrigins');
const { clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
const { createBoundPluginSurfaceController } = await import('./boundPluginSurfaceController');
const { decodeBase64 } = await import('@/encryption/base64');
const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { normalizePluginAccountCollectionContractsV1, PluginCollectionContractReadRequestV1Schema,
    PluginCollectionContractReadResultV1Schema, PluginCollectionQueryResultV1Schema,
    PluginCollectionGetResultV1Schema } = await import('@happier-dev/protocol/plugins/data/collectionsV1');
const { TriageReadSourceSessionLinksResultV1Schema } = await import('@happier-dev/triage-protocol/v1');

it('reads the real Triage Session links Resource in a browser without a receiving Machine', async () => {
    const accountId = 'triage-resource-account';
    const sessionId = 'cmwhleai000yjmcne359fxpdc';
    const taskId = 'linked-task';
    const machineId = 'offline-session-machine';
    const home = createHomeHubArtifactHttpBoundary(accountId);
    const session = createSessionFixture({ id: sessionId, metadata: { path: '/repo', host: 'test', machineId } });
    const sessionHttp = createSessionMetadataHttpBoundary(() => ({ [sessionId]: session }));
    sessionHttp.replaceSession(sessionId, SessionCurrentProjectionRecordV1Schema.parse(createPlainSessionByIdResponseFixture(session).session));
    const sessionRequest = createSessionReadBatchFetchBoundary(async (input, init) =>
        sessionHttp.handle(input, init) ?? Response.json({ error: 'not_found' }, { status: 404 }));
    const features = createRootLayoutFeaturesResponse({ capabilities: { accountStoredContentCompatibility: {
        v: 1, minimumProtocolVersion: 2,
        currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION.protocolVersion,
        declarationTransport: 'http-header-and-socket-auth-v1',
    } } });
    const plainRow = (key: string, value: unknown) => ({ key, version: 1,
        value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: value }) });
    const kv = createAccountKvHttpFixture({ rows: new Map([
        ['todo.index', plainRow('todo.index', { undoneOrder: [taskId], completedOrder: [] })],
        [`todo.${taskId}`, plainRow(`todo.${taskId}`, { id: taskId, title: 'Offline linked task',
            done: false, createdAt: 1, updatedAt: 2,
            linkedSessions: { [sessionId]: { title: 'Existing work', linkedAt: 3 } } })],
    ]) });
    const parsedManifest = ingestPluginManifestV2(PLUGIN_MANIFEST);
    if (!parsedManifest.ok) throw new Error('Expected canonical Triage manifest');
    const contracts = normalizePluginAccountCollectionContractsV1({ pluginId: PLUGIN_MANIFEST.id,
        contributions: parsedManifest.manifest.contributes.accountCollections });
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://triage-resource.test', accountId,
        request: async (input, init) => {
            const fromKv = await kv.handleFetch(input, init);
            if (fromKv) return fromKv;
            const path = new URL(String(input)).pathname;
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body, () => null);
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            if (path === '/v2/sessions/read-batch' || path === `/v2/sessions/${sessionId}`) return sessionRequest(input, init);
            if (path === '/v1/plugins/data/contract') {
                const { ref } = PluginCollectionContractReadRequestV1Schema.parse(JSON.parse(String(init?.body)));
                return Response.json(PluginCollectionContractReadResultV1Schema.parse({ access: 'writable',
                    contract: contracts.find(contract => contract.collectionId === ref.collectionId) }));
            }
            if (path === '/v1/plugins/data/query') return Response.json(PluginCollectionQueryResultV1Schema.parse({ rows: [], changeCursor: 1 }));
            if (path === '/v1/plugins/data/get') return Response.json(PluginCollectionGetResultV1Schema.parse({ row: null, absenceEpoch: 0 }));
            // This supported Home keeps personal tasks in Account KV.
            if (path === '/v1/tasks') return Response.json({ statusCode: 404, error: 'Not Found',
                message: 'Route GET:/v1/tasks not found' }, { status: 404 });
            return createEmptyAccountBootstrapHttpResponse(path, init) ?? home.request(input, init);
        } });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected restored Account lifetime');
    let installed: Awaited<ReturnType<typeof installPortableAccountPluginReleaseForTest>> | undefined;
    let controller: ReturnType<typeof createBoundPluginSurfaceController> | undefined;
    try {
        expect(await getServerFeaturesSnapshot({ serverId: lifetime.scope.serverId, force: true })).toMatchObject({ status: 'ready' });
        // Real authored metadata and activation; only executable byte delivery is substituted.
        installed = await installPortableAccountPluginReleaseForTest({ manifest: PLUGIN_MANIFEST,
            activate, accountLifetime: lifetime, publishProjection: true });
        const declaration = installed.projection.resourcesById[`${PLUGIN_MANIFEST.id}/${TRIAGE_SESSION_LINKS_RESOURCE_LOCAL_ID_V1}`];
        const origin = readPluginUiAccountExecutableOrigin(declaration);
        if (!declaration || !origin) throw new Error('Expected declared Account Resource');
        controller = createBoundPluginSurfaceController({ facts: {
            pluginId: PLUGIN_MANIFEST.id, contributionId: 'session-entries', surfaceId: 'triage-session-links',
            placement: 'sessionPane', platform: 'web', channel: 'internal', sessionId, machineId,
            serverId: lifetime.scope.serverId, accountLifetime: lifetime,
            occurrenceId: declaration.occurrenceId, accountExecutionOrigin: origin,
            pluginUiProjection: installed.projection, resourceCapability: { readable: false, dynamic: false },
            interactionEnabled: true, daemonInteractionEnabled: false,
        } });
        const response = await controller.hostApi.handleRequest({ version: 1, requestId: 'read-native-task-links',
            surface: controller.surfaceContext, method: 'readResource',
            payload: { resource: TRIAGE_SESSION_LINKS_RESOURCE_LOCAL_ID_V1 } });
        expect(response).toMatchObject({ contentType: 'application/json', bytesBase64: expect.any(String) });
        if (!response || typeof response !== 'object' || !('bytesBase64' in response) || typeof response.bytesBase64 !== 'string') {
            throw new Error('Expected Session link Resource bytes');
        }
        const value = TriageReadSourceSessionLinksResultV1Schema.parse(JSON.parse(
            new TextDecoder().decode(decodeBase64(response.bytesBase64, 'base64'))));
        expect(value).toMatchObject({ kind: 'complete', links: [{ sessionId,
            entryRef: { source: { pluginId: PLUGIN_MANIFEST.id, localId: 'internal' },
                kindId: 'task', collisionScope: 'personal', entryId: taskId },
            sourceInstanceId: INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.sourceInstanceId,
            displayPath: 'Offline linked task', linkedAtMs: 3,
        }] });
    } finally {
        controller?.dispose(); await installed?.dispose(); clearPluginAccountAvailabilityProjection(); await connection.dispose();
    }
});
