import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { PluginDevelopmentStatusV1Schema } from '@happier-dev/protocol/capabilities';
import type { CapabilitiesInvokeRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { IModal } from '@/modal';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createManagedResourceDependencyFixture } from '@/dev/testkit/fixtures/managedResourceDependencyFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';
import { createRegistryPluginCatalogFixture } from '@/dev/testkit/fixtures/registryPluginCatalog';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { DEFAULT_CURATED_MARKETPLACE_SOURCE_URL } from '@happier-dev/protocol/marketplace';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';

import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';

const boundary = vi.hoisted(() => ({
    rpc: vi.fn<(request: Readonly<{ machineId: string; serverId?: string | null; method: string; payload: unknown }>) => Promise<unknown>>(),
    confirm: vi.fn<IModal['confirm']>(),
    alert: vi.fn<IModal['alert']>(),
    push: vi.fn(),
}));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// This is the machine network boundary; capability parsing, selection, caches and the hook stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: boundary.rpc,
}));
installApprovalCommonModuleMocks({
    reactNative: async () => {
        const [{ createReactNativeWebMock }, { createCapturingFlatListMock }] = await Promise.all([
            import('@/dev/testkit/mocks/reactNative'), import('@/dev/testkit/mocks/virtualizedList'),
        ]);
        // Host strings do not invoke RN's virtualized cell renderers. Preserve
        // the platform boundary while rendering the real Collection row props.
        return createReactNativeWebMock({ ...createCapturingFlatListMock().module, SectionList: renderNativeSectionList });
    },
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        pathname: '/settings/plugins', router: { push: boundary.push },
    }).module,
    // Keep translation parameters visible so the test can see which reason reached the user.
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    modal: async () =>
        (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true, settleTransientConfirmations: false, spies: {
            confirm: boundary.confirm, alert: boundary.alert,
        } }).module,
});

// Configure the native presentation boundary before runtime-bearing harnesses
// can import Modal; otherwise the helper's default inert provider is cached.
const [
    { createAccountTokenForTests },
    { installDisconnectedServerSocketBoundary, restoreServerAccountForTest },
    { loadSyncSingletonForTests },
    { replacePluginAccountAvailabilityProjection },
    { createArtifactStoreBoundary },
] = await Promise.all([
    import('@/dev/testkit/harness/homeGovernanceHarness'),
    import('@/dev/testkit/harness/serverAccountConnectionHarness'),
    import('@/dev/testkit/harness/syncSingletonLoader'),
    import('@/sync/domains/plugins/availability/projection'),
    import('@/dev/testkit/harness/artifactStoreBoundary'),
]);

type NativeSection = Readonly<{ key: string; data: readonly unknown[] }>;
function renderNativeSectionList(props: Readonly<{
    sections: readonly NativeSection[];
    renderItem?: (info: Readonly<{ item: unknown; index: number; section: NativeSection }>) => React.ReactNode;
    renderSectionHeader?: (info: Readonly<{ section: NativeSection }>) => React.ReactNode;
    ListFooterComponent?: React.ReactNode;
}>) {
    return React.createElement('SectionList', props, props.sections.map(section => React.createElement(React.Fragment,
        { key: section.key }, props.renderSectionHeader?.({ section }), section.data.map((item, index) =>
            React.createElement(React.Fragment, { key: index }, props.renderItem?.({ item, index, section }))))), props.ListFooterComponent);
}
installDisconnectedServerSocketBoundary();
// Install native/modal boundary options before collecting the app-shell/runtime graph.
const { renderSettingsView } = await import('@/dev/testkit/harness/settingsViewHarness');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
beforeAll(loadSyncSingletonForTests);
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let scenario = 0;
afterEach(async () => { standardCleanup(); await connection?.dispose(); connection = null; vi.restoreAllMocks(); });

