import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { createServiceHealthNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { ExecutionRunPublicStateSchema, ExecutionRunListResponseSchema, ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ListAccountSessionFollowsResponseV1Schema } from '@happier-dev/protocol/sessions/follow/api';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginProjectedResourceV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginDynamicResourceContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { notifyExecutionRunActivity, notifyExecutionRunActivityReconnect } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SetSessionAttentionStandingRequestSchema, SetSessionAttentionStandingResponseSchema } from '@happier-dev/protocol/sessions/organization/standings';
import { SessionReadStateSetResultV1Schema } from '@happier-dev/protocol/sessions/readState/actions';
import { SessionQuestionContextV1Schema } from '@happier-dev/protocol/sessions/permissions/v1';

import { createDeferred, createPlainAccountEncryptionCurrentnessFixture, createSessionFixture, createSessionViewerFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, FeaturesResponseSchema, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { deriveArtifactCoarseKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { clearPluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { invokeMountedWorkRead } from '@/sync/ops/actions/mountedWorkReadAction';
import { deleteServerFeaturesSnapshot, primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createAutomationRunFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { WorkflowRunListPage } from '@/sync/domains/workflows/workflowRunListActions';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useSessionManagedWorkflowRuns, type SessionManagedWorkflowRunsState } from '@/components/workflows/run/useContextManagedWorkflowRuns';
import { projectWork, resolveWorkReadPresentation } from '@/components/sessions/work/workProjection';
import type { Artifact, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { createAccountNoticeArtifactFixture, createUsageNoticeArtifactFixture, usageNoticeFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { AutomationDefinitionListItemSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { createAutomationDefinitionSummary } from '@/sync/domains/automations/automationDefinitionProjection';
import { buildVoiceBrief, type VoiceBriefItem } from '@/voice/context/buildVoiceBrief';
import { VoiceBriefList } from '@/components/voice/brief/VoiceBrief';
import { Item } from '@/components/ui/lists/Item';
import { DiscussionSummaryV1Schema, DiscussionMessageV1Schema } from '@happier-dev/protocol/discussions/models';
import { DiscussionReadResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { readRegisteredDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';

import { InboxModelProvider, useInboxModel, type InboxModel } from './useInboxModel';
import { useInboxDiscussionSource } from './useInboxDiscussionSource';
import { AppShellPluginUiProjectionValueProvider, type AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { InboxSummaryProvider, useSharedInboxSummary, type InboxSummary } from './useInboxSummary';
import { countInbox, countInboxNeedsYou } from '@/components/inbox/inboxCounts';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { useInboxItemNavigation } from './useInboxItemNavigation';
import { useInboxItemResolved } from './useInboxItemResolved';
import type { InboxItemFocus } from '@/components/inbox/inboxItemFocus';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { readAccountNoticeArtifactHeader } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { InboxPluginSessionLines } from '@/components/inbox/InboxPluginSessionLines';
import { InboxContent } from '@/components/inbox/InboxContent';
import { createArtifactReadBatchHttpResponse, createArtifactStoreBoundary, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { isArtifactInventoryReady } from '@/sync/domains/artifacts/artifactInventory';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Inbox model groups by work root over the real classifier and the real workflow window.
 * Only HTTP, Socket.IO and device credentials are boundaries; the Action front door stays real.
 */
const listRuns = vi.hoisted(() => vi.fn<(params: { filter?: Record<string, unknown> }) => Promise<WorkflowRunListPage>>());
const executed = vi.hoisted(() => [] as Array<{ actionId: string; input: unknown }>);
const automationBoundary = vi.hoisted(() => ({ request: vi.fn() }));
const resourceBoundary = vi.hoisted(() => ({ request: vi.fn() }));
// The daemon network is the boundary; Resource admission, shared stores and Inbox remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: unknown) => resourceBoundary.request(request),
}));
const discussionBoundary = vi.hoisted(() => ({ request: vi.fn() }));
const artifactReadBoundary = vi.hoisted(() => ({ request: vi.fn() }));
const executionRunBoundary = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), follows: vi.fn(), rules: vi.fn() }));
let artifactStore = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
function seedArtifacts(artifacts: Record<string, DecryptedArtifact>, opaqueRows: readonly Artifact[] = []) {
    artifactStore.clear();
    for (const artifact of Object.values(artifacts)) {
        const stored = artifact.isDecrypted ? createPlainArtifactHttpFixture(artifact, 'account-a')
            : opaqueRows.find(row => row.id === artifact.id);
        if (!stored) throw new Error('Seed opaque HTTP bytes explicitly for a locked fixture');
        artifactStore.replaceStoredRow(stored);
        if (stored.ownerAccountId !== 'account-a' && stored.access !== 'owner') {
            artifactStore.seedAccountGrant(stored.id, 'account-a', stored.access);
        }
    }
    storage.setState({ artifacts });
}
let appliedSnapshot: typeof import('@/sync/domains/server/serverRuntime')['getActiveServerSnapshot'];
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let disposeActionLoader: (() => void) | undefined;
installDisconnectedServerSocketBoundary();
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

function page(runs: ReturnType<typeof createWorkflowRunSummaryFixture>[]): WorkflowRunListPage {
    return { runs, metadataByRunId: {}, nextCursor: undefined };
}

let model: InboxModel | null = null;
const readExecutor = createActionExecutor(createActionExecutorBoundaryFixture({ appShellAction: invokeMountedWorkRead }));
function readInbox(accountId = 'account-a') {
    return readExecutor.execute('inbox.get', {}, { surface: 'agent', authority: 'account_automation',
        serverId: appliedSnapshot().serverId, runtimeAccountId: accountId });
}
function Probe(): null {
    model = useInboxModel();
    return null;
}

function MountedInboxContent(props: Readonly<{ view?: 'updates' }>) {
    return <InboxContent model={useInboxModel()} view={props.view} />;
}

function MountedPluginSessionControls(): React.ReactNode {
    const inbox = useInboxModel();
    const row = inbox.items.find(item => item.focus.id === 'external-session-0');
    return <InboxPluginSessionLines rows={row?.pluginSessionRows ?? []}
        invoke={inbox.invokePluginSessionControl} testID="external-plugin-controls" />;
}

function BriefRows(props: Readonly<{ onOpen: (item: VoiceBriefItem) => void }>) {
    const inbox = useInboxModel();
    const brief = buildVoiceBrief({ inbox, settings: storage.getState().settings });
    return <VoiceBriefList brief={brief} onOpen={props.onOpen} />;
}

async function renderModel(children?: React.ReactNode) {
    const screen = await renderScreen(<InboxModelProvider><Probe />{children}</InboxModelProvider>);
    await act(async () => {});
    // These legacy scenarios vary other producers; the real HTTP inventory still has to settle.
    await vi.waitFor(() => expect(isArtifactInventoryReady(storage.getState(), 'inboxOpen')).toBe(true));
    return screen;
}

function enableDiscussionReads() {
    const base = createRootLayoutFeaturesResponse();
    const features = FeaturesResponseSchema.parse({ ...base, features: { ...base.features,
        sharing: { ...base.features.sharing, session: { enabled: true } },
        sessions: { ...base.features.sessions, conversations: { enabled: true } } } });
    primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features } });
}

