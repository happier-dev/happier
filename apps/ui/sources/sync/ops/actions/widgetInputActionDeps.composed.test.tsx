import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { AccountProfileSchema, ApprovalRequestV2Schema, buildApprovalRequestArtifactHeaderV1, PluginProjectionV2Schema, PluginUiViewV2Schema, tryWriteServerEnabledBitInPlace, type ActionExecutorDeps, type PluginJsonSchemaV2 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createPluginWidgetAreaHostPortV1 } from '@happier-dev/protocol/plugins/ui';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary, createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1, WidgetAreaLayoutV1Schema, WIDGET_SURFACE_ARTIFACT_KIND_V1, type WidgetAreaLayoutV1 } from '@happier-dev/protocol/widgets';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { widgetProjectionEntry, widgetProjectionOf, widgetInstalledPackage } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createDeferred } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import type { ConnectedAccountPurposeDefaultsIntent } from '@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { InputFieldHintSchema } from '@happier-dev/protocol/inputs';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { readBuiltinWidgetDescriptorV1, type WidgetDefinitionV1 } from '@happier-dev/protocol/widgets';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createPlainProjectAccountRowListFixture, createProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { createWorkBoardArtifactPortV1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { PluginUiWidgetAreaPresentation } from '@happier-dev/plugin-ui/advanced';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

// The viewer accepts the real Action confirmation at its presentation boundary.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
// Native overlay placement is outside this composed Action journey; render its real contents.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal, {
        maxHeight: 624, maxWidth: 960, placement: 'bottom',
    }));

installDisconnectedServerSocketBoundary();
// Install the external socket before any consumer can capture its transport.
// Each Account restoration below supplies its own HTTP Response boundary.
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { readCurrentAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
const { unionPluginUiProjections } = await import('@/sync/domains/plugins/ui/projectionUnion');
const { readWidgetDescriptor } = await import('@/components/widgets/widgetCatalog');
const { storage } = await import('@/sync/domains/state/storage');
const { readMachineControlTargetForSession } = await import('@/sync/ops/sessionMachineTarget');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { createWidgetInputActionDepsV1 } = await import('./widgetInputActionDeps');
const { createWidgetCatalogActionDepsV1, readWidgetActionCandidatesV1 } = await import('./widgetCatalogActionDeps');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { createPluginDeclaredResourceStore } = await import('@/components/plugins/surfaces/PluginContextualResourceStoreProvider');
const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
const { buildConnectedAccountPurposeSetupRoute, readConnectedAccountPurposeSetupRequest,
    isConnectedAccountPurposeSetupTargetCurrent } = await import('@/sync/domains/connectedServices/connectedAccountPurposeSetup');
const { useConnectedAccountPurposeDefaults } = await import('@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
const { applyConnectedAccountCatalogSnapshot } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
const { listMachinesForVoiceTool } = await import('@/voice/tools/actionImpl/machinesList');
const { createClientActionReverseDispatcher } = await import('../../../../../cli/src/session/actions/clientActionReverseDispatch');

it('keeps native Session denial for a saved builtin without borrowing plugin target authority', async () => {
    const bridge = await loadSyncSingletonForTests();
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://saved-native-inputs.test', accountId: 'viewer',
        request: createHomeHubArtifactHttpBoundary('viewer').request });
    const previous = storage.getState();
    try {
        const account = await captureLazyActionAccountContext(connection.home.id);
        const surface = { serverId: account.serverId, accountId: account.accountId, owner: { kind: 'home' as const } };
        const denied = createSessionFixture({ id: 'private-session', serverId: account.serverId });
        denied.access = { ...denied.access!, capabilities: { ...denied.access!.capabilities, readTranscript: false } };
        storage.setState({ sessions: { [denied.id]: denied } });
        const native = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'changes' })!;
        const definition: WidgetDefinitionV1 = { v: 1, id: 'saved-changes', name: 'Saved changes',
            body: { kind: 'builtin', id: 'changes' }, sizeDeclaration: native.sizeDeclaration,
            inputs: native.inputs!, inputSchema: native.inputSchema!, sessionInputPath: native.sessionInputPath,
            provenance: { source: { kind: 'authored' } } };
        const deps = createWidgetInputActionDepsV1(account, createActionExecutorBoundaryFixture({ widgetAccountScope: () => account }));
        expect(await deps.widgetInputs!.resolve({ ref: { surface, instanceId: 'copy' },
            instance: { v: 1, id: 'copy', definition: { kind: 'inline', definition }, bindings: {
                session: { kind: 'value', value: { serverId: account.serverId, sessionId: denied.id } },
            } }, context: { surface: 'ui', authority: 'present_user' },
        })).toMatchObject({ status: 'denied', fields: [{ path: 'session', reasonCode: 'widget_session_access_denied' }] });
    } finally { storage.setState(previous, true); await connection.dispose(); bridge.dispose(); }
});

it('offers every Home machine including offline machines without enabling voice inventory sharing', async () => {
    const previous = storage.getState();
    try {
        const machines = Array.from({ length: 251 }, (_, index) => createMachineFixture({ id: `machine-${index}`,
            active: index !== 250, activeAt: index === 250 ? 0 : Date.now(),
            metadata: { ...createMachineFixture().metadata!, host: `Host ${index}` } }));
        storage.setState({ machines: {}, machineListByServerId: { home: machines },
            machineListStatusByServerId: { home: 'idle' },
            settings: { ...previous.settings, voice: { ...previous.settings.voice, privacy: { ...previous.settings.voice.privacy, shareDeviceInventory: false } } } });
        expect(await listMachinesForVoiceTool({ serverId: 'home' })).toMatchObject({ errorCode: 'privacy_disabled' });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ machinesList: listMachinesForVoiceTool,
            widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) }));
        const request = { consumer: { kind: 'widget' as const,
            surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } },
            definition: { kind: 'builtin' as const, id: 'machine_vitals' } }, fieldPath: 'machine' };
        expect(await executor.execute('action.options.resolve', request, {
            surface: 'voice', authority: 'present_user', serverId: 'home',
        })).toMatchObject({ ok: false, errorCode: 'privacy_disabled' });
        const inventory = await executor.execute('action.options.resolve', request, {
            surface: 'ui', authority: 'present_user', serverId: 'home',
        });
        expect(inventory).toMatchObject({ ok: true, result: { options: expect.any(Array) } });
        if (!inventory.ok) throw new Error('Expected the admitted UI machine input inventory');
        const items = (inventory.result as { options: unknown[] }).options;
        expect(items).toHaveLength(251);
        expect(items[250]).toMatchObject({ value: { serverId: 'home', machineId: 'machine-250' }, description: 'Offline' });
    } finally { storage.setState(previous, true); }
});

it('resolves Companion and Board machine followers from the readable session owner view', async () => {
    const bridge = await loadSyncSingletonForTests();
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://widget-machine-context.test', accountId: 'viewer',
        request: createHomeHubArtifactHttpBoundary('viewer').request });
    const account = await captureLazyActionAccountContext(connection.home.id);
    const previous = storage.getState();
    try {
        const session = createSessionFixture({ id: 'followed', serverId: account.serverId, metadataLayoutVersion: 1,
            ownerMetadataView: { machineId: 'session-machine', path: '/repo', host: 'host' },
            metadata: { machineId: 'wrong-legacy-machine', path: '/old', host: 'old' } });
        storage.setState({ sessions: { followed: session } });
        const deps = createWidgetInputActionDepsV1(account, createActionExecutorBoundaryFixture({ widgetAccountScope: () => account }));
        for (const kind of ['companion', 'sessionBoard'] as const) {
            const surface = { serverId: account.serverId, accountId: account.accountId, owner: { kind, sessionId: session.id } };
            const request = { ref: { surface, instanceId: 'vitals' }, instance: { v: 1 as const, id: 'vitals',
                definition: { kind: 'builtin' as const, id: 'machine_vitals' }, bindings: { machine: { kind: 'context' as const, slot: 'machine' } } },
                context: { surface: 'ui' as const } };
            expect(await deps.widgetInputs!.resolve(request)).toEqual({ status: 'ready', input: {
                machine: { serverId: account.serverId, machineId: 'session-machine' },
            } });
            expect(await deps.widgetInputs!.resolve({ ...request, instance: { ...request.instance,
                bindings: { machine: { kind: 'value', value: { serverId: 'other-home', machineId: 'session-machine' } } } } }))
                .toMatchObject({ status: 'denied', fields: [{ path: 'machine', reasonCode: 'widget_target_scope_mismatch' }] });
            storage.setState({ sessions: { followed: { ...session, ownerMetadataView: null } } });
            expect(await deps.widgetInputs!.resolve(request)).toMatchObject({ status: 'selection_required' });
            storage.setState({ sessions: { followed: session } });
        }
    } finally { storage.setState(previous, true); await connection.dispose(); bridge.dispose(); }
});

it('constrains saved host choices while schema-valid followed Usage inputs retain their context authority', async () => {
    const bridge = await loadSyncSingletonForTests();
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://host-widget-choice.test', accountId: 'viewer',
        request: createHomeHubArtifactHttpBoundary('viewer').request });
    const previous = storage.getState();
    try {
        const { useConfiguredWidgetTarget } = await import('@/sync/domains/widgets/useConfiguredWidgetTarget');
        const scope = { serverId: connection.home.id, accountId: 'viewer', owner: { kind: 'home' as const } };
        storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: 'viewer' }) });
        const definition = { kind: 'builtin' as const, id: 'usage' };
        const base = readWidgetDescriptor(null, { kind: 'builtin', id: 'session_summary' });
        if (!base || base.surface !== undefined || base.definition.kind !== 'builtin') throw new Error('Missing built-in widget descriptor');
        const descriptor = { ...base,
            definition, target: 'app' as const, sessionInputPath: undefined,
            inputs: { fields: [InputFieldHintSchema.parse({ path: 'query', title: 'Usage', widget: 'select',
                inputType: { hostType: 'usageQuery' }, options: [{ value: { metric: 'cost' }, label: 'Cost' }] })] },
            inputSchema: undefined };
        const hook = await renderHook((props: Readonly<{ metric: string; follow: boolean }>) => useConfiguredWidgetTarget({
            scope, descriptor, providedContext: { query: [{ metric: props.metric }] },
            instance: { v: 1, id: 'copy', definition, bindings: { query: props.follow
                ? { kind: 'context', slot: 'query' } : { kind: 'value', value: { metric: props.metric } } } },
            appRuntime: { pluginUiProjection: null, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
                machineId: null, serverId: scope.serverId, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime() },
        }), { initialProps: { metric: 'tokens', follow: false } });
        expect(hook.getCurrent()).toMatchObject({ status: 'invalid', reasonCode: 'widget_input_option_unavailable' });
        await hook.rerender({ metric: 'cost', follow: true });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', input: { query: { metric: 'cost' } } });
        await hook.rerender({ metric: 'tokens', follow: true });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', input: { query: { metric: 'tokens' } } });
        await hook.rerender({ metric: 'not-a-metric', follow: true });
        expect(hook.getCurrent()).toMatchObject({ status: 'invalid', reasonCode: 'input_type_value_invalid' });
        await hook.rerender({ metric: 'tokens', follow: false });
        expect(hook.getCurrent()).toMatchObject({ status: 'invalid', reasonCode: 'widget_input_option_unavailable' });
        await hook.unmount();
    } finally { storage.setState(previous, true); await connection.dispose(); bridge.dispose(); }
});