async function renderRemovalOwner(
    method: 'disable' | 'uninstall',
    changes: readonly unknown[],
    options: Readonly<{ initiallyEnabled?: boolean; readbackEnabled?: boolean; development?: boolean;
        developmentRoot?: string; actionFailure?: boolean;
        beforeActionResponse?: (signal: AbortSignal | null | undefined) => Promise<void>;
        actionError?: string; catalog?: boolean; browse?: boolean; management?: boolean; focused?: boolean; installOutcomeUnknown?: boolean; declineInstall?: boolean; noTarget?: boolean;
        deferredInstall?: boolean; installErrorsByMachine?: Readonly<Record<string, string>>;
        installRegistryRequirement?: Readonly<{ registryOrigin: string; packageName: string; registryProfileId: string | null }>;
        /** A second online Machine beside the selected one. */
        secondMachine?: boolean; bundled?: boolean; bundledAccountEnabled?: boolean;
        /** Machines whose daemon returns its approval without an evaluated review. */
        unevaluatedMachineIds?: readonly string[] }> = {},
) {
    const twoMachines = options.noTarget || options.secondMachine;
    boundary.rpc.mockReset();
    boundary.confirm.mockReset().mockResolvedValue(true);
    boundary.alert.mockReset();
    boundary.push.mockReset();
    const { Modal } = await import('@/modal');
    // Each scenario owns a fresh native presentation surface as well as its Home.
    Modal.hideAll();
    vi.mocked(Modal.confirm).mockImplementation(boundary.confirm);
    vi.mocked(Modal.alert).mockImplementation(boundary.alert);
    // Each scenario supplies a different daemon census. Give it its own Home so the real
    // capability cache cannot answer with the preceding scenario's still-fresh snapshot.
    const serverIdentityId = `srv_plugin_removal_${++scenario}`;
    const selectedTarget = { serverIdentityId, machineId: 'controller-1' };
    const developmentActionsSettings = normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: {
        // These cases isolate retained-resource consent from the ordinary
        // uninstall Action prompt, which is covered by the policy suites.
        'plugins.uninstall': ['ui'],
        ...(options.declineInstall || options.deferredInstall ? {} : { 'plugins.install': ['ui' as const] }),
        'plugins.dev.submit': ['ui'], 'plugins.dev.unregister': ['ui'], 'plugins.dev.test': ['ui'], 'plugins.pack': ['ui'],
    } });
    let serverContent: unknown = { t: 'plain', v: {
        machineAdministrationTargetsLocalV1: options.noTarget ? {} : { 'plugins.home': selectedTarget },
        actionsSettingsV1: developmentActionsSettings,
    } };
    let serverVersion = 1;
    const pluginId = 'example.compute';
    const sourceRootPath = options.developmentRoot ?? '/plugins/example.compute';
    const installed = {
        pluginId, title: 'Example compute', description: null, version: '1.0.0', enabled: options.initiallyEnabled ?? true,
        source: { kind: options.bundled ? 'bundled' : 'localPath', locator: sourceRootPath, trustPolicy: 'trusted' },
        ...(options.bundled ? { accountEnabled: options.bundledAccountEnabled ?? false, machineEnabled: true,
            enabled: options.bundledAccountEnabled ?? false } : {}),
        install: { mode: 'managed', manifestVersion: '2' },
        compatibility: { status: 'compatible', diagnostics: [] }, diagnostics: [],
    };
    const catalog = createRegistryPluginCatalogFixture({ sourceUrl: `https://plugin-removal-${scenario}.test/catalog.json`,
        entries: [{ pluginId, title: 'Example compute', version: '1.2.3' }] });
    const catalogRows = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: {
        v: 2, disabledSourceIds: [], sources: [{ id: catalog.source.id, title: 'Catalog',
            format: 'happier-catalog', kinds: ['plugin', 'agent'], url: catalog.source.sourceUrl, enabled: true, addedAt: 1 }],
    } }], settingsVersion: 1 });
    const requests: Array<Readonly<{ machineId: string; serverId?: string | null; payload: CapabilitiesInvokeRequest }>> = [];
    const censusReads: Array<Readonly<{ machineId: string; installed: readonly Readonly<{ pluginId: string; version: string }>[] }>> = [];
    const actionRequests: Array<Readonly<{ actionId: string; envelope: ReturnType<typeof ExternalActionRequestEnvelopeV1Schema.parse> }>> = [];
    let catalogInstalled = false;
    let nativeInstallCommits = 0;
    const nativeExecutions: unknown[] = [];
    const nativeInvocations: Array<ExternalActionRequesterInvocationV1 | undefined> = [];
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-owner', encryptionMode: 'plain' });
    // This is the receiving daemon behind the HTTP boundary. Policy, approval
    // creation/CAS, decision and mounted observation all use their real owners.
    const nativeExecutor = createActionExecutor(createActionExecutorBoundaryFixture({
        readActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }),
        buildApprovalPreview: async ({ defaultPreview, input }) => options.unevaluatedMachineIds?.includes(
            input && typeof input === 'object' && 'machineId' in input ? String(input.machineId) : 'controller-1')
            ? defaultPreview : ({ ...defaultPreview, pluginInstall: {
            permissionsDisclosure: 'daemonEvaluated',
            pendingReview: { kind: 'reviewRequired', reviewKind: 'installation', pendingChangeId: `candidate-${scenario}-${
                input && typeof input === 'object' && 'machineId' in input ? String(input.machineId) : 'controller-1'}`,
                reason: options.catalog ? 'firstInstall' : 'authorityExpansion',
                currentVersion: options.catalog ? null : '1.0.0',
                authorityExpansion: options.catalog ? [] : ['requiredHostAccess'],
                review: createPluginInstallationReviewFixture({ pluginId, version: '1.2.3',
                    requiredHostAccess: [{ id: 'account-storage', capability: 'storage.account', reason: 'Plugin data',
                        authorizationClass: 'cooperativeDisclosure', normalizedScope: { enabled: true } }],
                }),
            },
        } }),
        approvalsCreate: async ({ request }) => {
            const [{ captureActionAccountContext }, { createApprovalArtifact }] = await Promise.all([
                import('@/sync/ops/actions/actionAccountContext'), import('@/sync/ops/actions/approvalArtifactWriter'),
            ]);
            const account = await captureActionAccountContext(serverIdentityId);
            try {
                return await createApprovalArtifact({ request, accountId: account.accountId,
                    read: artifactId => account.readArtifact(artifactId, { fresh: true, ownerOnly: true }),
                    create: async (artifactId, header, body, idScope) =>
                        (await account.createArtifactDocument({ artifactId, header, body, idScope })).artifact });
            } finally { account.dispose(); }
        },
        approvalsGet: async ({ artifactId }) => {
            const body = artifacts.readPlainBody(artifactId);
            return body ? ApprovalRequestV2Schema.parse(JSON.parse(body)) : null;
        },
        approvalsUpdate: async ({ artifactId, request, expectedStatus }) => {
            const [{ captureActionAccountContext }, { writeApprovalRequestArtifact }] = await Promise.all([
                import('@/sync/ops/actions/actionAccountContext'), import('@/sync/ops/actions/approvalArtifactWriter'),
            ]);
            const account = await captureActionAccountContext(serverIdentityId);
            try {
                return await writeApprovalRequestArtifact({ artifactId, request, expectedStatus,
                    read: artifactId => account.readArtifact(artifactId, { fresh: true, ownerOnly: true }),
                    write: (basis, header, body) => account.updateArtifact(artifactId, header, body, basis) });
            } finally { account.dispose(); }
        },
        isApprovalExecutionOriginCurrent: async ({ origin }) => {
            const [{ captureActionAccountContext }, { isApprovalExecutionOriginCurrentForAccountContext }] = await Promise.all([
                import('@/sync/ops/actions/actionAccountContext'), import('@/sync/ops/actions/defaultActionExecutor'),
            ]);
            const account = await captureActionAccountContext(serverIdentityId);
            try { return isApprovalExecutionOriginCurrentForAccountContext({ origin,
                accountServerId: account.serverId, accountId: account.accountId }); }
            finally { account.dispose(); }
        },
        // Plugin application runs in the other process, beyond this UI test.
        pluginsDevLoopAction: async () => {
            catalogInstalled = true;
            nativeInstallCommits += 1;
            return { ok: true, kind: 'plugins_install', outcome: 'applied', change: committed };
        },
    }));
    const developmentStatus = PluginDevelopmentStatusV1Schema.parse({
        roots: [{ kind: 'explicit', rootPath: sourceRootPath, trusted: true, persisted: true }],
        plugins: [{ pluginId, sourceRootPath, phase: 'active' }],
    });
    const { createExternalActionAccountHttpBoundary } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
    const nativeInstallBoundaries = options.deferredInstall ? await Promise.all(
        (twoMachines ? ['controller-1', 'controller-2'] : ['controller-1']).map(machineId => createExternalActionAccountHttpBoundary({
            serverUrl: `https://plugin-removal-${scenario}.test`, serverIdentityId, accountId: 'account-owner',
            machineId, installationId: machineId === 'controller-1' ? 'installation-1' : 'installation-2',
            actionId: 'plugins.install', tokenEpoch: 0, requesterInvocation: 'optional',
            failure: result => {
                const failure = ActionExecuteFailureSchema.safeParse(result);
                return failure.success ? failure.data : null;
            },
            execute: async (input, context) => {
                actionRequests.push({ actionId: 'plugins.install', envelope: ExternalActionRequestEnvelopeV1Schema.parse(context.envelope) });
                await options.beforeActionResponse?.(context.signal);
                const installError = options.installErrorsByMachine?.[machineId];
                if (installError) return { ok: false, errorCode: installError, error: installError };
                nativeInvocations.push(context.invocation);
                const execution = await nativeExecutor.execute('plugins.install', input, {
                    surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                    serverId: serverIdentityId, serverIdentityId, runtimeAccountId: 'account-owner',
                    actionRequestId: context.requestId, externalActionTarget: context.target,
                    ...(context.invocation?.presentUserConfirmation
                        ? { presentUserConfirmation: context.invocation.presentUserConfirmation } : {}),
                });
                nativeExecutions.push(execution);
                return execution.ok ? execution.result : execution;
            },
        })),
    ) : [];
    let machineCensus = {
        ...createPlainMachineRowFixture({ id: 'controller-1', accountId: 'account-owner' }),
        ...nativeInstallBoundaries[0]?.machine,
        installationId: 'installation-1', runnerContentKeyBinding: null,
    };
    boundary.rpc.mockImplementation(async request => {
        if (request.method === RPC_METHODS.CAPABILITIES_DETECT) {
            const installedPlugins = options.catalog
                ? catalogInstalled ? [{ ...installed, version: '1.2.3' }] : [] : [{
                ...installed, enabled: requests.length + actionRequests.length > 0 ? options.readbackEnabled ?? installed.enabled : installed.enabled,
            }];
            censusReads.push({ machineId: request.machineId, installed: installedPlugins });
            return { protocolVersion: 1, results: { 'tool.plugins': { ok: true, checkedAt: 1, data: {
                installedPlugins, ...(options.development ? { developmentActions: { create: true }, developmentStatus } : {}),
            } } } };
        }
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
            protocolVersion: 1,
            projection: { v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, 
                resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [] },
        };
        if (request.method === RPC_METHODS.CAPABILITIES_INVOKE) {
            const payload = request.payload as CapabilitiesInvokeRequest;
            requests.push({ machineId: request.machineId, serverId: request.serverId, payload });
            const change = changes[requests.length - 1];
            return { ok: true, result: { action: method, pluginId,
                ...(change === undefined ? { entry: { ...installed, enabled: false }, change: null } : { change }) } };
        }
        throw new Error(`Unexpected RPC: ${request.method}`);
    });
    connection = await restoreServerAccountForTest({
        serverUrl: `https://plugin-removal-${scenario}.test`, serverIdentityId, accountId: 'account-owner',
        additionalRequestOrigins: [new URL(DEFAULT_CURATED_MARKETPLACE_SOURCE_URL).origin, 'https://registry.npmjs.org'],
        credentials: { token: createAccountTokenForTests('account-owner', { currentAccount: true }) },
        request: async (rawUrl, init) => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/health') return Response.json({});
            if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'account-owner' }));
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
                capabilities: { serverIdentity: { serverIdentityId } },
            }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: serverVersion }));
            if (path === '/v2/account/settings') {
                if (init?.method === 'POST') {
                    const write = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                    expect(write.expectedVersion).toBe(serverVersion);
                    serverContent = write.content;
                    return Response.json({ success: true, version: ++serverVersion });
                }
                return Response.json({ content: serverContent, version: serverVersion });
            }
            if (options.deferredInstall) {
                const artifactResponse = artifacts.handle(`${path}${new URL(String(rawUrl)).search}`, init);
                if (artifactResponse) return await artifactResponse;
            }
            if (path === '/v1/artifacts') return Response.json([]);
            if (options.catalog && path.startsWith('/v1/account/entity-rows/prompt-library')) return catalogRows.handle(path, init);
            if (options.catalog && String(rawUrl) === catalog.source.sourceUrl) return Response.json(catalog);
            if (String(rawUrl) === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return Response.json(createRegistryPluginCatalogFixture({
                sourceUrl: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL, kind: 'curated', entries: [],
            }));
            if (String(rawUrl).startsWith('https://registry.npmjs.org/-/v1/search')) return Response.json({ total: 0, objects: [] });
            if (path === '/v1/machines') return Response.json(twoMachines ? [machineCensus, { ...machineCensus, id: 'controller-2' }] : [machineCensus]);
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
                id => id === machineCensus.id ? machineCensus
                    : twoMachines && id === 'controller-2' ? nativeInstallBoundaries[1]?.machine ?? { ...machineCensus, id: 'controller-2' } : null);
            if (options.deferredInstall) {
                const raw = init?.body ? JSON.parse(String(init.body)) : undefined;
                const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(raw);
                const envelope = ExternalActionRequestEnvelopeV1Schema.safeParse(authorized.success ? authorized.data.envelope : raw);
                const target = envelope.success ? envelope.data.target : null;
                const native = target?.kind === 'machine'
                    ? nativeInstallBoundaries.find(item => item.machine.id === target.machineId)
                    : nativeInstallBoundaries.find(item => path === `/v1/machines/${item.machine.id}`);
                const response = await native?.handle(new URL(String(rawUrl)), init);
                if (response) return response;
            }
            if (path.startsWith('/v1/actions/')) {
                const actionId = path.slice('/v1/actions/'.length);
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
                actionRequests.push({ actionId, envelope });
                await options.beforeActionResponse?.(init?.signal);
                const installError = actionId === 'plugins.install' && envelope.target?.kind === 'machine'
                    ? options.installErrorsByMachine?.[envelope.target.machineId] : undefined;
                if (actionId === 'plugins.install' && options.installRegistryRequirement) {
                    // The real READY176 daemon returns this refusal before acquiring package bytes.
                    // Only the cross-process HTTP response is substituted; mounted Action handling,
                    // Store selection and modal presentation retain their production owners.
                    const requirement = options.installRegistryRequirement;
                    return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId,
                        requestId: envelope.requestId, execution: ActionExecuteFailureSchema.parse({ ok: false,
                            errorCode: 'plugin_registry_profile_required',
                            error: `Npm registry '${requirement.registryOrigin}' requires a usable registry profile before installing ${requirement.packageName}.`,
                            details: requirement,
                        }) }));
                }
                if (installError) return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId,
                    requestId: envelope.requestId, execution: { ok: false, errorCode: installError, error: installError } }));
                if (options.deferredInstall && (actionId === 'plugins.install' || actionId === 'approval.request.create')) {
                    const execution = await nativeExecutor.execute(actionId, envelope.input,
                    { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                        serverId: serverIdentityId, serverIdentityId, runtimeAccountId: 'account-owner',
                        actionRequestId: envelope.requestId, externalActionTarget: envelope.target });
                    nativeExecutions.push(execution);
                    return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId,
                        requestId: envelope.requestId, execution }));
                }
                const declined = options.declineInstall && actionId === 'plugins.install'
                    && actionRequests.filter(request => request.actionId === actionId).length === 1;
                if (options.catalog && actionId === 'plugins.install' && !declined && !options.actionError) {
                    // A lost acknowledgement may follow the daemon's commit;
                    // an explicit consent decline never changes its inventory.
                    catalogInstalled = true;
                    nativeInstallCommits += 1;
                }
                const lifecycleChange = actionId === `plugins.${method}` ? changes[actionRequests.filter(request => request.actionId === actionId).length - 1] : undefined;
                return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId,
                    execution: declined
                        // The receiving daemon owns ordinary consent; this is
                        // its terminal HTTP decision, not a second UI prompt.
                        ? { ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' }
                    : options.actionError ? { ok: false, errorCode: options.actionError, error: options.actionError }
                    : options.catalog && actionId === 'plugins.install' ? { ok: true, result: {
                        ok: !options.installOutcomeUnknown, kind: 'plugins_install', outcome: options.installOutcomeUnknown ? 'failed' : 'applied',
                        change: options.installOutcomeUnknown ? { kind: 'outcomeUnknown', pluginId } : { ...committed, pluginId },
                    } } : { ok: true, result: { ok: options.actionFailure !== true, kind: actionId.replaceAll('.', '_'),
                        ...(actionId === `plugins.${method}` ? { action: method, pluginId, change: lifecycleChange ?? committed } : {}),
                        ...(options.actionFailure ? { diagnostics: [{ code: 'plugin_author_test_failed', message: 'Plugin tests failed' }] } : {}),
                        ...(actionId === 'plugins.dev.submit' || actionId === 'plugins.dev.unregister' ? { status: developmentStatus } : {}) } },
                }));
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        },
    });
    // Finish the restored Home's initial settings response before installing
    // scenario facts, as in the canonical Settings boundary harness.
    const { sync } = await import('@/sync/sync');
    const settingsQueue = Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync;
    await settingsQueue.awaitQueue();
    const { storage } = await import('@/sync/domains/state/storage');
    // Content and credential bindings share the portable Home identity. home.id is
    // only this device's profile lookup alias and would retire scoped registry reads.
    const scope = { serverId: connection.home.serverIdentityId!, accountId: 'account-owner' };
    storage.getState().activateProfileScope(scope);
    await storage.getState().activateSettingsScope(scope);
    storage.getState().applySettings({ ...storage.getState().settings,
        machineAdministrationTargetsLocalV1: options.noTarget ? {} : { 'plugins.home': selectedTarget },
        actionsSettingsV1: developmentActionsSettings,
    }, serverVersion);
    const machine = createMachineFixture({ id: 'controller-1', installationId: 'installation-1', activeAt: Date.now() });
    storage.getState().applyMachines(twoMachines ? [machine, { ...machine, id: 'controller-2' }] : [machine], true, { sourceServerId: scope.serverId });
    storage.setState({ isDataReady: true,
        machineListStatusByServerId: { [scope.serverId]: 'idle' },
    });
    let availabilityCursor = 1;
    const publishAccountEnabled = (enabled: boolean) => {
        replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: ++availabilityCursor,
            materializations: [], snapshots: [], intentReads: [{ pluginId,
                response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor,
                    hostingCapability: { enabled: false }, release: null, uiArtifacts: [], packageAssets: [],
                    intent: { pluginId, enabled, desiredVersion: null, offlineUiHosting: 'disabled',
                        writableCollections: [], revision: String(availabilityCursor) } }),
            }] } });
    };
    if (options.bundled) publishAccountEnabled(options.bundledAccountEnabled ?? false);
    const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    clearDaemonMergedProjectionCacheForTests();
    const { usePluginSettingsScreenState } = await import('./usePluginSettingsScreenState');
    const hook = await renderHook(({ focused }: { focused: boolean }) => usePluginSettingsScreenState({ focused,
        ...(options.browse ? { initialView: 'discover', management: options.management ?? true } : {}) }),
        { initialProps: { focused: options.focused ?? true } });
    if (options.focused !== false && !options.noTarget && options.management !== false) await vi.waitFor(() => expect(hook.getCurrent().daemonOperationsAvailable).toBe(true));
    if (options.development) await vi.waitFor(() => expect(hook.getCurrent().developmentPlugins.map(plugin => plugin.sourceRootPath)).toEqual([sourceRootPath]));
    const publishMachine = (changes: Partial<typeof machine>) => {
        const next = { ...machine, seq: machine.seq + 1, updatedAt: Date.now(), ...changes };
        machineCensus = { ...machineCensus, seq: next.seq, updatedAt: next.updatedAt,
            installationId: next.installationId ?? machineCensus.installationId,
            daemonStateVersion: next.daemonStateVersion,
        };
        storage.getState().applyMachines([next], true, { sourceServerId: scope.serverId });
    };
    const decideInstall = async (artifactId: string, decision: 'approve' | 'reject' | 'cancel',
        authority: 'present_user' | 'account_automation' = 'present_user') => {
        const result = await nativeExecutor.execute('approval.request.decide', { artifactId, decision }, {
            surface: authority === 'present_user' ? 'ui' : 'agent', authority,
            actionCaller: authority === 'present_user' ? { kind: 'host' } : { kind: 'session', sessionId: 'requesting-agent', starterDepth: 0, turnDepth: 0 },
            serverId: scope.serverId, serverIdentityId, runtimeAccountId: 'account-owner',
        });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        publishHomeAccountChange(scope.serverId, [artifactId], { changeKinds: ['artifact'] });
        return result;
    };
    return { hook, requests, actionRequests, storage, scope, machine, publishMachine, publishAccountEnabled, catalog, censusReads, artifacts, decideInstall, nativeExecutions, nativeInvocations,
        nativeInstallCommitCount: () => nativeInstallCommits };
}

