import { expect, it, vi } from 'vitest';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installNativeRuntimeFetchBoundaryForTest } from '@/dev/testkit/harness/nativeRuntimeFetch';
import { createSessionFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { buildPluginSearchProviderSections } from '@/components/appShell/search/pluginSearchProviderSections';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import type { PluginSearchActivationOutcome } from '@/components/appShell/search/pluginSearchProviderSections';

vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/triage/src/manifest');
const { activate } = await import('../../../../../../packages/plugins/triage/src/accountRuntime');
const { TRIAGE_SESSION_LINKS_RESOURCE_LOCAL_ID_V1 } = await import('../../../../../../packages/plugins/triage/src/sessions/sessionLinksResource');
const { TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1 } = await import('../../../../../../packages/plugins/triage/src/sessions/sessionLinksResourceProjection');
const { INTERNAL_TASK_SOURCE_RECORD_V1 } = await import('../../../../../../packages/plugins/triage/src/internalTasks/configuration');
const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { readPluginUiAccountExecutableOrigin } = await import('@/sync/domains/plugins/ui/projectionOrigins');
const { clearPluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
const { createBoundPluginSurfaceController } = await import('./boundPluginSurfaceController');
const { decodeBase64 } = await import('@/encryption/base64');
const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { normalizePluginAccountCollectionContractsV1, PluginCollectionContractReadRequestV1Schema,
    PluginCollectionContractReadResultV1Schema, PluginCollectionQueryResultV1Schema,
    PluginCollectionGetResultV1Schema } = await import('@happier-dev/protocol/plugins/data/collectionsV1');
const { TriageReadSourceSessionLinksResultV1Schema, TRIAGE_APP_PAGE_LOCAL_ID_V1 } = await import('@happier-dev/triage-protocol/v1');
const { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, TriageListEntriesResultV1Schema } = await import('../../../../../../packages/plugins/triage/src/actions/listEntriesProtocol');

it('reads registered Triage Session links and searches Account tasks on a native host without a receiving Machine, then retires both readers', async () => {
    installNativeRuntimeFetchBoundaryForTest();
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
    const taskRows = new Map([
        ['todo.index', plainRow('todo.index', { undoneOrder: [taskId], completedOrder: [] })],
        [`todo.${taskId}`, plainRow(`todo.${taskId}`, { id: taskId, title: 'Offline linked task',
            done: false, createdAt: 1, updatedAt: 2,
            linkedSessions: { [sessionId]: { title: 'Existing work', linkedAt: 3 } } })],
    ]);
    const initialTaskRows = new Map(taskRows);
    const kv = createAccountKvHttpFixture({ rows: taskRows });
    const parsedManifest = ingestPluginManifestV2(PLUGIN_MANIFEST);
    if (!parsedManifest.ok) throw new Error('Expected canonical Triage manifest');
    const contracts = normalizePluginAccountCollectionContractsV1({ pluginId: PLUGIN_MANIFEST.id,
        contributions: parsedManifest.manifest.contributes.accountCollections });
    const requests: URL[] = [];
    let taskKvUnavailable = false;
    const requestForAccount = (accountHome: typeof home, accountKv: typeof kv):
        NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['request']> => async (input, init) => {
            const url = new URL(String(input));
            requests.push(url);
            const path = url.pathname;
            if (taskKvUnavailable && (path === '/v1/kv' || path.startsWith('/v1/kv/'))) {
                return Response.json({ error: 'unavailable' }, { status: 503 });
            }
            const fromKv = await accountKv.handleFetch(input, init);
            if (fromKv) return fromKv;
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
            return createEmptyAccountBootstrapHttpResponse(path, init) ?? accountHome.request(input, init);
        };
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://triage-resource.test', accountId,
        request: requestForAccount(home, kv) });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected restored Account lifetime');
    let installed: Awaited<ReturnType<typeof installPortableAccountPluginReleaseForTest>> | undefined;
    let controller: ReturnType<typeof createBoundPluginSurfaceController> | undefined;
    let unpublish: (() => void) | undefined;
    let replacement: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
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
        const resourceStore = controller.resourceStore;
        if (!resourceStore) throw new Error('Expected the mounted host Resource store');
        const retained = resourceStore.getEntry(TRIAGE_SESSION_LINKS_RESOURCE_LOCAL_ID_V1)
            .select(TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1, snapshot => snapshot);
        await retained.refresh();
        expect(retained.getSnapshot().value?.links).toEqual(value.links);

        // The offline Session controller deliberately exposes no outward Action
        // dispatcher. Use the ordinary UI front door for Account list admission.
        const [{ createDefaultActionExecutor }, { createFrontDoorActionExecute }] = await Promise.all([
            import('@/sync/ops/actions/defaultActionExecutor'), import('@/sync/ops/actions/frontDoorRuntimeActionExecutor'),
        ]);
        const execute = createFrontDoorActionExecute(createDefaultActionExecutor());
        const listResult = await execute(ACTION_INVOKE_ACTION_ID_V1, { action: {
            pluginId: PLUGIN_MANIFEST.id, localId: TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
        }, input: { v: 1, sources: { kind: 'allConfigured' }, limit: 1, order: 'newest' } }, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: lifetime.scope.serverId,
        });
        expect(listResult, JSON.stringify(listResult)).toMatchObject({ ok: true });
        if (!listResult.ok) throw new Error(`The UI list Action failed (${listResult.errorCode})`);
        const parsedList = TriageListEntriesResultV1Schema.safeParse(listResult.result);
        expect(parsedList.success, JSON.stringify({ result: listResult.result,
            issues: parsedList.success ? [] : parsedList.error.issues })).toBe(true);
        if (!parsedList.success) throw new Error('The UI returned no valid Triage list');
        const listed = parsedList.data;
        expect(listed.window.rows).toEqual([expect.objectContaining({ entryRef: value.links[0]!.entryRef,
            observation: expect.objectContaining({ outcome: expect.objectContaining({ kind: 'present',
                snapshot: expect.objectContaining({ title: 'Offline linked task' }) }) }) })]);

        // Consume the availability owner's manifest-derived search declaration;
        // the executable-byte fixture supplies real registration, not provider rows.
        const availability = readPluginAccountAvailability(lifetime.scope);
        const readProjection = () => availability.readAccountUiProjection();
        unpublish = publishCommittedAppShellPluginUiProjection(readProjection);
        const projection = readProjection();
        if (!projection) throw new Error('Expected admitted Triage search declaration');
        const onCommitActivation = vi.fn<(activate: () => Promise<PluginSearchActivationOutcome>) => void>();
        // Destination selection is the physical host boundary. Query dispatch,
        // Triage list assembly and exact-entry command construction stay real.
        const openSurface = vi.fn(async () => ({ ok: true as const }));
        const sections = buildPluginSearchProviderSections({ projection,
            scopedLaunchFacts: { serverId: lifetime.scope.serverId, machineId: null, interactionEnabled: true },
            accountLifetime: lifetime, openSurface, onCommitActivation });
        expect(sections).toHaveLength(1);
        const section = sections[0]!;
        const result = await section.resolve('Offline linked', new AbortController().signal);
        expect(result.options).toHaveLength(1);
        expect(result.options[0]).toMatchObject({ label: 'Offline linked task' });
        result.options[0]!.onSelect?.();
        const activateResult = onCommitActivation.mock.calls[0]?.[0];
        if (!activateResult) throw new Error('Expected committed exact-entry activation');
        expect(await activateResult()).toMatchObject({ ok: true });
        expect(openSurface).toHaveBeenCalledExactlyOnceWith({
            destination: { pluginId: PLUGIN_MANIFEST.id, localId: TRIAGE_APP_PAGE_LOCAL_ID_V1 },
            input: { v: 1, kind: 'entryDetail', entryRef: value.links[0]!.entryRef,
                sourceInstance: { source: value.links[0]!.entryRef.source,
                    sourceInstanceId: INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.sourceInstanceId } },
            subPath: '',
        });
        expect(requests.every(url => url.origin === 'http://triage-resource.test')).toBe(true);

        // Fault and change only external Account storage. The same registered
        // relation Action and host projection own retention and complete removal.
        taskKvUnavailable = true;
        await retained.refresh();
        expect(retained.getSnapshot().value).toMatchObject({ kind: 'partial', links: value.links,
            lanes: expect.arrayContaining([expect.objectContaining({ health: expect.objectContaining({ kind: 'failed' }) })]) });
        taskKvUnavailable = false;
        kv.reset();
        await retained.refresh();
        expect(retained.getSnapshot().value).toMatchObject({ kind: 'complete', links: [] });
        for (const [key, row] of initialTaskRows) taskRows.set(key, row);
        await retained.refresh();
        expect(retained.getSnapshot().value?.links).toEqual(value.links);

        // The Session address stays identical while the real serialized Account
        // switch retires the reader's captured Account and executable custody.
        const otherAccountId = 'triage-resource-other-account';
        replacement = await restoreServerAccountForTest({ serverUrl: 'http://triage-resource.test',
            accountId: otherAccountId, activation: 'switch', request: requestForAccount(
                createHomeHubArtifactHttpBoundary(otherAccountId), createAccountKvHttpFixture()) });
        expect(lifetime.isCurrent()).toBe(false);
        expect(captureActiveServerAccountScopeLifetime()?.scope.accountId).toBe(otherAccountId);
        expect(retained.getSnapshot().value).toBeUndefined();
        expect(await controller.hostApi.handleRequest({ version: 1, requestId: 'retired-account-same-session',
            surface: controller.surfaceContext, method: 'readResource',
            payload: { resource: TRIAGE_SESSION_LINKS_RESOURCE_LOCAL_ID_V1 } })).toMatchObject({ code: 'stale_surface' });
        expect(buildPluginSearchProviderSections({ projection: readProjection(),
            scopedLaunchFacts: { serverId: lifetime.scope.serverId, machineId: null, interactionEnabled: true },
            accountLifetime: lifetime, onCommitActivation: () => {} })).toEqual([]);
        expect(await section.resolve('Offline linked', new AbortController().signal)).toEqual({ options: [] });
        expect(await activateResult()).toMatchObject({ ok: false, reason: 'plugin_ui_generation_retired' });
        expect(openSurface).toHaveBeenCalledOnce();
    } finally {
        taskKvUnavailable = false;
        unpublish?.(); controller?.dispose(); await installed?.dispose(); clearPluginAccountAvailabilityProjection();
        await replacement?.dispose(); await connection.dispose();
    }
});