it('admits checkout pins through authorized Project rows on any host and retires removed or forged targets', async () => {
    const bridge = await loadSyncSingletonForTests();
    const http = createHomeHubArtifactHttpBoundary('viewer');
    let workspaceRefs: WorkspaceRefV1[] = [];
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://widget-declared-inputs.test', accountId: 'viewer', request: async (url, init) =>
        new URL(String(url)).pathname === '/v1/account/project-rows/list'
            ? Response.json(createPlainProjectAccountRowListFixture({ workspaceRefs })) : http.request(url, init) });
    const account = await captureLazyActionAccountContext(connection.home.id);
    const previous = storage.getState();
    try {
        const scope = { serverId: account.serverId, accountId: account.accountId };
        const surface = { ...scope, owner: { kind: 'project' as const, projectId: 'project' } };
        const checkout = { id: 'checkout', serverId: scope.serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
        workspaceRefs = [checkout];
        const { createWidgetAreaActionDepsV1 } = await import('./widgetAreaActionDeps');
        const deps = createWidgetInputActionDepsV1(account, createActionExecutorBoundaryFixture({
            widgetAccountScope: () => scope, ...createWidgetAreaActionDepsV1(account),
        }));
        const request = { ref: { surface, instanceId: 'copy' }, instance: { v: 1 as const, id: 'copy',
            definition: { kind: 'builtin' as const, id: 'project_code' }, bindings: { checkout: { kind: 'value' as const, value: checkout } } },
            context: { surface: 'ui' as const, widgetAreaContext: { surface, values: { checkout: [checkout] } } } };
        expect(await deps.widgetInputs!.resolve(request)).toEqual({ status: 'ready', input: { checkout } });
        for (const owner of [{ kind: 'home' }, { kind: 'pluginArea', pluginId: 'acme.page', pageId: 'page', area: 'main' },
            { kind: 'corePage', pageId: 'usage', area: 'main' }] as const) {
            expect(await deps.widgetInputs!.resolve({ ...request, ref: { ...request.ref, surface: { ...surface, owner } },
                context: { surface: 'ui' } })).toEqual({ status: 'ready', input: { checkout } });
        }
        expect(await deps.widgetInputs!.resolve({ ...request, instance: { ...request.instance,
            bindings: { checkout: { kind: 'value', value: { ...checkout, rootPath: '/other' } } } } })).toMatchObject({ status: 'denied',
            fields: [{ path: 'checkout', reasonCode: 'widget_target_identity_mismatch' }] });
        const { useConfiguredWidgetTarget } = await import('@/sync/domains/widgets/useConfiguredWidgetTarget');
        const descriptor = readWidgetDescriptor(null, request.instance.definition)!;
        const hook = await renderHook((owner: typeof surface.owner | { kind: 'home' } | { kind: 'workBoard'; boardId: string }
            | { kind: 'pluginArea'; pluginId: string; pageId: string; area: string }) => useConfiguredWidgetTarget({
            scope: { ...surface, owner }, instance: request.instance, descriptor, providedContext: {},
            appRuntime: { phase: 'current', interactionEnabled: true, machineId: null, serverId: null, platform: 'web',
                pluginUiProjection: null, pluginBrowserProjection: null, accountLifetime: account.accountLifetime },
        }), { initialProps: surface.owner });
        try {
            expect(hook.getCurrent()).toMatchObject({ status: 'ready', target: { kind: 'workspace', checkout } });
            for (const owner of [{ kind: 'home' }, { kind: 'workBoard', boardId: 'board' },
                { kind: 'pluginArea', pluginId: 'acme.page', pageId: 'page', area: 'main' }] as const) {
                await hook.rerender(owner);
                expect(hook.getCurrent()).toMatchObject({ status: 'ready', target: { kind: 'workspace', checkout } });
            }
            workspaceRefs = [];
            expect(await deps.widgetInputs!.resolve(request)).toMatchObject({ status: 'denied' });
            await act(async () => storage.setState({ projectAccountRows: createProjectAccountRowsFixture(scope) }));
            expect(hook.getCurrent()).toMatchObject({ status: 'denied' });
        } finally { await hook.unmount(); }
        await connection.dispose();
        await expect(deps.widgetInputs!.resolve(request)).rejects.toThrow();
    } finally {
        account.dispose(); storage.setState(previous, true); await connection.dispose(); bridge.dispose();
    }
});

it('admits its own Account scope when the catalog is composed before scope deps are returned', async () => {
    const bridge = await loadSyncSingletonForTests();
    const http = createHomeHubArtifactHttpBoundary('catalog-viewer');
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://catalog-composition.test', accountId: 'catalog-viewer', request: http.request });
    const account = await captureLazyActionAccountContext(connection.home.id);
    const previous = storage.getState();
    try {
        const { createActionExecutor, createHomeHubArtifactPortV1 } = await import('@happier-dev/protocol');
        const scope = { serverId: account.serverId, accountId: account.accountId };
        storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: account.accountId }) });
        const surface = { ...scope, owner: { kind: 'home' as const } };
        const base = createActionExecutorBoundaryFixture({ homeHubArtifacts: createHomeHubArtifactPortV1(account.homeHubArtifactTransport, {
            accountId: account.accountId, shouldContinue: account.accountLifetime.isCurrent,
        }) });
        const executor = createActionExecutor({ ...base, ...createWidgetCatalogActionDepsV1(account, base) });
        const result = await executor.execute('widgets.catalog.list', { surface }, { surface: 'ui', serverId: scope.serverId });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
            surface, entries: expect.arrayContaining([expect.objectContaining({
                definition: { kind: 'builtin', id: 'session_summary' }, availability: 'available',
            })]),
        } });
    } finally {
        account.dispose();
        storage.setState(previous, true);
        await connection.dispose();
        bridge.dispose();
    }
});