type CarriedReview = Parameters<IModal['show']>[0];

async function waitForCarriedReviews(count: number): Promise<CarriedReview[]> {
    const { Modal } = await import('@/modal');
    const read = () => vi.mocked(Modal.show).mock.calls.map(([config]) => config)
        .filter(config => config.chrome?.testID === 'actions.confirmation-review.modal');
    await vi.waitFor(() => expect(read()).toHaveLength(count));
    return read();
}

async function answerCarriedReview(review: CarriedReview, confirmed: boolean): Promise<void> {
    const answer = review.props?.onAnswer;
    if (typeof answer !== 'function') throw new Error('Expected the carried review decision');
    const { Modal } = await import('@/modal');
    const index = vi.mocked(Modal.show).mock.calls.findIndex(([config]) => config === review);
    const modalId = vi.mocked(Modal.show).mock.results[index]?.value;
    await act(async () => {
        answer(confirmed);
        if (typeof modalId === 'string') Modal.hide(modalId);
    });
}

describe('Plugin install/update originating approval state', () => {
    it('keeps Browse search editable alongside catalog installs without a contribution projection', async () => {
        const { censusReads } = await renderRemovalOwner('disable', [], {
            catalog: true, browse: true, management: false,
        });
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { PluginSettingsHomeScreen } = await import('../PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(DestinationInstanceHost, {
            tabId: 'store', ref: { kind: 'plugins', params: { view: 'browse' } }, pathname: '/plugins', focused: true, visible: true,
            navigation: { push: boundary.push, pushRetainingCurrent: boundary.push, replace: boundary.push,
                back: () => {}, setParams: () => {} },
            children: React.createElement(AppPaneProvider, null, React.createElement(PluginSettingsHomeScreen)),
        }));
        await vi.waitFor(() => expect(screen.findByTestId('settings.plugins.marketplace.search')).not.toBeNull());
        await vi.waitFor(() => expect(screen.findByTestId('settings.plugins.marketplace.search')?.props.editable).toBe(true));
        await act(async () => {
            screen.findByTestId('settings.plugins.marketplace.search')?.props.onChangeText('Example compute');
        });
        expect(screen.findByTestId('settings.plugins.marketplace.search')?.props.value).toBe('Example compute');
        expect(censusReads).toHaveLength(0);
    });

    it('admits a catalog install from passive Browse without demanding installed contribution details', async () => {
        const { hook, catalog, actionRequests, censusReads } = await renderRemovalOwner('disable', [], {
            catalog: true, browse: true, management: false,
        });
        await vi.waitFor(() => expect(hook.getCurrent().discoverEntries.some(entry => entry.sourceId === catalog.source.id)).toBe(true));
        expect(hook.getCurrent().canRunDiscoverActions).toBe(true);
        expect(censusReads).toHaveLength(0);
        await act(async () => hook.getCurrent().runCatalogAction({ method: 'install', pluginId: 'example.compute', sourceId: catalog.source.id }));
        await vi.waitFor(() => expect(actionRequests).toHaveLength(1));
        expect(actionRequests[0]).toMatchObject({ actionId: 'plugins.install', envelope: {
            target: { kind: 'machine', machineId: 'controller-1' },
            input: { source: { kind: 'marketplace', sourceId: catalog.source.id, pluginId: 'example.compute', version: '1.2.3' } },
        } });
        expect(censusReads).toHaveLength(0);
    });

    it('opens registry selection when the receiving daemon requires a profile before catalog install', async () => {
        const requirement = { registryOrigin: 'https://nldw4-5-40-40.tailfce179.ts.net:39178',
            packageName: '@qa-l12/dash104-provider', registryProfileId: null };
        const { hook, catalog, actionRequests, nativeInstallCommitCount } = await renderRemovalOwner('disable', [], {
            catalog: true, browse: true, installRegistryRequirement: requirement,
        });
        const { ModalProvider } = await import('@/modal');
        const screen = await renderSettingsView(React.createElement(ModalProvider));
        await vi.waitFor(() => expect(hook.getCurrent().discoverEntries.some(entry => entry.sourceId === catalog.source.id)).toBe(true));
        await act(async () => {
            hook.getCurrent().runCatalogAction({ method: 'install', pluginId: 'example.compute', sourceId: catalog.source.id });
        });
        await vi.waitFor(() => expect(actionRequests).toHaveLength(1));
        await vi.waitFor(() => expect(screen.findByTestId('settings.plugins.registrySelection.body')).not.toBeNull());
        expect(boundary.alert).not.toHaveBeenCalled();
        expect(nativeInstallCommitCount()).toBe(0);
        await act(async () => { screen.pressByTestId('settings.plugins.registrySelection.cancel'); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(actionRequests).toHaveLength(1);
        expect(nativeInstallCommitCount()).toBe(0);
    });

    // Coordination 2026-11-15 23:05: this person's own UI Ask confirms in place.
    it('confirms each exact Machine in place without installing before its answer or lending confirmation to another target', async () => {
        const { hook, catalog, artifacts, nativeInstallCommitCount, actionRequests, scope, nativeInvocations } =
            await renderRemovalOwner('disable', [], { catalog: true, browse: true, noTarget: true, deferredInstall: true });
        await act(async () => hook.getCurrent().openDiscoverListing({ sourceId: catalog.source.id, pluginId: 'example.compute',
            itemId: 'example.compute', version: '1.2.3' }));
        await vi.waitFor(() => expect(hook.getCurrent().discoverEntries.some(entry => entry.id === 'example.compute')).toBe(true));
        const expectedTargets = ['controller-1', 'controller-2'].map(machineId => ({ serverIdentityId: scope.serverId, machineId }));
        const targets = expectedTargets.map(target => ({ ...target }));
        let pending!: Promise<void>;
        await act(async () => {
            pending = hook.getCurrent().runCatalogInstallOnMachines({ pluginId: 'example.compute', sourceId: catalog.source.id }, targets);
            targets[0]!.machineId = 'different-machine';
        });
        const reviews = await waitForCarriedReviews(2);
        expect(reviews.map(review => review.props?.actionArgs)).toEqual(expectedTargets.map(target => expect.objectContaining({ machineId: target.machineId })));
        expect(nativeInstallCommitCount()).toBe(0);
        expect(artifacts.list()).toHaveLength(0);
        await answerCarriedReview(reviews[0]!, true);
        await vi.waitFor(() => expect(nativeInstallCommitCount()).toBe(1));
        expect(nativeInvocations.filter(invocation => invocation?.presentUserConfirmation).map(invocation => invocation!.presentUserConfirmation!.target))
            .toEqual([{ kind: 'machine', machineId: 'controller-1' }]);
        await answerCarriedReview(reviews[1]!, false);
        await act(async () => { await pending; });
        expect(hook.getCurrent().pluginInstallReview).toMatchObject({ pluginId: 'example.compute', rows: [
            { kind: 'settled', target: expectedTargets[0], result: { ok: true } },
            { kind: 'settled', target: expectedTargets[1], result: { ok: false, errorCode: 'approval_canceled' } },
        ] });
        expect(nativeInstallCommitCount()).toBe(1);
        expect(artifacts.list()).toHaveLength(0);
        expect(actionRequests.filter(request => request.actionId === 'plugins.install').map(request => request.envelope.target))
            .toEqual([expectedTargets[0], expectedTargets[1], expectedTargets[0]].map(target => ({ kind: 'machine', machineId: target!.machineId })));
        expect(hook.getCurrent().pluginActionApproval.approvalId).toBeNull();
    });

    it('keeps one Machine refusal beside the other in-place confirmation without retrying the refused install', async () => {
        const { hook, catalog, artifacts, nativeInstallCommitCount, actionRequests, scope } =
            await renderRemovalOwner('disable', [], { catalog: true, browse: true, noTarget: true, deferredInstall: true,
                installErrorsByMachine: { 'controller-2': 'plugin_change_daemon_unavailable' } });
        await act(async () => hook.getCurrent().openDiscoverListing({ sourceId: catalog.source.id, pluginId: 'example.compute',
            itemId: 'example.compute', version: '1.2.3' }));
        await vi.waitFor(() => expect(hook.getCurrent().discoverEntries.some(entry => entry.id === 'example.compute')).toBe(true));
        let pending!: Promise<void>;
        await act(async () => {
            pending = hook.getCurrent().runCatalogInstallOnMachines({ pluginId: 'example.compute', sourceId: catalog.source.id },
                ['controller-1', 'controller-2'].map(machineId => ({ serverIdentityId: scope.serverId, machineId })));
        });
        const reviews = await waitForCarriedReviews(1);
        expect(reviews[0]!.props?.actionArgs).toMatchObject({ machineId: 'controller-1' });
        expect(nativeInstallCommitCount()).toBe(0);
        expect(artifacts.list()).toHaveLength(0);
        await answerCarriedReview(reviews[0]!, true);
        await act(async () => { await pending; });
        expect(hook.getCurrent().pluginInstallReview).toMatchObject({ rows: [
            { kind: 'settled', target: { machineId: 'controller-1' }, result: { ok: true } },
            { kind: 'settled', target: { machineId: 'controller-2' }, result: { ok: false, errorCode: 'plugin_change_daemon_unavailable' } },
        ] });
        expect(artifacts.list()).toHaveLength(0);
        expect(nativeInstallCommitCount()).toBe(1);
        expect(actionRequests.filter(request => request.actionId === 'plugins.install' && request.envelope.target?.kind === 'machine'
            && request.envelope.target.machineId === 'controller-2')).toHaveLength(1);
    });

    it('does not dispatch a retained batch install callback after its catalog Account retires', async () => {
        const { hook, catalog, storage, actionRequests, scope } =
            await renderRemovalOwner('disable', [], { catalog: true, browse: true, noTarget: true, deferredInstall: true });
        await act(async () => hook.getCurrent().openDiscoverListing({ sourceId: catalog.source.id, pluginId: 'example.compute',
            itemId: 'example.compute', version: '1.2.3' }));
        await vi.waitFor(() => expect(hook.getCurrent().discoverEntries.some(entry => entry.id === 'example.compute')).toBe(true));
        const retainedRun = hook.getCurrent().runCatalogInstallOnMachines;
        await act(async () => storage.getState().activateProfileScope({ ...scope, accountId: 'another-account' }));
        await act(async () => retainedRun({ pluginId: 'example.compute', sourceId: catalog.source.id },
            [{ serverIdentityId: scope.serverId, machineId: 'controller-1' }]));
        expect(actionRequests.filter(request => request.actionId === 'plugins.install')).toHaveLength(0);
        expect(hook.getCurrent().pluginInstallReview).toBeNull();
    });

    it.each([
        { method: 'install', decision: 'approve' }, { method: 'install', decision: 'reject' },
        { method: 'install', decision: 'cancel' }, { method: 'update', decision: 'approve' },
    ] as const)('confirms the carried $method review in flow and settles $decision without a self-approval Artifact', async ({ method, decision }) => {
        const { hook, catalog, artifacts, nativeInstallCommitCount, actionRequests, nativeExecutions, nativeInvocations } =
            await renderRemovalOwner('disable', [], { catalog: method === 'install', browse: method === 'install', deferredInstall: true });
        const { Modal } = await import('@/modal');
        if (method === 'install') {
            await act(async () => hook.getCurrent().openDiscoverListing({ sourceId: catalog.source.id, pluginId: 'example.compute',
                itemId: 'example.compute', version: '1.2.3' }));
            await vi.waitFor(() => expect(hook.getCurrent().canRunDiscoverActions).toBe(true));
            await act(async () => hook.getCurrent().runCatalogAction({ method, pluginId: 'example.compute', sourceId: catalog.source.id }));
        } else {
            await act(async () => hook.getCurrent().runInstalledPluginAction('update', 'example.compute'));
        }
        await vi.waitFor(() => expect(vi.mocked(Modal.show).mock.calls.filter(([config]) =>
            config.chrome?.testID === 'actions.confirmation-review.modal')).toHaveLength(1));
        const review = vi.mocked(Modal.show).mock.calls.find(([config]) =>
            config.chrome?.testID === 'actions.confirmation-review.modal')![0];
        const props = review.props;
        if (typeof props?.onAnswer !== 'function') throw new Error('Expected the carried review decision');
        const answer = props.onAnswer;
        expect(nativeExecutions[0]).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
        expect(props.actionArgs).toEqual(actionRequests[0]!.envelope.input);
        expect(props.preview).toMatchObject({ pluginInstall: { pendingReview: { review: {
                requiredHostAccess: [{ capability: 'storage.account', normalizedScope: { enabled: true } }],
            } } } });
        expect(artifacts.list()).toHaveLength(0);
        expect(actionRequests.some(request => request.actionId === 'approval.request.create')).toBe(false);
        expect(nativeInvocations[0]?.presentUserConfirmation).toBeUndefined();
        expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(true);
        expect(nativeInstallCommitCount()).toBe(0);
        await act(async () => {
            if (decision === 'cancel') review.onRequestClose?.();
            else answer(decision === 'approve');
        });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(hook.getCurrent().pluginActionApproval.approvalId).toBeNull();
        expect(hook.getCurrent().routineOperationSettlement).toMatchObject({ scope: method === 'install' ? 'discover' : 'installed',
            message: decision === 'approve' ? 'common.done' : `settingsPlugins.${method}Canceled` });
        expect(nativeInstallCommitCount()).toBe(decision === 'approve' ? 1 : 0);
        expect(artifacts.list()).toHaveLength(0);
        expect(actionRequests.filter(request => request.actionId === 'plugins.install')).toHaveLength(decision === 'approve' ? 2 : 1);
        if (decision === 'approve') {
            const refusal = ActionExecuteFailureSchema.parse(nativeExecutions[0]);
            if (!refusal.details || typeof refusal.details !== 'object' || !('reviewDigest' in refusal.details)) {
                throw new Error('Expected the receiving Machine review digest');
            }
            expect(nativeInvocations[1]?.presentUserConfirmation).toMatchObject({ actionId: 'plugins.install',
                reviewDigest: refusal.details.reviewDigest, target: { kind: 'machine', machineId: 'controller-1' } });
        }
    });

    it('presents Install confirmation on its listing and cancels on close without creating a self-approval Artifact', async () => {
        const { catalog, artifacts, actionRequests, nativeInstallCommitCount } =
            await renderRemovalOwner('disable', [], { catalog: true, deferredInstall: true });
        const { Modal, ModalProvider } = await import('@/modal');
        const { PluginListingPane } = await import('../listing/PluginListingScreen');
        const screen = await renderSettingsView(React.createElement(ModalProvider, null, React.createElement(PluginListingPane, {
            sourceId: catalog.source.id, pluginId: 'example.compute', itemId: 'example.compute', version: '1.2.3' })));
        await vi.waitFor(() => expect(screen.findByTestId('settings.plugins.listing.install')?.props.disabled).toBe(false));
        await act(async () => { screen.pressByTestId('settings.plugins.listing.install'); });
        await waitForControl(screen, 'actions.confirmation-review.decision-approve');
        const [review] = await waitForCarriedReviews(1);
        expect(review!.props?.actionArgs).toMatchObject({ machineId: 'controller-1' });
        expect(screen.findByTestId('actions.confirmation-review.decision-reject')).not.toBeNull();
        expect(boundary.push).not.toHaveBeenCalled();
        expect(nativeInstallCommitCount()).toBe(0);
        expect(artifacts.list()).toHaveLength(0);
        await act(async () => {
            review!.onRequestClose?.();
            Modal.hide(vi.mocked(Modal.show).mock.results.at(-1)!.value as string);
        });
        await waitForControl(screen, 'settings.plugins.discover.operationSettlement');
        expect(screen.findByTestId('actions.confirmation-review')).toBeNull();
        expect(screen.findByTestId('settings.plugins.listing.approvalWaiting')).toBeNull();
        expect(nativeInstallCommitCount()).toBe(0);
        expect(artifacts.list()).toHaveLength(0);
        expect(actionRequests.filter(request => request.actionId === 'plugins.install')).toHaveLength(1);
    });

    it('settles each selected Machine through its own in-place answer without an Artifact decision or an extra install press', async () => {
        const { screen, reviews, artifacts, nativeInstallCommitCount, actionRequests, decisions } = await openCombinedConfirmationReview({});
        expect(nativeInstallCommitCount()).toBe(0);
        expect(artifacts.list()).toHaveLength(0);
        await answerCarriedReview(reviews[0]!, true);
        await vi.waitFor(() => expect(nativeInstallCommitCount()).toBe(1));
        await answerCarriedReview(reviews[1]!, false);
        await waitForControl(screen, 'settings.plugins.installOnMachines.outcome.controller-1');
        await waitForControl(screen, 'settings.plugins.installOnMachines.outcome.controller-2');
        await waitForControl(screen, 'settings.plugins.installOnMachines.close');
        expect(screen.findByTestId('settings.plugins.installOnMachines.install')).toBeNull();
        expect(decisions()).toEqual([]);
        expect(artifacts.list()).toHaveLength(0);
        expect(nativeInstallCommitCount()).toBe(1);
        expect(actionRequests.filter(request => request.actionId === 'plugins.install').map(request => request.envelope.target))
            .toEqual(['controller-1', 'controller-2', 'controller-1'].map(machineId => ({ kind: 'machine', machineId })));
    });

    async function openCombinedConfirmationReview(options: Parameters<typeof renderRemovalOwner>[2]) {
        const owner = await renderRemovalOwner('disable', [], { catalog: true, deferredInstall: true, secondMachine: true, ...options });
        const { ModalProvider } = await import('@/modal');
        const { PluginListingPane } = await import('../listing/PluginListingScreen');
        const screen = await renderSettingsView(React.createElement(ModalProvider, null, React.createElement(PluginListingPane, {
            sourceId: owner.catalog.source.id, pluginId: 'example.compute', itemId: 'example.compute', version: '1.2.3' })));
        await vi.waitFor(() => expect(screen.findByTestId('settings.plugins.listing.installOnMachines')?.props.disabled).toBe(false));
        await act(async () => { screen.pressByTestId('settings.plugins.listing.installOnMachines'); });
        await waitForControl(screen, 'settings.plugins.installOnMachines.target.controller-2');
        await act(async () => { screen.findByTestId('settings.plugins.installOnMachines.target.controller-2.switch')!
            .props.onValueChange(true); });
        await act(async () => { screen.pressByTestId('settings.plugins.installOnMachines.continue'); });
        const reviews = await waitForCarriedReviews(2);
        expect(reviews.map(review => review.props?.actionArgs)).toEqual(['controller-1', 'controller-2'].map(machineId => expect.objectContaining({ machineId })));
        const decisions = () => boundary.rpc.mock.calls.map(([request]) => request).filter(request =>
            request.method === RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED || request.method === RPC_METHODS.APPROVAL_REQUEST_DECIDE);
        return { ...owner, screen, reviews, decisions };
    }

    async function openCombinedReview(options: Parameters<typeof renderRemovalOwner>[2]) {
        const owner = await renderRemovalOwner('disable', [], { catalog: true, deferredInstall: true, secondMachine: true, ...options });
        owner.storage.setState({ socketStatus: 'connected', endpointStatus: 'online', syncError: null });
        const { ModalProvider } = await import('@/modal');
        const { PluginListingPane } = await import('../listing/PluginListingScreen');
        const screen = await renderSettingsView(React.createElement(ModalProvider, null, React.createElement(PluginListingPane, {
            sourceId: owner.catalog.source.id, pluginId: 'example.compute', itemId: 'example.compute', version: '1.2.3' })));
        await vi.waitFor(() => expect(screen.findByTestId('settings.plugins.listing.installOnMachines')?.props.disabled).toBe(false));
        await act(async () => { screen.pressByTestId('settings.plugins.listing.installOnMachines'); });
        await waitForControl(screen, 'settings.plugins.installOnMachines.target.controller-2');
        await act(async () => { screen.findByTestId('settings.plugins.installOnMachines.target.controller-2.switch')!
            .props.onValueChange(true); });
        await act(async () => { screen.pressByTestId('settings.plugins.installOnMachines.continue'); });
        await vi.waitFor(() => expect(owner.artifacts.list()).toHaveLength(2));
        await waitForControl(screen, 'settings.plugins.installOnMachines.machine.controller-1');
        await waitForControl(screen, 'settings.plugins.installOnMachines.machine.controller-2');
        const decisions = () => boundary.rpc.mock.calls.map(([request]) => request).filter(request =>
            request.method === RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED || request.method === RPC_METHODS.APPROVAL_REQUEST_DECIDE);
        return { ...owner, screen, decisions,
            machineText: (machineId: string) => textWithin(screen.findByTestId(`settings.plugins.installOnMachines.machine.${machineId}`)) };
    }

    it('reads a row whose Home this device cannot name to one sign-in as unavailable, with nothing to confirm', async () => {
        // The review set keeps the portable identity when no single profile here names that Home (missing, or
        // several sign-ins on it); the row's review must then read as unavailable and never count toward the press.
        await renderRemovalOwner('disable', [], { catalog: true });
        const { ModalProvider } = await import('@/modal');
        const { PluginInstallOnMachinesSheet } = await import('../listing/PluginInstallOnMachines');
        const target = { serverIdentityId: 'srv_not_on_this_device', machineId: 'studio-mac' };
        const label = { machine: 'Studio Mac', server: 'Other Home' };
        function Host() {
            const [review, setReview] = React.useState<import('./usePluginInstallReviewSet').PluginInstallReviewSet | null>(null);
            return React.createElement(PluginInstallOnMachinesSheet, { name: 'Example compute', initialTarget: target,
                candidates: [{ target, displayName: label.machine, serverLabel: label.server, availability: 'online', observation: 'live', observedAt: 1 }],
                review, onClosed: () => {}, onClose: () => {},
                run: async () => { setReview({ pluginId: 'example.compute', rows: [{ kind: 'approval', target, targetLabel: label,
                    artifactId: 'approval-other-home', serverId: target.serverIdentityId }] }); } });
        }
        const screen = await renderSettingsView(React.createElement(ModalProvider, null, React.createElement(Host)));
        await waitForControl(screen, 'settings.plugins.installOnMachines.continue');
        await act(async () => { screen.pressByTestId('settings.plugins.installOnMachines.continue'); });
        await waitForControl(screen, 'settings.plugins.installOnMachines.machine.studio-mac');
        await vi.waitFor(() => expect(textWithin(screen.findByTestId('settings.plugins.installOnMachines.machine.studio-mac')))
            .toContain('actionConfirmations.homeUnavailable'));
        // Nothing here waits on this person: no Install control is offered, only Close.
        expect(screen.findByTestId('settings.plugins.installOnMachines.install')).toBeNull();
        await waitForControl(screen, 'settings.plugins.installOnMachines.close');
        expect(boundary.rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED
            || request.method === RPC_METHODS.APPROVAL_REQUEST_DECIDE)).toEqual([]);
    });

    it('keeps a Machine whose approval carries no evaluated review out of the press and says why', async () => {
        const { screen, decisions, machineText, artifacts } = await openCombinedReview({ unevaluatedMachineIds: ['controller-2'] });
        await vi.waitFor(() => expect(screen.findByTestId('settings.plugins.installOnMachines.install')?.props.disabled).toBe(false));
        // The evaluated row offers its facts; the other shows no facts, only why it cannot be approved here.
        expect(machineText('controller-1')).toContain('settingsPlugins.installReviewSections.identity');
        await vi.waitFor(() => expect(machineText('controller-2')).toContain('approvals.approveUnavailableHint'));
        expect(machineText('controller-2')).not.toContain('settingsPlugins.installReviewSections.identity');
        await act(async () => { screen.pressByTestId('settings.plugins.installOnMachines.install'); });
        await vi.waitFor(() => expect(decisions()).toHaveLength(1));
        const machineOf = (artifactId: string) => ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!))
            .executionOriginV1.target;
        const decided = (decisions()[0]!.payload as { artifactId?: string }).artifactId!;
        expect(machineOf(decided)).toEqual({ kind: 'machine', machineId: 'controller-1' });
    });
});