describe('useInboxModel work groups (ORC R-10)', () => {
    it('keeps one C1 health condition in Updates during its readable operation and restores blocking after settlement', async () => {
        listRuns.mockResolvedValue(page([]));
        const serverId = appliedSnapshot().serverId;
        const artifact = createServiceHealthNoticeArtifactFixture(serverId, { header: { type: 'blocked' } });
        seedArtifacts({ [artifact.id]: artifact });
        const reboot: ActionOperationSnapshotV1 = {
            version: 1, operationId: 'health-reboot', revision: 1, actionId: 'machines.reboot', state: 'running',
            scope: { accountId: 'account-a', machineId: 'machine' }, title: 'Reboot', createdAt: Date.now(),
            cancellation: 'unsupported', domainRef: { kind: 'machineReboot', serverId, machineId: 'machine',
                installationId: 'installation-a', task: { id: 'task', taskKind: 'machine.reboot.v1' },
                basis: { dispatchStarted: true, bootedAt: 1, expectedRunningServiceIds: ['instance/web'], expectedRunningServicesKnown: true } },
        };
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [reboot] });
        const screen = await renderModel();
        try {
            const rows = () => model!.items.filter(item => item.source.id === artifact.id);
            expect(rows()).toEqual([expect.objectContaining({ view: 'updates', expectedDuring: {
                kind: 'reboot', operation: { serverId, machineId: 'machine', operationId: 'health-reboot' },
            } })]);
            expect(await readInbox()).toMatchObject({ ok: true, result: { items: expect.arrayContaining([
                expect.objectContaining({ expectedDuring: { kind: 'reboot', operation: {
                    serverId, machineId: 'machine', operationId: 'health-reboot',
                } } }),
            ]) } });
            await act(async () => model!.markItemOpened(rows()[0]!));
            expect(model!.accountNotices[0]!.header).toMatchObject({ healthPhase: 'open', resolved: false });
            await act(async () => actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ ...reboot,
                revision: 2, state: 'failed', settledAt: Date.now() }] }));
            expect(rows()).toEqual([expect.objectContaining({ view: 'needs_you', type: 'blocked' })]);
            expect(rows()[0]!.expectedDuring).toBeUndefined();
            expect(readAccountNoticeArtifactHeader(storage.getState().artifacts[artifact.id]!, 'account-a'))
                .toMatchObject({ type: 'blocked', healthPhase: 'open', resolved: false });
        } finally { await screen.unmount(); actionOperationStore.reset(); }
    });
    it('keeps a list-only lead title current and private without reading transcript bodies on unrelated arrivals', async () => {
        listRuns.mockResolvedValue(page([]));
        const serverId = appliedSnapshot().serverId;
        const lead = createSessionListRenderableSessionFixture({ id: 'list-only-lead', serverId,
            metadata: { name: 'Payments rollout', path: '/project', host: 'qa-host' } });
        const worker = createSessionFixture({ id: 'list-only-worker', serverId, active: true,
            manager: { sessionId: lead.id }, pendingPermissionRequestCount: 1, pendingRequestObservedAt: Date.now() });
        storage.setState({ sessions: { [worker.id]: worker }, sessionMessages: {},
            sessionListRowsByServerId: { [serverId]: {
                [lead.id]: lead,
                [worker.id]: createSessionListRenderableSessionFixture({ ...worker, hasPendingPermissionRequests: true }),
            } }, ordinarySessionListMembershipByServerId: { [serverId]: [lead.id, worker.id] } });
        const screen = await renderModel(<MountedInboxContent />);
        try {
            await vi.waitFor(() => expect(model?.items.find(item => item.focus.id === worker.id)?.reportsTo)
                .toEqual({ address: { serverId, sessionId: lead.id }, title: 'Payments rollout' }));
            expect(screen.getTextContent()).toContain('Reports to Payments rollout');
            const row = model!.items.find(item => item.focus.id === worker.id);
            let bodyReads = 0;
            const messages = Array.from({ length: 1_000 }, (_, index): import('@happier-dev/session-core/raw').NormalizedMessage => ({
                id: `unrelated-${index}`, seq: index + 1, localId: null, createdAt: index + 1, role: 'user', isSidechain: false,
                content: { type: 'text', text: 'Unrelated work' },
            }));
            await act(async () => { storage.getState().applyMessages('unrelated-session', messages); });
            const transcript = storage.getState().sessionMessages['unrelated-session']!;
            for (const message of Object.values(transcript.messagesById)) {
                const kind = message.kind;
                Object.defineProperty(message, 'kind', { configurable: true, enumerable: true,
                    get: () => { bodyReads++; return kind; } });
            }
            await act(async () => storage.setState(state => ({ sessionMessages: { ...state.sessionMessages,
                'unrelated-session': { ...transcript, messagesVersion: transcript.messagesVersion + 1 },
            } })));
            expect(model!.items.find(item => item.focus.id === worker.id)).toBe(row);
            expect(bodyReads).toBe(0);
            await act(async () => storage.setState(state => ({ sessionListRowsByServerId: {
                ...state.sessionListRowsByServerId, [serverId]: { ...state.sessionListRowsByServerId[serverId],
                    [lead.id]: { ...lead, metadata: { ...lead.metadata!, name: 'Revised lead' } },
                },
            } })));
            await vi.waitFor(() => expect(model?.items.find(item => item.focus.id === worker.id)?.reportsTo?.title).toBe('Revised lead'));
            await act(async () => storage.setState(state => ({ sessionListRowsByServerId: {
                ...state.sessionListRowsByServerId, [serverId]: { ...state.sessionListRowsByServerId[serverId],
                    [lead.id]: { ...lead, encryptedContentAvailability: 'encrypted_content_unavailable' },
                },
            } })));
            await vi.waitFor(() => expect(model?.items.find(item => item.focus.id === worker.id)?.reportsTo?.title).toBeNull());
            expect(screen.getTextContent()).not.toContain('Payments rollout');
            expect(screen.getTextContent()).not.toContain('Revised lead');
        } finally { await screen.unmount(); }
    });

    it('carries loaded lead and WorkerUpdate facts through message-only updates', async () => {
        listRuns.mockResolvedValue(page([]));
        const serverId = appliedSnapshot().serverId;
        const lead = createSessionFixture({ id: 'report-lead', serverId,
            metadata: { name: 'Payments rollout', path: '/project', host: 'qa-host' } });
        const worker = createSessionFixture({ id: 'report-worker', serverId, active: true,
            manager: { sessionId: lead.id }, pendingPermissionRequestCount: 1, pendingRequestObservedAt: Date.now() });
        const otherLead = createSessionFixture({ id: 'other-report-lead', serverId,
            metadata: { name: 'Next lead', path: '/project', host: 'qa-host' } });
        const notice = (seq: number, headline: string): import('@happier-dev/session-core/raw').NormalizedMessage => ({
            id: `worker-update-${seq}`, seq, localId: null, createdAt: seq, role: 'event', isSidechain: false,
            content: { type: 'worker-update', update: { v: 1, workerKind: 'session', workerId: worker.id,
                ownerState: 'settled', wake: 'finished', headline, canInspect: true } },
        });
        storage.setState({ sessions: { [lead.id]: lead, [worker.id]: worker, [otherLead.id]: otherLead },
            sessionListRowsByServerId: { [serverId]: {
                [lead.id]: createSessionListRenderableSessionFixture(lead),
                [worker.id]: createSessionListRenderableSessionFixture({ ...worker, hasPendingPermissionRequests: true }),
            } }, ordinarySessionListMembershipByServerId: { [serverId]: [lead.id, worker.id] }, sessionMessages: {} });
        storage.getState().applyMessages(lead.id, [notice(1, 'Runbook drafted')]);
        const screen = await renderModel();
        try {
            await vi.waitFor(() => expect(model?.items.find(item => item.focus.id === worker.id)).toMatchObject({
                reportsTo: { address: { serverId, sessionId: lead.id }, title: 'Payments rollout' },
                workerUpdateHeadline: 'Runbook drafted',
            }));
            await act(async () => { storage.getState().applyMessages(lead.id, [notice(2, 'Runbook revised')]); });
            await vi.waitFor(() => expect(model?.items.find(item => item.focus.id === worker.id)?.workerUpdateHeadline)
                .toBe('Runbook revised'));
            const row = model!.items.find(item => item.focus.id === worker.id);
            await act(async () => { storage.getState().applyMessages(otherLead.id, [
                { id: 'unrelated-prompt', seq: 1, localId: null, createdAt: 1, role: 'user', isSidechain: false,
                    content: { type: 'text', text: 'Unrelated work' } },
            ]); });
            expect(model!.items.find(item => item.focus.id === worker.id)).toBe(row);
            await act(async () => storage.setState(state => ({ sessions: { ...state.sessions,
                [worker.id]: { ...state.sessions[worker.id]!, manager: { sessionId: otherLead.id } },
            } })));
            await vi.waitFor(() => expect(model?.items.find(item => item.focus.id === worker.id)?.reportsTo)
                .toEqual({ address: { serverId, sessionId: otherLead.id }, title: 'Next lead' }));
        } finally { await screen.unmount(); }
    });

    it('keeps one Triage PR landing through the public Channels Watch Action, dedupes requests and honors settled standing until unlinked', async () => {
        listRuns.mockResolvedValue(page([]));
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const serverId = lifetime.scope.serverId;
        const { PLUGIN_MANIFEST } = await import('@happier-dev/plugins-triage/manifest');
        const { activate } = await import('@happier-dev/plugins-triage/happier-plugin-ui/triage-account-runtime');
        const { CHANNELS_PLUGIN } = await import('@happier-dev/plugins-channels/manifest');
        const { GITHUB_PLUGIN } = await import('../../../../../packages/plugins/scm-github/src/manifest');
        const { channelsProviderDescriptorFixture } =
            await import('../../../../../packages/plugins/channels/src/testkit/operationOnlyTargetedContributionsFixture');
        const { createPluginTestkit } = await import('@happier-dev/plugin-sdk/testing');
        const { observeSessionPullRequestWatchAction } = await import('../../../../../packages/plugins/channels/src/sessionPullRequestWatch');
        const { MemoryCollection } = await import('../../../../../packages/plugins/channels/src/testkit/memoryCollection');
        const { CHANNEL_STATE_COLLECTION } = await import('../../../../../packages/plugins/channels/src/collections');
        const { withChannelStateSessionIdentity } = await import('../../../../../packages/plugins/channels/src/collectionMigrations');
        const { sessionPullRequestBindingFixture } =
            await import('../../../../../packages/plugins/channels/src/testkit/sessionPullRequestBindingFixture');
        const state = new MemoryCollection();
        for (const [id, number] of [['one', 1], ['two', 2]] as const) {
            const binding = sessionPullRequestBindingFixture(id, 'linked-session', number);
            await state.put(withChannelStateSessionIdentity(binding, binding.payload.target), { expectedRevision: 'absent' });
        }
        // Only persistent Data, Settings IO and host Session discovery are boundaries; both plugin owners stay real.
        const services = {
            targetedContributions: channelsProviderDescriptorFixture(GITHUB_PLUGIN.manifest),
            storage: {
                // The real testkit accepts the full host service; this fixture admits Account Data only.
                get ephemeral(): never { throw new Error('Watch metadata must not acquire ephemeral storage'); },
                get daemonSession(): never { throw new Error('Watch metadata must not acquire daemon Session storage'); },
                get daemon(): never { throw new Error('Watch metadata must not acquire daemon storage'); },
                ...({ account: { collection: (definition: { id: string }) => {
                    if (definition.id !== CHANNEL_STATE_COLLECTION.id) throw new Error('Unexpected Collection');
                    return state;
                } } } as unknown as import('@happier-dev/plugin-sdk/actions').PluginAccountActionContext['services']['storage']),
            },
            actions: { execute: async (id: string, input: unknown) => {
                if (id !== 'session.targets.resolve' || !input || typeof input !== 'object' || !('target' in input)
                    || typeof input.target !== 'string') {
                    throw new Error('Watch metadata must not acquire native status');
                }
                return { coverage: 'complete', addresses: [{ sessionId: input.target, serverId }], error: null };
            } } as unknown as import('@happier-dev/plugin-sdk').PluginServices['actions'],
            settings: { forScope: () => ({ snapshot: async () => ({ scope: { kind: 'account' as const }, revision: '1', values: {} }),
                get: async () => null, describe: () => [], watch: () => ({ dispose() {} }),
                set: async () => { throw new Error('Read only'); }, reset: async () => { throw new Error('Read only'); } }) },
        } satisfies Pick<import('@happier-dev/plugin-sdk').PluginServices, 'storage' | 'actions' | 'settings' | 'targetedContributions'>;
        const channels = await createPluginTestkit({ manifest: CHANNELS_PLUGIN.manifest, module: CHANNELS_PLUGIN, services });
        const session = createSessionFixture({ id: 'linked-session', serverId, updatedAt: 123 });
        storage.setState({ sessions: { [session.id]: session },
            sessionListRowsByServerId: { [serverId]: { [session.id]: createSessionListRenderableSessionFixture(session) } },
            ordinarySessionListMembershipByServerId: { [serverId]: [session.id] } });
        const pluginId = PLUGIN_MANIFEST.id;
        const resources = (PLUGIN_MANIFEST.contributes?.resources ?? [])
            .filter(resource => resource.source === 'dynamic').map(resource => PluginDynamicResourceContributionV2Schema.parse(resource));
        const index = resources.find(resource => resource.sessionInbox);
        expect(index).toBeDefined();
        if (!index) throw new Error('Expected the Triage Session Inbox index');
        const detailId = index.sessionInbox!.detailResourceId;
        const hostAccountOrigin = { ...lifetime.scope, custodyId: 'triage-inbox-custody',
            sourceCustody: { kind: 'bundled_first_party' as const, packagedRuntime: {
                kind: 'source_declaration' as const, packageName: '@happier-dev/plugins-triage' } } };
        const declarations = resources.filter(resource => resource.id === index.id || resource.id === detailId)
            .map(resource => ({ ...PluginProjectedResourceV2Schema.parse({ id: resource.id, pluginId,
                occurrenceId: hostAccountOrigin.custodyId, resourceKind: resource.kind, scope: resource.scope,
                contentType: resource.contentType, execution: resource.execution,
                ...(resource.sessionInbox ? { sessionInbox: resource.sessionInbox } : {}) }), hostAccountOrigin }));
        const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, installedPackagesById: { [pluginId]: {
            id: pluginId, displayName: 'Triage', enabled: true, occurrenceId: hostAccountOrigin.custodyId,
            source: { kind: 'local', locator: '/triage/inbox' } } },
            resourcesById: Object.fromEntries(declarations.map(resource => [`${pluginId}/${resource.id}`, resource])) };
        const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
        const unpublish = publishCommittedAppShellPluginUiProjection(() => projection);
        const { createPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
        const { getInstalledPluginUiClientExecutableComposition } = await import('@/components/plugins/reactNative/clientExecutableContributions');
        const composition = getInstalledPluginUiClientExecutableComposition();
        if (index.execution?.target !== 'account') throw new Error('Expected the portable Triage index');
        const target = { realm: 'account' as const, ...index.execution.account, platform: 'web' as const };
        const cache = createPluginReactNativeBundleCache();
        const identity = { pluginId, contributionId: `resources/${index.id}`, artifactId: target.artifactId,
            artifactDigest: `sha256:${'a'.repeat(64)}` as const, platform: 'web' as const };
        cache.putInstalledArtifact({ identity, format: 'plainJs', bytes: new TextEncoder().encode('exports.activate = function() {};') });
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        const queries = vi.spyOn(state, 'query');
        const watchReads: import('@happier-dev/plugin-sdk').JsonValue[] = [];
        const activationErrors: string[] = [];
        try {
            const attempts = await composition.reconcile([{ pluginId, contributes: PLUGIN_MANIFEST.contributes ?? {},
                target, executionOrigin: null,
                occurrenceId: hostAccountOrigin.custodyId, pluginVersion: PLUGIN_MANIFEST.version, accountLifetime: lifetime,
                hostUiApiRange: '^1.0.0', cache, identity, moduleReference: { exportName: 'activate' },
                // Cross-plugin transport invokes the real registered Channels Action; no metadata assembler is mocked.
                backend: { backendId: 'commonJs', available: true, diagnostics: [], loadInstalledBundle: async () =>
                    (api: import('@happier-dev/plugin-sdk').PluginAccountApi) => {
                        try { return activate({ ...api, resources: {
                        registerDynamicResource: (id, runtime) => api.resources.registerDynamicResource(id, {
                            read: options => runtime.read({ ...options, readAction: async (ref, input, readOptions) => {
                                if (ref.pluginId !== 'happier.channels' || ref.localId !== 'session-pull-request-watch-v1') {
                                    throw new Error('Index must only read the public Watch metadata Action');
                                }
                                watchReads.push(input);
                                return { ok: true, result: await channels.invokeAction(ref.localId, input,
                                    { surface: 'ui', signal: readOptions?.signal }) };
                            } }),
                            observe: (invalidate, options) => runtime.observe(invalidate, { ...options,
                                observeAction: async (ref, input, notify, readOptions) => {
                                    if (ref.pluginId !== 'happier.channels' || ref.localId !== 'session-pull-request-watch-v1') {
                                        throw new Error('Index must only observe the public Watch metadata Action');
                                    }
                                    return observeSessionPullRequestWatchAction(input, notify,
                                        { services, invokedAtMs: Date.now(), signal: readOptions?.signal ?? options.signal });
                                } }),
                        }),
                        } }); } catch (error) {
                            activationErrors.push(error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown activation exception');
                            throw error;
                        }
                    },
                }, authority: { kind: 'account', ...lifetime.scope, custodyId: hostAccountOrigin.custodyId },
                isCurrent: lifetime.isCurrent }]);
            expect(activationErrors).toEqual([]);
            expect(attempts.map(attempt => attempt.result)).toEqual([{ ok: true }]);
            const value: AppShellPluginUiProjectionValue = { pluginUiProjection: projection, pluginBrowserProjection: null,
                phase: 'current', interactionEnabled: true, machineId: null, serverId, platform: 'web', accountLifetime: lifetime,
                reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {} };
            const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
            const view = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active}>
                <AppShellPluginUiProjectionValueProvider value={value}><InboxModelProvider><Probe /></InboxModelProvider>
                </AppShellPluginUiProjectionValueProvider></PluginSurfaceFocusEligibilityProvider>;
            screen = await renderScreen(view(false));
            expect(queries).not.toHaveBeenCalled();
            await screen.update(view(true));
            await vi.waitFor(() => expect(model?.items.filter(item => item.focus.kind === 'session')).toHaveLength(1));
            expect(model!.items[0]).toMatchObject({ producer: 'live', type: 'update', createdAt: 123,
                focus: { kind: 'session', id: session.id, serverId }, pluginSessionRows: [expect.objectContaining({ pluginId })] });
            expect(model!.items[0]!.pluginSessionRows![0]!.detailBinding).toMatchObject({ machineId: null,
                context: { kind: 'session', sessionId: session.id }, accountResource: { id: detailId } });
            expect(watchReads.length).toBeGreaterThan(0);
            expect(watchReads.every(input => input !== null && typeof input === 'object' && 'kind' in input && input.kind === 'list')).toBe(true);
            const initialReads = watchReads.length;
            const now = Date.now();
            const requested = createSessionFixture({ ...session, active: true, pendingUserActionRequestCount: 1,
                pendingRequestObservedAt: now, agentState: { requests: { question: { tool: 'AskUserQuestion', kind: 'user_action',
                    arguments: { questions: [{ question: 'Continue?' }] }, createdAt: now,
                    questionV1: SessionQuestionContextV1Schema.parse({ mode: 'continue', assumption: 'Keep working', lasting: false, type: 'blocked' }) } } } });
            await act(async () => { storage.setState({ sessions: { [session.id]: requested },
                sessionListRowsByServerId: { [serverId]: { [session.id]: createSessionListRenderableSessionFixture({ ...requested,
                    hasPendingUserActionRequests: true }) } }, sessionOrganizationAttentionStandingsBySessionKey: {
                    [buildSessionOrganizationSessionKey(serverId, session.id)]: { sessionId: session.id, standing: false, updatedAt: now },
                } }); });
            await vi.waitFor(() => expect(model?.items.filter(item => item.focus.id === session.id))
                .toEqual([expect.objectContaining({ type: 'blocked', pluginSessionRows: [expect.objectContaining({ pluginId })] })]));
            await act(async () => { storage.setState({ sessions: { [session.id]: session },
                sessionListRowsByServerId: { [serverId]: { [session.id]: createSessionListRenderableSessionFixture(session) } } }); });
            await vi.waitFor(() => expect(model?.items.filter(item => item.focus.id === session.id)).toEqual([]));
            await act(async () => { storage.setState({ sessionOrganizationAttentionStandingsBySessionKey: {} }); });
            await vi.waitFor(() => expect(model?.items.filter(item => item.focus.id === session.id)).toHaveLength(1));
            expect(watchReads).toHaveLength(initialReads); // Session/request/standing changes never reread retained PR metadata.
            await act(async () => { for (const id of ['one', 'two']) await state.delete(id, { expectedRevision: 1 }); });
            await vi.waitFor(() => expect(model?.items.filter(item => item.focus.id === session.id)).toEqual([]));
            expect(resourceBoundary.request).not.toHaveBeenCalled();
        } finally { await screen?.unmount(); unpublish(); await composition.invalidatePlugin(pluginId); await channels.dispose(); }
    });

    it('derives external Resource Session rows without Channels, hidden reads or unrelated-arrival rereads', async () => {
        listRuns.mockResolvedValue(page([]));
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const serverId = lifetime.scope.serverId;
        const pluginId = 'acme.live-inbox';
        const question = SessionQuestionContextV1Schema.parse({ mode: 'continue', assumption: 'Keep working',
            lasting: false, type: 'blocked' });
        const observedAt = Date.now();
        const session = createSessionFixture({ id: 'external-session-0', serverId, active: true,
            pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 1, pendingRequestObservedAt: observedAt,
            agentState: { requests: { 'external-question': { tool: 'AskUserQuestion', kind: 'user_action',
                arguments: { questions: [{ question: 'Which direction?' }] }, createdAt: observedAt, questionV1: question } } } });
        storage.setState({ sessions: { [session.id]: session },
            sessionListRowsByServerId: { [serverId]: { [session.id]: createSessionListRenderableSessionFixture({ ...session,
                hasPendingUserActionRequests: true }) } },
            ordinarySessionListMembershipByServerId: { [serverId]: [session.id] } });
        const index = PluginProjectedResourceV2Schema.parse({ id: 'inbox', pluginId, occurrenceId: 'external-1',
            resourceKind: 'config', scope: 'surface', contentType: 'application/json', sessionInbox: { detailResourceId: 'detail' } });
        const detail = PluginProjectedResourceV2Schema.parse({ id: 'detail', pluginId, occurrenceId: 'external-1',
            resourceKind: 'config', scope: 'session', contentType: 'application/json' });
        const rows = Array.from({ length: 1_000 }, (_, i) => ({ id: `row-${i}`,
            session: { serverId, sessionId: `external-session-${i}` }, title: `External ${i}`, detail: null,
            detailResource: { pluginId, resourceId: 'detail' }, ...(i < 2 ? { controls: [
                { id: 'See / details', label: { key: 'details', fallback: 'See details' },
                    effect: { kind: 'open', page: { pageId: 'review', subPath: 'items/42' } } },
                ...['review', 'disabled', 'absent'].map(localId => ({ id: localId, label: 'Review this',
                    effect: { kind: 'action', invocation: { action: { pluginId: 'acme.other', localId }, input: { expectedRevision: 1 } } } })),
            ] } : {}) }));
        const { PluginProjectedActionV2Schema, formatQualifiedPluginActionId, normalizeActionsSettingsV1 } = await import('@happier-dev/protocol');
        const reviewAction = PluginProjectedActionV2Schema.parse({ id: 'review', pluginId: 'acme.other', occurrenceId: 'other-1',
            title: 'Current catalog title', icon: 'checkmark', scopes: ['global'], surfaces: ['ui'],
            execution: { target: 'daemon' }, dangerLevel: 'safe', available: true });
        const reads: unknown[] = [];
        const detailReads: unknown[] = [];
        const watches: string[] = [];
        let indexUnavailable = false;
        let indexChanged = false;
        resourceBoundary.request.mockImplementation(async (request: { method: string; payload: Record<string, unknown>; signal?: AbortSignal }) => {
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) {
                const ref = request.payload.resource as { localId: string };
                const context = request.payload.context as { kind: string; sessionId?: string; launchInput?: { cursor: string | null } };
                if (ref.localId === 'detail') {
                    detailReads.push(context);
                    return { ok: true, resource: request.payload.resource, kind: 'config', contentType: 'application/json',
                        digest: `sha256:${'b'.repeat(64)}`, bytesBase64: Buffer.from(JSON.stringify({ sessionId: context.sessionId })).toString('base64') };
                }
                reads.push(request.payload);
                const second = context.launchInput?.cursor === 'second';
                return { ok: true, resource: request.payload.resource, kind: 'config', contentType: 'application/json',
                    digest: `sha256:${(indexUnavailable ? 'c' : indexChanged ? 'd' : 'a').repeat(64)}`, bytesBase64: Buffer.from(JSON.stringify(indexUnavailable
                        ? { kind: 'unavailable', reason: 'denied' }
                        : { kind: 'ready', rows: second ? rows.slice(500) : rows.slice(0, 500), nextCursor: second ? null : 'second' })).toString('base64') };
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN) {
                const ref = request.payload.resource as { localId: string };
                watches.push(ref.localId);
                return { ok: true, subscriptionId: request.payload.subscriptionId,
                    digest: `sha256:${(ref.localId === 'detail' ? 'b' : 'a').repeat(64)}` };
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE) return { ok: true };
            return new Promise((_resolve, reject) => request.signal?.addEventListener('abort',
                () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
        });
        const value: AppShellPluginUiProjectionValue = { pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION,
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'External Inbox', enabled: true,
                occurrenceId: 'external-1', source: { kind: 'local', locator: '/external/inbox' } } },
            resourcesById: { [`${pluginId}/inbox`]: index, [`${pluginId}/detail`]: detail },
            actionsById: { 'acme.other/review': reviewAction,
                'acme.other/disabled': { ...reviewAction, id: 'disabled', available: false } } },
            pluginBrowserProjection: null, phase: 'current', interactionEnabled: true, machineId: 'external-machine',
            serverId, platform: 'web', accountLifetime: lifetime,
            reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {} };
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const navigation = { push: vi.fn(), replace: vi.fn(), back: vi.fn() };
        const render = (active: boolean, projected = value, children?: React.ReactNode) => <DestinationInstanceHost
            tabId="external-inbox" ref={{ kind: 'inbox', params: {} }} pathname="/inbox" focused visible navigation={navigation}>
            <PluginSurfaceFocusEligibilityProvider active={active}>
            <AppShellPluginUiProjectionValueProvider value={projected}><InboxModelProvider><Probe />{children}</InboxModelProvider>
            </AppShellPluginUiProjectionValueProvider></PluginSurfaceFocusEligibilityProvider></DestinationInstanceHost>;
        const screen = await renderScreen(render(false));
        expect(reads).toEqual([]);
        expect(watches).toEqual([]);
        await screen.update(render(true));
        await vi.waitFor(() => expect(model?.items.filter(item => item.source.kind === 'session')).toHaveLength(1_000));
        expect(reads).toHaveLength(2);
        expect(detailReads).toEqual([]);
        expect(reads[0]).toMatchObject({ context: { kind: 'surface',
            launchInput: { serverId, cursor: null } } });
        await vi.waitFor(() => expect(watches).toEqual(['inbox', 'inbox']));
        const first = model!.items.find(item => item.focus.id === 'external-session-0');
        expect(first?.pageRoute).toContain('external-session-0');
        expect(model!.items.filter(item => item.focus.id === session.id)).toHaveLength(1);
        expect(first).toMatchObject({ type: 'blocked', question: { requestId: 'external-question' },
            pluginSessionRows: [expect.objectContaining({ pluginId })] });
        const controlRow = first!.pluginSessionRows![0]!;
        expect(controlRow.controls?.map(control => control.id)).toEqual(['See / details', 'review']);
        expect(controlRow.controls?.[1]?.action).toMatchObject({ title: 'Current catalog title', icon: 'checkmark', enabled: true,
            identity: { pluginId: 'acme.other', localId: 'review' }, occurrenceId: 'other-1' });
        await screen.update(render(true, value, <MountedPluginSessionControls />));
        const { router } = await import('expo-router');
        vi.mocked(router.push).mockClear();
        await screen.pressByTestIdAsync('external-plugin-controls.control.See / details');
        expect(vi.mocked(router.push).mock.calls.length + navigation.push.mock.calls.length).toBe(1);
        expect(navigation.push).toHaveBeenCalledExactlyOnceWith(`/plugins/${pluginId}/review/items/42?serverId=${encodeURIComponent(serverId)}`);
        expect(router.push).not.toHaveBeenCalled();
        for (let i = 0; i < 20; i++) await act(async () => publishHomeAccountChange(
            serverId, [`unrelated-${i}`], { changeKinds: ['artifact'] }));
        expect(reads).toHaveLength(2);
        expect(model!.items.find(item => item.focus.id === 'external-session-0')).toBe(first);
        await act(async () => storage.setState(state => ({ settingsScope: lifetime.scope, settings: { ...state.settings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {
                [formatQualifiedPluginActionId({ pluginId: 'acme.other', localId: 'review' })]: { enabled: false },
            } }),
        } })));
        const disabledControlRow = model!.items.find(item => item.focus.id === 'external-session-0')!.pluginSessionRows![0]!;
        expect(disabledControlRow.controls?.map(control => control.id)).toEqual(['See / details']);
        await expect(model!.invokePluginSessionControl(controlRow, 'review')).resolves.toEqual({ kind: 'unavailable' });
        expect(reads).toHaveLength(2);
        expect(detailReads).toEqual([]);
        const { acquirePluginContextualResourceStore, PluginContextualResourceState, PluginContextualResourceStoreProvider } = await import('@/components/plugins/surfaces/PluginContextualResourceStoreProvider');
        const binding = first!.pluginSessionRows![0]!.detailBinding!;
        const detailValues: unknown[] = [];
        const detailBody = (active: boolean) => <PluginContextualResourceStoreProvider>{[0, 1].map(key =>
            <PluginContextualResourceState key={key} binding={binding} resource="detail" active={active}>
                {snapshot => { if (snapshot?.value) detailValues.push(JSON.parse(new TextDecoder().decode(snapshot.value.bytes))); return null; }}
            </PluginContextualResourceState>)}</PluginContextualResourceStoreProvider>;
        await screen.update(render(true, value, detailBody(false)));
        expect(detailReads).toEqual([]);
        await screen.update(render(true, value, detailBody(true)));
        await vi.waitFor(() => expect(detailValues).toContainEqual({ sessionId: 'external-session-0' }));
        expect(detailReads).toEqual([{ kind: 'session', sessionId: 'external-session-0' }]);
        expect(watches.filter(id => id === 'detail')).toHaveLength(1);
        expect(reads).toHaveLength(2);
        await act(async () => { storage.setState({ sessions: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {} }); });
        const indexLease = acquirePluginContextualResourceStore({ pluginId, machineId: 'external-machine', serverId,
            expectedCallerOccurrenceId: 'external-1', accountLifetime: lifetime,
            context: { kind: 'surface', mountInstanceKey: 'happier:session-inbox', launchInput: { cursor: null, serverId } } })!;
        try {
            const unchanged = model!.items.find(item => item.focus.id === 'external-session-1')!.pluginSessionRows![0]!;
            rows[0]!.title = 'Updated external 0';
            indexChanged = true;
            await act(async () => { await indexLease.store.getEntry('inbox').refresh(); });
            expect(model!.items.find(item => item.focus.id === 'external-session-1')!.pluginSessionRows![0]).toBe(unchanged);
            indexUnavailable = true;
            await act(async () => { await indexLease.store.getEntry('inbox').refresh(); });
            expect(model!.items.some(item => item.focus.id.startsWith('external-session-'))).toBe(false);
            expect(model!.showCaughtUp).toBe(false); // A denied producer is not a successful empty page.
            indexUnavailable = false;
            await act(async () => { await indexLease.store.getEntry('inbox').refresh(); });
            await vi.waitFor(() => expect(model?.items.filter(item => item.source.kind === 'session')).toHaveLength(1_000));
        } finally { indexLease.dispose(); }
        await screen.update(render(true, { ...value, pluginUiProjection: { ...value.pluginUiProjection!, resourcesById: {} } }));
        expect(model!.items.some(item => item.focus.id.startsWith('external-session-'))).toBe(false);
        await screen.update(render(true, { ...value, pluginUiProjection: { ...value.pluginUiProjection!,
            resourcesById: { [`${pluginId}/inbox`]: index } } }));
        expect(model!.showCaughtUp).toBe(false); // Missing declared detail is unavailable, not an empty producer.
        await act(async () => (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime());
        expect(model!.items.some(item => item.focus.id.startsWith('external-session-'))).toBe(false);
        await screen.unmount();
    });

    beforeAll(async () => {
        await loadSyncSingletonForTests();
        disposeActionLoader = await installRealActionExecutorModuleLoader();
    });
    afterAll(() => disposeActionLoader?.());
    beforeEach(async () => {
        clearPluginAccountAvailabilityProjection();
        const runtime = await import('@/sync/domains/server/serverRuntime');
        appliedSnapshot = runtime.getActiveServerSnapshot;
        (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
        model = null;
        executed.length = 0;
        listRuns.mockReset();
        automationBoundary.request.mockReset();
        discussionBoundary.request.mockReset().mockResolvedValue(null);
        artifactReadBoundary.request.mockReset().mockResolvedValue(null);
        artifactStore = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        executionRunBoundary.list.mockReset().mockResolvedValue({ runs: [] });
        executionRunBoundary.get.mockReset();
        executionRunBoundary.follows.mockReset().mockResolvedValue({ follows: [] });
        executionRunBoundary.rules.mockReset().mockResolvedValue({ rules: [] });
        automationBoundary.request.mockImplementation(async () => new Response(JSON.stringify({ runs: [], nextCursor: null }), { status: 200 }));
        const base = createRootLayoutFeaturesResponse();
        const features = FeaturesResponseSchema.parse({
            ...base, features: { ...base.features, workflows: { enabled: true }, automations: { ...base.features.automations, enabled: true },
                sessions: { ...base.features.sessions, enabled: true, following: { enabled: true } },
                social: { ...base.features.social, friends: { enabled: false } } },
        });
        connection = await restoreServerAccountForTest({ serverUrl: 'http://inbox-home.test', accountId: 'account-a',
            configureSocket: socket => {
                configureConnectedServerSocketBoundary(socket);
                socket.emitWithAck = vi.fn(async (event: string, payload: unknown) => {
                    if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object'
                        || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
                        throw new Error('Expected Session RPC wire request');
                    }
                    const request = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, payload.params, payload.method);
                    if (payload.method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_GET)) return { ok: true,
                        result: await socketRpcCodec.encodeResponse({ mode: 'plain' },
                            ExecutionRunGetResponseSchema.parse(await executionRunBoundary.get()), request.callId) };
                    if (!payload.method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_LIST)) throw new Error('Unexpected Session RPC');
                    return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' },
                        ExecutionRunListResponseSchema.parse(await executionRunBoundary.list(payload.method)), request.callId) };
                });
            }, request: createSessionReadBatchFetchBoundary(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/session-follows') return Response.json(
                ListAccountSessionFollowsResponseV1Schema.parse(await executionRunBoundary.follows()));
            if (path === '/v2/account/session-follow-rules') return Response.json(await executionRunBoundary.rules());
            if (path === '/v2/sessions/run-session') return Response.json({
                session: createPlainSessionCurrentProjectionRecordFixture({ id: 'run-session', active: true }),
            });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                experiments: true, featureToggles: { automations: true },
            } }, version: 1 });
            if (path === '/v3/automations/runs') return automationBoundary.request(url, init);
            if (path === '/v3/automations/runs/workflow-storage') {
                const body = JSON.parse(String(init?.body)) as { request: Record<string, unknown> };
                const result = await listRuns({ filter: body.request });
                return Response.json({ runs: result.runs, acceptedEnvelopesByRunId: {}, keyCensusByRunId: {}, nextCursor: result.nextCursor });
            }
            if (path.startsWith('/v2/session-organization/attention-standings/')) {
                const sessionId = decodeURIComponent(path.split('/').at(-1)!);
                const request = SetSessionAttentionStandingRequestSchema.parse(JSON.parse(String(init?.body)));
                executed.push({ actionId: 'session.attention.set', input: { sessionId, ...request } });
                return Response.json(SetSessionAttentionStandingResponseSchema.parse({ standing:
                    request.standing === null || request.remindAt === null ? null : {
                        sessionId, standing: request.standing ?? false, updatedAt: 1,
                        ...(typeof request.remindAt === 'number' ? { remindAt: request.remindAt } : {}),
                    },
                }));
            }
            if (path.endsWith('/read-state')) {
                const sessionId = decodeURIComponent(path.split('/').at(-2)!);
                const request = JSON.parse(String(init?.body)) as { state: 'read' | 'unread' };
                executed.push({ actionId: 'session.read_state.set', input: { sessionId, ...request } });
                return Response.json({ success: true, ...SessionReadStateSetResultV1Schema.parse({
                    state: request.state, lastViewedSessionSeq: 1, didChange: true,
                }) });
            }
            if (path.startsWith('/v1/discussions')) return discussionBoundary.request(path, init);
            if (path === '/v1/artifacts/read') {
                const response = await artifactReadBoundary.request(path, init);
                if (response) return response;
            }
            const artifactUrl = new URL(String(url));
            const artifactResponse = artifactStore.handle(`${artifactUrl.pathname}${artifactUrl.search}`, init);
            if (artifactResponse) return artifactResponse;
            return null;
        }) });
        publishAppliedActiveServerSnapshot(appliedSnapshot());
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features } });
        storage.setState({
            settings: { ...storage.getState().settings, experiments: true, featureToggles: { ...storage.getState().settings.featureToggles, automations: true } },
            profileScope: { serverId: runtime.getActiveServerSnapshot().serverId, accountId: 'account-a' },
            friends: {},
            sessions: {},
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
            artifacts: {},
            automations: {},
            isDataReady: true,
            workflowRunsById: {},
            workflowRunListWindows: {},
            sessionOrganizationAttentionStandingsBySessionKey: {},
        } as never);
    });

    afterEach(async () => {
        standardCleanup();
        await connection?.dispose();
        connection = undefined;
        clearPluginAccountAvailabilityProjection();
        deleteServerFeaturesSnapshot();
        (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
        (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    });

    it('keeps Inbox readiness truthful while a followed Run baseline or empty refresh is unavailable', async () => {
        listRuns.mockResolvedValue(page([]));
        const base = createRootLayoutFeaturesResponse();
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ ...base,
            features: { ...base.features, sessions: { ...base.features.sessions, enabled: true, following: { enabled: true } } },
        }) } });
        executionRunBoundary.follows.mockResolvedValue({ follows: [{
            source: { kind: 'execution_run', sessionId: 'run-session', runId: 'followed-run' },
            following: true, persistent: true, policy: { preset: 'important' },
        }] });
        const baseline = createDeferred<{ runs: [] }>();
        executionRunBoundary.list.mockReturnValueOnce(baseline.promise);
        await renderModel();
        await vi.waitFor(() => expect(executionRunBoundary.list).toHaveBeenCalledTimes(1));
        expect(model!.isLoading).toBe(true);
        expect(model!.showCaughtUp).toBe(false);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'loading' } });

        await act(async () => { baseline.reject(new Error('offline')); });
        await vi.waitFor(() => expect(model!.isLoading).toBe(false));
        expect(model!.showCaughtUp).toBe(false);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'unavailable' } });

        const serverId = appliedSnapshot().serverId;
        executionRunBoundary.list.mockResolvedValue({ runs: [] });
        await act(async () => notifyExecutionRunActivityReconnect(serverId));
        await vi.waitFor(() => expect(model!.showCaughtUp).toBe(true));
        executionRunBoundary.list.mockRejectedValue(new Error('offline again'));
        await act(async () => notifyExecutionRunActivity({ serverId, sessionId: 'run-session' }));
        await vi.waitFor(() => expect(executionRunBoundary.list).toHaveBeenCalledTimes(3));
        await vi.waitFor(() => expect(model!.showCaughtUp).toBe(false));
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'unavailable' } });
    });

    it('derives one followed Execution Run row from live Run facts and clears it on settle without notices', async () => {
        listRuns.mockResolvedValue(page([]));
        const base = createRootLayoutFeaturesResponse();
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ ...base,
            features: { ...base.features, sessions: { ...base.features.sessions, enabled: true, following: { enabled: true } } },
        }) } });
        const serverId = appliedSnapshot().serverId;
        const run = ExecutionRunPublicStateSchema.parse({ runId: 'followed-run', callId: 'call', sidechainId: 'sidechain',
            intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, display: { title: 'Review the changes' },
            permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
            status: 'running', startedAtMs: 100 });
        executionRunBoundary.follows.mockResolvedValue({ follows: [{ source: { kind: 'execution_run', sessionId: 'run-session', runId: run.runId },
            following: true, persistent: true, policy: { preset: 'important' } }] });
        executionRunBoundary.list.mockResolvedValue({ runs: [run, { ...run, runId: 'unfollowed-run' }] });
        const summary: { current: InboxSummary | null } = { current: null };
        let summaryRenders = 0;
        function SummaryProbe() { summary.current = useSharedInboxSummary(); summaryRenders += 1; return null; }
        await renderScreen(<InboxSummaryProvider><SummaryProbe /><InboxModelProvider><Probe /></InboxModelProvider></InboxSummaryProvider>);
        await vi.waitFor(() => expect(executionRunBoundary.follows).toHaveBeenCalled());
        await vi.waitFor(() => expect(executionRunBoundary.list).toHaveBeenCalled());
        await vi.waitFor(() => expect(model!.items.filter(item => item.source.kind === 'execution_run')).toHaveLength(1));
        const row = model!.items.find(item => item.source.kind === 'execution_run')!;
        expect(row).toMatchObject({ producer: 'live', type: 'update', view: 'updates', title: 'Review the changes',
            focus: { kind: 'execution_run', serverId, id: run.runId, sessionId: 'run-session' } });
        expect(row.pageRoute).toContain('/session/run-session/runs/followed-run');
        expect(model!.accountNotices).toEqual([]);
        expect(await readInbox()).toMatchObject({ ok: true, result: { items: [expect.objectContaining({
            focus: { kind: 'execution_run', serverId, id: run.runId, sessionId: 'run-session' }, producer: 'live',
        })] } });
        expect(countInbox(model!)).toBe(1);
        expect(summary.current!.count).toBe(1);
        expect(executionRunBoundary.follows).toHaveBeenCalledTimes(1);
        expect(executionRunBoundary.rules).not.toHaveBeenCalled();
        executionRunBoundary.list.mockRejectedValueOnce(new Error('offline refresh'));
        await act(async () => notifyExecutionRunActivity({ serverId, sessionId: 'run-session' }));
        await vi.waitFor(() => expect(executionRunBoundary.list).toHaveBeenCalledTimes(2));
        expect(model!.items.find(item => item.source.kind === 'execution_run')).toBe(row);
        expect(model!.executionRunAttention.failed).toBe(true);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'ready', refreshFailed: true } });
        await act(async () => {
            for (let index = 0; index < 1_000; index++) publishHomeAccountChange(serverId, undefined, { source: 'catch-up-pending' });
        });
        expect(executionRunBoundary.follows).toHaveBeenCalledTimes(1);
        expect(executionRunBoundary.rules).not.toHaveBeenCalled();
        const rendersBeforePermission = summaryRenders;
        executionRunBoundary.list.mockResolvedValue({ runs: [{ ...run,
            attention: { kind: 'permission_required', requestIds: ['permission-a'] } }] });
        await act(async () => notifyExecutionRunActivity({ serverId, sessionId: 'run-session' }, { runId: run.runId }));
        await vi.waitFor(() => expect(model!.items.find(item => item.source.kind === 'execution_run')).toMatchObject({
            type: 'approval', view: 'needs_you', key: row.key,
        }));
        expect(summary.current!.count).toBe(1);
        expect(summaryRenders).toBe(rendersBeforePermission);
        executionRunBoundary.list.mockResolvedValue({ runs: [{ ...run, status: 'succeeded', finishedAtMs: 200 }] });
        await act(async () => notifyExecutionRunActivity({ serverId, sessionId: 'run-session' }, { runId: run.runId }));
        await vi.waitFor(() => expect(model!.items.filter(item => item.source.kind === 'execution_run')).toEqual([]));
        expect(model!.accountNotices).toEqual([]);
        expect(countInbox(model!)).toBe(0);
        expect(summary.current!.count).toBe(0);
        executionRunBoundary.list.mockResolvedValue({ runs: [run] });
        await act(async () => notifyExecutionRunActivity({ serverId, sessionId: 'run-session' }, { runId: run.runId }));
        await vi.waitFor(() => expect(model!.items.filter(item => item.source.kind === 'execution_run')).toHaveLength(1));
        executionRunBoundary.follows.mockResolvedValue({ follows: [] });
        const { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } = await import('@happier-dev/protocol/sessions/follow/changes');
        await act(async () => publishHomeAccountChange(serverId, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
        await vi.waitFor(() => expect(model!.items.filter(item => item.source.kind === 'execution_run')).toEqual([]));
        expect(summary.current!.count).toBe(0);
    });

    it('displays one consumed terminal Run receipt in Updates despite an unreadable neighboring notice', async () => {
        listRuns.mockResolvedValue(page([]));
        const serverId = appliedSnapshot().serverId;
        const run = ExecutionRunPublicStateSchema.parse({ runId: 'settled-run', callId: 'call', sidechainId: 'sidechain',
            intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, display: { title: 'Review changes' },
            permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
            status: 'succeeded', startedAtMs: 100, finishedAtMs: 200 });
        const source = { kind: 'execution_run', sessionId: 'run-session', runId: run.runId } as const;
        executionRunBoundary.follows.mockResolvedValue({ follows: [{ source, following: false, persistent: false,
            policy: { preset: 'custom', events: {} }, once: null,
            onceDeliveries: [{ original: { source, terminalEventId: 'terminal-one' }, event: { kind: 'finished' } }],
        }] });
        executionRunBoundary.get.mockResolvedValue({ run });
        const malformed = createUsageNoticeArtifactFixture({ id: 'unreadable-notice', body: '{}' });
        seedArtifacts({ [malformed.id]: malformed });
        const screen = await renderModel(<MountedInboxContent view="updates" />);
        await vi.waitFor(() => expect(model!.items.filter(item => item.focus.id === run.runId)).toHaveLength(1));
        expect(screen.findByTestId(`inbox.run.${run.runId}`)).not.toBeNull();
        expect(model!.artifactSource.phase).toBe('partial');
        expect(model!.openAccountNotices).toEqual([]);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'partial', refreshFailed: true,
            items: [expect.objectContaining({ producer: 'live', view: 'updates', read: false,
                focus: { kind: 'execution_run', serverId, sessionId: source.sessionId, id: run.runId } })] } });
        const reads = executionRunBoundary.get.mock.calls.length;
        await act(async () => { for (let index = 0; index < 100; index++)
            storage.getState().addArtifact({ ...malformed, id: `unrelated-${index}`, header: { kind: 'markdown', title: 'Document' } }); });
        expect(executionRunBoundary.get).toHaveBeenCalledTimes(reads);
        expect(model!.items.filter(item => item.focus.id === run.runId)).toHaveLength(1);
        await screen.unmount();
    });

    it.each(['retirement', 'unmount'] as const)('quietly cancels an Inbox Discussion refresh on %s', async reason => {
        enableDiscussionReads();
        const started = createDeferred<AbortSignal>();
        discussionBoundary.request.mockImplementation((_path: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error('Expected a cancellable Discussion read');
            started.resolve(signal);
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }));
        const unhandled: unknown[] = [];
        const recordUnhandled = (error: unknown) => { unhandled.push(error); };
        process.on('unhandledRejection', recordUnhandled);
        try {
            const serverId = appliedSnapshot().serverId;
            const hook = await renderHook(() => useInboxDiscussionSource(serverId));
            const signal = await started.promise;
            if (reason === 'unmount') await hook.unmount();
            else await act(async () => {
                const server = appliedSnapshot();
                await TokenStorage.removeCredentialsForServerUrl(server.serverUrl, { serverId });
            });
            expect(signal.aborted).toBe(true);
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(unhandled).toEqual([]);
            if (reason === 'retirement') expect(hook.getCurrent().source).toBeNull();
        } finally {
            process.removeListener('unhandledRejection', recordUnhandled);
        }
    });

    it('keeps a refused Inbox Discussion refresh visible through its source state', async () => {
        enableDiscussionReads();
        discussionBoundary.request.mockResolvedValue(Response.json({ error: 'discussion_read_denied' }, { status: 403 }));
        const hook = await renderHook(() => useInboxDiscussionSource(appliedSnapshot().serverId));
        await expect.poll(() => hook.getCurrent().errorCode).toBe('discussion_read_denied');
        expect(hook.getCurrent().status).toBe('revoked');
        expect(hook.getCurrent().coverage).toBe('partial');
    });

    it.each([
        { type: 'mention', producer: 'agent' },
        { type: 'decision', producer: 'agent' },
        { type: 'mention', producer: 'workflow' },
    ] as const)('keeps the unopened badge and opened $type row from $producer in agreement until its owner settles it', async ({ type, producer }) => {
        listRuns.mockResolvedValue(page([]));
        let lastReadSeq = 0;
        let proposalOpen = true;
        let message = DiscussionMessageV1Schema.parse({ id: 'mention-1', discussionId: 'doc-comments', localId: null,
            seq: 1, authorAccountId: null, accountActor: null,
            producerV1: producer === 'workflow' ? { v: 1, kind: 'workflow', runId: 'workflow-run',
                invocationRecordId: 'workflow-invocation', invocationAttempt: '1',
                execution: { kind: 'action', actionId: 'session.status.get' }, outcome: 'answer' }
                : { v: 1, kind: 'agent', sessionId: 'inbox-bot' },
            content: { t: 'plain', v: producer === 'workflow' ? { kind: 'workflow_result', value: { complete: true },
                summary: 'Review this passage', source: { runId: 'workflow-run', invocationRecordId: 'workflow-invocation', invocationAttempt: '1' } }
                : type === 'decision' ? { kind: 'doc_edit_proposal', proposal: {
                target: { ref: { kind: 'doc', artifactId: 'plan', serverId: appliedSnapshot().serverId },
                    revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 6 }, quote: 'Before' },
                baseRevision: { headerVersion: 1, bodyVersion: 1 }, before: 'Before', after: 'After', reason: 'Clarify',
            } } : { v: 1, parts: [{ t: 'text', text: 'Review this passage' }] } },
            mentionedAccountIds: ['account-a'], createdAt: 1,
            ...(type === 'decision' ? { docEditProposalDispositionV1: { state: 'open' } } : {}) });
        const summary = () => DiscussionSummaryV1Schema.parse({ id: 'doc-comments', ownerAccountId: 'account-a', encryptionMode: 'plain',
            anchor: { kind: 'doc', doc: { ref: { kind: 'doc', artifactId: 'plan', serverId: appliedSnapshot().serverId },
                revision: { headerVersion: 1, bodyVersion: 1 } } }, access: 'owner', keyReadiness: true, dataEncryptionKey: null,
            creationLocalId: null, titleContent: { t: 'plain', v: { v: 1, title: 'Plan comments' } },
            latestMessage: { id: message.id, localId: null, seq: 1, authorAccountId: null, accountActor: null, producerV1: null, createdAt: 1 },
            messageSeq: 1, lastReadSeq, unreadCount: 1 - lastReadSeq, unreadMentionCount: 1 - lastReadSeq,
            recentAuthorAccountIds: [], archivedAt: null, capabilities: { postMessages: true, rename: true, archive: true,
                restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false } });
        discussionBoundary.request.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/discussions/attention') return Response.json({ discussions: (type === 'decision' ? proposalOpen : lastReadSeq === 0)
                ? [{ discussion: summary(), occurrences: [{ message, type }] }] : [], nextCursor: null, incomplete: false });
            if (path === '/v1/discussions') return Response.json({ discussions: [summary()], nextCursor: null });
            if (path === '/v1/discussions/doc-comments') return Response.json({ discussion: summary() });
            if (path === '/v1/discussions/doc-comments/messages') return Response.json({ messages: [message], hasMoreOlder: false, messageSeq: 1 });
            if (path === '/v1/discussions/doc-comments/read') {
                const body = JSON.parse(String(init?.body)) as { lastReadSeq: number };
                lastReadSeq = body.lastReadSeq;
                return Response.json(DiscussionReadResponseV1Schema.parse({ discussionId: 'doc-comments', lastReadSeq, didChange: true }));
            }
            return null;
        });
        enableDiscussionReads();
        const bot = createSessionFixture({ id: 'inbox-bot', serverId: appliedSnapshot().serverId,
            metadata: { name: 'Payments coordinator', path: '/work/payments', host: 'machine' } });
        storage.setState({ sessions: { [bot.id]: bot } });
        let badge: InboxSummary | null = null;
        function Badge() { badge = useSharedInboxSummary(); return null; }
        const chrome = await renderScreen(<InboxSummaryProvider><Badge /></InboxSummaryProvider>);
        await vi.waitFor(() => expect(badge).toEqual({ count: 1, hasContent: true }));
        const stableBadge = badge;
        await act(async () => { storage.setState({ friends: {} }); });
        expect(badge).toBe(stableBadge);
        const screen = await renderModel();
        const scope = storage.getState().profileScope!;
        await vi.waitFor(() => expect(model!.discussionAttention.source?.entries).toHaveLength(1));
        const repository = readRegisteredDiscussionRepository(scope, { serverId: scope.serverId });
        expect(repository).not.toBeNull();
        await vi.waitFor(() => expect(model!.items.some(item => item.source.kind === 'discussion')).toBe(true));
        expect(repository!.getSnapshot().threads).toEqual({});
        expect(discussionBoundary.request.mock.calls.filter(([path]) => path.includes('/messages'))).toEqual([]);
        const row = model!.items.find(item => item.source.kind === 'discussion');
        const resolution = await renderHook(() => useInboxItemResolved(row!.focus,
            { sessionCandidates: [], accountNotices: [], isDataReady: true }));
        expect(resolution.getCurrent()).toBe(false);
        expect(row).toMatchObject({ type, view: type === 'decision' ? 'needs_you' : 'mentions', read: false,
            pageRoute: `/discussions/doc-comments?serverId=${encodeURIComponent(scope.serverId)}&messageId=mention-1`,
            focus: { kind: 'discussion', serverId: scope.serverId,
            id: 'doc-comments', messageId: 'mention-1' }, discussion: { anchor: summary().anchor },
            source: { displayName: 'Plan comments' }, author: producer === 'agent' ? { name: 'Payments coordinator' } : null });
        expect([...model!.discussionAttention.source!.sessionDisplayNames!.keys()]).toEqual(producer === 'agent' ? ['inbox-bot'] : []);
        expect(countInbox(model!)).toBe(1);
        expect(countInboxNeedsYou(model!)).toBe(type === 'decision' ? 1 : 0);
        expect(model!.discussionAttention.coverage).toBe('complete');
        await act(async () => { storage.setState({ sessions: { [bot.id]: { ...bot, encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_content_unavailable' } } }); });
        expect(model!.items.find(item => item.source.kind === 'discussion')?.author).toBeNull();
        await act(async () => { await model!.markItemOpened(row!); });
        if (type === 'decision') {
            // Opening Needs you never marks it read. The Discussion's own visible-read
            // owner may advance its cursor, but that is still not proposal disposition.
            expect(lastReadSeq).toBe(0);
            await act(async () => { await model!.discussionAttention.markOpened(row!); });
            expect(lastReadSeq).toBe(1);
            expect(model!.items.find(item => item.source.kind === 'discussion')).toMatchObject({ read: true, view: 'needs_you' });
            expect(countInboxNeedsYou(model!)).toBe(1);
            expect(badge).toEqual({ count: 1, hasContent: true });
            proposalOpen = false;
            await act(async () => { await repository!.refreshAttention(); });
            expect(resolution.getCurrent()).toBe(false);
            message = DiscussionMessageV1Schema.parse({ ...message,
                docEditProposalDispositionV1: { state: 'declined', decidedBy: { accountId: 'account-a', atMs: 2 } } });
            await act(async () => { await repository!.refreshDiscussion('doc-comments'); });
            expect(resolution.getCurrent()).toBe(true);
        } else expect(lastReadSeq).toBe(1);
        expect(model!.items.filter(item => item.source.kind === 'discussion')).toEqual([]);
        expect(countInbox(model!)).toBe(0);
        expect(badge).toEqual({ count: 0, hasContent: false });
        expect(executed.filter(item => item.actionId === 'session.read_state.set')).toEqual([]);
        await resolution.unmount();
        await screen.unmount();
        await chrome.unmount();
    });

    it('names the loaded exact-Home approval requester and keeps wrong-Home or locked names unavailable', async () => {
        listRuns.mockResolvedValue(page([]));
        const serverId = appliedSnapshot().serverId;
        const bot = createSessionFixture({ id: 'approval-bot', serverId,
            metadata: { name: 'Payments coordinator', path: '/work/payments', host: 'machine' } });
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli', sessionId: bot.id }, actionId: 'account.name.set', actionArgs: { name: 'Captain' }, summary: 'Change name',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                sessionId: bot.id, serverId, actionId: 'account.name.set', requestId: 'approval-source' } });
        const artifact: DecryptedArtifact = { id: 'approval-source', isDecrypted: true, title: request.summary,
            header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        storage.setState({ sessions: { [bot.id]: bot } });
        seedArtifacts({ [artifact.id]: artifact });
        const screen = await renderModel();
        expect(model!.items.find(item => item.source.kind === 'approval')?.source.displayName).toBe('Payments coordinator');
        await act(async () => { storage.setState({ sessions: { [bot.id]: { ...bot, serverId: 'another-home' } } }); });
        expect(model!.items.find(item => item.source.kind === 'approval')?.source.displayName).toBeNull();
        await act(async () => { storage.setState({ sessions: { [bot.id]: { ...bot, encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_content_unavailable' } } }); });
        expect(model!.items.find(item => item.source.kind === 'approval')?.source.displayName).toBeNull();
        await screen.unmount();
    });

    it('keeps the exact selected approval through missing and crossed revisions, then advances on its admitted answer', async () => {
        listRuns.mockResolvedValue(page([]));
        const serverId = appliedSnapshot().serverId;
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli' }, actionId: 'account.name.set', actionArgs: { name: 'Captain' }, summary: 'Change name',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                serverId, actionId: 'account.name.set', requestId: 'selected-approval' } });
        const open: DecryptedArtifact = { id: 'selected-approval', isDecrypted: true, title: request.summary,
            header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 2, updatedAt: 2 };
        const next = { ...open, id: 'next-approval', createdAt: 1, updatedAt: 1 };
        seedArtifacts({ [open.id]: open, [next.id]: next });
        // A real body demand may remain pending during the missing projection; it is not an answer.
        const hydration = createDeferred<Response>();
        let focus: InboxItemFocus | null = null;
        function SelectedApproval() {
            const inbox = useInboxModel();
            const [selected, select] = React.useState<InboxItemFocus | null>({ kind: 'approval', id: open.id, serverId });
            const selectedResolved = useInboxItemResolved(selected, { sessionCandidates: inbox.sessionCandidates,
                accountNotices: inbox.accountNotices, isDataReady: inbox.source.isDataReady });
            const close = React.useCallback(() => select(null), []);
            const openPage = React.useCallback(() => {}, []);
            useInboxItemNavigation({ items: inbox.items, view: 'needs_you', focus: selected, selectedResolved,
                enabled: true, select, close, open: openPage, markOpened: inbox.markItemOpened });
            focus = selected;
            return null;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}>
            <InboxModelProvider><Probe /><SelectedApproval /></InboxModelProvider>
        </KeyboardShortcutProvider>);
        await vi.waitFor(() => expect(model!.items.some(item => item.focus.id === open.id)).toBe(true));
        artifactReadBoundary.request.mockImplementation(() => hydration.promise);
        await act(async () => storage.setState({ artifacts: { [open.id]: { ...open, body: undefined }, [next.id]: next } }));
        expect(model!.items.some(item => item.focus.id === open.id)).toBe(false);
        expect(focus).toMatchObject({ id: open.id });
        await act(async () => storage.setState({ artifacts: { [open.id]: open, [next.id]: next } }));
        expect(focus).toMatchObject({ id: open.id });
        const answered = ApprovalRequestV2Schema.parse({ ...request, status: 'canceled', updatedAtMs: 3 });
        const terminal = { ...open, header: buildApprovalRequestArtifactHeaderV1(answered), headerVersion: 2, bodyVersion: 2, updatedAt: 3 };
        await act(async () => storage.setState({ artifacts: { [open.id]: terminal, [next.id]: next } }));
        expect(focus).toMatchObject({ id: open.id });
        await act(async () => storage.setState({ artifacts: { [open.id]: { ...terminal, body: JSON.stringify(answered) }, [next.id]: next } }));
        expect(focus).toMatchObject({ id: next.id });
        await act(async () => storage.setState({ artifacts: { [open.id]: { ...terminal, body: JSON.stringify(answered) },
            [next.id]: { ...next, body: undefined } } }));
        expect(focus).toMatchObject({ id: next.id });
        hydration.resolve(Response.json({ error: 'unavailable' }, { status: 503 }));
        await screen.unmount();
    });

    it('uses an owned notice disposition and follows the canonical scope through retirement and renewal', async () => {
        const serverId = appliedSnapshot().serverId;
        const artifact = createAccountNoticeArtifactFixture({ header: { type: 'decision' } });
        const header = readAccountNoticeArtifactHeader(artifact, 'account-a')!;
        const focus: InboxItemFocus = { kind: 'notice', id: artifact.id, serverId };
        const input: Parameters<typeof useInboxItemResolved>[1] = { sessionCandidates: [], accountNotices: [{ artifact, header }], isDataReady: true };
        type Props = { focus: InboxItemFocus | null; input: typeof input };
        const initialProps: Props = { focus: null, input };
        const hook = await renderHook((props: Props) => useInboxItemResolved(props.focus, props.input), { initialProps });
        expect(hook.getCurrent()).toBe(false);
        expect(await hook.rerender({ focus, input })).toBe(false);
        expect(await hook.rerender({ focus, input: { ...input, accountNotices: [] } })).toBe(false);
        const dismissed = createAccountNoticeArtifactFixture({ header: { type: 'decision', status: 'dismissed' } });
        const settled = { ...input, accountNotices: [{ artifact: dismissed, header: readAccountNoticeArtifactHeader(dismissed, 'account-a')! }] };
        expect(await hook.rerender({ focus, input: settled })).toBe(true);
        expect(await hook.rerender({ focus: { ...focus, serverId: 'other-home' }, input: settled })).toBe(false);
        expect(await hook.rerender({ focus, input: settled })).toBe(true);
        const unavailable = { ...settled, isDataReady: false };
        expect(await hook.rerender({ focus, input: unavailable })).toBe(false);
        await act(async () => (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime());
        expect(hook.getCurrent()).toBe(false);
        expect(await hook.rerender({ focus, input: settled })).toBe(true);
        await act(async () => storage.setState({ profileScope: null }));
        expect(hook.getCurrent()).toBe(false);
    });

    it('uses the selected retained workflow row after it leaves attention, never a missing row', async () => {
        const serverId = appliedSnapshot().serverId;
        const summary = createWorkflowRunSummaryFixture({ id: 'selected-run', state: 'waiting_for_review',
            attentionRequired: true, invocationAttentionRequired: true });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(summary, null)]);
        const focus: InboxItemFocus = { kind: 'workflow_run', id: summary.id, serverId };
        const hook = await renderHook(() => useInboxItemResolved(focus,
            { sessionCandidates: [], accountNotices: [], isDataReady: true }));
        expect(hook.getCurrent()).toBe(false);
        await act(async () => storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary({ ...summary, revision: summary.revision + 1,
            state: 'running', attentionRequired: false, invocationAttentionRequired: false }, null)]));
        expect(hook.getCurrent()).toBe(true);
        await act(async () => storage.getState().removeWorkflowRun(summary.id));
        expect(hook.getCurrent()).toBe(false);
    });

    it('uses the Session Activity owner after an answer and keeps missing or unreadable Sessions unknown', async () => {
        const serverId = appliedSnapshot().serverId;
        const viewer = createSessionViewerFixture({ relevance: { relevant: true, reasons: ['followed_by_me'] },
            attention: { needsAttention: true, presentation: 'full', primary: 'user_action_required', reasons: ['user_action_required'] } });
        const session = createSessionFixture({ id: 'selected-session', serverId, viewer });
        const focus: InboxItemFocus = { kind: 'session', id: session.id, serverId };
        const input: Parameters<typeof useInboxItemResolved>[1] = { sessionCandidates: [buildSessionActivityAttention({ session })], accountNotices: [], isDataReady: true };
        const hook = await renderHook((value: typeof input) => useInboxItemResolved(focus, value), { initialProps: input });
        expect(hook.getCurrent()).toBe(false);
        expect(await hook.rerender({ ...input, sessionCandidates: [] })).toBe(false);
        const answered = { ...session, viewer: createSessionViewerFixture({ relevance: viewer.relevance }) };
        expect(await hook.rerender({ ...input, sessionCandidates: [buildSessionActivityAttention({ session: answered })] })).toBe(true);
        const locked = createSessionFixture({ ...answered, encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_content_unavailable' });
        expect(await hook.rerender({ ...input, sessionCandidates: [buildSessionActivityAttention({ session: locked })] })).toBe(false);
    });

    it('uses the Activity sources exact-Home scope for an answered Session on a non-active Home', async () => {
        const serverId = 'other-home';
        const session = createSessionFixture({ id: 'other-home-session', serverId,
            viewer: createSessionViewerFixture({ relevance: { relevant: true, reasons: ['followed_by_me'] } }) });
        const focus: InboxItemFocus = { kind: 'session', id: session.id, serverId };
        const input = { sessionCandidates: [buildSessionActivityAttention({ session })], accountNotices: [], isDataReady: true,
            sessionScopes: new Map([[serverId, { serverId, accountId: 'other-home-account' }]]) };
        const hook = await renderHook((value: typeof input) => useInboxItemResolved(focus, value), { initialProps: input });
        expect(hook.getCurrent()).toBe(true);
        expect(await hook.rerender({ ...input, sessionScopes: new Map() })).toBe(false);
    });

    it('hydrates a header-only managed Delete Ask and lists it exactly once', async () => {
        listRuns.mockResolvedValue(page([]));
        const serverId = appliedSnapshot().serverId;
        const request = ApprovalRequestV2Schema.parse({
            v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'cli' }, requestedSurface: 'ui',
            actionId: 'machines.managed.delete',
            actionArgs: { homeId: serverId, managedId: 'managed-a', when: 'now', expectedRevision: 3,
                intent: 'delete', reviewedDependencies: true },
            summary: 'Delete managed machine',
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
                serverId, accountId: 'account-a', machineId: 'controller-a', target: { kind: 'machine', machineId: 'controller-a' },
                actionId: 'machines.managed.delete', requestId: 'delete-request' },
        });
        const header = buildApprovalRequestArtifactHeaderV1(request);
        const artifact: DecryptedArtifact = { id: 'delete-ask', isDecrypted: true, title: request.summary, header,
            body: undefined, headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        seedArtifacts({ [artifact.id]: artifact });
        artifactReadBoundary.request.mockImplementation(async (_path: string, init?: RequestInit) => {
            const input: unknown = JSON.parse(String(init?.body));
            return createArtifactReadBatchHttpResponse(input, () => ({ artifactId: artifact.id, ok: true, recipientCensus: null, artifact: {
                id: artifact.id, kind: deriveArtifactCoarseKindV1(header), ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'plain',
                publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent(header),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            } }));
        });
        const screen = await renderModel();
        await expect.poll(() => model?.openApprovals.map(row => row.id)).toEqual([artifact.id]);
        expect(model?.items.filter(item => item.source.kind === 'approval')).toHaveLength(1);
        expect(artifactReadBoundary.request.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
            { artifactIds: [artifact.id] },
            { artifactIds: [artifact.id], projection: 'headers' },
        ]);
        await screen.unmount();
    });

    it('names plugin notices from the existing Account-scoped package projection and withdraws unavailable names', async () => {
        listRuns.mockResolvedValue(page([]));
        const notice = createAccountNoticeArtifactFixture({ header: { body: 'Review the change' } });
        seedArtifacts({ [notice.id]: notice });
        const value: AppShellPluginUiProjectionValue = {
            pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, installedPackagesById: { 'acme.review': {
                id: 'acme.review', displayName: 'Acme Review', version: '1.0.0', enabled: true,
                source: { kind: 'bundled', locator: '@acme/review' },
            } } }, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true, machineId: null,
            serverId: appliedSnapshot().serverId, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(),
            reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
        };
        const render = (next: AppShellPluginUiProjectionValue) => <AppShellPluginUiProjectionValueProvider value={next}>
            <InboxModelProvider><Probe /></InboxModelProvider>
        </AppShellPluginUiProjectionValueProvider>;
        const screen = await renderScreen(render(value));
        expect(model!.items[0]).toMatchObject({ source: { displayName: 'Acme Review' }, author: null, excerpt: 'Review the change' });
        await screen.update(render({ ...value, accountLifetime: null }));
        expect(model!.items[0]?.source.displayName).toBeNull();
        await screen.unmount();
    });

    it('projects only current Account-owned readable open usage notices without creating Sessions', async () => {
        listRuns.mockResolvedValue(page([]));
        const notice = usageNoticeFixture;
        const owned = createUsageNoticeArtifactFixture();
        const rows: DecryptedArtifact[] = [owned,
            { ...owned, id: 'foreign', ownerAccountId: 'account-b' },
            { ...owned, id: 'shared', ownerAccountId: 'account-b', access: 'view' },
            { ...owned, id: 'published', publicAudience: 'retained' },
            { ...owned, id: 'unknown-audience', publicAudience: 'unknown' },
            createUsageNoticeArtifactFixture({ id: 'dismissed', header: { ...owned.header!, status: 'dismissed' }, body: undefined }),
            createUsageNoticeArtifactFixture({ id: 'invalid', header: { ...owned.header!, notice: { ...notice, evidence: {} } }, body: undefined }),
            createUsageNoticeArtifactFixture({ id: 'body-mismatch', body: JSON.stringify({ v: 1, notice: { ...notice, issueFingerprint: 'other' } }) }),
            createUsageNoticeArtifactFixture({ id: 'header-only', body: undefined }),
            { ...owned, id: 'locked', isDecrypted: false, title: null, header: null,
                rawHeader: null, body: undefined, sessions: undefined, draft: undefined,
                storageMode: 'plain', availability: { kind: 'locked', reason: 'invalid_stored_content' } },
        ];
        seedArtifacts(Object.fromEntries(rows.map(row => [row.id, row])), [{
            id: 'locked', kind: 'other', kindHint: 'usage_notice.v1', ownerAccountId: 'account-a',
            access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
            header: 'unopenable-header', body: encodePlainArtifactStoredContent({ body: null }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            headerVersion: 3, bodyVersion: 2, seq: 1, createdAt: 1_000, updatedAt: 2_000,
        }]);

        await renderModel();

        expect(model).toMatchObject({ openUsageNotices: [{ artifact: owned, header: owned.header }],
            hasPrimaryAttention: true, showCaughtUp: false });
        expect(model?.workGroups).toEqual([]);
        expect(storage.getState().sessions).toEqual({});
        // The admitted owned row remains readable; malformed/locked neighbors disclose incomplete coverage.
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'partial', refreshFailed: true,
            usageNoticeIds: ['notice-owned'] } });

        await act(async () => { storage.setState({ artifacts: {
            ...storage.getState().artifacts,
            'header-only': createUsageNoticeArtifactFixture({ id: 'header-only' }),
        } }); });
        expect(model?.openUsageNotices.map(entry => entry.artifact.id)).toEqual(['notice-owned', 'header-only']);

        await act(async () => { storage.setState({ profileScope: {
            ...storage.getState().profileScope!, accountId: 'account-b',
        } }); });
        expect(model?.openUsageNotices).toEqual([]);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'unavailable' } });
        expect(readAccountNoticeArtifactHeader(rows[1]!, 'account-b')).not.toBeNull();
        expect(await readInbox('account-b')).toMatchObject({ ok: true, result: { status: 'unavailable' } });
    });

    it('reads started and recovered machine notices beside Connected notices through the same private Account artifact owner', async () => {
        listRuns.mockResolvedValue(page([]));
        const notice = { topic: 'resource_limit', kind: 'memory_pressure', phase: 'started', machineId: 'machine', at: 2000, since: 1000,
            workingSessionCount: 2, guardEnabled: false, evidence: { level: 'critical', sustainMs: 60000 } };
        const header = { v: 1, kind: 'usage_notice.v1', title: 'Machine notice', status: 'open', notice };
        const owned = createUsageNoticeArtifactFixture({ id: 'machine-notice', header, rawHeader: header, body: JSON.stringify({ v: 1, notice }) });
        const recovered = { ...notice, phase: 'recovered', at: 3000 };
        const recoveredHeader = { ...header, notice: recovered };
        const recovery = createUsageNoticeArtifactFixture({ id: 'machine-recovered', header: recoveredHeader, rawHeader: recoveredHeader, body: JSON.stringify({ v: 1, notice: recovered }) });
        const connected = createUsageNoticeArtifactFixture();
        seedArtifacts({ [owned.id]: owned, [recovery.id]: recovery, [connected.id]: connected,
            foreign: { ...owned, id: 'foreign', ownerAccountId: 'account-b' },
            shared: { ...owned, id: 'shared', ownerAccountId: 'account-b', access: 'view' },
            mismatch: { ...owned, id: 'mismatch', body: JSON.stringify({ v: 1, notice: recovered }) } });
        await renderModel();
        expect(model?.openUsageNotices.map(entry => entry.artifact.id)).toEqual(['machine-notice', 'machine-recovered', 'notice-owned']);
        expect(model?.openUsageNotices.map(entry => entry.header.notice)).toEqual([notice, recovered, usageNoticeFixture]);
        expect(model?.workGroups).toEqual([]);
        expect(storage.getState().sessions).toEqual({});
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'partial', refreshFailed: true,
            usageNoticeIds: ['machine-notice', 'machine-recovered', 'notice-owned'] } });
    });

    it('retries an initially unreadable Work window through the same Action and distinguishes proven empty work', async () => {
        listRuns.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(page([]));
        let workRead: SessionManagedWorkflowRunsState | null = null;
        const projection = projectWork({
            sessionId: 'session-1', reportSessions: [], agentEntries: [], workflowHeadlineRuns: [], managedRuns: [],
            ownTriggerRunIds: new Set(), describeAgentStatus: (entry) => entry.status,
            describeProgress: ({ completed, total }) => `${completed} of ${total}`,
        });
        function WorkProbe() {
            workRead = useSessionManagedWorkflowRuns({ sessionId: 'session-1', serverId: appliedSnapshot().serverId });
            return null;
        }
        function currentRead(): SessionManagedWorkflowRunsState | null { return workRead; }
        await renderScreen(<WorkProbe />);
        await act(async () => {});
        const read = () => resolveWorkReadPresentation({ projection, managedRuns: workRead, transcriptLoaded: true });
        expect(read()).toEqual({ nothingYet: false, holdWorkingPlace: false, managedUnavailable: true });
        await act(async () => { currentRead()?.retry(); });
        expect(read()).toEqual({ nothingYet: true, holdWorkingPlace: false, managedUnavailable: false });
    });

    it('exposes a pre-session Automation failure with its exact Run route and removes it on the Account wake', async () => {
        listRuns.mockResolvedValue(page([]));
        const automation = createAutomationDefinitionSummary(AutomationDefinitionListItemSchema.parse({
            id: 'automation-1', name: 'Nightly dependency check', description: null, enabled: true, targetType: 'newSession',
            existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [], triggers: [],
        }));
        storage.setState({ automations: { [automation.id]: automation } });
        const run = createAutomationRunFixture({ id: 'pre-session', state: 'failed', errorCode: 'machine_unavailable' });
        let needsAttention = true;
        // HTTP reports the same current window until its producer changes;
        // mounting another real consumer must not consume a one-shot fixture.
        automationBoundary.request.mockImplementation(async () => Response.json({ runs: needsAttention ? [run] : [], nextCursor: null }));
        const opened = vi.fn();
        const screen = await renderModel(<BriefRows onOpen={opened} />);
        expect(model?.automationAttentionItems).toEqual([expect.objectContaining({
            key: 'automation-run:pre-session', title: automation.name, run: expect.objectContaining({ producedSessionId: null }),
            route: expect.stringMatching(/^\/workflows\/runs\/pre-session\?target=occurrence&automationId=automation-1&serverId=/),
        })]);
        expect(model?.hasPrimaryAttention).toBe(true);
        expect(screen.findAllByType(Item).map(item => item.props.title)).toEqual([automation.name]);
        await screen.pressByTestIdAsync('voice-brief.item.automation-run:pre-session');
        expect(opened.mock.lastCall?.[0].destination).toEqual({ kind: 'automation', route: model?.automationAttentionItems[0]?.route });
        await act(async () => { storage.setState({ automations: { [automation.id]: { ...automation, name: 'Morning dependency check' } } }); });
        expect(model?.automationAttentionItems[0]).toMatchObject({ title: 'Morning dependency check' });
        expect(screen.findAllByType(Item).map(item => item.props.title)).toEqual(['Morning dependency check']);
        needsAttention = false;
        await act(async () => { publishHomeAccountChange(appliedSnapshot().serverId, ['automation:automation-1']); });
        expect(model?.automationAttentionItems).toEqual([]);
        expect(screen.findAllByType(Item)).toEqual([]);
        expect(model?.showCaughtUp).toBe(true);
    });

    it('lists a followed Run once from its owner and clears it on settlement despite a retained notice copy', async () => {
        // Historical 0.3 writer output. Current Run attention must not inherit its independent lifetime.
        const content = { v: 1, type: 'update', resolved: false, source: { kind: 'host', topic: 'follow_update' },
            notice: { topic: 'follow_update', follow: { original: { source: { kind: 'workflow_run', runId: 'run-held' }, revision: 1 },
                event: { kind: 'update_posted' } } } };
        const header = { ...content, kind: 'account_notice.v1', title: 'Run updated', status: 'open' };
        const retiredNotice = createUsageNoticeArtifactFixture({ header, rawHeader: header, body: JSON.stringify(content) });
        seedArtifacts({ [retiredNotice.id]: retiredNotice });
        listRuns
            .mockResolvedValueOnce(page([createWorkflowRunSummaryFixture({ id: 'run-held', state: 'interrupted' })]))
            .mockResolvedValueOnce(page([]));

        const screen = await renderModel();

        expect(model?.workGroups.map((group) => group.key)).toEqual(['run:run-held']);
        expect(model?.workGroups[0]?.items.map((item) => item.key)).toEqual(['run:run-held']);
        expect(model?.hasPrimaryAttention).toBe(true);
        expect(model?.items).toEqual([expect.objectContaining({ producer: 'live', source: {
            kind: 'workflow_run', id: 'run-held', serverId: appliedSnapshot().serverId, displayName: expect.any(String),
        } })]);
        // An unreadable historical notice cannot hide current rows from another owner.
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'partial',
            isLoading: false, refreshFailed: true, items: [expect.objectContaining({
                source: expect.objectContaining({ kind: 'workflow_run', id: 'run-held' }),
            })] } });
        expect(await readInbox('different-account')).toMatchObject({ ok: true, result: { status: 'unavailable' } });

        await act(async () => {
            publishHomeAccountChange(appliedSnapshot().serverId, ['workflow-run:run-held']);
        });
        await act(async () => {});

        expect(model?.workGroups).toEqual([]);
        expect(model?.items).toEqual([]);
        expect(storage.getState().artifacts[retiredNotice.id]).toMatchObject(retiredNotice);
        await screen.unmount();
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'unavailable' } });
    });

    it('keeps ready rows readable while notice bodies load, fail and recover without automatic re-polls', async () => {
        listRuns.mockResolvedValue(page([createWorkflowRunSummaryFixture({ id: 'ready-work', state: 'interrupted' })]));
        const notice = createUsageNoticeArtifactFixture();
        seedArtifacts({ [notice.id]: notice });
        const screen = await renderModel();
        const hydration = createDeferred<Response>();
        artifactReadBoundary.request.mockImplementation(() => hydration.promise);
        await act(async () => storage.setState({ artifacts: { [notice.id]: { ...notice, body: undefined } } }));
        await vi.waitFor(() => expect(model!.artifactSource.phase).toBe('loading'));
        expect(model!.showCaughtUp).toBe(false);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'partial', isLoading: true,
            coverage: { sources: [{ source: 'notices', status: 'partial' }] },
            items: [expect.objectContaining({ source: expect.objectContaining({ kind: 'workflow_run', id: 'ready-work' }) })] } });

        await act(async () => hydration.resolve(Response.json({ error: 'content_unavailable' }, { status: 403 })));
        await vi.waitFor(() => expect(model!.artifactSource.phase).toBe('failed'));
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'partial', isLoading: false, refreshFailed: true,
            coverage: { sources: [{ source: 'notices', status: 'partial', reason: 'content_unavailable' }] },
            items: [expect.objectContaining({ source: expect.objectContaining({ kind: 'workflow_run', id: 'ready-work' }) })] } });
        const reads = artifactReadBoundary.request.mock.calls.length;
        await act(async () => {});
        await readInbox();
        await readInbox();
        expect(artifactReadBoundary.request).toHaveBeenCalledTimes(reads);

        artifactReadBoundary.request.mockResolvedValue(null);
        await act(async () => model!.artifactSource.retry());
        await vi.waitFor(() => expect(model!.artifactSource.phase).toBe('current'));
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'ready', isLoading: false, refreshFailed: false } });
        expect(model!.openUsageNotices.map(entry => entry.artifact.id)).toEqual([notice.id]);
        await screen.unmount();
    });

    it('reads a valid single-Home missing lead and refuses the real mixed-Home model rather than filtering it empty', async () => {
        listRuns.mockResolvedValue(page([]));
        const serverId = appliedSnapshot().serverId;
        const first = createSessionFixture({ id: 'child', serverId, manager: { sessionId: 'unknown-lead' } });
        const foreign = createSessionFixture({ id: 'foreign', serverId: 'other-home' });
        const remindAt = Date.now() + 60_000;
        storage.setState({ sessions: { child: first }, sessionOrganizationAttentionStandingsBySessionKey: {
            [buildSessionOrganizationSessionKey(serverId, first.id)]: { sessionId: first.id, standing: true, remindAt, updatedAt: 1 },
        } });
        await renderModel();
        expect(model?.workGroups[0]?.root).toEqual({ kind: 'lead', sessionId: 'unknown-lead', session: null });
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'ready', groups: [
            { key: 'lead:unknown-lead', root: { kind: 'lead', sessionId: 'unknown-lead' },
                items: [{ kind: 'snoozed', serverId, sessionId: first.id, remindAt }] },
        ] } });
        await act(async () => { storage.setState({ sessions: { child: first, foreign },
            sessionOrganizationAttentionStandingsBySessionKey: {
                ...storage.getState().sessionOrganizationAttentionStandingsBySessionKey,
                [buildSessionOrganizationSessionKey('other-home', foreign.id)]: { sessionId: foreign.id, standing: true, remindAt, updatedAt: 1 },
            } }); });
        expect(model?.workGroups.flatMap(group => group.items)).toHaveLength(2);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'unavailable' } });
    });

    it('settles through the one attention Action and the read-state Action, in that order', async () => {
        listRuns.mockResolvedValue(page([]));
        await renderModel();

        await act(async () => {
            await model?.settle(createSessionFixture({ id: 'session-1', serverId: appliedSnapshot().serverId }));
        });

        expect(executed).toEqual([
            { actionId: 'session.attention.set', input: { sessionId: 'session-1', standing: false } },
            { actionId: 'session.read_state.set', input: { sessionId: 'session-1', state: 'read' } },
        ]);
    });

    it('does not claim caught up after an initial workflow failure, and retries into grouped attention', async () => {
        listRuns.mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(page([createWorkflowRunSummaryFixture({ id: 'run-held', state: 'interrupted' })]));
        await renderModel();

        expect(model?.workflowAttention.phase).toBe('failed');
        expect(model?.isLoading).toBe(false);
        expect(model?.showCaughtUp).toBe(false);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'unavailable' } });

        await act(async () => { model?.workflowAttention.retry(); });
        expect(model?.workflowAttention.phase).toBe('loaded');
        expect(model?.workGroups.map((group) => group.key)).toEqual(['run:run-held']);
    });

    it('waits for the first workflow read rather than showing caught up', async () => {
        listRuns.mockImplementation(() => new Promise(() => {}));
        await renderModel();

        expect(model?.workflowAttention.phase).toBe('loading');
        expect(model?.isLoading).toBe(true);
        expect(model?.showCaughtUp).toBe(false);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'loading' } });
    });

    it('keeps known groups during a failed workflow refresh and recovers on retry', async () => {
        listRuns.mockResolvedValueOnce(page([createWorkflowRunSummaryFixture({ id: 'run-held', state: 'interrupted' })]))
            .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page([]));
        await renderModel();
        const knownGroups = model?.workGroups;

        await act(async () => { model?.workflowAttention.retry(); });
        expect(model?.workflowAttention.refreshFailed).toBe(true);
        expect(model?.workGroups).toBe(knownGroups);
        expect(model?.showCaughtUp).toBe(false);

        await act(async () => { model?.workflowAttention.retry(); });
        expect(model?.workflowAttention.refreshFailed).toBe(false);
        expect(model?.showCaughtUp).toBe(true);
    });

    it('does not treat a failed refresh of a previously empty workflow list as caught up', async () => {
        listRuns.mockResolvedValueOnce(page([])).mockRejectedValueOnce(new Error('offline'));
        await renderModel();
        expect(model?.showCaughtUp).toBe(true);

        await act(async () => { model?.workflowAttention.retry(); });
        expect(model?.workflowAttention.refreshFailed).toBe(true);
        expect(model?.showCaughtUp).toBe(false);
    });

    it('snoozes with remindAt and clears it with null through the same Action', async () => {
        listRuns.mockResolvedValue(page([]));
        await renderModel();

        await act(async () => {
            await model?.setReminder(createSessionFixture({ id: 'session-1', serverId: appliedSnapshot().serverId }), 9_000);
            await model?.setReminder(createSessionFixture({ id: 'session-1', serverId: appliedSnapshot().serverId }), null);
        });

        expect(executed).toEqual([
            { actionId: 'session.attention.set', input: { sessionId: 'session-1', remindAt: 9_000 } },
            { actionId: 'session.attention.set', input: { sessionId: 'session-1', remindAt: null } },
        ]);
    });
});