it('repairs a shared mounted viewer purpose through the Account catalog without changing Settings or shared inputs', async () => {
    // Bridge Metro's call-time require to the same real Sync singleton; no settings logic is replaced.
    const syncBridge = await loadSyncSingletonForTests();
    let profile = AccountProfileSchema.parse({ id: 'viewer' });
    const http = createHomeHubArtifactHttpBoundary('viewer', () => profile);
    const raw: Record<string, unknown> = {};
    const version = 1;
    let purposeBindings: ConnectedPurposeCatalogV1 = { v: 1, bindings: [] };
    let revision = 1;
    let reject = false;
    const writes: ConnectedPurposeCatalogV1[] = [];
    const missingSession = createDeferred<void>();
    const sessionRequests: Array<{ method: string; path: string }> = [];
    const request = createSessionReadBatchFetchBoundary(async (input, init) => {
        if (new URL(String(input)).pathname === '/v2/sessions/named-session') {
            await missingSession.promise;
            return Response.json({ error: 'Session not found' }, { status: 404 });
        }
        const path = new URL(String(input)).pathname;
        if (path === '/v2/account/settings') {
            if (init?.method === 'POST') throw new Error('viewer_purpose_must_not_write_settings');
            return Response.json({ content: { t: 'plain', v: raw }, version });
        }
        if (path !== '/v1/account/entity-rows/connected-accounts/purposes') return http.request(input, init);
        if (init?.method !== 'POST') return Response.json({ status: 'present', revision, content: { t: 'plain', v: { key: 'purposes', value: purposeBindings } } });
        if (reject) return Response.json({ error: 'denied' }, { status: 403 });
        const body = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
        expect(body.expectedRevision).toBe(revision);
        expect(body.settingsMutation).toBeUndefined();
        if (body.content?.t !== 'plain' || body.content.v.key !== 'purposes') throw new Error('Expected explicit purpose Account envelope');
        purposeBindings = body.content.v.value; writes.push(purposeBindings); revision += 1;
        return Response.json({ status: 'updated', revision, cursor: revision });
    });
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://viewer-purpose-recovery.test', accountId: 'viewer', request: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.startsWith('/v2/sessions/')) sessionRequests.push({ method: init?.method ?? 'GET', path });
        return request(input, init);
    } });
    const previous = storage.getState();
    const restoreExecutorLoader = await installRealActionExecutorModuleLoader();
    try {
        const { useConfiguredWidgetTarget } = await import('@/sync/domains/widgets/useConfiguredWidgetTarget');
        const surface = { pluginId: 'com.acme.recovery', localId: 'status' };
        const consumer = { pluginId: surface.pluginId, localId: 'metrics' };
        const service = { pluginId: surface.pluginId, localId: 'cloud' };
        const ref = { service, accountId: 'mine' };
        const connected = AccountProfileSchema.parse({ id: 'viewer', connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'token',
            configurationReady: true, configurationRevision: null, revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [] }] });
        storage.setState({ profile, profileScope: { serverId: connection.home.id, accountId: 'viewer' } });
        const widget = { ...widgetProjectionEntry({ ...surface, entryId: 'recovery-widget', target: 'app', occurrenceId: 'current', inputs: { fields: [
            { path: 'connection', title: 'Cloud account', widget: 'select', connectedAccountOptions: true },
        ] }, inputSchema: { type: 'object', properties: { connection: { type: 'object', required: ['service', 'accountId'],
            properties: { service: { type: 'object', properties: { pluginId: { type: 'string' }, localId: { type: 'string' } }, required: ['pluginId', 'localId'], additionalProperties: false },
                accountId: { type: 'string' } }, additionalProperties: false } }, additionalProperties: false } }),
            resources: [consumer], connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'read', consumer }] };
        const rawProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [surface.pluginId]: { ...widgetInstalledPackage(surface.pluginId, 'Recovery'), occurrenceId: 'current',
                source: { kind: 'local', locator: `/plugins/${surface.pluginId}` } } },
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: { 'recovery-widget': widget } } },
            resourcesById: { metrics: { id: consumer.localId, pluginId: consumer.pluginId, resourceKind: 'config', scope: 'global',
                connectedAccountPurposes: [{ purpose: 'read', serviceRefs: [service] }] } },
        });
        const projection = normalizePluginUiProjection(rawProjection);
        daemon.projections.set('machine', rawProjection);
        storage.setState({ machines: { ...storage.getState().machines,
            machine: createMachineFixture({ id: 'machine', activeAt: Date.now() }) } });
        clearDaemonMergedProjectionCacheForTests();
        const descriptor = readWidgetDescriptor(projection, surface)!;
        const scope = { serverId: connection.home.id, accountId: 'viewer', owner: { kind: 'sessionBoard' as const, sessionId: 'shared' } };
        const instance = { v: 1 as const, id: 'shared', definition: { kind: 'installed' as const, surface }, bindings: { connection: { kind: 'viewer' as const, purpose: 'read' } } };
        let runtime = { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current' as const, interactionEnabled: true,
            machineId: 'machine', serverId: connection.home.id, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime() };
        applyConnectedAccountCatalogSnapshot({ serverId: scope.serverId, accountId: 'viewer' }, 'purposes', {
            status: 'ready', revision, record: { key: 'purposes', value: purposeBindings },
        }, true);
        const hook = await renderHook(() => {
            const defaults = useConnectedAccountPurposeDefaults();
            return { resolution: useConfiguredWidgetTarget({ scope, instance, descriptor, providedContext: {}, appRuntime: runtime }),
                select: defaults.mutateDefaults, execution: defaults.execution };
        });
        await vi.waitFor(() => expect(hook.getCurrent().execution.ready).toBe(true));
        const initial = hook.getCurrent().resolution;
        if (initial.status === 'ready' || initial.status === 'loading' || !initial.repair?.connection) throw new Error(`Expected admitted viewer-purpose Connect recovery: ${JSON.stringify(initial)}`);
        const request = readConnectedAccountPurposeSetupRequest(buildConnectedAccountPurposeSetupRoute(initial.repair.connection).params)!;
        expect(request.purpose).toEqual({ consumer, purpose: 'read' });
        // Authentication adds a profile, but it does not choose this Resource's purpose.
        await act(async () => { profile = connected; storage.setState({ profile }); });
        expect(hook.getCurrent().resolution).toMatchObject({ status: 'selection_required', repair: { kind: 'connect' } });
        const catalogScope = { serverId: scope.serverId, accountId: 'viewer' };
        await act(async () => {
            purposeBindings = { v: 1, bindings: [{ purpose: request.purpose, target: { kind: 'account', account: ref } }] };
            applyConnectedAccountCatalogSnapshot(catalogScope, 'purposes', { status: 'ready', revision: 1,
                record: { key: 'purposes', value: purposeBindings } }, true);
        });
        expect(hook.getCurrent().resolution).toMatchObject({ status: 'ready', input: { connection: ref } });
        await act(async () => {
            applyConnectedAccountCatalogSnapshot(catalogScope, 'purposes', { status: 'unavailable', reason: 'account-mode-mismatch' }, true);
        });
        expect(hook.getCurrent().resolution).toMatchObject({ status: 'unavailable', reasonCode: 'connected_account_purpose_catalog_unavailable' });
        await act(async () => {
            purposeBindings = { v: 1, bindings: [] }; revision = 2;
            applyConnectedAccountCatalogSnapshot(catalogScope, 'purposes', { status: 'ready', revision: 2,
                record: { key: 'purposes', value: purposeBindings } }, true);
        });
        expect(isConnectedAccountPurposeSetupTargetCurrent({ request, viewer: storage.getState().profileScope,
            runtime, profile: connected, target: null })).toBe(false);
        const next = { kind: 'account' as const, account: ref };
        const isCurrent = () => isConnectedAccountPurposeSetupTargetCurrent({ request, viewer: storage.getState().profileScope,
            runtime, profile: storage.getState().profile, target: next });
        expect(isCurrent()).toBe(true);
        const intent: ConnectedAccountPurposeDefaultsIntent = { kind: 'resource',
            input: { machineId: request.machineId, purpose: request.purpose, target: next } };
        reject = true;
        await act(async () => { await expect(hook.getCurrent().select(intent)).rejects.toThrow(); });
        expect(writes).toHaveLength(0);
        expect(hook.getCurrent().resolution.status).toBe('selection_required');
        reject = false;
        await act(async () => { await hook.getCurrent().select(intent); });
        expect(writes).toHaveLength(1);
        expect(raw).toEqual({});
        expect(version).toBe(1);
        expect(hook.getCurrent().resolution).toMatchObject({ status: 'ready', input: { connection: ref } });
        expect(instance.bindings).toEqual({ connection: { kind: 'viewer', purpose: 'read' } });
        expect(isConnectedAccountPurposeSetupTargetCurrent({ request, viewer: { serverId: scope.serverId, accountId: 'other' },
            runtime, profile: connected, target: next })).toBe(false);
        runtime = { ...runtime, pluginUiProjection: { ...projection, resourcesById: {} } };
        daemon.projections.set('machine', { ...rawProjection, resourcesById: {} });
        publishMachineContributionRegistryProjectionInvalidation({ serverId: scope.serverId, machineId: 'machine' });
        await act(async () => { await expect(hook.getCurrent().select(intent)).rejects.toThrow(); });
        expect(writes).toHaveLength(1);
        const capturedSelect = hook.getCurrent().select;
        const capturedLifetime = captureActiveServerAccountScopeLifetime();
        if (!capturedLifetime) throw new Error('Expected the viewer Account lifetime');
        await hook.unmount();
        const deniedSession = createSessionFixture({ id: 'named-session', serverId: scope.serverId,
            metadata: { name: 'Build release', path: '/private/release', host: 'machine' } });
        deniedSession.access = { ...deniedSession.access!, capabilities: { ...deniedSession.access!.capabilities, readTranscript: false } };
        await act(async () => { storage.setState({ sessions: { [deniedSession.id]: deniedSession } }); });
        const nativeDefinition = { kind: 'builtin' as const, id: 'session_summary' };
        const nativeDescriptor = readWidgetDescriptor(null, nativeDefinition)!;
        const named = await renderHook(() => useConfiguredWidgetTarget({ scope, providedContext: {}, descriptor: nativeDescriptor,
            instance: { v: 1, id: 'named', definition: nativeDefinition, bindings: {
                session: { kind: 'value', value: { serverId: scope.serverId, sessionId: deniedSession.id } },
            } }, appRuntime: runtime }));
        expect(named.getCurrent()).toMatchObject({ status: 'denied', reasonCode: 'widget_session_access_denied',
            repair: { kind: 'session_denied', field: { selectedLabel: 'Build release' } } });
        await act(async () => { storage.setState({ sessions: {} }); });
        // A removed render-cache row is not terminal absence; retain the repair
        // until the exact Session's admitted batch part actually returns 404.
        await vi.waitFor(() => expect(named.getCurrent()).toMatchObject({ status: 'loading', reasonCode: 'widget_session_hydrating' }));
        await vi.waitFor(() => expect(sessionRequests).toContainEqual({ method: 'POST', path: '/v2/sessions/read-batch' }));
        missingSession.resolve();
        await vi.waitFor(() => expect(named.getCurrent()).toMatchObject({ status: 'unavailable', reasonCode: 'widget_session_unavailable',
            repair: { kind: 'session_unavailable', field: { path: 'session', label: 'Session' } } }));
        expect(sessionRequests).not.toContainEqual({ method: 'GET', path: '/v2/sessions/named-session' });
        const unavailable = named.getCurrent();
        if (unavailable.status !== 'unavailable') throw new Error('Expected the unavailable Session repair');
        // A missing reference is not a display label; the canonical repair owner
        // names the input instead of disclosing its raw Session id.
        expect(unavailable.repair?.field).not.toHaveProperty('selectedLabel');
        await named.unmount();
        await connection.dispose();
        const successorHttp = createHomeHubArtifactHttpBoundary('other');
        const successorWrites: unknown[] = [];
        const successor = await restoreServerAccountForTest({ serverUrl: 'http://viewer-purpose-recovery.test', accountId: 'other',
            request: async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path !== '/v1/account/entity-rows/connected-accounts/purposes') return successorHttp.request(input, init);
                if (init?.method === 'POST') {
                    const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    successorWrites.push(mutation);
                    return Response.json({ status: 'updated', revision: 2, cursor: 2 });
                }
                return Response.json({ status: 'present', revision: 1, content: {
                    t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } },
                } });
            } });
        try {
            expect(capturedLifetime.isCurrent()).toBe(false);
            expect(await capturedSelect(intent)).toBe(false);
            expect(writes).toHaveLength(1);
            expect(successorWrites).toEqual([]);
        } finally { await successor.dispose(); }
    } finally { missingSession.resolve(); restoreExecutorLoader(); daemon.projections.delete('machine'); clearDaemonMergedProjectionCacheForTests();
        storage.setState(previous, true); await connection.dispose(); syncBridge.dispose(); }
});