function textWithin(node: import('react-test-renderer').ReactTestInstance | null | undefined): string {
    if (!node) return '';
    return node.children.map(child => typeof child === 'string' ? child : textWithin(child)).join(' ');
}

describe('My plugins presented demand and shared Add continuation', () => {
    it('keeps no selected Machine distinct from disconnected through the real settings hook', async () => {
        const { hook, storage, scope } = await renderRemovalOwner('disable', [], { noTarget: true });
        await vi.waitFor(() => expect(hook.getCurrent().administrationTargetSelection.state.kind).toBe('unselected'));
        expect(hook.getCurrent().readOnlySnapshotNotice).toEqual({ reason: 'noTarget' });
        expect(boundary.rpc.mock.calls).toHaveLength(0);
        await act(async () => { storage.getState().applySettings({ ...storage.getState().settings,
            machineAdministrationTargetsLocalV1: { 'plugins.home': { serverIdentityId: scope.serverId, machineId: 'controller-1' } },
        }, 2); });
        await vi.waitFor(() => expect(hook.getCurrent().daemonOperationsAvailable).toBe(true));
        expect(hook.getCurrent().readOnlySnapshotNotice).toBeNull();
    });

    it('renders the Store column without native management acquisition for its badge', async () => {
        const { requests } = await renderRemovalOwner('disable', [], { focused: false });
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { PluginsNavigationColumn } = await import('../PluginsNavigationColumn');
        const screen = await renderSettingsView(React.createElement(DestinationInstanceHost, {
            tabId: 'store', ref: { kind: 'plugins', params: {} }, pathname: '/plugins', focused: true, visible: true,
            navigation: { push: boundary.push, pushRetainingCurrent: boundary.push, replace: boundary.push,
                back: () => {}, setParams: () => {} },
            children: React.createElement(PluginsNavigationColumn),
        }));
        expect(screen.findByTestId('plugins-column')).not.toBeNull();
        await act(async () => { await Promise.resolve(); });
        expect(requests).toEqual([]);
        expect(boundary.rpc.mock.calls).toEqual([]);
    });
    it('keeps an admitted mutation alive on blur and reports an honest unknown without replay', async () => {
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        let issuedSignal: AbortSignal | null | undefined;
        const { hook, actionRequests } = await renderRemovalOwner('disable', [{ kind: 'outcomeUnknown', pluginId: 'example.compute' }], {
            readbackEnabled: false, beforeActionResponse: async signal => { issuedSignal = signal; await pending; },
        });
        try {
            await act(async () => { hook.getCurrent().runInstalledPluginAction('disable', 'example.compute'); });
            await vi.waitFor(() => expect(actionRequests).toHaveLength(1));
            await hook.rerender({ focused: false });
            expect(issuedSignal?.aborted).toBe(false);
        } finally { release(); }
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(hook.getCurrent().routineOperationSettlement).toBeNull();
        expect(boundary.alert).toHaveBeenCalledWith('settingsPlugins.pluginChangeOutcomeUnknownTitle',
            expect.stringContaining('settingsPlugins.pluginChangeOutcomeUnknownBody'));
        await hook.rerender({ focused: true });
        await vi.waitFor(() => expect(hook.getCurrent().installedPlugins[0]?.enabled).toBe(false));
        expect(actionRequests).toHaveLength(1);
    });

    it('hands an Agent plugin payload to the same exact listing continuation without installing from the Agent picker', async () => {
        const { actionRequests, catalog } = await renderRemovalOwner('disable', [], { catalog: true });
        const { AgentAddModal } = await import('../../agents/add/agentAddModalConfig');
        const screen = await renderSettingsView(React.createElement(AgentAddModal, { onClose: () => {}, onAddedStay: () => {},
            params: { sourceId: catalog.source.id, onOpenDefinition: () => {}, onOpenAgent: () => {} } }));
        await measureAddCollection(screen, 'agents.add');
        await waitForControl(screen, 'agents.add.row.example.compute');
        await act(async () => { screen.pressByTestId('agents.add.row.example.compute'); });
        await waitForControl(screen, 'agents.add:primary');
        await vi.waitFor(() => expect(screen.findByTestId('agents.add:primary')?.props.disabled).toBe(false));
        await act(async () => { screen.pressByTestId('agents.add:primary'); });
        await vi.waitFor(() => expect(boundary.push).toHaveBeenCalledWith(expect.objectContaining({ params: {
            sourceId: catalog.source.id, pluginId: 'example.compute', itemId: 'example.compute', version: '1.2.3',
        } })));
        expect(actionRequests).toEqual([]);
    });

    it('installs from a cold exact listing pane without requiring a parent Browse row', async () => {
        const { catalog, actionRequests, nativeInstallCommitCount } = await renderRemovalOwner('disable', [], { catalog: true });
        const { PluginListingPane } = await import('../listing/PluginListingScreen');
        const listing = { sourceId: catalog.source.id, pluginId: 'example.compute', itemId: 'example.compute', version: '1.2.3' };
        const screen = await renderSettingsView(React.createElement(PluginListingPane, listing));
        await waitForControl(screen, 'settings.plugins.listing.install');
        await vi.waitFor(() => expect(screen.findByTestId('settings.plugins.listing.install')?.props.disabled).toBe(false));
        expect(actionRequests).toHaveLength(0);
        await act(async () => { screen.pressByTestId('settings.plugins.listing.install'); });
        await waitForControl(screen, 'settings.plugins.listing.manage');
        expect(actionRequests).toHaveLength(1);
        expect(actionRequests[0]).toMatchObject({ actionId: 'plugins.install', envelope: {
            target: { kind: 'machine', machineId: 'controller-1' }, input: { source: { kind: 'marketplace',
                sourceId: catalog.source.id, pluginId: 'example.compute', packageName: 'example-compute', version: '1.2.3' } },
        } });
        expect(nativeInstallCommitCount()).toBe(1);
    });

    it('withdraws capability, projection and source acquisition while hidden, retaining the exact selection', async () => {
        const { hook } = await renderRemovalOwner('disable', [], { focused: false });
        expect(hook.getCurrent().executionMachineId).toBe('controller-1');
        await act(async () => {});
        expect(boundary.rpc.mock.calls).toHaveLength(0);
        await hook.rerender({ focused: true });
        await vi.waitFor(() => expect(hook.getCurrent().daemonOperationsAvailable).toBe(true));
        expect(boundary.rpc.mock.calls.every(([request]) => request.machineId === 'controller-1')).toBe(true);
        const held = hook.getCurrent().installedPlugins;
        await hook.rerender({ focused: false });
        boundary.rpc.mockClear();
        await act(async () => { hook.getCurrent().refreshPluginTruth(); });
        expect(boundary.rpc.mock.calls).toHaveLength(0);
        expect(hook.getCurrent().installedPlugins).toBe(held);
    });

    it.each(['committed', 'unknown', 'declined'] as const)('My plugins Add preserves the selected native pin through daemon consent (%s)', async outcome => {
        const { actionRequests, catalog, requests, censusReads, nativeInstallCommitCount } = await renderRemovalOwner('disable', [], {
            catalog: true, installOutcomeUnknown: outcome === 'unknown', declineInstall: outcome === 'declined',
        });
        const { ModalProvider } = await import('@/modal');
        const { PluginSettingsHomeScreen } = await import('../PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(ModalProvider, null,
            React.createElement(AppPaneProvider, null, React.createElement(PluginSettingsHomeScreen))));
        await act(async () => { screen.pressByTestId('settings.plugins.add'); });
        await waitForControl(screen, 'plugins.add:collection');
        await measureAddCollection(screen, 'plugins.add');
        await waitForControl(screen, `plugins.add.row.${catalog.source.id}.example.compute`);
        await act(async () => { screen.pressByTestId(`plugins.add.row.${catalog.source.id}.example.compute`); });
        await vi.waitFor(() => expect(screen.findByTestId('plugins.add:primary')).not.toBeNull());
        await vi.waitFor(() => expect(screen.findByTestId('plugins.add:primary')?.props.disabled).toBe(false));
        await act(async () => { screen.pressByTestId('plugins.add:primary'); });
        await vi.waitFor(() => expect(boundary.push).toHaveBeenCalledWith(expect.objectContaining({ params: {
            sourceId: catalog.source.id, pluginId: 'example.compute', itemId: 'example.compute', version: '1.2.3',
        } })));
        const { PluginListingScreen } = await import('../listing/PluginListingScreen');
        await screen.update(React.createElement(AppPaneProvider, null, React.createElement(PluginListingScreen, {
            sourceId: catalog.source.id, pluginId: 'example.compute', itemId: 'example.compute', version: '1.2.3',
        })));
        await vi.waitFor(() => expect(screen.findByTestId('settings.plugins.listing.install')?.props.disabled).toBe(false));
        await act(async () => { screen.pressByTestId('settings.plugins.listing.install'); });
        await vi.waitFor(() => expect(actionRequests).toHaveLength(1));
        if (outcome === 'declined') {
            await vi.waitFor(() => expect(screen.findByTestId('settings.plugins.listing.install')?.props.disabled).toBe(false));
            expect(screen.findByTestId('settings.plugins.listing.manage')).toBeNull();
            expect(boundary.alert).not.toHaveBeenCalled();
            expect(boundary.confirm).not.toHaveBeenCalled();
            expect(requests).toEqual([]);
            expect(censusReads.every(read => read.installed.length === 0)).toBe(true);
            expect(nativeInstallCommitCount()).toBe(0);
            const readsAfterDecline = censusReads.length;
            await act(async () => {});
            expect(actionRequests).toHaveLength(1);
            expect(censusReads).toHaveLength(readsAfterDecline);
            // Only a new deliberate Install intent may request another change.
            await act(async () => { screen.pressByTestId('settings.plugins.listing.install'); });
            await vi.waitFor(() => expect(actionRequests).toHaveLength(2));
        }
        expect(actionRequests[0]).toMatchObject({ actionId: 'plugins.install', envelope: {
            target: { kind: 'machine', machineId: 'controller-1' }, input: { machineId: 'controller-1',
                source: { kind: 'marketplace', sourceId: catalog.source.id, pluginId: 'example.compute',
                    packageName: 'example-compute', version: '1.2.3' } },
        } });
        await waitForControl(screen, 'settings.plugins.listing.manage');
        expect(censusReads.every(read => read.machineId === 'controller-1')).toBe(true);
        expect(censusReads.at(-1)?.installed).toContainEqual(expect.objectContaining({ pluginId: 'example.compute', version: '1.2.3' }));
        expect(nativeInstallCommitCount()).toBe(1);
        expect(actionRequests).toHaveLength(outcome === 'declined' ? 2 : 1);
        if (outcome === 'declined') expect(actionRequests[1]?.envelope.input).toEqual(actionRequests[0]?.envelope.input);
        expect(requests).toEqual([]);
    });
});

async function waitForControl(screen: Awaited<ReturnType<typeof renderSettingsView>>, testID: string) {
    await vi.waitFor(() => expect(screen.findByTestId(testID), `Missing control: ${testID}`).not.toBeNull());
}

async function measureAddCollection(screen: Awaited<ReturnType<typeof renderSettingsView>>, testID: string) {
    const stage = screen.findAll(node => node.props.testID === `${testID}:collection:stage`
        && typeof node.props.onLayout === 'function')[0];
    expect(stage, `Missing measured stage: ${testID}`).toBeDefined();
    await act(async () => stage!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 1080, height: 600 } } }));
}

describe('development Settings through the real UI Action wiring', () => {
    it('does not admit a new install from a retained callback while the projection refreshes', async () => {
        const { hook, actionRequests } = await renderRemovalOwner('disable', []);
        const runCatalogAction = hook.getCurrent().runCatalogAction;
        const originalRpc = boundary.rpc.getMockImplementation()!;
        let releaseProjection!: () => void;
        const projection = new Promise<void>(resolve => { releaseProjection = resolve; });
        boundary.rpc.mockImplementation(async request => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) await projection;
            return originalRpc(request);
        });
        try {
            await act(async () => { hook.getCurrent().refreshPluginTruth(); });
            await vi.waitFor(() => expect(hook.getCurrent().daemonOperationsAvailable).toBe(false));
            await act(async () => { runCatalogAction({ method: 'update', pluginId: 'example.compute' }); });
            expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false);
            expect(actionRequests).toEqual([]);
        } finally { releaseProjection(); }
    });

    it('presents a failed install preparation instead of silently re-enabling the action', async () => {
        const { hook, actionRequests } = await renderRemovalOwner('disable', [], { actionError: 'approval_context_unavailable' });
        await act(async () => { hook.getCurrent().runCatalogAction({ method: 'update', pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(actionRequests).toHaveLength(1));
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(boundary.alert).toHaveBeenCalledWith('common.error', 'approval_context_unavailable');
        expect(hook.getCurrent().routineOperationSettlement).toBeNull();
    });

    it.each(['daemon generation', 'installation', 'reconnect'] as const)('settles an admitted exact install once across %s', async change => {
        let releaseResponse!: () => void;
        const response = new Promise<void>(resolve => { releaseResponse = resolve; });
        let actionSignal: AbortSignal | null | undefined;
        const { hook, actionRequests, publishMachine, catalog, nativeInstallCommitCount } = await renderRemovalOwner('disable', [], {
            catalog: true, browse: true,
            beforeActionResponse: async signal => { actionSignal = signal; await response; },
        });
        await vi.waitFor(() => expect(hook.getCurrent().discoverEntries.some(entry => entry.sourceId === catalog.source.id)).toBe(true));
        try {
            await act(async () => { hook.getCurrent().runCatalogAction({ method: 'install', pluginId: 'example.compute', sourceId: catalog.source.id }); });
            await vi.waitFor(() => expect(actionRequests).toHaveLength(1));
            if (change === 'reconnect') {
                await act(async () => { publishMachine({ active: false }); });
                await vi.waitFor(() => expect(hook.getCurrent().daemonOperationsAvailable).toBe(false));
                expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(true);
                await act(async () => { publishMachine({ active: true }); });
            } else await act(async () => { publishMachine(change === 'installation'
                ? { installationId: 'installation-next' } : { daemonStateVersion: 2 }); });
            expect(actionSignal?.aborted).toBe(false);
            expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(true);
            expect(boundary.alert).not.toHaveBeenCalled();
            expect(hook.getCurrent().routineOperationSettlement).toBeNull();
        } finally { releaseResponse(); }
        await vi.waitFor(() => expect(hook.getCurrent().routineOperationSettlement?.message).toBe('common.done'));
        expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false);
        expect(actionRequests).toHaveLength(1);
        expect(nativeInstallCommitCount()).toBe(1);
        await vi.waitFor(() => expect(hook.getCurrent().installedPlugins[0]?.version).toBe('1.2.3'));
        expect(actionRequests[0]?.envelope.input).toMatchObject({ machineId: 'controller-1',
            source: { sourceId: catalog.source.id, pluginId: 'example.compute', version: '1.2.3' } });
    });

    it.each(['account', 'unmount'] as const)('withdraws admitted install feedback on %s retirement', async retirement => {
        let releaseResponse!: () => void;
        const response = new Promise<void>(resolve => { releaseResponse = resolve; });
        const { hook, actionRequests, storage, scope } = await renderRemovalOwner('disable', [], {
            beforeActionResponse: async () => { await response; },
        });
        try {
            await act(async () => { hook.getCurrent().runCatalogAction({ method: 'update', pluginId: 'example.compute' }); });
            await vi.waitFor(() => expect(actionRequests).toHaveLength(1));
            if (retirement === 'unmount') await hook.unmount();
            else await act(async () => { storage.getState().activateProfileScope({ ...scope, accountId: 'account-next' }); });
        } finally { await act(async () => { releaseResponse(); }); }
        expect(boundary.alert).not.toHaveBeenCalled();
        expect(hook.getCurrent().routineOperationSettlement).toBeNull();
        expect(actionRequests).toHaveLength(1);
    });

    it('keeps an issued install pending across a projection refresh on the same daemon', async () => {
        let releaseResponse!: () => void;
        const response = new Promise<void>(resolve => { releaseResponse = resolve; });
        let actionSignal: AbortSignal | null | undefined;
        const { hook, actionRequests } = await renderRemovalOwner('disable', [], {
            beforeActionResponse: async signal => { actionSignal = signal; await response; },
        });
        try {
            await act(async () => { hook.getCurrent().runCatalogAction({ method: 'update', pluginId: 'example.compute' }); });
            await vi.waitFor(() => expect(actionRequests).toHaveLength(1));
            expect(actionSignal?.aborted).toBe(false);
            const originalRpc = boundary.rpc.getMockImplementation()!;
            let releaseProjection!: () => void;
            const projection = new Promise<void>(resolve => { releaseProjection = resolve; });
            boundary.rpc.mockImplementation(async request => {
                if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) await projection;
                return originalRpc(request);
            });
            try {
                await act(async () => { hook.getCurrent().refreshPluginTruth(); });
                await vi.waitFor(() => expect(hook.getCurrent().daemonOperationsAvailable).toBe(false));
                expect(actionSignal?.aborted).toBe(false);
                expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(true);
            } finally { releaseProjection(); }
        } finally { releaseResponse(); }
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(actionRequests).toHaveLength(1);
    });

    it.each(['approval_rejected', 'machine_unavailable'])('retains the installed revision and trust when native update returns %s', async actionError => {
        const { hook, actionRequests } = await renderRemovalOwner('disable', [], { actionError });
        const before = structuredClone(hook.getCurrent().installedPlugins);
        expect(before).toMatchObject([{ pluginId: 'example.compute', version: '1.0.0',
            source: { kind: 'localPath', trustPolicy: 'trusted' } }]);
        await act(async () => { hook.getCurrent().runCatalogAction({ method: 'update', pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(actionRequests).toHaveLength(1));
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(hook.getCurrent().installedPlugins).toEqual(before);
        if (actionError === 'approval_rejected') {
            expect(hook.getCurrent().routineOperationSettlement).toMatchObject({ outcome: 'withdrawn' });
        } else {
            expect(boundary.alert).toHaveBeenCalledWith('common.error', 'machine_unavailable');
        }
    });

    it('updates the selected installed channel without reconstructing its distribution in the UI', async () => {
        const { hook, requests, actionRequests } = await renderRemovalOwner('disable', []);
        await act(async () => { hook.getCurrent().runCatalogAction({ method: 'update', pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(actionRequests).toHaveLength(1));
        expect(actionRequests[0]).toMatchObject({ actionId: 'plugins.install', envelope: {
            target: { kind: 'machine', machineId: 'controller-1' },
            input: { machineId: 'controller-1', source: { kind: 'installed', pluginId: 'example.compute' } },
        } });
        expect(requests).toEqual([]);
    });
    it('presents the daemon development install review and applies nothing when canceled', async () => {
        const sourceRootPath = '/plugins/example.compute';
        const { hook, nativeInstallCommitCount, actionRequests } = await renderRemovalOwner('disable', [], {
            development: true, developmentRoot: sourceRootPath, deferredInstall: true,
        });
        const { Modal } = await import('@/modal');
        await act(async () => { hook.getCurrent().runDevelopmentSourceInstall(sourceRootPath); });
        await vi.waitFor(() => expect(vi.mocked(Modal.show).mock.calls).toHaveLength(1));
        const review = vi.mocked(Modal.show).mock.calls[0]![0].props as {
            actionArgs: unknown; preview: unknown; onAnswer(confirmed: boolean): void;
        };
        expect(review.actionArgs).toEqual({ machineId: 'controller-1', path: sourceRootPath, dev: true });
        expect(review.preview).toMatchObject({ pluginInstall: { pendingReview: { review: {
            requiredHostAccess: [{ capability: 'storage.account', normalizedScope: { enabled: true } }],
        } } } });
        expect(nativeInstallCommitCount()).toBe(0);
        expect(hook.getCurrent().isPluginActionInFlight(sourceRootPath)).toBe(true);
        expect(boundary.alert).not.toHaveBeenCalled();
        await act(async () => { review.onAnswer(false); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight(sourceRootPath)).toBe(false));
        expect(nativeInstallCommitCount()).toBe(0);
        expect(actionRequests.filter(request => request.actionId === 'plugins.install')).toHaveLength(1);
        expect(hook.getCurrent().routineOperationSettlement).toBeNull();
        expect(boundary.alert).not.toHaveBeenCalled();
    });

    it.each(['/plugins/example.compute', '/plugins/example.compute.mjs'])('submits, tests, packs, and unregisters %s only on the selected machine through Actions', async (sourceRootPath) => {
        const { hook, requests, actionRequests } = await renderRemovalOwner('disable', [], {
            development: true, developmentRoot: sourceRootPath,
        });
        await act(async () => { hook.getCurrent().runDevelopmentSourceInstall(sourceRootPath); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight(sourceRootPath)).toBe(false));
        for (const action of ['test', 'pack', 'unregister'] as const) {
            // A development source is addressed by its root, so a source that never loaded stays actionable.
            await act(async () => { hook.getCurrent().runDevelopmentAction(action, sourceRootPath); });
            await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight(sourceRootPath)).toBe(false));
        }
        expect(actionRequests.map(({ actionId, envelope }) => ({ actionId, target: envelope.target, input: envelope.input }))).toEqual([
            { actionId: 'plugins.install', target: { kind: 'machine', machineId: 'controller-1' }, input: { machineId: 'controller-1', path: sourceRootPath, dev: true } },
            { actionId: 'plugins.dev.test', target: { kind: 'machine', machineId: 'controller-1' }, input: { projectRoot: sourceRootPath } },
            { actionId: 'plugins.pack', target: { kind: 'machine', machineId: 'controller-1' }, input: { locator: sourceRootPath } },
            { actionId: 'plugins.dev.unregister', target: { kind: 'machine', machineId: 'controller-1' }, input: { projectRoot: sourceRootPath } },
        ]);
        expect(requests).toEqual([]);
        await vi.waitFor(() => expect(hook.getCurrent().routineOperationSettlement?.message).toBe('common.done'));
    });

    it('settles a failed development Action without publishing success', async () => {
        const { hook, actionRequests, requests } = await renderRemovalOwner('disable', [], {
            development: true, actionFailure: true,
        });
        await vi.waitFor(() => expect(hook.getCurrent().developmentPlugins).toHaveLength(1));
        // The row acts on the source root reported by this scenario's daemon census.
        const sourceRootPath = hook.getCurrent().developmentPlugins[0]!.sourceRootPath;
        await act(async () => { hook.getCurrent().runDevelopmentAction('test', sourceRootPath); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight(sourceRootPath)).toBe(false));
        expect(actionRequests.map(request => request.actionId)).toEqual(['plugins.dev.test']);
        expect(requests).toEqual([]);
        expect(hook.getCurrent().routineOperationSettlement).toBeNull();
        expect(boundary.alert).toHaveBeenCalledWith('common.error', 'Plugin tests failed');
    });
});

const committed = { kind: 'committed', pluginId: 'example.compute', desiredGeneration: null, appliedGeneration: null, pendingSurfaces: [] };

describe('local plugin removal at the actual settings hook and machine RPC boundary', () => {
    it('updates the first Account switch change from Account push while the Machine catalog retains its initial snapshot', async () => {
        const { hook, publishAccountEnabled, actionRequests, requests } = await renderRemovalOwner('disable', [committed], {
            bundled: true, bundledAccountEnabled: true,
        });
        expect(hook.getCurrent().installedPlugins[0]).toMatchObject({ accountEnabled: true, machineEnabled: true });
        const initialCatalogReads = requests.length;
        await act(async () => { publishAccountEnabled(false); });
        await vi.waitFor(() => expect(hook.getCurrent().installedPlugins[0])
            .toMatchObject({ accountEnabled: false, machineEnabled: true }));
        expect(requests).toHaveLength(initialCatalogReads);
        await act(async () => { hook.getCurrent().runInstalledPluginAction('enable', 'example.compute', 'account'); });
        await vi.waitFor(() => expect(actionRequests).toHaveLength(1));
        expect(actionRequests[0]?.actionId).toBe('plugins.enable');
    });

    it.each(['account', 'machine'] as const)('dispatches bundled %s enablement through its semantic Action', async scope => {
        const { hook, requests, actionRequests } = await renderRemovalOwner('disable', [committed], { bundled: true });
        const action = scope === 'account' ? 'enable' : 'disable';
        await act(async () => { hook.getCurrent().runInstalledPluginAction(action, 'example.compute', scope); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(actionRequests.map(request => ({ actionId: request.actionId, input: request.envelope.input }))).toEqual([
            { actionId: `plugins.${action}`, input: { pluginId: 'example.compute', machineId: 'controller-1', scope } },
        ]);
        expect(requests).toEqual([]);
        expect(boundary.confirm).not.toHaveBeenCalled();
    });

    it('dispatches disable through the semantic Action with no default confirmation', async () => {
        const { hook, requests, actionRequests } = await renderRemovalOwner('disable', [committed]);
        await act(async () => { hook.getCurrent().runInstalledPluginAction('disable', 'example.compute'); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(actionRequests.map(request => ({ actionId: request.actionId, target: request.envelope.target, input: request.envelope.input }))).toEqual([
            { actionId: 'plugins.disable', target: { kind: 'machine', machineId: 'controller-1' }, input: { pluginId: 'example.compute', machineId: 'controller-1' } },
        ]);
        expect(requests).toEqual([]);
        expect(boundary.confirm).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(hook.getCurrent().routineOperationSettlement?.message).toBe('common.done'));
    });

    it.each(['disable', 'uninstall'] as const)('reviews exact native responsibility and a renewed census before %s can commit', async method => {
        const first = createManagedResourceDependencyFixture();
        const renewed = createManagedResourceDependencyFixture(8);
        const { hook, requests, actionRequests } = await renderRemovalOwner(method, [
            { kind: 'managedResourcesReviewRequired', pluginId: 'example.compute', resources: [first] },
            { kind: 'managedResourcesReviewRequired', pluginId: 'example.compute', resources: [renewed] }, committed,
        ]);
        await act(async () => { hook.getCurrent().runCatalogAction({ method, pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(actionRequests.length, JSON.stringify({ alerts: boundary.alert.mock.calls })).toBeGreaterThan(0));
        await vi.waitFor(() => expect(boundary.confirm).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(boundary.confirm, JSON.stringify({ requests, alerts: boundary.alert.mock.calls })).toHaveBeenCalledTimes(2);
        expect(boundary.confirm.mock.calls[0]?.[1]).toContain('native-1');
        const disposition = (resource: typeof first) => ({
            managedId: resource.managedId, expectedIntentRevision: resource.intentRevision,
            expectedAllocation: resource.allocation, expectedResource: resource.resource,
            expectedNativeOperationRef: resource.nativeOperationRef, expectedRecovery: resource.recovery, responsibility: 'manual',
        });
        expect(actionRequests.map(request => ({ actionId: request.actionId, input: request.envelope.input }))).toEqual([
            { actionId: `plugins.${method}`, input: { machineId: 'controller-1', pluginId: 'example.compute' } },
            { actionId: `plugins.${method}`, input: { machineId: 'controller-1', pluginId: 'example.compute', managedResourceDispositions: [disposition(first)] } },
            { actionId: `plugins.${method}`, input: { machineId: 'controller-1', pluginId: 'example.compute', managedResourceDispositions: [disposition(renewed)] } },
        ]);
        expect(actionRequests.every(request => request.envelope.target?.kind === 'machine' && request.envelope.target.machineId === 'controller-1')).toBe(true);
        expect(requests).toEqual([]);
        await vi.waitFor(() => expect(hook.getCurrent().routineOperationSettlement?.message).toBe('common.done'));
    });

    it.each(['cancel', 'account'] as const)('does not retry or report success after consent retires (%s)', async retirement => {
        const { hook, requests, actionRequests, storage, scope } = await renderRemovalOwner('disable', [
            { kind: 'managedResourcesReviewRequired', pluginId: 'example.compute', resources: [createManagedResourceDependencyFixture()] }, committed,
        ]);
        boundary.confirm.mockImplementation(async () => {
            if (retirement === 'account') storage.getState().activateProfileScope({ ...scope, accountId: 'account-next' });
            return retirement !== 'cancel';
        });
        await act(async () => { hook.getCurrent().runCatalogAction({ method: 'disable', pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(actionRequests.length, JSON.stringify({ alerts: boundary.alert.mock.calls })).toBeGreaterThan(0));
        await vi.waitFor(() => expect(boundary.confirm).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(boundary.confirm, JSON.stringify({ requests, alerts: boundary.alert.mock.calls })).toHaveBeenCalledTimes(1);
        expect(actionRequests).toHaveLength(1);
        expect(requests).toEqual([]);
        expect(hook.getCurrent().routineOperationSettlement).toBeNull();
    });

    it.each([
        { kind: 'dataRemovalPartial', pluginId: 'example.compute', completed: ['uninstall'], pending: ['secrets'], causeCode: 'unavailable' },
        { kind: 'failed', code: 'invalid_disposition' },
        { kind: 'outcomeUnknown', pluginId: 'example.compute' },
        { kind: 'managedResourcesReviewRequired', pluginId: 'wrong-plugin', resources: [createManagedResourceDependencyFixture()] },
        { kind: 'managedResourcesReviewRequired', pluginId: 'example.compute', resources: [createManagedResourceDependencyFixture()], unknownRecovery: true },
        { kind: 'managedResourcesReviewRequired', pluginId: 'example.compute', resources: [{ ...createManagedResourceDependencyFixture(), intentRevision: 'unreadable' }] },
    ])('does not report disable success for an uncommitted or mismatched daemon result ($kind)', async change => {
        const { hook, requests, actionRequests } = await renderRemovalOwner('disable', [change]);
        await act(async () => { hook.getCurrent().runCatalogAction({ method: 'disable', pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(actionRequests).toHaveLength(1);
        expect(requests).toEqual([]);
        expect(boundary.confirm).not.toHaveBeenCalled();
        expect(hook.getCurrent().routineOperationSettlement?.message).not.toBe('common.done');
    });

    it.each([
        { detail: 'named field', change: { kind: 'failed', code: 'PLUGIN_SETTINGS_DEFAULT_INVALID',
            message: 'Plugin example.compute Settings group "general" field "enabled" declares a default that is not a boolean.' },
            expected: 'Plugin example.compute Settings group "general" field "enabled" declares a default that is not a boolean.' },
        { detail: 'generic refusal', change: { kind: 'failed', code: 'plugin_change_failed' },
            expected: 'settingsPlugins.marketplaceChangeDecisionFailed' },
    ])('tells the author why a change was refused without inventing a daemon reason ($detail)', async ({ change, expected }) => {
        const { hook } = await renderRemovalOwner('disable', [change]);
        await act(async () => { hook.getCurrent().runCatalogAction({ method: 'disable', pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(boundary.alert).toHaveBeenCalledWith('common.error', expect.stringContaining(expected));
        expect(hook.getCurrent().routineOperationSettlement?.message).not.toBe('common.done');
    });

    it('refreshes unknown disable inventory without promoting readback to a confirmed outcome or replaying', async () => {
        const { hook, requests, actionRequests } = await renderRemovalOwner('disable', [
            { kind: 'outcomeUnknown', pluginId: 'example.compute' },
        ], { readbackEnabled: false });
        await act(async () => { hook.getCurrent().runCatalogAction({ method: 'disable', pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(actionRequests).toHaveLength(1);
        expect(requests).toEqual([]);
        expect(boundary.confirm).not.toHaveBeenCalled();
        expect(boundary.alert).toHaveBeenCalledWith('settingsPlugins.pluginChangeOutcomeUnknownTitle',
            expect.stringContaining('settingsPlugins.pluginChangeOutcomeUnknownBody'));
        expect(hook.getCurrent().routineOperationSettlement).toBeNull();
        await vi.waitFor(() => expect(hook.getCurrent().installedPlugins.find(entry => entry.pluginId === 'example.compute')?.enabled).toBe(false));
    });

    it('preserves the daemon confirmed disabled no-op without a native responsibility review', async () => {
        const { hook, requests, actionRequests } = await renderRemovalOwner('disable', [undefined], { initiallyEnabled: false });
        await act(async () => { hook.getCurrent().runCatalogAction({ method: 'disable', pluginId: 'example.compute' }); });
        await vi.waitFor(() => expect(hook.getCurrent().isPluginActionInFlight('example.compute')).toBe(false));
        expect(actionRequests).toHaveLength(1);
        expect(requests).toEqual([]);
        expect(boundary.confirm).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(hook.getCurrent().routineOperationSettlement?.message).toBe('common.done'));
    });
});