it('admits a personal connection pin only from the current Account and refuses shared pins', async () => {
    await import('@/sync/syncEngine');
    const surface = { pluginId: 'com.acme.binding', localId: 'connection' };
    const selected = { service: { pluginId: surface.pluginId, localId: 'cloud' }, accountId: 'mine' };
    const profile = AccountProfileSchema.parse({ id: 'viewer', connectedAccountsV4: [{ ref: selected, status: 'connected', authenticationModeId: 'token',
        configurationReady: true, configurationRevision: null, revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [] }] });
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://personal-pin-mount.test', accountId: 'viewer',
        request: createHomeHubArtifactHttpBoundary('viewer', profile).request });
    const previous = storage.getState();
    const restoreExecutorLoader = await installRealActionExecutorModuleLoader();
    try {
        const { useConfiguredWidgetTarget } = await import('@/sync/domains/widgets/useConfiguredWidgetTarget');
        const foreign = { ...selected, accountId: 'foreign' };
        storage.setState({ profile, profileScope: { serverId: connection.home.id, accountId: profile.id } });
        const valueSchema = { type: 'object', required: ['service', 'accountId'], additionalProperties: false, properties: {
                service: { type: 'object', required: ['pluginId', 'localId'], additionalProperties: false,
                    properties: { pluginId: { type: 'string' }, localId: { type: 'string' } } }, accountId: { type: 'string' },
            } } satisfies PluginJsonSchemaV2;
        const inputs = { fields: [{ path: 'connection', title: 'Connection', widget: 'select' as const, connectedAccountOptions: true as const }] };
        const inputSchema = { type: 'object' as const, properties: { connection: valueSchema }, additionalProperties: false } satisfies PluginJsonSchemaV2;
        const consumer = { pluginId: surface.pluginId, localId: 'metrics' };
        const purposes = { resources: [consumer], connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'read', consumer }] };
        const admitted = PluginUiViewV2Schema.parse({ sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' }, id: surface.localId, renderer: 'widget-native', container: 'widget', target: { kind: 'app' }, inputs, inputSchema, ...purposes });
        expect(admitted).toMatchObject({ inputs, inputSchema });
        const widget = { ...widgetProjectionEntry({ ...surface, entryId: 'connection-widget', target: 'app', inputs, inputSchema, occurrenceId: 'current' }), ...purposes };
        const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [surface.pluginId]: { id: surface.pluginId, displayName: 'Binding', enabled: true, occurrenceId: 'current',
                source: { kind: 'local', locator: `/plugins/${surface.pluginId}` } } },
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: { 'connection-widget': widget } } },
            resourcesById: { metrics: { id: consumer.localId, pluginId: consumer.pluginId, resourceKind: 'config', scope: 'global',
                connectedAccountPurposes: [{ purpose: 'read', serviceRefs: [selected.service] }] } },
        }));
        const descriptor = readWidgetDescriptor(projection, surface)!;
        const home = { serverId: connection.home.id, accountId: 'viewer', owner: { kind: 'home' as const } };
        const { callWorkflowAction } = await import('@/sync/domains/workflows/callWorkflowAction');
        const hook = await renderHook((props: Readonly<{ value: typeof selected; shared: boolean }>) => useConfiguredWidgetTarget({
            scope: props.shared ? { ...home, owner: { kind: 'sessionBoard', sessionId: 'shared' } } : home,
            descriptor, providedContext: {}, instance: { v: 1, id: 'pin', definition: { kind: 'installed', surface },
                bindings: { connection: { kind: 'value', value: props.value } } },
            appRuntime: { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
                machineId: 'machine', serverId: home.serverId, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime() },
        }), { initialProps: { value: selected, shared: false }, wrapper: ({ children }) => React.createElement(AppShellPluginUiProjectionValueProvider,
            { children, value: { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
                machineId: 'machine', serverId: home.serverId, platform: 'web', reloadConnectedAccountProjection: () => {},
                accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {} } }, children) });
        await act(async () => {
            expect(await callWorkflowAction({ actionId: 'action.options.resolve', input: { consumer: { kind: 'widget', surface: home,
                definition: { kind: 'installed', surface } }, fieldPath: 'connection' }, parseResult: value => value }))
                .toMatchObject({ options: [{ value: selected }] });
            await vi.waitFor(() => expect(hook.getCurrent().status, JSON.stringify(hook.getCurrent())).toBe('ready'));
        });
        expect(hook.getCurrent()).toMatchObject({ input: { connection: selected } });
        await hook.rerender({ value: foreign, shared: false });
        expect(hook.getCurrent()).toMatchObject({ status: 'denied' });
        await hook.rerender({ value: selected, shared: true });
        expect(hook.getCurrent()).toMatchObject({ status: 'denied' });
        await hook.unmount();
    } finally { restoreExecutorLoader(); storage.setState(previous, true); await connection.dispose(); }
});

it('validates a mounted schema-only typed pin from its selected origin before exposing a ready Widget target', async () => {
    await import('@/sync/syncEngine');
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://typed-widget-mount.test', accountId: 'viewer',
        request: createHomeHubArtifactHttpBoundary('viewer').request });
    const previous = storage.getState();
    try {
        const { useConfiguredWidgetTarget } = await import('@/sync/domains/widgets/useConfiguredWidgetTarget');
        const inputType = { pluginId: 'com.acme.types', localId: 'repository' };
        const surface = { pluginId: 'com.acme.binding', localId: 'status' };
        const typeOrigin = { serverIdentityId: 'srv_types', materializationRef: {
            machineId: 'machine', materializationId: 'types-materialization', pluginId: inputType.pluginId,
        } };
        const widget = widgetProjectionEntry({ ...surface, entryId: 'typed-widget', target: 'app', inputs: { fields: [
            { path: 'repository', title: 'Repository', widget: 'select', inputType },
        ] }, inputSchema: { type: 'object', properties: { repository: { type: 'object' } }, additionalProperties: false } });
        const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [surface.pluginId]: { id: surface.pluginId, displayName: 'Binding', enabled: true,
                source: { kind: 'local', locator: `/plugins/${surface.pluginId}` } },
                [inputType.pluginId]: { id: inputType.pluginId, displayName: 'Types', enabled: true, occurrenceId: 'current',
                    source: { kind: 'local', locator: `/plugins/${inputType.pluginId}` } } },
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: { 'typed-widget': widget } },
                inputTypes: { family: 'inputTypes', entriesById: { [`${inputType.pluginId}/${inputType.localId}`]: {
                    id: `${inputType.pluginId}/${inputType.localId}`, pluginId: inputType.pluginId, pluginVersion: '1.0.0', occurrenceId: 'current',
                    executionOrigin: typeOrigin,
                    definition: { id: inputType.localId, title: 'Repository', semantic: 'repository',
                        valueSchema: { type: 'object', required: ['repositoryId'], additionalProperties: false,
                            properties: { repositoryId: { type: 'string' } } } },
                } } } },
        }));
        const union = unionPluginUiProjections([{ machineId: 'machine', serverId: connection.home.id, projection,
            phase: 'current', interactionEnabled: true }], new Map([[inputType.pluginId, typeOrigin]]));
        if (!union.pluginUiProjection) throw new Error('Expected the current selected projection');
        let descriptor = readWidgetDescriptor(union.pluginUiProjection, surface)!;
        let currentProjection = union.pluginUiProjection;
        let projectionPhase: 'current' | 'establishing' = 'current';
        const scope = { serverId: connection.home.id, accountId: 'viewer', owner: { kind: 'home' as const } };
        const hook = await renderHook((repositoryId: string | number) => useConfiguredWidgetTarget({ scope, descriptor,
            providedContext: {}, instance: { v: 1, id: 'typed-copy', definition: { kind: 'installed', surface },
                bindings: { repository: { kind: 'value', value: { repositoryId } } } },
            appRuntime: { pluginUiProjection: currentProjection, pluginBrowserProjection: null, phase: projectionPhase, interactionEnabled: projectionPhase === 'current',
                machineId: 'machine', serverId: scope.serverId, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime() },
        }), { initialProps: 42 as string | number });
        expect(hook.getCurrent()).toMatchObject({ status: 'invalid', reasonCode: 'input_type_value_invalid' });
        await hook.rerender('repo');
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', input: { repository: { repositoryId: 'repo' } } });
        const refreshing = unionPluginUiProjections([
            { machineId: 'machine', serverId: connection.home.id, projection, phase: 'establishing', interactionEnabled: false },
            { machineId: 'other-machine', serverId: connection.home.id, projection: normalizePluginUiProjection(
                PluginProjectionV2Schema.parse({ v: 2, generation: 1, installedPackagesById: {}, familiesById: {} })),
                phase: 'current', interactionEnabled: true },
        ], new Map());
        expect(refreshing.phase).toBe('current');
        if (!refreshing.pluginUiProjection) throw new Error('Expected retained type declarations during refresh');
        currentProjection = refreshing.pluginUiProjection;
        await hook.rerender('repo');
        // Known schema remains admissible; its unbound source still has no
        // effect authority (the controller owns offline/refresh presentation).
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', input: { repository: { repositoryId: 'repo' } } });
        await hook.rerender(42);
        expect(hook.getCurrent()).toMatchObject({ status: 'invalid', reasonCode: 'input_type_value_invalid' });
        projectionPhase = 'establishing';
        await hook.rerender('repo');
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', input: { repository: { repositoryId: 'repo' } } });
        currentProjection = { ...projection, inputTypesById: {} };
        await hook.rerender('repo');
        expect(hook.getCurrent()).toMatchObject({ status: 'loading', reasonCode: 'widget_projection_establishing' });
        projectionPhase = 'current';
        currentProjection = union.pluginUiProjection;
        await hook.rerender('repo');
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', input: { repository: { repositoryId: 'repo' } } });
        const typeId = `${inputType.pluginId}/${inputType.localId}`;
        currentProjection = { ...union.pluginUiProjection, inputTypesById: {
            [typeId]: { ...union.pluginUiProjection.inputTypesById[typeId]!, occurrenceId: undefined },
        } };
        await hook.rerender('repo');
        expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', reasonCode: 'widget_projection_unavailable' });
        currentProjection = union.pluginUiProjection;
        descriptor = { ...descriptor, inputs: { fields: [InputFieldHintSchema.parse({ path: 'repository', title: 'Repository',
            widget: 'select', inputType, options: [{ value: { repositoryId: 'repo' }, label: 'Repository' }] })] } };
        await hook.rerender('excluded');
        expect(hook.getCurrent()).toMatchObject({ status: 'invalid', reasonCode: 'widget_input_option_unavailable' });
        await hook.rerender('repo');
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', input: { repository: { repositoryId: 'repo' } } });
        currentProjection = { ...projection, inputTypesById: {} };
        await hook.rerender('repo');
        expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', reasonCode: 'input_type_unavailable' });
        await hook.unmount();
    } finally { storage.setState(previous, true); await connection.dispose(); }
});

it('shows a mounted pin of a Resource-backed typed input while the type\'s serving machine cannot be reached for its choices', async () => {
    await import('@/sync/syncEngine');
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://typed-widget-unreachable.test', accountId: 'viewer',
        request: createHomeHubArtifactHttpBoundary('viewer').request });
    const previous = storage.getState();
    try {
        const { useConfiguredWidgetTarget } = await import('@/sync/domains/widgets/useConfiguredWidgetTarget');
        const inputType = { pluginId: 'com.acme.types', localId: 'kind' };
        const surface = { pluginId: 'com.acme.binding', localId: 'count' };
        const typeOrigin = { serverIdentityId: 'srv_types', materializationRef: {
            machineId: 'machine', materializationId: 'types-materialization', pluginId: inputType.pluginId,
        } };
        const widget = widgetProjectionEntry({ ...surface, entryId: 'count-widget', target: 'app', inputs: { fields: [
            { path: 'filter', title: 'Count', widget: 'select', inputType },
        ] }, inputSchema: { type: 'object', properties: { filter: { type: 'string' } }, additionalProperties: false } });
        const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [surface.pluginId]: { id: surface.pluginId, displayName: 'Binding', enabled: true,
                source: { kind: 'local', locator: `/plugins/${surface.pluginId}` } },
                [inputType.pluginId]: { id: inputType.pluginId, displayName: 'Types', enabled: true, occurrenceId: 'current',
                    source: { kind: 'local', locator: `/plugins/${inputType.pluginId}` } } },
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: { 'count-widget': widget } },
                inputTypes: { family: 'inputTypes', entriesById: { [`${inputType.pluginId}/${inputType.localId}`]: {
                    id: `${inputType.pluginId}/${inputType.localId}`, pluginId: inputType.pluginId, pluginVersion: '1.0.0', occurrenceId: 'current',
                    executionOrigin: typeOrigin,
                    definition: { id: inputType.localId, title: 'Kind', semantic: 'kind', valueSchema: { type: 'string' },
                        options: { resource: 'kinds' } },
                } } } },
        }));
        // The machine that serves the type's choices is unreachable: its origin is retained, not current.
        const union = unionPluginUiProjections([{ machineId: 'machine', serverId: connection.home.id, projection,
            phase: 'retainedOffline', interactionEnabled: false }], new Map([[inputType.pluginId, typeOrigin]]));
        if (!union.pluginUiProjection) throw new Error('Expected the retained projection');
        const descriptor = readWidgetDescriptor(union.pluginUiProjection, surface)!;
        const scope = { serverId: connection.home.id, accountId: 'viewer', owner: { kind: 'home' as const } };
        const hook = await renderHook(() => useConfiguredWidgetTarget({ scope, descriptor, providedContext: {},
            instance: { v: 1, id: 'count-copy', definition: { kind: 'installed', surface }, bindings: { filter: { kind: 'value', value: 'files' } } },
            appRuntime: { pluginUiProjection: union.pluginUiProjection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
                machineId: 'machine', serverId: scope.serverId, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime() } }));
        try {
            await flushHookEffects({ cycles: 3 });
            expect(hook.getCurrent()).toMatchObject({ status: 'ready', input: { filter: 'files' } });
        } finally { await hook.unmount(); }
    } finally { storage.setState(previous, true); await connection.dispose(); }
});

const daemon = vi.hoisted(() => ({ projections: new Map<string, unknown>(), resourceRead: vi.fn() }));
// Replace only the machine network transport. Projection admission, Account,
// exact Session hydration, catalog policy and input binding remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: Readonly<{ machineId: string; method: string; payload: unknown; signal?: AbortSignal }>) => {
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) return daemon.resourceRead(request.machineId, request.payload, request.signal);
        if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
            throw new Error(`Unexpected daemon RPC: ${request.method}`);
        return { protocolVersion: 1, projection: daemon.projections.get(request.machineId) };
    },
}));

it('resolves installed Board Count choices and input admission on the consumer Session machine', async () => {
    await import('@/sync/syncEngine');
    const http = createHomeHubArtifactHttpBoundary('viewer');
    let approvalHttp: ReturnType<typeof createLayoutArtifactHttpBoundary<ReturnType<typeof ApprovalRequestV2Schema.parse>>> | null = null;
    let areaHttp: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | null = null;
    const serverIdentityId = 'srv_board_counter_inputs';
    const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId } } });
    const invocations: ExternalActionRequesterInvocationV1[] = [];
    const optionsHttp = await createExternalActionAccountHttpBoundary({ serverUrl: 'http://board-counter-input.test',
        serverIdentityId, accountId: 'viewer', machineId: 'z-counter-machine', actionId: 'action.options.resolve', tokenEpoch: 0,
        execute: (_input, context) => {
            invocations.push(context.invocation);
            return { actionId: 'widgets.catalog.list', fieldPath: 'filter', optionsSourceId: 'plugin-input:examples.widget-areas/count-kind',
                options: [{ value: 'files', label: 'Files' }, { value: 'folders', label: 'Folders' }] };
        },
    });
    const missingConsumerHttp = await createExternalActionAccountHttpBoundary({ serverUrl: 'http://board-counter-input.test',
        serverIdentityId, accountId: 'viewer', machineId: 'a-other-machine', actionId: 'action.options.resolve', tokenEpoch: 0,
        execute: () => null,
        failure: () => ({ errorCode: 'input_type_consumer_unavailable', error: 'input_type_consumer_unavailable' }),
    });
    const { encodeSessionSystemRecordRevision } = await import('../../../../../server/sources/app/session/systemRecords/sessionSystemRecordRevision');
    const instanceId = 'c15c9e20-f054-4681-ae82-cb89c6cf5533';
    let localId = 'counter';
    let boardRecordReads = 0;
    const instance = () => ({ v: 1 as const, id: instanceId, definition: { kind: 'installed' as const,
        surface: { pluginId: 'examples.widget-areas', localId } }, bindings: {
        directory: { kind: 'value' as const, value: '/home/happier/happier-dev/packages/plugin-sdk/examples/widget-areas' },
        filter: { kind: 'value' as const, value: 'files' },
    } });
    const record = () => ({ id: 'counter-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: instanceId },
        content: { t: 'plain', v: { v: 1, title: 'Directory count', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance: instance() } } }, revision: encodeSessionSystemRecordRevision({ id: 'counter-row', version: 1 }),
        createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' });
    if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Expected Board feature');
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://board-counter-input.test', serverIdentityId, accountId: 'viewer',
        credentials: { token: createAccountTokenForTests('viewer', { currentAccount: true }) }, request: async (input, init) => {
        const url = new URL(String(input));
        if (areaHttp && (url.pathname.startsWith(`/v1/artifacts/${areaHttp.artifactId}`)
            || url.pathname === '/v1/artifacts' && init?.method === 'POST'
                && Reflect.get(JSON.parse(String(init.body)), 'id') === areaHttp.artifactId)) return areaHttp.request(input, init);
        if (approvalHttp && url.pathname.startsWith(`/v1/artifacts/${approvalHttp.artifactId}`)) return approvalHttp.request(input, init);
        if (url.pathname === '/v1/machines') return Response.json([missingConsumerHttp.machine, optionsHttp.machine]);
        if (url.pathname === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
            id => [missingConsumerHttp.machine, optionsHttp.machine].find(machine => machine.id === id) ?? null);
        const optionsRequest = init?.body && (url.pathname.startsWith('/v1/actions/') || url.pathname.startsWith('/v1/action-'))
            ? ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(JSON.parse(String(init.body))) : null;
        const options = await (optionsRequest?.success && optionsRequest.data.machineId === 'a-other-machine'
            ? missingConsumerHttp : optionsHttp).handle(url, init);
        if (options) return options;
        if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Promise.resolve(Response.json(features));
        if (url.pathname === '/v2/sessions/counter-session/system-records/record') { boardRecordReads++; return Promise.resolve(Response.json({ record: url.searchParams.get('kind') === 'item.v1' ? record() : null })); }
        if (url.pathname === '/v2/sessions/counter-session/system-records') { boardRecordReads++; return Promise.resolve(Response.json({ records: [record()], nextCursor: null, hasNext: false })); }
        return http.request(input, init);
    } });
    const previous = storage.getState();
    let tree: renderer.ReactTestRenderer | null = null;
    const account = await captureLazyActionAccountContext(connection.home.id);
    try {
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId: account.serverId, snapshot: { status: 'ready', features } });
        const scope = { serverId: account.serverId, accountId: account.accountId };
        const session = createSessionFixture({ id: 'counter-session', serverId: scope.serverId,
            metadata: { path: '/repo', machineId: 'z-counter-machine', host: 'counter' } });
        const machines = [createMachineFixture({ id: 'a-other-machine', activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!, host: 'A other' } }),
            createMachineFixture({ id: 'z-counter-machine', activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!, host: 'Z counter' } })];
        storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }), sessions: { [session.id]: session },
            sessionListRowsByServerId: { [scope.serverId]: { [session.id]: createSessionListRenderableSessionFixture({ ...session }) } },
            machines: Object.fromEntries(machines.map(machine => [machine.id, machine])), machineListByServerId: { [scope.serverId]: machines } });
        const pluginId = 'examples.widget-areas';
        const inputType = { pluginId, localId: 'count-kind' };
        const typeOrigin = { serverIdentityId, materializationRef: {
            machineId: 'z-counter-machine', materializationId: 'counter-materialization', pluginId,
        } };
        const countKindSchema = { type: 'string', enum: ['files', 'folders'] } satisfies PluginJsonSchemaV2;
        const inputSchema: PluginJsonSchemaV2 = { type: 'object', additionalProperties: false, required: ['directory', 'filter'],
            properties: { directory: { type: 'string', minLength: 1 }, filter: countKindSchema } };
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [pluginId]: { ...widgetInstalledPackage(pluginId, 'Widget areas'), occurrenceId: 'counter-occurrence',
                source: { kind: 'local', locator: `/plugins/${pluginId}` } } },
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(['counter', 'snapshot-counter'].map(localId => [localId,
                widgetProjectionEntry({ pluginId, localId, target: 'app', occurrenceId: 'counter-occurrence', inputSchema, inputs: { fields: [
                    { path: 'directory', title: 'Directory on the serving machine', widget: 'text', required: true },
                    { path: 'filter', title: 'Count', widget: 'select', required: true, inputType },
                ] } })])) }, inputTypes: { family: 'inputTypes', entriesById: { [`${pluginId}/count-kind`]: { id: `${pluginId}/count-kind`, pluginId,
                    executionOrigin: typeOrigin,
                    pluginVersion: '1.0.0', occurrenceId: 'counter-occurrence', definition: { id: 'count-kind', title: 'Count kind', semantic: 'directory-count-kind',
                        valueSchema: countKindSchema, options: { resource: 'count-kinds' } } } } } } });
        daemon.projections.set('z-counter-machine', projection);
        clearDaemonMergedProjectionCacheForTests();
        const projected = unionPluginUiProjections([{ machineId: 'z-counter-machine', serverId: scope.serverId, projection: normalizePluginUiProjection(projection),
            phase: 'current', interactionEnabled: true }], new Map([[pluginId, typeOrigin]]));
        await act(async () => { tree = renderer.create(<AppShellPluginUiProjectionValueProvider value={{ ...projected,
            pluginBrowserProjection: null, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables() {}, reloadConnectedAccountProjection() {} }}><></></AppShellPluginUiProjectionValueProvider>); });
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const { useInputFieldOptions } = await import('@/components/sessions/actions/useInputFieldOptions');
        const workBoardHttp = createWorkBoardArtifactBoundary({ v: 1, boards: [{ id: 'pins', name: 'Pins',
            source: { picked: [] }, mode: 'canvas', snap: true, positionsByItemRef: {}, pinnedInSessions: false }] });
        const executor = createDefaultActionExecutor({ workBoardArtifacts: createWorkBoardArtifactPortV1(workBoardHttp.transport) });
        const surface = { ...scope, owner: { kind: 'sessionBoard' as const, sessionId: session.id } };
        const { resolveUiAccountActionFallbackMachineId } = await import('./accountActionDeps');
        expect(resolveUiAccountActionFallbackMachineId(scope)).toBe('a-other-machine');
        for (const current of ['counter', 'snapshot-counter']) {
            localId = current;
            const definition = { kind: 'installed' as const, surface: { pluginId, localId } };
            const admitted = await executor.execute('widgets.item.inputs.validate', { ref: { surface, instanceId }, bindings: instance().bindings },
                { surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId });
            expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true, result: { status: 'ready',
                input: { directory: instance().bindings.directory.value, filter: 'files' } } });
            const options = await executor.execute('action.options.resolve', { consumer: { kind: 'widget', surface, definition }, fieldPath: 'filter',
                draftInput: { directory: '/home/happier/happier-dev/packages/plugin-sdk/examples/widget-areas' } },
                { surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
                    externalActionTarget: { kind: 'machine', machineId: 'a-other-machine' } });
            expect(options, JSON.stringify(options)).toMatchObject({ ok: true, result: { options: [{ value: 'files' }, { value: 'folders' }] } });
            const field = { path: 'filter', inputType };
            const hook = await renderHook(() => useInputFieldOptions({ enabled: true, serverId: scope.serverId,
                accountLifetime: account.accountLifetime, machineId: 'a-other-machine',
                requests: [{ field, consumer: { kind: 'widget', surface, definition }, draftInput: { directory: instance().bindings.directory.value } }] }));
            try {
                await vi.waitFor(() => expect(hook.getCurrent().state(field)).toMatchObject({ status: 'ready',
                    options: [{ value: 'files' }, { value: 'folders' }] }));
            } finally { await hook.unmount(); }
        }
        // App widgets have no Session target. The Account's first reachable
        // machine has no Count consumer; setup and write admission must both
        // use the type producer retained by the real union projection.
        {
            const pinnedSurface = { ...scope, owner: { kind: 'pluginArea' as const, pluginId,
                pageId: 'gallery', area: 'pinned' } };
            areaHttp = createLayoutArtifactHttpBoundary('viewer', {
                artifactId: buildWidgetSurfaceArtifactIdV1(pinnedSurface), kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
                defaultLayout: { v: 1, surface: pinnedSurface, items: [] },
                parseLayout: value => WidgetAreaLayoutV1Schema.parse(value), buildHeader: buildWidgetSurfaceArtifactHeaderV1,
            });
            areaHttp.seed({ v: 1, surface: pinnedSurface, items: [] });
            const pinned = { ...instance(), id: 'pinned-count' };
            const context = { surface: 'ui' as const, serverId: scope.serverId, expectedAccountId: scope.accountId };
            const options = await executor.execute('action.options.resolve', {
                consumer: { kind: 'widget', surface: pinnedSurface, definition: pinned.definition }, fieldPath: 'filter',
                draftInput: { directory: pinned.bindings.directory.value },
            }, { ...context, externalActionTarget: { kind: 'machine', machineId: 'z-counter-machine' } });
            expect(options, JSON.stringify(options)).toMatchObject({ ok: true, result: { options: [{ value: 'files' }, { value: 'folders' }] } });
            const { createWidgetAreaActionDepsV1 } = await import('./widgetAreaActionDeps');
            const { createUiAccountAction } = await import('./accountActionDeps');
            const relay = createUiAccountAction({ account });
            const base = createActionExecutorBoundaryFixture({ ...createWidgetAreaActionDepsV1(account), widgetAccountScope: () => account,
                readAdmittedInputTypeOptions: ({ input, context }) => relay({ actionId: 'action.options.resolve', input, context }) });
            const owner = createWidgetInputActionDepsV1(account, { ...base, ...createWidgetCatalogActionDepsV1(account, base) }).widgetInputs!;
            const admitted = await owner.resolve({ ref: { surface: pinnedSurface, instanceId: pinned.id }, instance: pinned,
                admission: 'configuration', context: { ...context, authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: scope.accountId } });
            expect(admitted, JSON.stringify(admitted)).toEqual({ status: 'ready', input: {
                directory: pinned.bindings.directory.value, filter: 'files',
            } });
            const added = await executor.execute('widgets.item.add', { surface: pinnedSurface, instance: pinned }, context);
            expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
            expect(areaHttp.layout().items).toMatchObject([{ kind: 'widget', instance: pinned }]);
            const edited = await executor.execute('widgets.item.inputs.set', {
                ref: { surface: pinnedSurface, instanceId: pinned.id }, bindings: { filter: { kind: 'value', value: 'folders' } }, paths: ['filter'],
            }, context);
            expect(edited, JSON.stringify(edited)).toMatchObject({ ok: true });
            expect(areaHttp.layout().items).toMatchObject([{ kind: 'widget', instance: { bindings: {
                directory: pinned.bindings.directory, filter: { kind: 'value', value: 'folders' },
            } } }]);
            for (const owner of [{ kind: 'home' as const }, { kind: 'workBoard' as const, boardId: 'pins' }]) {
                const surface = { ...scope, owner };
                const copy = { ...pinned, id: `pin-${owner.kind}` };
                const added = await executor.execute('widgets.item.add', { surface, instance: copy }, context);
                expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
                expect(await executor.execute('widgets.item.inputs.validate', {
                    ref: { surface, instanceId: copy.id }, bindings: copy.bindings,
                }, context)).toMatchObject({ ok: true, result: { status: 'ready' } });
                expect(await executor.execute('widgets.item.inputs.set', {
                    ref: { surface, instanceId: copy.id }, bindings: { filter: { kind: 'value', value: 'folders' } }, paths: ['filter'],
                }, context)).toMatchObject({ ok: true });
                expect(await executor.execute('widgets.item.list', { surface }, context)).toMatchObject({ ok: true, result: {
                    instances: expect.arrayContaining([expect.objectContaining({ instance: { ...copy,
                        bindings: { ...copy.bindings, filter: { kind: 'value', value: 'folders' } } } })]),
                } });
            }
        }
        // A CLI proposal is executed by the approving Account app. Keep its real
        // catalog/type/options composition and inspect the durable replay result.
        {
            const filter = 'files';
            const artifactId = 'approved-counter-files';
            const actionArgs = { surface, instance: { ...instance(), id: 'approved-new-counter', bindings: {
                ...instance().bindings, filter: { kind: 'value' as const, value: filter },
            } } };
            const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
                createdBy: { surface: 'cli', sessionId: session.id }, requestedSurface: 'cli',
                approval: { flow: 'deferred', result: 'required' }, actionId: 'widgets.item.add', actionArgs, summary: 'Add directory count',
                executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
                    serverId: scope.serverId, serverIdentityId, accountId: scope.accountId, sessionId: session.id,
                    machineId: 'z-counter-machine', target: { kind: 'machine', machineId: 'z-counter-machine' },
                    actionId: 'widgets.item.add', requestId: artifactId } });
            approvalHttp = createLayoutArtifactHttpBoundary('viewer', { artifactId, kind: 'approval_request.v1', defaultLayout: request,
                parseLayout: value => ApprovalRequestV2Schema.parse(value), buildHeader: buildApprovalRequestArtifactHeaderV1 });
            approvalHttp.seed(request);
            daemon.projections.set('z-counter-machine', PluginProjectionV2Schema.parse({ ...projection,
                generation: 2, familiesById: { ...projection.familiesById, inputTypes: { family: 'inputTypes', entriesById: {} } } }));
            clearDaemonMergedProjectionCacheForTests();
            const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' },
                { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId });
            const expected = { errorCode: 'widget_inputs_invalid', details: { status: 'unavailable', fields: [
                    { path: 'filter', status: 'unavailable', reasonCode: 'input_type_unavailable' },
                ] } };
            expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'failed', execution: expected } });
            expect(approvalHttp.layout()).toMatchObject({ status: 'failed', execution: expected });
            daemon.projections.set('z-counter-machine', projection);
            clearDaemonMergedProjectionCacheForTests();
        }
        expect(invocations.length).toBeGreaterThan(0);
        expect(invocations.every(invocation => invocation.surface === 'ui' && invocation.authority === 'present_user'
            && invocation.caller.kind === 'host')).toBe(true);
        const catalog = createWidgetCatalogActionDepsV1(account, {});
        const definition = { kind: 'installed' as const, surface: { pluginId, localId: 'counter' } };
        const selected = { ...session, id: 'selected-counter-session' };
        storage.setState({ sessions: { [session.id]: session, [selected.id]: selected } });
        const readFields = () => catalog.widgetCatalog!.readInstalledInputFields!({ surface, definition,
            context: { surface: 'ui', authority: 'present_user' }, boundSession: { serverId: scope.serverId, sessionId: selected.id } });
        const beforeMetadata = boardRecordReads;
        expect(await readFields()).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'filter', inputType })]));
        expect(boardRecordReads).toBe(beforeMetadata);
        for (const denied of [session, selected]) {
            storage.setState({ sessions: { [session.id]: session, [selected.id]: selected,
                [denied.id]: { ...denied, access: { ...denied.access!, capabilities: { ...denied.access!.capabilities, readTranscript: false } } } } });
            expect(await readFields()).toMatchObject({ ok: false, errorCode: 'widget_read_denied' });
        }
    } finally {
        if (tree) await act(async () => { tree!.unmount(); });
        storage.setState(previous, true); account.dispose(); await connection.dispose();
    }
});

it('admits and refreshes a B-only stored widget using current B inputs and Resource declarations', async () => {
    await import('@/sync/syncEngine');
    const { encodeSessionSystemRecordRevision } = await import('../../../../../server/sources/app/session/systemRecords/sessionSystemRecordRevision');
    const http = createHomeHubArtifactHttpBoundary('viewer');
    let areaHttp: ReturnType<typeof createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>> | null = null;
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Expected canonical Board feature');
    let boardItem: unknown = null;
    let itemVersion = 0;
    const record = (kind: string, localId: string, value: unknown) => ({ id: `${kind}-row`,
        address: { owner: 'host', namespace: 'surface', kind, localId }, content: { t: 'plain', v: value },
        revision: encodeSessionSystemRecordRevision({ id: `${kind}-row`, version: kind === 'item.v1' ? itemVersion : 1 }),
        createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' });
    // Real plain system-record envelopes at the HTTP persistence boundary;
    // canonical repository, Board adapter and Action port open them normally.
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://widget-input-binding.test', accountId: 'viewer', request: async (input, init) => {
        const url = new URL(String(input));
        if (areaHttp && (url.pathname === `/v1/artifacts/${areaHttp.artifactId}`
            || url.pathname.startsWith(`/v1/artifacts/${areaHttp.artifactId}/`)
            || url.pathname === '/v1/artifacts' && init?.method === 'POST')) return areaHttp.request(input, init);
        if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(features);
        if (url.pathname === '/v2/sessions/physical-a/system-records/record') return Response.json({ record: url.searchParams.get('kind') === 'layout.v1'
            ? record('layout.v1', 'layout', { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'copy-b', width: 'wide' }] }] })
            : boardItem ? record('item.v1', 'copy-b', boardItem) : null });
        if (url.pathname === '/v2/sessions/physical-a/system-records') return Response.json({ records: boardItem ? [record('item.v1', 'copy-b', boardItem)] : [], nextCursor: null, hasNext: false });
        return http.request(input, init);
    } });
    const previous = storage.getState();
    let tree: renderer.ReactTestRenderer | null = null;
    const account = await captureLazyActionAccountContext(connection.home.id);
    try {
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId: account.serverId, snapshot: { status: 'ready', features } });
        const scope = { serverId: account.serverId, accountId: account.accountId };
        const areaSurface = { ...scope, owner: { kind: 'pluginArea' as const, pluginId: 'com.acme.binding', pageId: 'overview', area: 'pinned' } };
        areaHttp = createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('viewer', { artifactId: buildWidgetSurfaceArtifactIdV1(areaSurface),
            kind: WIDGET_SURFACE_ARTIFACT_KIND_V1, defaultLayout: { v: 1, surface: areaSurface, items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value) });
        const a = createSessionFixture({ id: 'physical-a', serverId: scope.serverId, metadata: { path: '/a', machineId: 'machine-a', host: 'a' } });
        const b = createSessionFixture({ id: 'selected-b', serverId: scope.serverId, metadata: { path: '/b', machineId: 'machine-b', host: 'b' } });
        const machines = [createMachineFixture({ id: 'machine-a' }), createMachineFixture({ id: 'machine-b' })];
        storage.setState({ sessions: { [a.id]: a, [b.id]: b },
            sessionListRowsByServerId: { [scope.serverId]: Object.fromEntries([a, b].map(session => [session.id,
                createSessionListRenderableSessionFixture({ ...session })])) },
            machines: Object.fromEntries(machines.map(machine => [machine.id, machine])), machineListByServerId: { [scope.serverId]: machines } });
        const surface = { pluginId: 'com.acme.binding', localId: 'status' };
        const inputSchema = { type: 'object' as const, required: ['session', 'mode'], additionalProperties: false,
            properties: { session: { type: 'object' as const, required: ['serverId', 'sessionId'], additionalProperties: false,
                properties: { serverId: { type: 'string' as const }, sessionId: { type: 'string' as const } } }, mode: { type: 'string' as const } } };
        const entry = (choice: string) => ({ ...surface, inputSchema, sessionInputPath: 'session', occurrenceId: 'binding-occurrence',
            sizeDeclaration: { sizes: choice === 'current-b' ? ['medium', 'full', 'tall'] : ['medium'], defaultSize: choice === 'current-b' ? 'tall' : 'medium' } satisfies import('@happier-dev/protocol/widgets').WidgetSizeDeclarationV1,
            resources: [{ pluginId: surface.pluginId, localId: `${choice}-state` }], inputs: { fields: [
            { path: 'session', title: 'Session', widget: 'json' as const, required: true },
            { path: 'mode', title: 'Mode', widget: 'select' as const, required: true, options: [{ value: choice, label: choice }] },
        ] } });
        const installed = { [surface.pluginId]: { ...widgetInstalledPackage(surface.pluginId, 'Binding'), occurrenceId: 'binding-occurrence', source: { kind: 'local', locator: `/plugins/${surface.pluginId}` } } };
        const resources = (choice: string) => ({ [buildQualifiedPluginContributionKey({ pluginId: surface.pluginId, localId: `${choice}-state` })]: { id: `${choice}-state`, pluginId: surface.pluginId, resourceKind: 'config' as const,
            contentType: 'application/json', scope: 'session' as const } });
        const projection = (choice?: string) => PluginProjectionV2Schema.parse({ v: 2, generation: 1, installedPackagesById: installed, actionsById: {},
            resourcesById: choice ? resources(choice) : {},
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: choice ? { widget: widgetProjectionEntry(entry(choice)) } : {} } } });
        daemon.projections.set('machine-a', projection());
        daemon.projections.set('machine-b', projection('current-b'));
        clearDaemonMergedProjectionCacheForTests();
        const metadata = widgetProjectionOf([entry('metadata-only')], installed, resources('metadata-only'));
        const projected = unionPluginUiProjections([{ machineId: 'machine-b', serverId: scope.serverId, projection: metadata,
            phase: 'current', interactionEnabled: true }], new Map());
        await act(async () => { tree = renderer.create(<AppShellPluginUiProjectionValueProvider value={{ ...projected,
            pluginBrowserProjection: null, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables() {}, reloadConnectedAccountProjection() {} }}><></></AppShellPluginUiProjectionValueProvider>); });
        const physical = { ...scope, owner: { kind: 'sessionBoard' as const, sessionId: a.id } };
        const definition = { kind: 'installed' as const, surface };
        expect(readWidgetDescriptor(readCurrentAppShellPluginUiProjection(), definition)).not.toBeNull();
        expect(readMachineControlTargetForSession({ ...scope, sessionId: b.id })).toMatchObject({ machineId: 'machine-b' });
        const physicalCandidates = await readWidgetActionCandidatesV1(physical, account);
        expect(Array.isArray(physicalCandidates) && physicalCandidates.some(candidate => 'surface' in candidate && candidate.surface.localId === surface.localId)).toBe(false);
        const bCandidates = await readWidgetActionCandidatesV1(physical, account, undefined, { serverId: scope.serverId, sessionId: b.id });
        expect(bCandidates).toEqual(expect.arrayContaining([expect.objectContaining({ surface })]));
        // Static input admission and the public Refresh use real descriptor
        // resolution; only HTTP and daemon network transports are replaced.
        const inputs = createWidgetInputActionDepsV1(account, createActionExecutorBoundaryFixture(createWidgetCatalogActionDepsV1(account, createActionExecutorBoundaryFixture({})))).widgetInputs!;
        const instance = { v: 1 as const, id: 'copy-b', definition, bindings: {
            session: { kind: 'value' as const, value: { serverId: scope.serverId, sessionId: b.id } },
            mode: { kind: 'value' as const, value: 'current-b' },
        } };
        const request = { ref: { surface: physical, instanceId: instance.id }, instance, context: { serverId: scope.serverId } };
        itemVersion += 1;
        boardItem = { v: 1, title: 'Bound B', frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'widget', instance } };
        expect(await inputs.resolve(request)).toEqual({ status: 'ready', input: { session: { serverId: scope.serverId, sessionId: b.id }, mode: 'current-b' } });
        expect(await inputs.readSizeDeclaration(request)).toEqual({ sizes: ['medium', 'full', 'tall'], defaultSize: 'tall' });
        expect(await inputs.resolve({ ...request, instance: { ...instance, bindings: { ...instance.bindings, mode: { kind: 'value', value: 'metadata-only' } } } }))
            .toMatchObject({ status: 'invalid', fields: [{ path: 'mode', reasonCode: 'widget_input_option_unavailable' }] });
        daemon.resourceRead.mockReset();
        const resourceResult = { ok: true, resource: { pluginId: surface.pluginId, localId: 'current-b-state' },
            kind: 'config', contentType: 'application/json', digest: `sha256:${'b'.repeat(64)}`, bytesBase64: 'MQ==' };
        daemon.resourceRead.mockResolvedValue(resourceResult);
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { serverId: scope.serverId, expectedAccountId: scope.accountId, surface: 'ui' as const };
        const { createUiClientActionReverseHandler } = await import('./clientActionReverseDispatch');
        const receive = createUiClientActionReverseHandler({ ...scope, isCurrent: account.accountLifetime!.isCurrent });
        const remote = createActionExecutor(createActionExecutorBoundaryFixture({ clientActionExecute: createClientActionReverseDispatcher(() => ({
            hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
            // The network hop is the boundary; the exact B read and both dispatchers remain real.
            callConnectedClientRpc: async (_method, payload, options) => {
                options.onIssued();
                return { ok: true, result: await receive(payload, { signal: options.signal ?? new AbortController().signal }) };
            },
        })) }));
        expect(await remote.execute('widgets.item.refresh', { ref: request.ref }, { ...context, surface: 'cli', authority: 'present_user' }))
            .toEqual({ ok: true, result: { ref: request.ref, status: 'refreshed' } });
        expect(daemon.resourceRead).toHaveBeenCalledTimes(1);
        for (const call of daemon.resourceRead.mock.calls) expect(call.slice(0, 2)).toEqual(['machine-b', expect.objectContaining({
            resource: { pluginId: surface.pluginId, localId: 'current-b-state' }, context: { kind: 'session', sessionId: b.id },
            expectedCallerOccurrenceId: 'binding-occurrence',
        })]);
        let pageCurrent = true;
        const areaPort = createPluginWidgetAreaHostPortV1({ scope, pluginId: surface.pluginId, pageId: 'overview',
            declarations: [{ name: 'pinned', contextSchema: { type: 'object', properties: { session: inputSchema.properties.session },
                required: ['session'], additionalProperties: false } }], isCurrent: () => pageCurrent && account.accountLifetime!.isCurrent(),
            execute: (id, input, areaContext) => executor.execute(id, input, { ...context, ...areaContext, bypassApprovals: true }) });
        const areaInstance = { ...instance, bindings: { ...instance.bindings, session: { kind: 'context' as const, slot: 'session' } } };
        const pageContext = { session: { serverId: scope.serverId, sessionId: b.id } };
        const added = await areaPort.execute({ area: 'pinned', context: pageContext, operation: { actionId: 'widgets.item.add', instance: areaInstance } });
        expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
        // Exercise the ungrouped follow binding: the group below pins B and would
        // conceal reverse Refresh losing the mounted page's Session context.
        const { PluginPageWidgetArea } = await import('@/components/widgets/area/PluginPageWidgetArea');
        const { useWidgetDefinitionFlows } = await import('@/components/widgets/definitions/useWidgetDefinitionFlows');
        const { WidgetAboutPanel } = await import('@/components/widgets/definitions/WidgetAboutPanel');
        const { resolveMountedWidgetAreaLayoutSelectionOwner } = await import('@/sync/domains/widgets/widgetAreaLayoutSelection');
        const pagePort: PluginUiWidgetAreaPresentation['port'] = { execute: (operation, context, options) =>
            areaPort.execute({ area: 'pinned', context, operation, layoutId: options?.layoutId }, options?.signal) };
        let about: ReturnType<typeof useWidgetDefinitionFlows> | undefined;
        function FollowedArea({ duplicate = false }: { duplicate?: boolean }) {
            const flows = useWidgetDefinitionFlows({ scope: areaSurface, instance: areaInstance,
                anchorRef: React.useRef(null), providedContext: { session: [pageContext.session] }, testID: 'followed' });
            about = flows;
            return <>
                <PluginPageWidgetArea area="pinned" context={pageContext} port={pagePort} surfaceName="Binding" />
                {duplicate ? <PluginPageWidgetArea area="pinned" context={pageContext} port={pagePort} surfaceName="Binding" /> : null}
                {flows.panel}
            </>;
        }
        const mountedPage = (content: React.ReactNode) => <AppShellPluginUiProjectionValueProvider value={{ ...projected,
            pluginBrowserProjection: null, platform: 'web', accountLifetime: account.accountLifetime!, clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables() {}, reloadConnectedAccountProjection() {} }}>{content}</AppShellPluginUiProjectionValueProvider>;
        const areaRef = { surface: areaSurface, instanceId: areaInstance.id };
        const areaWrites = areaHttp.writes.length;
        try {
            await act(async () => { tree!.update(mountedPage(<FollowedArea />)); });
            await vi.waitFor(() => expect(resolveMountedWidgetAreaLayoutSelectionOwner(areaSurface)).not.toHaveProperty('ok'));
            await act(async () => { about!.about!(); });
            const refreshAbout = tree!.root.findByType(WidgetAboutPanel).props.onRefresh;
            daemon.resourceRead.mockClear();
            await act(async () => { expect(await refreshAbout()).toBe(true); });
            expect(daemon.resourceRead).toHaveBeenCalledTimes(1);
            expect(daemon.resourceRead.mock.calls[0]?.slice(0, 2)).toEqual(['machine-b', expect.objectContaining({
                resource: { pluginId: surface.pluginId, localId: 'current-b-state' }, context: { kind: 'session', sessionId: b.id },
                expectedCallerOccurrenceId: 'binding-occurrence',
            })]);
            daemon.resourceRead.mockClear();
            expect(await remote.execute('widgets.item.refresh', { ref: areaRef }, { ...context, surface: 'cli', authority: 'present_user' }))
                .toEqual({ ok: true, result: { ref: areaRef, status: 'refreshed' } });
            expect(daemon.resourceRead).toHaveBeenCalledTimes(1);
            // A mounted address does not outlive its actual host port's admission.
            pageCurrent = false;
            daemon.resourceRead.mockClear();
            expect(await remote.execute('widgets.item.refresh', { ref: areaRef }, { ...context, surface: 'cli', authority: 'present_user' }))
                .toMatchObject({ ok: false, errorCode: 'widget_area_scope_retired' });
            expect(daemon.resourceRead).not.toHaveBeenCalled();
            pageCurrent = true;
            await act(async () => { tree!.update(mountedPage(<FollowedArea duplicate />)); });
            await vi.waitFor(() => expect(resolveMountedWidgetAreaLayoutSelectionOwner(areaSurface))
                .toMatchObject({ ok: false, errorCode: 'widget_area_layout_owner_ambiguous' }));
            daemon.resourceRead.mockClear();
            expect(await remote.execute('widgets.item.refresh', { ref: areaRef }, { ...context, surface: 'cli', authority: 'present_user' }))
                .toMatchObject({ ok: false, errorCode: 'widget_area_layout_owner_ambiguous' });
            expect(daemon.resourceRead).not.toHaveBeenCalled();
        } finally { pageCurrent = true; await act(async () => { tree!.update(mountedPage(null)); }); }
        daemon.resourceRead.mockClear();
        expect(await remote.execute('widgets.item.refresh', { ref: areaRef }, { ...context, surface: 'cli', authority: 'present_user' }))
            .toMatchObject({ ok: false, errorCode: 'widget_area_layout_owner_unavailable' });
        expect(daemon.resourceRead).not.toHaveBeenCalled();
        expect(areaHttp.writes).toHaveLength(areaWrites);
        expect(await executor.execute('widgets.group.create', { surface: areaSurface, groupId: 'group-b', instanceIds: [instance.id],
            context: { session: { kind: 'value', value: pageContext.session } } }, { ...context, bypassApprovals: true }))
            .toMatchObject({ ok: true });
        const followsGroup = await areaPort.execute({ area: 'pinned', context: { session: { serverId: scope.serverId, sessionId: a.id } },
            operation: { actionId: 'widgets.item.inputs.validate', instanceId: instance.id, bindings: areaInstance.bindings } });
        expect(followsGroup).toMatchObject({ ok: true, result: { status: 'ready', input: { session: pageContext.session } } });
        expect(await areaPort.execute({ area: 'pinned', context: pageContext, operation: { actionId: 'widgets.item.inputs.validate', instanceId: instance.id, bindings: areaInstance.bindings } }))
            .toMatchObject({ ok: true, result: { status: 'ready', input: { session: pageContext.session } } });
        expect(await areaPort.execute({ area: 'pinned', context: pageContext, operation: { actionId: 'widgets.item.size.set', instanceId: instance.id, size: 'full' } })).toMatchObject({ ok: true });
        const admittedSizeWrites = areaHttp.writes.length;
        expect(await areaPort.execute({ area: 'pinned', context: pageContext, operation: { actionId: 'widgets.item.size.set', instanceId: instance.id, size: 'wide' } }))
            .toMatchObject({ ok: false, errorCode: 'widget_size_unsupported' });
        expect(areaHttp.writes).toHaveLength(admittedSizeWrites);
        expect(await areaPort.execute({ area: 'pinned', context: pageContext, operation: { actionId: 'widgets.item.refresh', instanceId: instance.id } }))
            .toMatchObject({ ok: true, result: { status: 'refreshed', ref: { surface: { owner: { kind: 'pluginArea' } } } } });
        expect(daemon.resourceRead.mock.calls.at(-1)?.slice(0, 2)).toEqual(['machine-b', expect.objectContaining({
            resource: { pluginId: surface.pluginId, localId: 'current-b-state' }, context: { kind: 'session', sessionId: b.id },
        })]);
        daemon.resourceRead.mockReset();
        daemon.resourceRead.mockResolvedValue(resourceResult);
        const writesAfterAreaEdits = areaHttp.writes.length;
        if (!account.accountLifetime) throw new Error('Expected canonical Account lifetime');
        const mount = createPluginDeclaredResourceStore({ accountLifetime: account.accountLifetime, pluginId: surface.pluginId,
            machineId: 'machine-b', serverId: scope.serverId, expectedCallerOccurrenceId: 'binding-occurrence', sessionId: b.id,
            resourcesById: resources('current-b'), resourceDeclarationsComplete: true })!;
        const mountedEntry = mount.getEntry('current-b-state');
        const releaseMount = mountedEntry.subscribe(() => {}, false);
        try {
            await vi.waitFor(() => { expect(mountedEntry.getSnapshot().digest).toBe(resourceResult.digest); });
            let acknowledge: ((value: typeof resourceResult) => void) | undefined;
            const read = new Promise<typeof resourceResult>(resolve => { acknowledge = resolve; });
            daemon.resourceRead.mockReturnValue(read);
            const pending = executor.execute('widgets.item.refresh', { ref: request.ref }, context);
            await vi.waitFor(() => { expect(daemon.resourceRead).toHaveBeenCalledTimes(2); });
            releaseMount(); mount.dispose();
            // The Action's static demand protects this requested read after
            // the last physical subscriber and its store lease disappear.
            expect(daemon.resourceRead.mock.calls[1]?.[2]?.aborted).toBe(false);
            acknowledge!(resourceResult);
            expect(await pending).toEqual({ ok: true, result: { ref: request.ref, status: 'refreshed' } });
            expect(daemon.resourceRead).toHaveBeenCalledTimes(2);
        } finally { releaseMount(); mount.dispose(); }
        const copiedDefinition = { v: 1 as const, id: 'copied-declarative', name: 'Copied checks', inputSchema, sizeDeclaration: entry('current-b').sizeDeclaration,
            inputs: entry('current-b').inputs, sessionInputPath: 'session', provenance: { source: { kind: 'authored' as const } },
            body: { kind: 'declarative' as const, document: { version: 1 as const, root: { kind: 'metric' as const, label: 'Checks',
                data: { kind: 'resource' as const, resource: { pluginId: surface.pluginId, localId: 'current-b-state' },
                    inputSchema, outputSchema: { type: 'number' as const } }, value: { path: [], type: 'number' as const } } } } };
        const copiedInstance = { ...instance, definition: { kind: 'inline' as const, definition: copiedDefinition } };
        itemVersion += 1;
        boardItem = { v: 1, title: 'Copied checks', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance: copiedInstance } };
        daemon.resourceRead.mockResolvedValue(resourceResult);
        expect(await executor.execute('widgets.item.refresh', { ref: request.ref }, context))
            .toEqual({ ok: true, result: { ref: request.ref, status: 'refreshed' } });
        expect(daemon.resourceRead.mock.calls.at(-1)?.slice(0, 2)).toEqual(['machine-b', expect.objectContaining({
            resource: { pluginId: surface.pluginId, localId: 'current-b-state' }, context: { kind: 'session', sessionId: b.id },
            expectedCallerOccurrenceId: 'binding-occurrence',
        })]);
        const htmlDefinition = { ...copiedDefinition, body: { kind: 'html' as const,
            source: artifactHtmlBundleFromBodyV1('<main>Viewer resource</main>'),
            requestedCapabilities: { hostMethods: ['readResource' as const], resources: [{ pluginId: surface.pluginId, localId: 'current-b-state' }] } } };
        itemVersion += 1;
        boardItem = { v: 1, title: 'HTML checks', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance: { ...instance, definition: { kind: 'inline', definition: htmlDefinition } } } };
        expect(await executor.execute('widgets.item.refresh', { ref: request.ref }, context))
            .toEqual({ ok: true, result: { ref: request.ref, status: 'refreshed' } });
        expect(daemon.resourceRead.mock.calls.at(-1)?.slice(0, 2)).toEqual(['machine-b', expect.objectContaining({
            resource: { pluginId: surface.pluginId, localId: 'current-b-state' }, context: { kind: 'session', sessionId: b.id },
            expectedCallerOccurrenceId: 'binding-occurrence',
        })]);
        const readsBeforeDenial = daemon.resourceRead.mock.calls.length;
        storage.setState({ sessions: { ...storage.getState().sessions, [b.id]: { ...b, access: { ...b.access!, capabilities: { ...b.access!.capabilities, readTranscript: false } } } } });
        expect(await inputs.resolve(request)).toMatchObject({ status: 'unavailable' });
        expect(await executor.execute('widgets.item.refresh', { ref: request.ref }, context)).toMatchObject({ ok: false });
        expect(daemon.resourceRead).toHaveBeenCalledTimes(readsBeforeDenial);
        expect(areaHttp.writes).toHaveLength(writesAfterAreaEdits);
        expect(http.writes).toHaveLength(0);
        const native = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'changes' })!;
        const savedNative: WidgetDefinitionV1 = { v: 1, id: 'saved-native', name: 'Saved changes',
            body: { kind: 'builtin', id: 'changes' }, sizeDeclaration: native.sizeDeclaration,
            inputs: native.inputs!, inputSchema: native.inputSchema!, sessionInputPath: native.sessionInputPath,
            provenance: { source: { kind: 'authored' } } };
        for (const definition of [{ kind: 'builtin' as const, id: 'changes' }, { kind: 'inline' as const, definition: savedNative }]) {
            itemVersion += 1;
            boardItem = { v: 1, title: 'Native changes', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
                source: { kind: 'widget', instance: { v: 1, id: 'copy-b', definition, bindings: {
                    session: { kind: 'value', value: { serverId: scope.serverId, sessionId: b.id } },
                } } } };
            expect(await executor.execute('widgets.item.refresh', { ref: request.ref }, context))
                .toMatchObject({ ok: false, errorCode: 'widget_refresh_unavailable' });
        }
        expect(daemon.resourceRead).toHaveBeenCalledTimes(readsBeforeDenial);
    } finally {
        await act(async () => { tree?.unmount(); });
        account.dispose(); clearDaemonMergedProjectionCacheForTests(); daemon.projections.clear();
        storage.setState(previous, true); await connection.dispose();
    }
});
