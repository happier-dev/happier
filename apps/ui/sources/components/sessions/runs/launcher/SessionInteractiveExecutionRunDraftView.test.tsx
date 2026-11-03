import * as React from 'react';
import { Dimensions } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIBackendProfileSchema, buildBackendTargetKeyV2, DaemonContributionRegistryProjectionDescribeResponseSchema, ExecutionRunPublicStateSchema, FeaturesResponseSchema, PluginProjectionV2Schema, V2SessionByIdResponseSchema } from '@happier-dev/protocol';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { projectExecutionRunChildChoiceV1, withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ComposerSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/composer';
import type { RoleOverrideRecordV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import type { NativeComposerInputHandle } from '@/components/ui/forms/nativeComposerInput';

import { changeTextTestInstance, createMachineFixture, createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { serveActionHomes, type ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { getStorage } from '@/sync/domains/state/storageStore';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { configureSessionDraftRepository, createSessionDraftRepository, ensureSessionDraftAddressesHydrated, ensureSessionDraftRepositoryHydrated, getSessionDraftSnapshot, resetSessionDraftRepositoryForTests, writeExistingSessionDraft, type SessionDraftRepositoryCipher, type SessionDraftRepositoryTransport } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { getSessionDraftDocumentField } from '@/sync/ops/sessionDrafts/sessionDraftDocumentFields';
import { createSessionDraftPrivatePayloadV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1, ProfileRowsListResponseV1Schema, ProfileReferenceGuardReadResponseV1Schema, sealProfileRecordContentV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1, ProfileTransferRowReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileTransferV1';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { invalidateRoleCatalog } from '@/components/roles/catalog/useRoleCatalog';
import { t } from '@/text';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { restoreConnectionToActiveServer, disconnectActiveServerConnection } from '@/sync/runtime/orchestration/connectionManager';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { applyProfileCatalogSnapshot, getProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } from '@/sync/store/settings/profileCatalogSnapshot';
import { resetProfileCatalogEngineForTests } from '@/sync/engine/settings/profileCatalogEngine';
import { resolveReviewEngineTarget } from '@/sync/domains/reviews/reviewEngineCatalog';
import { refreshSavedSecretCatalog, resetSavedSecretCatalogEngineForTests } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { refreshPromptLibraryCatalog, resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { saveAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { beginAcpCatalogLoad } from '@/sync/store/settings/acpCatalogSnapshot';
import { readComposerPresentationSnapshot } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { AgentInput } from '@/components/sessions/agentInput';
import { AgentInputChipPickerPanel } from '@/components/sessions/agentInput/components/AgentInputChipPickerPanel';
import { SessionParticipantComposer } from '@/components/sessions/participants/composer/SessionParticipantComposer';
import { SessionInteractiveExecutionRunDraftView } from './SessionInteractiveExecutionRunDraftView';
import { StartReviewDialog } from '@/components/sessions/reviews/walkthrough/StartReviewDialog';
import { ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ReviewEngineListItemSchema } from '@happier-dev/protocol/reviews/reviewEngines';
import { askSelectionQuote, type AskSelectionTargetContext } from '@/components/ui/code/selection/askSelectionTarget';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import { TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, TeamCredentialResourceCatalogEntryV1Schema, TeamCredentialResourceDiscoverInputV1Schema, TeamCredentialResourceReadInputV1Schema } from '@happier-dev/protocol/teams';
import { teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import { resetTeamsDirectoryEngineForTests } from '@/sync/engine/teams/teamsDirectoryEngine';
import { resetTeamsSnapshotsForTests } from '@/sync/store/teams/teamsSnapshots';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { BUNDLED_ACCOUNT_PROVIDER_DECLARATIONS, BUNDLED_CANONICAL_AGENT_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';

// Platform, credentials, local persistence, HTTP and RPC are the boundaries. The composer,
// capture/coordinator, draft repository, launcher options, role catalog, capability/feature
// decisions, default Action executor and sync.submitMessage all run for real.
// The common AgentInput installer deliberately supplies a small fake store. This journey needs
// the whole real store, so install its canonical platform factories without that store override.
const windowState = vi.hoisted(() => ({ width: 1024 }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => ({ width: windowState.width, height: 800 }) });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: modal.alert, show: modal.show, update: modal.update } }).module;
});
vi.mock('expo-image', () => ({ Image: (props: Record<string, unknown>) => React.createElement('Image', props) }));
vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
    const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
    return createBrowserRecordStorageModuleMock();
});
type RpcRequest = Readonly<{ sessionId?: string; machineId?: string; serverId?: string | null; scope?: { serverId: string }; method: string; payload: unknown }>;
const transport = vi.hoisted(() => ({ call: vi.fn<(request: RpcRequest) => Promise<unknown>>() }));
vi.mock('socket.io-client', async () => {
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    return { io: (url: string) => {
        const { socket } = createSocketIoBoundaryStub();
        socket.emitWithAck.mockImplementation(async (event, raw) => {
            if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: ['session_1'] };
            if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) {
                throw new Error('Malformed Socket RPC boundary request');
            }
            const colon = raw.method.indexOf(':');
            const target = raw.method.slice(0, colon);
            const method = raw.method.slice(colon + 1);
            const { listServerProfiles, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
            const profile = listServerProfiles().find((candidate) => candidate.serverUrl === url);
            const serverId = profile ? resolveServerProfileScopeIdForIdentifier(profile.id) : undefined;
            const result = await transport.call({ method, payload: raw.params, serverId,
                ...(target === 'machine_1' ? { machineId: target } : { sessionId: target }) });
            // Relay acknowledgements are outside the target handler's result envelope.
            if (startRelayFailure && (method === SESSION_RPC_METHODS.EXECUTION_RUN_START
                || method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1)) {
                return { ok: false, ...startRelayFailure };
            }
            return { ok: true, result };
        });
        return socket;
    } };
});
const modal = vi.hoisted(() => ({ alert: vi.fn(), show: vi.fn(), update: vi.fn() }));
const platform = vi.hoisted(() => ({ focus: vi.fn() }));
const random = vi.hoisted(() => ({ next: 0 }));
vi.mock('@/platform/randomUUID', () => ({ randomUUID: () => `00000000-0000-4000-8000-${(++random.next).toString(16).padStart(12, '0')}` }));

await loadSyncSingletonForTests();
// Load pane composition before activating the test Account; its route graph initializes Sync.
const [workspaceRunSurfaces, sessionRunSurfaces] = await Promise.all([
    import('@/components/projects/panes/details/surfaces/workspaceDetailsSurfaceRenderers'),
    import('@/components/sessions/panes/surfaces/sessionDetailsSurfaceRenderers'),
]);

type Screen = Awaited<ReturnType<typeof renderScreen>>;
type ComposerProps = React.ComponentProps<typeof SessionParticipantComposer>;
type Chip = NonNullable<ComposerProps['extraActionChips']>[number];
type Run = Readonly<Record<string, unknown>>;
let home: Awaited<ReturnType<typeof serveActionHomes>>;
let serverId = '';
let sequence = 0;
let screen: Screen;
let backends: Record<string, { available: boolean; intents: string[] }>;
let protocolSupported = true;
let detachedScopeSupported = true;
let detachedSendFailure = false;
let admissionFailure = false;
let admissionGate: Promise<void> | null = null;
/** Holds the Machine's capability read, or fails it, so a test can stand in the unanswered window. */
let capabilitiesGate: Promise<void> | null = null;
let capabilitiesFailure = false;
/** Holds the Roles catalog read the same way. */
let rolesGate: Promise<void> | null = null;
let startResults: Array<unknown | Promise<unknown>>;
let startRelayFailure: Readonly<{ error: string; errorCode: string }> | null = null;
let listedRuns: Run[];
let listResult: Promise<unknown> | null;
let emittedStarts: Array<Record<string, unknown>>;
let outbound: ServedHomeRequest[];
let pluginProjection = false;
let secretAvailable = false;
let publishedProfiles: Array<ReturnType<typeof AIBackendProfileSchema.parse>> = [];
let roleOverrides: RoleOverrideRecordV1['overrides'] = {};
let teamModelsEnabled = false;
const teamModel = { kind: 'team_credential_provider_model', teamId: 'team_run', resourceId: 'resource_run',
    expectedResourceRevision: 3, deliveryMode: 'brokered', agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5.5' } as const;
function teamResource(application?: unknown) {
    return TeamCredentialResourceCatalogEntryV1Schema.parse({ id: teamModel.resourceId, teamId: teamModel.teamId,
        displayName: 'Shared coding pool', resourceRevision: 3, readiness: { kind: 'available' }, recoveryAction: null,
        mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
        connectedServiceSelections: [{ source: 'team_resource', resourceId: teamModel.resourceId, deliveryMode: 'brokered' }],
        providerModels: application ? [{ selection: teamModel, descriptor: { id: teamModel.modelId, name: 'GPT-5.5' },
            application, sourceRevision: 'source-1', availability: 'available' }] : [],
        sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } } });
}
const secretRef = 'happier:shared-secret:v1:personal-secret';
const reviewAgentProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, installedPackagesById: {},
    agentsById: Object.fromEntries((['claude', 'codex'] as const).map(agentId => [agentId, { id: agentId, title: agentId,
        identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId],
        providerRequirements: BUNDLED_CANONICAL_AGENT_DECLARATIONS[agentId]?.providerRequirements ?? undefined,
        capabilities: { surfaces: [], sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
    }])), actionsById: {},
    // Match the Machine producer's declaration projection, using the canonical
    // bundled definitions rather than a test-owned compatibility contract.
    familiesById: { providers: { family: 'providers', entriesById: Object.fromEntries(
        Object.values(BUNDLED_ACCOUNT_PROVIDER_DECLARATIONS).map(declaration => {
            const identity = parseQualifiedPluginContributionKey(declaration.contributionKey);
            if (!identity) throw new Error('Expected a qualified bundled Provider declaration');
            return [declaration.contributionKey, { id: declaration.contributionKey, pluginId: identity.pluginId,
                definition: declaration.definition, provenance: declaration.provenance, sourceKind: 'bundled' }];
        }),
    ) } },   resourcesById: {}, settingsById: {}, diagnostics: [] });
function reviewAgentReadiness() { return Object.fromEntries(['claude', 'codex'].map(agentId => [`cli.${agentId}`, {
    ok: true, checkedAt: Date.now(), data: MachineAgentInventoryItemSchema.parse({ agentId, title: agentId, installed: true,
        version: '1', latestVersion: null, update: { supported: false, command: null },
        signIn: { status: 'signedIn', loginSupport: 'status_only' }, platform: { supported: true },
        install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [],
    }),
}])); }

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected boundary object');
    return value as Record<string, unknown>;
}
function started(runId = 'run_1') { return { runId, callId: `call_${runId}`, sidechainId: `side_${runId}` }; }
function uncertain() { return { ok: false, error: 'response lost', details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } } }; }
function childChoiceRefusal(agentTargetKey = 'agent:codex', parentModelSelection?: Parameters<typeof projectExecutionRunChildChoiceV1>[0]['parentModelSelection']) {
    return { ok: false, error: 'Choose a model for this Run', errorCode: 'execution_run_child_choice_required', details: {
        childChoice: projectExecutionRunChildChoiceV1({ agentTargetKey, parentModelSelection }), executionRunStart: { v: 1, runCreation: 'noRunCreated' } } };
}
function noRun() { return { ok: false, error: 'not started', details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } }; }
function run(runId: string, launchOrigin?: unknown): Run {
    return ExecutionRunPublicStateSchema.parse({ ...started(runId), intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only', status: 'running', startedAtMs: 1,
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', ...(launchOrigin ? { launchOrigin } : {}) });
}
function startedTargetKey(value: Record<string, unknown>) {
    return buildBackendTargetKeyV2(AgentExecutionTargetV1Schema.parse(value.backendTarget));
}
function canonicalTargetKey(optionId: string) {
    return optionId.includes(':') ? resolveBackendTargetKeyV2(optionId)
        : buildBackendTargetKeyV2(resolveReviewEngineTarget(optionId));
}
function setSettings(patch: Partial<Settings>) {
    getStorage().setState((state) => ({ settings: { ...state.settings, ...patch } }));
}
function publishProfile(profile: ReturnType<typeof AIBackendProfileSchema.parse>) {
    publishedProfiles = [profile];
    applyProfileCatalogSnapshot({ serverId, accountId: 'account_1' }, { status: 'ready', source: 'destination',
        authority: 'active', diagnostics: [], referenceGuardRevision: 1,
        records: [{ record: { v: 1, id: profile.id, definition: { kind: 'legacy', profile },
            enabled: true, secretBindings: {}, promptStack: [], skillSeeds: [] }, revision: 1 }],
        controlRevision: 1, control: { revision: 1, record: { v: 1, phase: 'active', sourceSettingsVersion: 0,
            migratedLogicalRevision: 1, inventory: [{ kind: 'account_row', id: profile.id, revision: 1 }] } } }, true);
}
function composer(): ComposerProps { return screen.root.findByType(Reflect.get(SessionParticipantComposer, 'type')).props as ComposerProps; }
function chip(key: string): Chip {
    const found = composer().extraActionChips?.find((item) => item.key === key);
    expect(found, key).toBeDefined();
    return found!;
}
function input() {
    const found = screen.root.findAll((node) => ['session-composer-input', 'new-session-composer-input'].includes(node.props.testID) && typeof node.props.onChangeText === 'function').at(-1);
    expect(found).toBeDefined();
    return found!;
}
function sendButton() {
    const found = screen.root.findAll((node) => ['session-composer-send', 'new-session-composer-send'].includes(node.props.testID) && typeof node.props.onPress === 'function').at(-1);
    expect(found).toBeDefined();
    return found!;
}
async function settle() {
    await act(async () => {});
}
async function waitFor(assertion: () => void) {
    await vi.waitFor(async () => { await settle(); assertion(); });
}
async function mount(props: Partial<React.ComponentProps<typeof SessionInteractiveExecutionRunDraftView>> = {}) {
    screen = await renderScreen(<SessionInteractiveExecutionRunDraftView sessionId="session_1" serverId={serverId} onRunStarted={vi.fn()} {...props} />, {
        createNodeMock: (element) => element.type === 'TextInput' || element.type === 'textarea' || element.type === 'HappierComposerInput'
            ? { focus: platform.focus, blur: vi.fn(), setNativeProps: vi.fn(), setSelection: vi.fn(), setTextAndSelection: vi.fn(),
                setDropCaret: vi.fn(), offsetAtPoint: vi.fn(async () => null),
                measureInWindow: callback => callback(0, 0, 300, 40) } satisfies NativeComposerInputHandle & { setNativeProps: () => void }
            : null,
    });
    await settle();
    return screen;
}
async function type(text: string) { await act(async () => changeTextTestInstance(input(), text)); }
async function send(text = 'Inspect this', waitForCompletion = true) {
    await type(text);
    await waitFor(() => expect(composer().canSendMessages, JSON.stringify({ visible: screen.getTextContent(),
        profileCatalog: getProfileCatalogSnapshot({ serverId, accountId: 'account_1' })?.catalog,
        rpc: transport.call.mock.calls.map(([request]) => request.method), http: home.requests.map((request) => request.path) })).toBe(true));
    await waitFor(() => expect(composer().isSendDisabled).toBe(false));
    await act(async () => { await sendButton().props.onPress(); });
    await settle();
    if (waitForCompletion) await waitFor(() => expect(screen.findByTestId('execution-run-conversation-phase')).toBeNull());
}
// Chooses through the real engine popover panel, as a user does: a row that only takes focus
// leaves the draft on its previous Agent, which a direct `engine.onSelect` call would hide.
async function selectEngine(id: string) {
    const engine = composer().engine!;
    const picker = await renderScreen(<AgentInputChipPickerPanel title={engine.title} options={engine.options}
        selectedOptionId={engine.selectedOptionId} onSelect={engine.onSelect} onRequestClose={vi.fn()} />);
    await picker.pressByTestIdAsync(`agent-input-chip-picker.option:${id}`);
    await settle();
}
async function renderChipContent(key: string) {
    const renderContent = chip(key).collapsedContentPopover?.renderContent;
    return renderScreen(<>{typeof renderContent === 'function' ? renderContent({ requestClose: vi.fn(), maxHeight: Dimensions.get('window').height }) : renderContent}</>);
}
async function renderChip(key: string) {
    return renderScreen(<>{chip(key).render({ chipStyle: () => ({}), showLabel: true, iconColor: '#000', textStyle: {}, countTextStyle: {}, popoverAnchorRef: React.createRef() })}</>);
}
async function reviewers() {
    const choices = await renderChipContent('execution-run-start-reviewers-add');
    // The current catalog includes every enabled bundled Agent. This journey chooses
    // two reviewers; it must not silently select every unrelated catalog entry.
    const prefix = 'execution-run-launcher-target:';
    const available = [...new Set(choices.root.findAll(node => typeof node.props.testID === 'string'
        && node.props.testID.startsWith(prefix)).map(node => String(node.props.testID)))];
    const ids = ['claude', 'codex'].map(agentId => {
        const id = available.find(candidate => canonicalTargetKey(candidate.slice(prefix.length)) === canonicalTargetKey(agentId));
        if (!id) throw new Error('Expected selectable reviewer: ' + agentId);
        return id;
    });
    for (const id of ids) await choices.pressByTestIdAsync(id);
    await settle();
    return ids;
}
function reviewerKeys() { return (composer().extraActionChips ?? []).map((item) => item.key).filter((key) => key.startsWith('execution-run-start-reviewer:')); }
function draft(runId = 'run_1') {
    const snapshot = getSessionDraftSnapshot({ serverId, accountId: 'account_1' }, { kind: 'run', sessionId: 'session_1', runId });
    if (!snapshot) return null;
    const document = snapshot.document;
    if (!('composer' in document)) throw new Error('Expected a Run composer draft');
    return { ...snapshot, document };
}
function admitted() { return record(outbound.at(-1)?.body); }
function admittedRunId() { return outbound.at(-1)?.path.split('/execution-runs/')[1]?.split('/')[0]; }
function outboundText() {
    const content = record(admitted().content);
    return JSON.stringify(content);
}

describe('SessionInteractiveExecutionRunDraftView — real composer and Action path', () => {
    beforeEach(async () => {
        resetTeamsDirectoryEngineForTests();
        resetTeamsSnapshotsForTests();
        teamModelsEnabled = false;
        resetProfileCatalogEngineForTests();
        resetProfileCatalogSnapshotsForTests();
        resetSavedSecretCatalogEngineForTests();
        resetSavedSecretCatalogSnapshotsForTests();
        resetPromptLibraryCatalogEngineForTests();
        resetPromptLibraryCatalogSnapshotsForTests();
        random.next = 0;
        protocolSupported = true;
        detachedScopeSupported = true;
        detachedSendFailure = false;
        admissionFailure = false;
        admissionGate = null;
        capabilitiesGate = null;
        capabilitiesFailure = false;
        rolesGate = null;
        pluginProjection = false;
        secretAvailable = false;
        publishedProfiles = [];
        roleOverrides = {};
        backends = { claude: { available: true, intents: ['delegate', 'review', 'plan'] }, codex: { available: true, intents: ['delegate', 'review', 'plan'] } };
        startResults = [];
        startRelayFailure = null;
        listedRuns = [];
        listResult = null;
        emittedStarts = [];
        outbound = [];
        modal.alert.mockClear();
        modal.show.mockClear();
        modal.show.mockReturnValue('launcher-modal');
        modal.update.mockClear();
        platform.focus.mockClear();
        resetSessionDraftRepositoryForTests();
        retireActiveServerAccountScopeLifetime();
        invalidateAccountEncryptionModeCache();
        clearDaemonMergedProjectionCacheForTests();
        transport.call.mockReset();
        transport.call.mockImplementation(async (request) => {
            if (request.method === RPC_METHODS.CAPABILITIES_INVOKE) return { ok: true, result: {
                availableModels: [{ id: 'gpt-6.1-luna', name: '6.1 Luna' }], supportsFreeform: false,
                source: 'dynamic', observedAt: Date.now(),
            } };
            if (request.method === RPC_METHODS.CAPABILITIES_DETECT && (capabilitiesGate || capabilitiesFailure)) {
                await capabilitiesGate;
                if (capabilitiesFailure) throw new Error('capabilities unavailable');
            }
            if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return {
                protocolVersion: 1,
                results: { ...reviewAgentReadiness(), 'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: {
                    available: true, backends, protocolVersion: 2,
                    features: { detachedScope: detachedScopeSupported, startAndWait: true, exactInputResults: true, runScopedAgentBindings: protocolSupported, secretReferenceOverlay: protocolSupported },
                } } },
            };
            if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_START
                || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1) {
                emittedStarts.push(record(request.method === SESSION_RPC_METHODS.EXECUTION_RUN_START
                    ? request.payload : record(request.payload).start));
                return await (startResults.shift() ?? started());
            }
            if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION || request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
                // A successful, ready daemon resume publishes the host's active Session fact.
                getStorage().setState((state) => ({ sessions: { session_1: { ...state.sessions.session_1!, active: true } } }));
                return { type: 'success', sessionId: 'session_1' };
            }
            if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return await (listResult ?? { runs: listedRuns });
            if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_SEND) return detachedSendFailure
                ? { ok: false, error: 'Machine did not accept input' } : { ok: true };
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
                protocolVersion: 1,
                projection: pluginProjection ? { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
                    agentsById: { ...reviewAgentProjection.agentsById, ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.agentsById } } : reviewAgentProjection,
            });
            return { errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' };
        });
        const nextSequence = ++sequence;
        const serverUrl = `https://launcher-${nextSequence}.example.test`;
        const serverIdentityId = `srv_launcher_${nextSequence}`;
        // Genuine HTTP boundaries: the canonical fixture publishes the installation key,
        // mints the exact authorization, and opens the real sealed requester invocation.
        const detachedStart = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId,
            accountId: 'account_1', machineId: 'machine_1', actionId: 'execution.run.start', tokenEpoch: 0,
            execute: async (input, context) => {
                expect(context.target).toEqual({ kind: 'machine', machineId: 'machine_1' });
                expect(context.invocation).toMatchObject({ caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' });
                expect(context.invocation.defaultSessionId).toBeUndefined();
                emittedStarts.push(record(input));
                return await (startResults.shift() ?? started());
            },
        });
        home = await serveActionHomes({
            homes: [{ key: 'home', serverUrl, serverIdentityId,
                accountId: 'account_1', currentAccount: true }],
            route: createSessionReadBatchHttpBoundary(async (request) => {
                if (teamModelsEnabled && request.path === '/v1/teams/list') return Response.json({ items: [teamSummaryFixture({ id: teamModel.teamId, name: 'Engineering' })], nextCursor: null });
                if (teamModelsEnabled && request.path === TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1) {
                    const { application } = TeamCredentialResourceDiscoverInputV1Schema.parse(request.body);
                    return Response.json({ resources: [teamResource(application)], nextCursor: null, failures: [] });
                }
                // Session-status admission still performs a finite single-Team read.
                if (teamModelsEnabled && request.path === '/v1/teams/credential-resources/entitled/list') {
                    const { application } = TeamCredentialResourceReadInputV1Schema.parse(request.body);
                    return Response.json({ resources: [teamResource(application)], nextCursor: null });
                }
                const detachedResponse = await detachedStart.handle(request.url, { method: request.method,
                    headers: request.headers, signal: request.signal,
                    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}) });
                if (detachedResponse) return detachedResponse;
                if (request.path === '/v1/actions/review.engines.list') return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({
                    v: 1, actionId: 'review.engines.list', requestId: record(request.body).requestId,
                    execution: { ok: true, result: { items: Object.keys(backends).map((engineId) => ReviewEngineListItemSchema.parse({
                        engineId, value: engineId, label: engineId, enabled: backends[engineId]!.available,
                        capabilities: { structuredNarration: true },
                    })) } },
                }));
                if (request.path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({
                    features: { execution: { runs: { enabled: true } }, teams: { enabled: true, credentialResources: { enabled: true } }, encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } } },
                    capabilities: { session: { pendingInput: { protocolVersion: 3 } }, accountStoredContentCompatibility: { v: 1, currentProtocolVersion: 3, minimumProtocolVersion: 3, declarationTransport: 'http-header-and-socket-auth-v1' } },
                }));
                if (request.path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'machine_1', accountId: 'account_1' })]);
                if (request.path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(request.body,
                    id => id === 'machine_1' ? createPlainMachineRowFixture({ id, accountId: 'account_1' }) : null);
                if (request.path === '/v1/machines/machine_1') return Response.json({ machine: createPlainMachineRowFixture({ id: 'machine_1', accountId: 'account_1' }) });
                if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (request.path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({ status: 'absent' }));
                if (request.path === PROFILE_ROWS_ROUTE_V1 || request.path === PROFILE_TRANSFER_ROUTE_V1 || request.path === PROFILE_REFERENCE_GUARD_ROUTE_V1) {
                    const transferControl = ProfileTransferRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
                        content: { t: 'plain', v: { v: 1, phase: 'active', sourceSettingsVersion: 0, migratedLogicalRevision: 1,
                            inventory: publishedProfiles.map(profile => ({ kind: 'account_row', id: profile.id, revision: 1 })) } } });
                    if (request.path === PROFILE_TRANSFER_ROUTE_V1) return Response.json(transferControl);
                    if (request.path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json(ProfileReferenceGuardReadResponseV1Schema.parse({ status: 'ready', revision: 1 }));
                    return Response.json(ProfileRowsListResponseV1Schema.parse({ status: 'listed', complete: true, nextCursor: null,
                        referenceGuardRevision: 1, transferControl, diagnostics: [], rows: publishedProfiles.map(profile => ({ id: profile.id, revision: 1,
                            content: sealProfileRecordContentV1({ mode: 'plain', material: null, record: { v: 1, id: profile.id,
                                definition: { kind: 'legacy', profile }, enabled: true, secretBindings: {}, promptStack: [], skillSeeds: [] } }) })) }));
                }
                if (request.path === PROMPT_LIBRARY_ROWS_ROUTE_V1) await rolesGate;
                if (request.path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return Response.json(PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: [{ key: 'role-overrides', revision: 1,
                    content: { t: 'plain', v: { key: 'role-overrides', value: { v: 1, overrides: roleOverrides } } } }] }));
                if (request.path === '/v1/account/saved-secrets/resources/materials') return Response.json(SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: secretAvailable ? [{
                    resourceId: 'personal-secret', encryptionMode: 'plain', recipientEnvelope: null,
                    storedContent: { t: 'plain', v: { v: 1, name: 'Personal secret', kind: 'token', value: 'sealed-secret' } },
                    entry: { ref: secretRef, source: 'shared_resource', relationship: 'owner', name: 'Personal secret', kind: 'token', revision: 1,
                        materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
                }] : [] }));
                if (request.path === '/v2/sessions/session_1') {
                    const session = getStorage().getState().sessions.session_1!;
                    return Response.json(V2SessionByIdResponseSchema.parse({ session: createPlainSessionCurrentProjectionRecordFixture({
                        id: session.id, active: session.active, seq: session.seq, metadata: session.metadata,
                    }) }));
                }
                if (request.path.includes('/execution-runs/') && request.path.endsWith('/pending')) {
                    if (request.method === 'GET') return Response.json({ pending: [], discarded: [], pendingVersion: 1, pendingCount: 0 });
                    outbound.push(request);
                    await admissionGate;
                    if (admissionFailure) return Response.json({ error: 'execution_run_not_allowed' }, { status: 409 });
                    const body = record(request.body);
                    const recipient = { kind: 'execution_run', runId: request.path.split('/execution-runs/')[1]!.split('/')[0] };
                    return Response.json({ didWrite: true, recipient, requestedAction: body.requestedAction,
                        pending: { ...body, recipient, status: 'queued', position: 1, createdAt: 1, updatedAt: 1 }, pendingVersion: 1, pendingCount: 1 });
                }
                if (request.path === '/v1/artifacts') {
                    // Kind-filtered inventory reads (Role catalog) answer the canonical filtered envelope.
                    const params = new URL(request.url).searchParams;
                    const filtered = params.has('kind') || params.has('kinds') || params.has('unclassified');
                    return Response.json(filtered ? { items: [], hasUnclassified: false } : []);
                }
                return undefined;
            }).handle,
        });
        serverId = home.homes.home!.id;
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.homes.home!.serverUrl);
        if (!credentials) throw new Error('Fixture credentials unavailable');
        await restoreConnectionToActiveServer(credentials);
        const session = createSessionFixture({ id: 'session_1', serverId, active: true, pendingVersion: 3,
            metadata: { path: '/repo', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine_1', flavor: 'claude' } });
        const machine = createMachineFixture({ id: 'machine_1', activeAt: Date.now(), storageMode: 'plain' });
        // Account activation reloads the persisted settings of its scope, so the Account's choices live there too.
        const launcherSettings = { ...settingsDefaults, experiments: true, featureToggles: { 'execution.runs': true, teams: true }, backendEnabledByTargetKey: {}, sessionMessageSendMode: 'server_pending' as const, currentSecretBindingsByProfileId: {} };
        saveAccountSettings({ serverId, accountId: 'account_1' }, launcherSettings, 1);
        getStorage().setState({ sessions: { session_1: session }, machines: { machine_1: machine }, machineListByServerId: { [serverId]: [machine] },
            settings: launcherSettings,
            settingsScope: { serverId, accountId: 'account_1' }, profileScope: { serverId, accountId: 'account_1' } });
        await ensureSessionDraftRepositoryHydrated({ serverId, accountId: 'account_1' });
    });
    afterEach(async () => { await disconnectActiveServerConnection(); await standardCleanup(); await home?.dispose(); });

    it.each(['project', 'session'] as const)('starts a quote-seeded conversation from the %s pane with its owning context', async (pane) => {
        detachedScopeSupported = pane === 'project';
        const opened = vi.fn();
        const scope = { kind: 'project' as const, workspaceRefId: 'workspace_1', serverId, machineId: 'machine_1', rootPath: '/repo', activeRootPath: '/repo' };
        let requestedTab: DetailsTab | undefined;
        expect(await askSelectionQuote({ workspaceScope: scope, sessionTarget: pane === 'session' ? { sessionId: 'session_1' } : null,
            sideRun: pane === 'session', quote: 'src/app.ts:3\n```\nselected code\n```', context: {
                openDetailsTab: tab => { requestedTab = tab; },
                navigateToNewSession: () => { throw new Error('A capable exact Machine must open its Run draft'); },
            } })).toBe(true);
        if (!requestedTab) throw new Error('The canonical Ask target did not open a draft');
        if (pane === 'session') {
            expect(transport.call.mock.calls.filter(([request]) => request.method === RPC_METHODS.CAPABILITIES_DETECT)).toEqual([]);
            expect(requestedTab.resource).not.toHaveProperty('sessionId');
            expect(requestedTab.resource).not.toHaveProperty('workspace');
        }
        const tab = { ...requestedTab, isPinned: true, isPreview: false };
        const surfaceInput = { tab, scope, region: 'details' as const, active: true,
            descriptor: { surfaceId: 'project:workspace_1:details:run-draft', resourceKey: tab.key, scope, region: 'details' as const, status: 'available' as const },
            callbacks: { replaceTab: (_key: string, next: { resource?: unknown }) => opened(next.resource) } };
        const renderers = pane === 'project'
            ? workspaceRunSurfaces.createWorkspaceDetailsSurfaceRenderers({ scopeId: 'project:workspace_1', workspaceRefId: 'workspace_1',
            workspaceCacheKey: 'workspace_1', workspaceScope: scope, serverId, machineId: 'machine_1', rootPath: '/repo', activeRootPath: '/repo',
            presentation: 'panel', pinDetailsTab: vi.fn(), openFileTab: vi.fn(), renderWorkspaceInfo: () => null })
            : sessionRunSurfaces.createSessionDetailsSurfaceRenderers({
                scopeId: 'session:session_1', sessionId: 'session_1', serverId, requestClose: vi.fn(), openFileTab: vi.fn(),
                getStartEditingFileHandler: () => vi.fn(), sessionScreenTestIdsEnabled: false, closeDetailsTab: vi.fn(),
            });
        const renderer = renderers.find(candidate => candidate.canRender(surfaceInput));
        expect(renderer).toBeDefined();
        screen = await renderScreen(<>{renderer!.render(surfaceInput)}</>);
        await waitFor(() => expect(composer().isSendDisabled).toBe(false));
        await waitFor(() => expect(input().props.value, JSON.stringify({ initialText: composer().initialText,
            sessionId: composer().sessionId, launcherDraftKey: composer().launcherDraftKey,
            draft: getSessionDraftSnapshot({ serverId, accountId: 'account_1' }, { kind: 'session', sessionId: 'session_1' }) })).toContain('selected code'));
        await act(async () => { await sendButton().props.onPress(); });
        await waitFor(() => expect(opened, JSON.stringify({ visible: screen.getTextContent(), emittedStarts })).toHaveBeenCalledWith(expect.objectContaining({ kind: 'executionRun', runId: 'run_1' })));
        if (pane === 'project') {
            expect(opened.mock.calls[0]![0]).toMatchObject({ sessionId: null, workspace: { machineId: 'machine_1', cwd: '/repo' } });
            expect(emittedStarts).toEqual([expect.objectContaining({ sessionId: null, cwd: '/repo', runClass: 'long_lived' })]);
            expect(JSON.stringify(transport.call.mock.calls.filter(([request]) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_SEND))).toContain('selected code');
            expect(transport.call.mock.calls.filter(([request]) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_SEND)
                .every(([request]) => request.machineId === 'machine_1')).toBe(true);
            expect(outbound).toEqual([]);
        } else {
            expect(opened.mock.calls[0]![0]).not.toHaveProperty('sessionId');
            expect(opened.mock.calls[0]![0]).not.toHaveProperty('workspace');
            expect(emittedStarts).toEqual([expect.objectContaining({ launchOrigin: { kind: 'session', sessionId: 'session_1', draftCorrelationId: expect.any(String) } })]);
            expect(outbound[0]).toMatchObject({ path: '/v2/sessions/session_1/execution-runs/run_1/pending' });
            expect(outboundText()).toContain('selected code');
        }
    });

    it('starts a quote-seeded detached fallback when the exact Machine does not support detached conversations', async () => {
        detachedScopeSupported = false;
        const navigate = vi.fn<AskSelectionTargetContext['navigateToNewSession']>();
        const openDetailsTab = vi.fn();
        const quote = 'src/app.ts:3\n```\nselected code\n```';
        expect(await askSelectionQuote({ workspaceScope: { serverId, machineId: 'machine_1', rootPath: '/repo' },
            sessionTarget: null, quote, context: { openDetailsTab, navigateToNewSession: navigate } })).toBe(true);
        expect(openDetailsTab).not.toHaveBeenCalled();
        expect(navigate).toHaveBeenCalledWith({ dataId: null, draftId: expect.any(String) });
        const draftId = navigate.mock.calls[0]![0].draftId;
        const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        expect(readNewSessionDraftFromRepository({ scope: { serverId, accountId: 'account_1' }, draftId }), JSON.stringify({
            draftId, profileScope: getStorage().getState().profileScope,
            snapshot: getSessionDraftSnapshot({ serverId, accountId: 'account_1' }, { kind: 'newSession', draftId }),
        })).toMatchObject({
            input: quote, selectedMachineId: 'machine_1', selectedPath: '/repo',
        });
        expect(emittedStarts).toEqual([]);
        expect(outbound).toEqual([]);
    });

    it('starts a quote-seeded detached fallback through the persisted Account Session preference without opening a Run', async () => {
        const scope = { serverId, accountId: 'account_1' };
        saveAccountSettings(scope, { ...getStorage().getState().settings, filesAskWithoutSessionTarget: 'session' }, 1);
        const navigate = vi.fn<AskSelectionTargetContext['navigateToNewSession']>();
        const openDetailsTab = vi.fn();
        const quote = 'src/app.ts:3\n```\nselected code\n```';
        expect(await askSelectionQuote({ workspaceScope: { serverId, machineId: 'machine_1', rootPath: '/repo' },
            sessionTarget: null, quote, context: { openDetailsTab, navigateToNewSession: navigate } })).toBe(true);
        expect(openDetailsTab).not.toHaveBeenCalled();
        expect(navigate).toHaveBeenCalledWith({ dataId: null, draftId: expect.any(String) });
        const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const draftId = navigate.mock.calls[0]![0].draftId;
        expect(readNewSessionDraftFromRepository({ scope, draftId }), JSON.stringify({ draftId,
            profileScope: getStorage().getState().profileScope, snapshot: getSessionDraftSnapshot(scope, { kind: 'newSession', draftId }),
        })).toMatchObject({
            input: quote, selectedMachineId: 'machine_1', selectedPath: '/repo',
        });
        expect(emittedStarts).toEqual([]);
        expect(outbound).toEqual([]);
    });

    it.each([false, true])('appends a later host selection to the mounted draft without replacing the question (detached=%s)', async detached => {
        const opened = vi.fn();
        const target = { sessionId: detached ? null : 'session_1', ...(detached ? { workspace: { machineId: 'machine_1', cwd: '/repo' } } : {}) };
        await mount({ ...target, initialText: 'First selected line', onRunStarted: opened });
        await waitFor(() => expect(composer().isSendDisabled).toBe(false));
        await type('First selected line\nWhy is this here?');
        await screen.update(<SessionInteractiveExecutionRunDraftView {...target} serverId={serverId}
            initialText="Second selected line" onRunStarted={opened} />);
        await waitFor(() => expect(input().props.value).toBe('First selected line\nWhy is this here?\nSecond selected line'));
        expect(emittedStarts).toEqual([]);
    });

    it('starts a quote-seeded detached Run and keeps its unsent quote when the first input is refused', async () => {
        detachedSendFailure = true;
        const opened = vi.fn();
        await mount({ sessionId: null, workspace: { machineId: 'machine_1', cwd: '/repo' },
            initialText: 'Selected code\nWhy is it here?', onRunStarted: opened });
        await waitFor(() => expect(composer().isSendDisabled).toBe(false));
        const inputId = composer().initialLocalId;
        await act(async () => { await sendButton().props.onPress(); });
        await waitFor(() => expect(opened, JSON.stringify({ visible: screen.getTextContent(), emittedStarts })).toHaveBeenCalledWith('run_1', {
            retryInputLocalId: inputId, initialText: 'Selected code\nWhy is it here?',
        }, expect.anything()));
        expect(input().props.value).toBe('Selected code\nWhy is it here?');
        expect(emittedStarts).toHaveLength(1);
        expect(outbound).toEqual([]);
    });

    it('creates nothing until rendered Send, then admits captured text to the exact new Run', async () => {
        const opened = vi.fn();
        await mount({ onRunStarted: opened });
        const inputId = composer().initialLocalId;
        expect(emittedStarts).toEqual([]);
        expect(outbound).toEqual([]);
        expect(getSessionDraftSnapshot({ serverId, accountId: 'account_1' }, { kind: 'session', sessionId: 'session_1' })).toBeNull();
        await send();
        expect(emittedStarts[0]).toMatchObject({ intent: 'delegate', runClass: 'long_lived', launchOrigin: { kind: 'session', sessionId: 'session_1', draftCorrelationId: expect.any(String) } });
        await waitFor(() => expect(opened).toHaveBeenCalledWith('run_1', undefined, { title: 'Inspect this' }));
        expect(outbound[0]).toMatchObject({ home: 'home', accountId: 'account_1', path: '/v2/sessions/session_1/execution-runs/run_1/pending' });
        expect(admitted()).toMatchObject({ localId: inputId, targetMachineId: 'machine_1' });
        expect(outboundText()).toContain('Inspect this');
    });
    it('waits for the retained launcher draft before seeding host text', async () => {
        await mount();
        await waitFor(() => expect(composer().canSendMessages).toBe(true));
        await screen.unmount();
        const scope = { serverId, accountId: 'account_1' };
        const address = { kind: 'session', sessionId: 'session_1' } as const;
        const values = new Map<string, string>();
        const cipher: SessionDraftRepositoryCipher = {
            seal: async (address, document) => ({ t: 'plain', v: createSessionDraftPrivatePayloadV2(address, document) }),
            open: async (_address, content) => content.t === 'plain' ? content.v.document : null,
        };
        const producer = createSessionDraftRepository({ syncEnabled: false, cipher,
            randomUUID: () => '00000000-0000-4000-8000-000000000001',
            storage: { getString: (key) => values.get(key), set: (key, value) => { values.set(key, value); }, delete: (key) => { values.delete(key); } } });
        producer.writeExistingSessionDraft({ scope, sessionId: 'session_1', patch: { executionRunLauncher: {
            key: 'conversation', patch: { text: 'Previously retained text' },
        } } });
        const document = producer.getSessionDraftSnapshot(scope, address)!.document;
        const record = { address, revision: 1, createdAt: 1, updatedAt: 1,
            content: { t: 'plain' as const, v: createSessionDraftPrivatePayloadV2(address, document) } };
        let release!: () => void;
        const boundary = new Promise<void>((resolve) => { release = resolve; });
        const transport: SessionDraftRepositoryTransport = {
            read: async () => { await boundary; return { status: 'present', record }; },
            list: async () => ({ items: [] }),
            mutate: async () => ({ status: 'conflict', current: record }),
        };
        configureSessionDraftRepository({ scope, syncEnabled: true, cipher, transport });
        try {
            const hydration = ensureSessionDraftAddressesHydrated(scope, [address]);
            await mount({ initialText: 'Host seed' });
            await act(async () => { release(); expect(await hydration).toBe(true); });
            expect(getSessionDraftSnapshot(scope, address)?.document, JSON.stringify({ visible: input().props.value, identity: composer().initialLocalId })).toMatchObject({ extensions: { happier: {
                'executionRunLauncherV1:conversation:text': { value: 'Previously retained text' },
            } } });
            await waitFor(() => expect(input().props.value).toBe('Previously retained text'));
        } finally {
            configureSessionDraftRepository({ syncEnabled: false });
        }
    });
    it('refuses a disabled start Action before issuing a Run RPC and preserves the editable draft', async () => {
        setSettings({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'execution.run.start': { disabledSurfaces: ['ui'] } } }) });
        const opened = vi.fn();
        await mount({ onRunStarted: opened });
        const inputId = composer().initialLocalId;
        await send();
        expect(emittedStarts).toEqual([]);
        expect(outbound).toEqual([]);
        expect(opened).not.toHaveBeenCalled();
        expect(input().props.value).toBe('Inspect this');
        expect(composer().initialLocalId).toBe(inputId);
        expect(composer().canSendMessages).toBe(true);
        expect(screen.findByTestId('execution-run-conversation-start-another')).toBeNull();
    });
    it('does not start under a replacement Account after mounted admission', async () => {
        await mount();
        await type('Keep my Account-bound draft');
        await waitFor(() => expect(composer().canSendMessages).toBe(true));
        // The secure credential boundary now answers for another Account, before
        // its asynchronous UI projection can replace the mounted binding.
        await home.switchAccount('home', 'replacement_account');
        await act(async () => { await sendButton().props.onPress(); });
        await settle();
        expect(emittedStarts).toEqual([]);
        expect(outbound).toEqual([]);
        expect(input().props.value).toBe('');
        expect(getSessionDraftSnapshot({ serverId, accountId: 'account_1' }, { kind: 'session', sessionId: 'session_1' })?.document).toMatchObject({ extensions: { happier: {
            'executionRunLauncherV1:conversation:text': { value: 'Keep my Account-bound draft' },
        } } });
    });
    it('clears the accepted Run draft before navigation retires the Account binding', async () => {
        let atNavigation: unknown;
        await mount({ onRunStarted: () => { atNavigation = draft()?.document.composer.text.value; retireActiveServerAccountScopeLifetime(); } });
        await send();
        await waitFor(() => expect(atNavigation).toBe(''));
        expect(input().props.value).toBe('');
    });
    it('preserves text authored after capture when admission hands off before navigation retires the binding', async () => {
        let acknowledge!: () => void;
        admissionGate = new Promise((resolve) => { acknowledge = resolve; });
        let atNavigation: unknown;
        await mount({ onRunStarted: () => { atNavigation = draft()?.document.composer.text.value; retireActiveServerAccountScopeLifetime(); } });
        await send('Inspect this', false);
        await waitFor(() => expect(outbound).toHaveLength(1));
        await type('Typed after capture');
        expect(outboundText()).toContain('Inspect this');
        expect(outboundText()).not.toContain('Typed after capture');
        await act(async () => acknowledge());
        await waitFor(() => expect(atNavigation).toBe('Typed after capture'));
        expect(input().props.value).toBe('Typed after capture');
    });
    it('starts with the eligible Agent selected in the real launcher options', async () => {
        await mount();
        const codex = composer().engine!.options.find((option) => option.id.includes('codex'))!;
        await selectEngine(codex.id);
        await send();
        expect(startedTargetKey(emittedStarts[0]!)).toBe(canonicalTargetKey(codex.id));
        expect(admittedRunId()).toBe('run_1');
    });
    it('keeps built-in Agent choices and child choice recovery usable while configured Agents refresh', async () => {
        await mount();
        await waitFor(() => expect(composer().canSendMessages).toBe(true));
        await type('Keep my child draft');
        await act(async () => beginAcpCatalogLoad({ serverId, accountId: 'account_1' }));
        expect(composer().engine).not.toBeNull();
        expect(composer().canSendMessages).toBe(true);
        expect(input().props.value).toBe('Keep my child draft');
        const codex = composer().engine!.options.find((option) => option.id.includes('codex'))!;
        await selectEngine(codex.id);
        startResults.push(childChoiceRefusal(canonicalTargetKey(codex.id)), started());
        await send('Keep my child draft');
        expect(startedTargetKey(emittedStarts[0]!)).toBe(canonicalTargetKey(codex.id));
        expect(screen.findByTestId('execution-run-child-choice')).not.toBeNull();
        await screen.pressByTestIdAsync('execution-run-child-choice.model');
        const shown = modal.show.mock.calls.at(-1)?.[0] as { props: { onSelect: (ref: unknown) => void } };
        const ref = { agentTargetKey: canonicalTargetKey(codex.id), providerConnectionId: null, modelId: 'gpt-6.1-luna' };
        await act(async () => shown.props.onSelect(ref));
        await waitFor(() => expect(emittedStarts).toHaveLength(2));
        expect(emittedStarts[1]).toMatchObject({ modelSelection: ref });
        expect(outboundText()).toContain('Keep my child draft');
    });
    it('does not let an unavailable default Agent hide an eligible Agent', async () => {
        backends.claude = { available: false, intents: ['delegate'] };
        await mount();
        expect(composer().engine!.options.some((option) => option.id.includes('codex'))).toBe(true);
        const codex = composer().engine!.options.find((option) => option.id.includes('codex'))!;
        await send();
        expect(startedTargetKey(emittedStarts[0]!)).toBe(canonicalTargetKey(codex.id));
    });
    it('starts an eligible installed-plugin Agent even when the default Agent is unavailable', async () => {
        pluginProjection = true;
        backends = { claude: { available: false, intents: ['delegate'] }, 'acme.review.provider': { available: true, intents: ['delegate'] } };
        await mount();
        await send();
        expect(emittedStarts[0]).toMatchObject({ backendTarget: { kind: 'agent', identity: { pluginId: 'acme.review', localId: 'provider' } } });
    });
    it('rejoins exactly one correlated Run after an uncertain start without starting another', async () => {
        startResults.push(uncertain());
        await mount();
        const baseTransport = transport.call.getMockImplementation()!;
        transport.call.mockImplementation(async (request) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST
            ? { runs: [run('run_found', emittedStarts[0]?.launchOrigin)] }
            : baseTransport(request));
        await send();
        expect(emittedStarts).toHaveLength(1);
        await waitFor(() => expect(admittedRunId()).toBe('run_found'));
    });
    it('does not guess when correlation has zero matches and leaves authored text intact', async () => {
        startResults.push(uncertain());
        await mount();
        const inputId = composer().initialLocalId;
        await send();
        expect(emittedStarts).toHaveLength(1);
        expect(outbound).toEqual([]);
        expect(input().props.value).toBe('Inspect this');
        expect(composer().initialLocalId).toBe(inputId);
        expect(composer().disabled).toBe(true);
        expect(screen.findByTestId('execution-run-conversation-error')?.props.children)
            .toBe(t('sessionDrafts.executionRunStart.unresolved'));
        expect(screen.findByTestId('execution-run-conversation-start-another')).not.toBeNull();
        // The draft says it once, inline, beside its recovery action; no second blocking message.
        expect(modal.alert).not.toHaveBeenCalled();
        const listRequests = transport.call.mock.calls.filter(([request]) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST);
        expect(listRequests.length).toBeGreaterThan(0);
        for (const [request] of listRequests) expect(request).toMatchObject({ sessionId: 'session_1', serverId, payload: {} });
    });
    it('offers no second Start while reconciliation is pending', async () => {
        startResults.push(uncertain());
        let resolveList!: (result: unknown) => void;
        listResult = new Promise((resolve) => { resolveList = resolve; });
        await mount();
        await send('Inspect this', false);
        expect(composer().disabled).toBe(true);
        const inputId = composer().initialLocalId;
        expect(screen.findByTestId('execution-run-conversation-start-another')).toBeNull();
        expect(emittedStarts).toHaveLength(1);
        await act(async () => resolveList({ runs: [] }));
        await settle();
        await waitFor(() => expect(screen.findByTestId('execution-run-conversation-start-another')).not.toBeNull());
        expect(composer().disabled).toBe(true);
        expect(composer().initialLocalId).toBe(inputId);
        expect(input().props.value).toBe('Inspect this');
        expect(emittedStarts).toHaveLength(1);
        expect(outbound).toEqual([]);
    });
    it('uses fresh correlation and input identities only after explicit Start another', async () => {
        startResults.push(uncertain(), started('run_new'));
        await mount();
        const initialInputId = composer().initialLocalId;
        await send();
        expect(composer().initialLocalId).toBe(initialInputId);
        expect(input().props.value).toBe('Inspect this');
        expect(emittedStarts).toHaveLength(1);
        await screen.pressByTestIdAsync('execution-run-conversation-start-another');
        await settle();
        expect(composer().initialLocalId).not.toBe(initialInputId);
        expect(input().props.value).toBe('Inspect this');
        expect(emittedStarts).toHaveLength(1);
        expect(outbound).toEqual([]);
        await send();
        expect(record(emittedStarts[0]?.launchOrigin).draftCorrelationId).not.toBe(record(emittedStarts[1]?.launchOrigin).draftCorrelationId);
        expect(admitted().localId).not.toBe(initialInputId);
    });
    it('preserves selected Agent and correlation across a known no-run retry', async () => {
        startResults.push(noRun(), started());
        await mount();
        const codex = composer().engine!.options.find((option) => option.id.includes('codex'))!;
        await selectEngine(codex.id);
        await send();
        expect(composer().engine!.selectedOptionId).toBe(codex.id);
        await send();
        const selected = canonicalTargetKey(codex.id);
        expect(emittedStarts.map(startedTargetKey)).toEqual([selected, selected]);
        expect(emittedStarts[0]?.launchOrigin).toEqual(emittedStarts[1]?.launchOrigin);
    });
    it('asks for the Agent default when it cannot follow the session, keeps the draft, then starts fresh with that choice', async () => {
        startResults.push(childChoiceRefusal(), started());
        const opened = vi.fn();
        await mount({ onRunStarted: opened });
        await send();
        expect(screen.findByTestId('execution-run-child-choice')).not.toBeNull();
        expect(modal.alert).not.toHaveBeenCalled();
        expect(outbound).toEqual([]);
        await screen.pressByTestIdAsync('execution-run-child-choice.default');
        await waitFor(() => expect(opened).toHaveBeenCalledWith('run_1', undefined, { title: 'Inspect this' }));
        expect(emittedStarts).toHaveLength(2);
        expect(emittedStarts[1]).toMatchObject({ childSelection: 'agentDefault' });
        expect(emittedStarts[1]).not.toHaveProperty('modelSelection');
        expect(emittedStarts[1]?.launchOrigin).toEqual(emittedStarts[0]?.launchOrigin);
        expect(outboundText()).toContain('Inspect this');
        expect(screen.findByTestId('execution-run-child-choice')).toBeNull();
    });
    it('says the session model by its catalog title in the chooser, never its raw id', async () => {
        startResults.push(childChoiceRefusal('agent:codex', { agentTargetKey: 'agent:claude', providerConnectionId: null, modelId: 'claude-haiku-4-5' }));
        await mount();
        await send();
        expect(screen.findByTestId('execution-run-child-choice')).not.toBeNull();
        const parent = screen.getTextContent().match(/childChoice\.incompatible\(agent=[^,]*,parent=([^)]*)\)/)?.[1] ?? '';
        expect(parent).toContain('Haiku 4.5');
        expect(parent).not.toContain('claude-haiku-4-5');
    });
    it('starts with the exact model picked in the chooser, and Cancel starts nothing', async () => {
        await mount();
        // The chooser asks about the Agent the start targeted, and the model it returns must belong to that Agent.
        const agent = canonicalTargetKey(composer().engine!.selectedOptionId!);
        startResults.push(childChoiceRefusal(agent), childChoiceRefusal(agent), started());
        await send();
        await screen.pressByTestIdAsync('execution-run-child-choice-learn-more');
        expect(screen.findByTestId('execution-run-child-choice')).toBeNull();
        expect(emittedStarts).toHaveLength(1);
        await send();
        await screen.pressByTestIdAsync('execution-run-child-choice.model');
        const shown = modal.show.mock.calls.at(-1)?.[0] as { props: { onSelect: (ref: unknown) => void } };
        const ref = { agentTargetKey: agent, providerConnectionId: null, modelId: 'gpt-6.1-luna' };
        await act(async () => shown.props.onSelect(ref));
        await waitFor(() => expect(emittedStarts).toHaveLength(3));
        expect(emittedStarts[2]).toMatchObject({ modelSelection: ref });
        expect(emittedStarts[2]).not.toHaveProperty('childSelection');
    });
    it.each(['plan', 'delegate'] as const)('offers a %s launch the child choice, keeps the draft, then starts one fresh Run with the Agent default', async (intent) => {
        startResults.push(childChoiceRefusal(), started());
        const opened = vi.fn();
        await mount({ intent, onRunStarted: opened });
        await send();
        expect(screen.findByTestId('execution-run-child-choice')).not.toBeNull();
        expect(screen.findByTestId('execution-run-conversation-error')).toBeNull();
        expect(opened).not.toHaveBeenCalled();
        expect(input().props.value).toBe('Inspect this');
        await screen.pressByTestIdAsync('execution-run-child-choice.default');
        await waitFor(() => expect(opened).toHaveBeenCalledWith('run_1', undefined, { title: 'Inspect this' }));
        expect(emittedStarts).toHaveLength(2);
        expect(emittedStarts[1]).toMatchObject({ intent, instructions: 'Inspect this', childSelection: 'agentDefault' });
        expect(screen.findByTestId('execution-run-child-choice')).toBeNull();
    });
    it('resolves only the refused reviewer with the exact model and never replays the one that started', async () => {
        startResults.push(started('run_claude'), childChoiceRefusal(), started('run_codex'));
        const opened = vi.fn();
        await mount({ intent: 'review', onRunStarted: opened });
        await reviewers();
        await send();
        expect(screen.findByTestId('execution-run-child-choice')).not.toBeNull();
        expect(opened).not.toHaveBeenCalled();
        expect(input().props.value).toBe('Inspect this');
        await screen.pressByTestIdAsync('execution-run-child-choice.model');
        const shown = modal.show.mock.calls.at(-1)?.[0] as { props: { onSelect: (ref: unknown) => void } };
        const ref = { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'gpt-6.1-luna' };
        await act(async () => shown.props.onSelect(ref));
        await waitFor(() => expect(opened).toHaveBeenCalledWith('run_codex', undefined, { title: 'Inspect this' }));
        expect(emittedStarts).toHaveLength(3);
        expect(startedTargetKey(emittedStarts[2]!)).toBe(startedTargetKey(emittedStarts[1]!));
        expect(startedTargetKey(emittedStarts[2]!)).not.toBe(startedTargetKey(emittedStarts[0]!));
        expect(emittedStarts[2]).toMatchObject({ modelSelection: ref });
    });
    it('asks each refused reviewer its own question in turn and gives every Agent only its own model', async () => {
        startResults.push(childChoiceRefusal('agent:claude'), childChoiceRefusal('agent:codex'), started('run_claude'), started('run_codex'));
        const opened = vi.fn();
        await mount({ intent: 'review', onRunStarted: opened });
        await reviewers();
        await send();
        expect(emittedStarts).toHaveLength(2);
        const chooseModel = async (agentTargetKey: string) => {
            await screen.pressByTestIdAsync('execution-run-child-choice.model');
            const shown = modal.show.mock.calls.at(-1)?.[0] as { props: { onSelect: (ref: unknown) => void } };
            const ref = { agentTargetKey, providerConnectionId: null, modelId: 'gpt-6.1-luna' };
            await act(async () => shown.props.onSelect(ref));
            return ref;
        };
        const claudeRef = await chooseModel('agent:claude');
        await waitFor(() => expect(emittedStarts).toHaveLength(3));
        // The second reviewer is not reduced to a generic alert: its own question follows.
        expect(emittedStarts[2]).toMatchObject({ modelSelection: claudeRef });
        expect(startedTargetKey(emittedStarts[2]!)).toBe(startedTargetKey(emittedStarts[0]!));
        await waitFor(() => expect(screen.findByTestId('execution-run-child-choice')).not.toBeNull());
        expect(opened).not.toHaveBeenCalled();
        expect(modal.alert).not.toHaveBeenCalled();
        const codexRef = await chooseModel('agent:codex');
        await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
        expect(emittedStarts).toHaveLength(4);
        expect(emittedStarts[3]).toMatchObject({ modelSelection: codexRef });
        expect(startedTargetKey(emittedStarts[3]!)).toBe(startedTargetKey(emittedStarts[1]!));
        expect(modal.alert).not.toHaveBeenCalled();
    });
    it('does not treat an unknown-outcome reviewer as permission to start it again', async () => {
        startResults.push(uncertain(), childChoiceRefusal(), started('run_codex'));
        const opened = vi.fn();
        await mount({ intent: 'review', onRunStarted: opened });
        await reviewers();
        await send();
        expect(screen.findByTestId('execution-run-child-choice')).not.toBeNull();
        await screen.pressByTestIdAsync('execution-run-child-choice.model');
        const shown = modal.show.mock.calls.at(-1)?.[0] as { props: { onSelect: (ref: unknown) => void } };
        await act(async () => shown.props.onSelect({ agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'gpt-6.1-luna' }));
        await waitFor(() => expect(opened).toHaveBeenCalledWith('run_codex', undefined, { title: 'Inspect this' }));
        expect(emittedStarts).toHaveLength(3);
        expect(startedTargetKey(emittedStarts[2]!)).toBe(startedTargetKey(emittedStarts[1]!));
    });
    describe('choosing a model for this Run from the route chip', () => {
        async function mountTeamParent(browserShape = false) {
            teamModelsEnabled = true;
            getStorage().setState(state => ({ sessions: { ...state.sessions, session_1: { ...state.sessions.session_1!, metadata: {
                ...state.sessions.session_1!.metadata!, flavor: 'codex',
                sessionAppliedModelV1: { v: 1, provider: 'codex', modelId: 'gpt-5.5', updatedAt: 1 },
                ...(browserShape ? { connectedServices: undefined, sessionModelsV1: {
                    v: 1 as const, agentId: 'codex', updatedAt: 2, currentModelId: teamModel.modelId,
                    availableModels: [{ id: teamModel.modelId, name: teamModel.modelId }], activeSelectionV1: {
                        v: 2 as const, source: 'runtime_apply' as const, runner: { pid: 42, processStartTimeMs: 1 },
                        selection: { agentTargetKey: teamModel.agentTargetKey, providerConnectionId: null, modelId: teamModel.modelId },
                        teamCredentialModel: { ...teamModel, expectedResourceRevision: 0 },
                    },
                } } : { connectedServices: ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
                    source: 'team_resource', resourceId: teamModel.resourceId, deliveryMode: 'brokered',
                } } }) }),
            } } } }));
            await mount();
        }
        it('names the inherited Team resource and Team on the Run draft', async () => {
            await mountTeamParent();
            await waitFor(() => expect(screen.getTextContent()).toContain('Shared coding pool'));
            expect(screen.getTextContent()).toContain('Engineering');
        });
        it.each([1440, 390])('names the browser parent applied Team route without a Connected Service binding at width %s', async (width) => {
            windowState.width = width;
            try {
                await mountTeamParent(true);
                await waitFor(() => expect(screen.getTextContent()).toContain('Shared coding pool'));
                expect(screen.getTextContent()).toContain('Engineering');
                const route = await renderChip('execution-run-start-route');
                const label = route.findByTestId('execution-run-start-route-chip')?.props.accessibilityLabel;
                expect(label).toContain('Shared coding pool');
                expect(label).toContain('Engineering');
                expect(label).toContain(teamModel.modelId);
                expect(label).not.toContain(t('connectedServices.authChip.nativeLabel'));
                if (width === 390) {
                    expect(screen.findByTestId('execution-run-start-foot')?.props.children).toContain('Shared coding pool');
                } else {
                    expect(route.getTextContent()).toContain('Shared coding pool');
                    expect(screen.findByTestId('execution-run-start-foot')?.props.children)
                        .toBe(t('agentStart.startsWhenYouSend', { count: 1 }));
                }
                await send();
                expect(emittedStarts).toHaveLength(1);
                expect(emittedStarts[0]).not.toHaveProperty('teamCredentialModel');
                expect(emittedStarts[0]).not.toHaveProperty('modelSelection');
                expect(emittedStarts[0]).not.toHaveProperty('modelId');
                expect(emittedStarts[0]).not.toHaveProperty('connectedServices');
            } finally {
                windowState.width = 1024;
            }
        });
        it.each(['Agent chip', 'route chip'] as const)('offers the Team model through the %s shared picker', async entry => {
            await mountTeamParent();
            let picker: Screen;
            if (entry === 'Agent chip') {
                const engine = composer().engine!;
                picker = await renderScreen(<AgentInputChipPickerPanel title={engine.title} options={engine.options}
                    selectedOptionId={engine.selectedOptionId} onSelect={engine.onSelect} onRequestClose={vi.fn()} />);
            } else {
                await chooseModelRow();
                const shown = modal.show.mock.calls.at(-1)?.[0] as { component: React.ComponentType<Record<string, unknown>>; props: Record<string, unknown> };
                await waitFor(() => expect((modal.update.mock.calls.at(-1)?.[1] ?? shown.props).teamCredentialResources).toEqual(expect.arrayContaining([expect.objectContaining({ id: teamModel.resourceId })])));
                picker = await renderScreen(React.createElement(shown.component, { ...(modal.update.mock.calls.at(-1)?.[1] ?? shown.props), onClose: vi.fn() }));
            }
            const id = `model-picker-overlay-option:${sessionModelSelectionKey(teamModel)}`;
            await waitFor(() => expect(picker.findByTestId(id)).not.toBeNull());
            await waitFor(() => expect(picker.findByTestId(id)?.props.disabled).not.toBe(true));
            expect(picker.getTextContent()).toContain('Shared coding pool');
            expect(picker.getTextContent()).toContain('Engineering');
        });
        it('renders the selected Agent model detail in the engine picker and submits its exact choice', async () => {
            await mount();
            const engine = composer().engine!;
            const codex = engine.options.find((option) => option.id.includes('codex'))!;
            const picker = await renderScreen(<AgentInputChipPickerPanel title={engine.title} options={engine.options}
                selectedOptionId={engine.selectedOptionId} onSelect={engine.onSelect} onRequestClose={vi.fn()} />);
            await picker.pressByTestIdAsync(`agent-input-chip-picker.option:${codex.id}`);
            const ref = { agentTargetKey: canonicalTargetKey(codex.id), providerConnectionId: null, modelId: 'gpt-6.1-luna' };
            const modelId = `model-picker-overlay-option:${JSON.stringify([ref.agentTargetKey, null, ref.modelId])}`;
            await waitFor(() => expect(picker.findByTestId(modelId)).not.toBeNull());
            await picker.pressByTestIdAsync(modelId);
            await send();
            expect(emittedStarts[0]).toMatchObject({ modelSelection: ref });
            expect(startedTargetKey(emittedStarts[0]!)).toBe(ref.agentTargetKey);
        });
        async function chooseModelRow() {
            const content = await renderChipContent('execution-run-start-route');
            await content.pressByTestIdAsync('execution-run-route-choice.choose');
            await content.pressByTestIdAsync('execution-run-route-choice.model');
            return modal.show.mock.calls.at(-1)?.[0] as { props: { onSelect: (ref: unknown) => void } };
        }
        const claude = () => canonicalTargetKey('claude');
        it('opens the real native model rows from Choose for this run and submits the tapped exact choice', async () => {
            await mount();
            const codex = composer().engine!.options.find((option) => option.id.includes('codex'))!;
            await selectEngine(codex.id);
            await chooseModelRow();
            const shown = modal.show.mock.calls.at(-1)?.[0] as {
                component: React.ComponentType<Record<string, unknown>>;
                props: { agentTargetKey: string; nativeModels: readonly { value: string }[] };
            };
            const latestProps = () => (modal.update.mock.calls.at(-1)?.[1] ?? shown.props) as typeof shown.props;
            await waitFor(() => expect(latestProps().nativeModels).toEqual(expect.arrayContaining([
                expect.objectContaining({ value: 'gpt-6.1-luna' }),
            ])));
            const live = latestProps();
            const model = live.nativeModels.find((candidate) => candidate.value !== 'default')!;
            const picker = await renderScreen(React.createElement(shown.component, { ...live, onClose: vi.fn() }));
            const selected = { agentTargetKey: shown.props.agentTargetKey, providerConnectionId: null, modelId: model!.value };
            await picker.pressByTestIdAsync(`model-picker-overlay-option:${JSON.stringify([selected.agentTargetKey, null, selected.modelId])}`);
            await send();
            expect(emittedStarts[0]).toMatchObject({ modelSelection: selected });
            expect(startedTargetKey(emittedStarts[0]!)).toBe(canonicalTargetKey(codex.id));
        });
        it('restores unsent text and an explicit Agent/model after repository reload without changing the parent draft', async () => {
            writeExistingSessionDraft({ scope: { serverId, accountId: 'account_1' }, sessionId: 'session_1', patch: { text: 'Parent draft' } });
            await mount();
            const codex = composer().engine!.options.find((option) => option.id.includes('codex'))!;
            const defaultTarget = composer().engine?.selectedOptionId;
            await selectEngine(codex.id);
            const picker = await chooseModelRow();
            const selected = { agentTargetKey: canonicalTargetKey(codex.id), providerConnectionId: null, modelId: 'gpt-6.1-luna' };
            const modelLabel = () => ((modal.update.mock.calls.at(-1)?.[1] ?? picker.props) as {
                nativeModels: readonly { value: string; label: string }[];
            }).nativeModels.find((model) => model.value === selected.modelId)?.label;
            await waitFor(() => expect(modelLabel()).toBeTruthy());
            const chosenLabel = modelLabel()!;
            await act(async () => picker.props.onSelect(selected));
            await type('Keep this unsent Run');
            const localId = composer().initialLocalId;
            await screen.unmount();
            resetSessionDraftRepositoryForTests();
            await ensureSessionDraftRepositoryHydrated({ serverId, accountId: 'account_1' });
            await mount();
            expect(input().props.value).toBe('Keep this unsent Run');
            expect(composer().engine?.selectedOptionId).toBe(codex.id);
            expect(composer().engine?.label).toBe(codex.label);
            expect(screen.getTextContent()).toContain(chosenLabel);
            expect(screen.getTextContent()).not.toContain(t('agentInput.model.useCliSettings'));
            expect(composer().initialLocalId).toBe(localId);
            await send('Keep this unsent Run');
            expect(emittedStarts[0]).toMatchObject({ modelSelection: selected });
            const parentDraft = getSessionDraftSnapshot({ serverId, accountId: 'account_1' }, { kind: 'session', sessionId: 'session_1' });
            expect(getSessionDraftDocumentField(parentDraft?.document ?? null, { kind: 'composer', field: 'text' })?.value).toBe('Parent draft');
            await screen.unmount();
            resetSessionDraftRepositoryForTests();
            await ensureSessionDraftRepositoryHydrated({ serverId, accountId: 'account_1' });
            await mount();
            expect(input().props.value).toBe('');
            expect(composer().engine?.selectedOptionId).toBe(defaultTarget);
        });
        it('starts on the exact source and model picked, telling same-name models of two sources apart', async () => {
            await mount();
            const picker = await chooseModelRow();
            const first = { agentTargetKey: claude(), providerConnectionId: 'pc_a', modelId: 'same-name' };
            const second = { agentTargetKey: claude(), providerConnectionId: 'pc_b', modelId: 'same-name' };
            await act(async () => picker.props.onSelect(first));
            await act(async () => picker.props.onSelect(second));
            await send();
            expect(emittedStarts[0]).toMatchObject({ modelSelection: second });
            expect(emittedStarts[0]).not.toHaveProperty('modelId');
        });
        it('starts on a native model without a source', async () => {
            await mount();
            const picker = await chooseModelRow();
            const native = { agentTargetKey: claude(), providerConnectionId: null, modelId: 'claude-native' };
            await act(async () => picker.props.onSelect(native));
            await send();
            expect(emittedStarts[0]).toMatchObject({ modelSelection: native });
        });
        it('on a phone says what the Run follows beside when it starts, so a scrolled-away chip never hides it', async () => {
            windowState.width = 390;
            try {
                await mount();
                const foot = () => screen.findByTestId('execution-run-start-foot')?.props.children as string;
                expect(foot()).toContain(t('runPage.menu.selectionInherited'));
                const picker = await chooseModelRow();
                await act(async () => picker.props.onSelect({ agentTargetKey: claude(), providerConnectionId: 'pc_a', modelId: 'm' }));
                expect(foot()).not.toContain(t('runPage.menu.selectionInherited'));
            } finally {
                windowState.width = 1024;
            }
        });
        it('on a wide window keeps the route in its labelled chip and says it once', async () => {
            await mount();
            expect(screen.findByTestId('execution-run-start-foot')?.props.children)
                .toBe(t('agentStart.startsWhenYouSend', { count: 1 }));
        });
        it('returns to following the session when Inherit is chosen again', async () => {
            await mount();
            const picker = await chooseModelRow();
            await act(async () => picker.props.onSelect({ agentTargetKey: claude(), providerConnectionId: 'pc_a', modelId: 'm' }));
            const content = await renderChipContent('execution-run-start-route');
            await content.pressByTestIdAsync('execution-run-route-choice.inherit');
            await send();
            expect(emittedStarts[0]).not.toHaveProperty('modelSelection');
            expect(emittedStarts[0]).not.toHaveProperty('modelId');
        });
        it('carries the exact choice into a bounded launch', async () => {
            await mount({ intent: 'delegate' });
            const picker = await chooseModelRow();
            const ref = { agentTargetKey: claude(), providerConnectionId: 'pc_a', modelId: 'same-name' };
            await act(async () => picker.props.onSelect(ref));
            await send();
            expect(emittedStarts[0]).toMatchObject({ intent: 'delegate', modelSelection: ref });
        });
    });
    it('does not guess when correlation has multiple matches', async () => {
        startResults.push(uncertain());
        await mount();
        const baseTransport = transport.call.getMockImplementation()!;
        transport.call.mockImplementation(async (request) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST
            ? { runs: [run('run_a', emittedStarts[0]?.launchOrigin), run('run_b', emittedStarts[0]?.launchOrigin)] }
            : baseTransport(request));
        await send();
        expect(emittedStarts).toHaveLength(1);
        expect(outbound).toEqual([]);
        expect(input().props.value).toBe('Inspect this');
        expect(composer().disabled).toBe(true);
        expect(screen.findByTestId('execution-run-conversation-error')?.props.children)
            .toBe(t('sessionDrafts.executionRunStart.unresolved'));
    });
    it('retains the materialized Run and exact draft when HTTP admission refuses custody', async () => {
        admissionFailure = true;
        const opened = vi.fn();
        await mount({ onRunStarted: opened });
        const inputId = composer().initialLocalId;
        await send();
        await waitFor(() => expect(opened).toHaveBeenCalledWith('run_1', { retryInputLocalId: inputId }, { title: 'Inspect this' }));
        expect(draft()?.document.composer.text.value).toBe('Inspect this');
    });
    it('does not start from an ambient same-id Session in another Home', async () => {
        getStorage().setState((state) => ({ sessions: { session_1: { ...state.sessions.session_1!, serverId: 'wrong_home' } } }));
        await mount();
        await type('Keep my draft');
        expect(composer().canSendMessages).toBe(false);
        expect(input().props.value).toBe('Keep my draft');
        expect(emittedStarts).toEqual([]);
    });
    it('uses the exact parent access capabilities and recovers when write access is granted', async () => {
        getStorage().setState((state) => ({ sessions: { session_1: createSessionFixture({
            ...state.sessions.session_1!, access: createSessionAccessFixture('view'),
        }) } }));
        await mount();
        await type('Keep my draft across access changes');
        expect(composer().canSendMessages).toBe(false);
        await act(async () => { await sendButton().props.onPress(); });
        expect(emittedStarts).toEqual([]);
        expect(outbound).toEqual([]);
        await act(async () => getStorage().setState((state) => ({ sessions: { session_1: createSessionFixture({
            ...state.sessions.session_1!, access: createSessionAccessFixture('owner'),
        }) } })));
        await waitFor(() => expect(composer().canSendMessages).toBe(true));
        expect(input().props.value).toBe('Keep my draft across access changes');
        await send('Keep my draft across access changes');
        expect(emittedStarts).toHaveLength(1);
        expect(outboundText()).toContain('Keep my draft across access changes');
    });
    it('keeps the actual mounted composer and unsent content across Start another', async () => {
        startResults.push(uncertain());
        await mount();
        const owner = screen.root.findByType(Reflect.get(AgentInput, 'type'));
        await send();
        await screen.pressByTestIdAsync('execution-run-conversation-start-another');
        await settle();
        expect(screen.root.findByType(Reflect.get(AgentInput, 'type'))).toBe(owner);
        expect(input().props.value).toBe('Inspect this');
    });
    it('announces launch and reconciliation through the polite status owner', async () => {
        let resolveStart!: (result: unknown) => void;
        let resolveList!: (result: unknown) => void;
        startResults.push(new Promise((resolve) => { resolveStart = resolve; }));
        listResult = new Promise(resolve => { resolveList = resolve; });
        await mount();
        await send('Inspect this', false);
        expect(screen.findHostByTestId('execution-run-conversation-accessibility-status')?.props.accessibilityLiveRegion).toBe('polite');
        await act(async () => resolveStart(uncertain()));
        await waitFor(() => expect(screen.findByTestId('execution-run-conversation-phase')).not.toBeNull());
        expect(screen.getTextContent()).toContain(t('sessionDrafts.executionRunStart.reconciling'));
        await act(async () => resolveList({ runs: [] }));
        await waitFor(() => expect(screen.findByTestId('execution-run-conversation-start-another')).not.toBeNull());
    });
    it('registers the actual composer focus target only when autofocus is requested', async () => {
        await mount({ autoFocusComposer: true });
        await waitFor(() => expect(platform.focus).toHaveBeenCalled());
        platform.focus.mockClear();
        startResults.push({ ok: false, error: 'backend_unavailable' });
        await send('Inspect this', false);
        await waitFor(() => expect(screen.findByTestId('execution-run-conversation-start-another')).not.toBeNull());
        expect(composer().disabled).toBe(true);
        await screen.pressByTestIdAsync('execution-run-conversation-start-another');
        await waitFor(() => expect(composer().disabled).toBe(false));
        expect(platform.focus).not.toHaveBeenCalled();
        await screen.unmount();
        platform.focus.mockClear();
        await mount({ autoFocusComposer: false });
        expect(platform.focus).not.toHaveBeenCalled();
    });
    it('keeps Ask Agent selection as context and sends it ahead of the typed question', async () => {
        await mount({ initialText: 'Selected discussion messages', launchOrigin: { kind: 'discussion', serverId: 'server-a', discussionId: 'discussion_1', messageIds: ['message_1'], draftCorrelationId: 'selection_1' } });
        expect(input().props.value).toBe('');
        await send('Why did this fail?');
        expect(outboundText()).toContain('Selected discussion messages');
        expect(outboundText()).toContain('Why did this fail?');
        expect(emittedStarts[0]).toMatchObject({ launchOrigin: { discussionId: 'discussion_1', draftCorrelationId: 'selection_1' } });
    });
    it('titles the new Run by the captured question', async () => {
        const opened = vi.fn();
        await mount({ onRunStarted: opened });
        await send('Explain this race');
        await waitFor(() => expect(opened).toHaveBeenCalledWith('run_1', undefined, { title: 'Explain this race' }));
        expect(emittedStarts[0]).toMatchObject({ display: { title: 'Explain this race' } });
    });
    it('keeps Discussion provenance after explicit unresolved recovery', async () => {
        startResults.push(uncertain(), started());
        await mount({ initialText: 'Selection', launchOrigin: { kind: 'discussion', serverId: 'server-a', discussionId: 'discussion_1', messageIds: ['message_1'], draftCorrelationId: 'selection_1' } });
        await send();
        await screen.pressByTestIdAsync('execution-run-conversation-start-another');
        await settle();
        await send();
        expect(emittedStarts[1]).toMatchObject({ launchOrigin: { kind: 'discussion', discussionId: 'discussion_1', messageIds: ['message_1'] } });
        expect(record(emittedStarts[1]?.launchOrigin).draftCorrelationId).not.toBe('selection_1');
    });
    it('forwards the Report chip selection on a plain conversation', async () => {
        await mount();
        expect(chip('execution-run-start-report').stabilityKey).toMatch(/^false:/);
        const report = await renderChip('execution-run-start-report');
        const toggle = report.root.findAll((node) => node.props.testID === 'execution-run-start-report-switch' && typeof node.props.onValueChange === 'function').at(-1)!;
        await act(async () => toggle.props.onValueChange(true));
        await send();
        expect(emittedStarts[0]).toMatchObject({ notifyParentOnCompletion: true });
    });
    it('starts all selected reviewers through real review.start and accepts the typed instructions', async () => {
        const opened = vi.fn();
        startResults.push(started('run_claude'), started('run_codex'));
        await mount({ intent: 'review', onRunStarted: opened });
        expect(composer().isSendDisabled).toBe(true);
        expect(await reviewers()).toHaveLength(2);
        expect(reviewerKeys()).toHaveLength(2);
        await send();
        expect(emittedStarts).toHaveLength(2);
        expect(emittedStarts.map((value) => value.intent)).toEqual(['review', 'review']);
        for (const start of emittedStarts) expect(start).toMatchObject({ instructions: 'Inspect this', notifyParentOnCompletion: true, retentionPolicy: 'resumable' });
        expect(record(emittedStarts[0]?.display).groupId).toBe(record(emittedStarts[1]?.display).groupId);
        expect(input().props.value).toBe('');
        await waitFor(() => expect(opened).toHaveBeenCalledWith('run_claude', undefined, { title: 'Inspect this' }));
    });
    it('removes one chosen reviewer from its real removable chip', async () => {
        await mount({ intent: 'review' });
        await reviewers();
        const first = reviewerKeys()[0]!;
        const reviewer = await renderChip(first);
        await reviewer.pressByTestIdAsync(`${first}:remove`);
        await send();
        expect(emittedStarts).toHaveLength(1);
    });
    it('opens a partially started review and names the reviewer that failed', async () => {
        startResults.push(started('run_claude'), { ok: false, error: 'review_engine_unavailable', errorCode: 'review_engine_unavailable' });
        const opened = vi.fn();
        await mount({ intent: 'review', onRunStarted: opened });
        await reviewers();
        await send();
        await waitFor(() => expect(opened).toHaveBeenCalledWith('run_claude', undefined, { title: 'Inspect this' }));
        await waitFor(() => expect(modal.alert).toHaveBeenCalledWith(t('runPage.review.reviewersNotStarted', { count: 1 }), expect.any(String)));
        const failureMessage = modal.alert.mock.calls.at(-1)![1];
        expect(failureMessage).toContain('codex');
        expect(failureMessage).not.toContain('claude');
        expect(input().props.value).toBe('');
    });
    it('keeps the typed draft when the real plan Action refuses every start', async () => {
        startResults.push({ ok: false, error: 'backend_unavailable' });
        const opened = vi.fn();
        await mount({ intent: 'plan', onRunStarted: opened });
        await send();
        expect(emittedStarts[0]).toMatchObject({ intent: 'plan', instructions: 'Inspect this', notifyParentOnCompletion: true });
        expect(opened).not.toHaveBeenCalled();
        expect(input().props.value).toBe('Inspect this');
        expect(screen.findByTestId('execution-run-conversation-error')).not.toBeNull();
        expect(modal.alert).not.toHaveBeenCalled();
    });
    it('keeps a written draft while execution runs are disabled', async () => {
        setSettings({ featureToggles: { 'execution.runs': false } });
        await mount({ intent: 'review' });
        await type('Keep this');
        expect(composer().isSendDisabled).toBe(true);
        expect(input().props.editable).not.toBe(false);
        expect(screen.findByTestId('execution-run-start-blocked')).not.toBeNull();
        expect(input().props.value).toBe('Keep this');
    });

    it('names the Reviewer role as loading, never by its raw id, until the Roles catalog answers', async () => {
        let release!: () => void;
        rolesGate = new Promise((resolve) => { release = resolve; });
        invalidateRoleCatalog();
        await mount({ intent: 'review' });
        const roleChip = await renderChip('execution-run-start-role');
        expect(roleChip.getTextContent()).toContain(t('common.loading'));
        expect(roleChip.getTextContent()).not.toContain('reviewer');
        release();
        await vi.waitFor(async () => {
            await settle();
            expect((await renderChip('execution-run-start-role')).getTextContent()).toContain('Reviewer');
        });
    });
    it('reads an unanswered Machine as checking, offers no Agent yet, and still names the Session\'s own Agent', async () => {
        let release!: () => void;
        capabilitiesGate = new Promise((resolve) => { release = resolve; });
        await mount();
        expect(screen.getTextContent()).toContain(t('runPage.launcher.checking'));
        expect(screen.getTextContent()).not.toContain(t('runPage.launcher.unavailableReason'));
        expect(composer().engine?.agentType).toBe('claude');
        expect(composer().engine!.options.slice(1).every((option) => option.muted === true)).toBe(true);
        release();
        await waitFor(() => expect(screen.findByTestId('execution-run-start-blocked')).toBeNull());
        expect(composer().engine!.options.slice(1).some((option) => option.muted !== true)).toBe(true);
    });
    it('says the Machine could not be checked, not that it offers nothing, when its capability read fails', async () => {
        capabilitiesFailure = true;
        await mount({ intent: 'review' });
        await waitFor(() => expect(screen.getTextContent()).toContain(t('machineAgents.unknown')));
        expect(screen.getTextContent()).not.toContain(t('runPage.launcher.unavailableReason'));
    });

    async function chooseRole(roleId: string) {
        const rail = composer().engine!.options[0]!;
        expect(rail.id).toBe('roles');
        const choices = await renderScreen(<>{rail.renderDetailContent?.({ onRequestClose: vi.fn() })}</>);
        // A real popover receives the composer's current controlled props when
        // the asynchronous catalog arrives. Keep this separately mounted leaf current too.
        await vi.waitFor(async () => {
            await choices.update(<>{composer().engine!.options[0]!.renderDetailContent?.({ onRequestClose: vi.fn() })}</>);
            expect(choices.findByTestId(`roles-rail-option:${roleId}`), JSON.stringify({ text: choices.getTextContent(), http: home.requests.map((request) => request.path) })).not.toBeNull();
        });
        await choices.pressByTestIdAsync(`roles-rail-option:${roleId}`);
        await settle();
    }
    it('chooses Planner from the real Roles rail and carries roleId through plan admission', async () => {
        await mount({ intent: 'plan' });
        await chooseRole('planner');
        await send();
        expect(emittedStarts[0]).toMatchObject({ intent: 'plan', roleId: 'planner' });
    });
    it('moves the selected Agent when the chosen role names another Agent', async () => {
        const roles = await createDefaultActionExecutor().execute('roles.list', {}, { serverId, expectedAccountId: 'account_1' });
        expect(roles, JSON.stringify(roles)).toMatchObject({ ok: true });
        await mount({ intent: 'delegate' });
        const codex = composer().engine!.options.find((option) => option.id.includes('codex'))!;
        roleOverrides = { scout: { roleId: 'scout', engine: { agentTargetKey: canonicalTargetKey(codex.id) } } };
        await refreshPromptLibraryCatalog({ serverId, accountId: 'account_1' });
        invalidateRoleCatalog();
        await settle();
        await chooseRole('scout');
        expect(composer().engine!.selectedOptionId).toBe(codex.id);
    });
    it('names the implicit Reviewer role while leaving an unchosen roleId absent from the start', async () => {
        await mount({ intent: 'review' });
        await act(async () => chip('execution-run-start-role').onIntent?.());
        const role = await renderChipContent('execution-run-start-role');
        // The actual open popover receives new controlled props when its demanded catalog arrives.
        await vi.waitFor(async () => {
            const renderContent = chip('execution-run-start-role').collapsedContentPopover?.renderContent;
            await role.update(<>{typeof renderContent === 'function'
                ? renderContent({ requestClose: vi.fn(), maxHeight: Dimensions.get('window').height }) : renderContent}</>);
            expect(role.getTextContent()).toContain('Reviewer');
        });
        await reviewers();
        await send();
        expect(emittedStarts[0]).not.toHaveProperty('roleId');
    });
    it('names the review for what it is on the tab and in its heading, and says where it looks instead of which machine', async () => {
        await mount({ intent: 'review', roleId: 'second_opinion', heading: 'Second opinion' });
        const text = screen.getTextContent();
        expect(text).toContain('Second opinion');
        expect(text).not.toContain('runPage.launcher.titles.review');
        expect(text).toContain('runPage.launcher.descriptions.review');
    });
    it('starts Second opinion through the real review Action with its explicit role', async () => {
        await mount({ intent: 'review', roleId: 'second_opinion' });
        // Choosing who reviews is launch readiness, not a change to the parent's input grant.
        // The person can write the question before making that choice.
        expect(composer().canSendMessages).toBe(true);
        expect(input().props.editable).not.toBe(false);
        expect(input().props.placeholder).toBe(t('agentStart.placeholders.review'));
        await type('Inspect this');
        expect(sendButton().props.disabled).toBe(true);
        expect(composer().extraActionChips?.find(chip => chip.key === 'execution-run-start-reviewers-add'))
            .toMatchObject({ requirement: { code: 'reviewer_required', fieldPath: 'engineIds' } });
        const snapshot = readComposerPresentationSnapshot(screen.root.findByType(Reflect.get(AgentInput, 'type')).props.composerRef);
        expect(ComposerSnapshotV1Schema.parse(snapshot).state).toMatchObject({ editable: true, submittable: false });
        await act(async () => { await sendButton().props.onPress(); });
        expect(emittedStarts).toEqual([]);
        await reviewers();
        expect(composer().extraActionChips?.find(chip => chip.key === 'execution-run-start-reviewers-add')?.requirement).toBeNull();
        await send();
        expect(emittedStarts[0]).toMatchObject({ intent: 'review', roleId: 'second_opinion' });
    });
    it('carries a chosen conversation role after the exact daemon confirms binding support', async () => {
        await mount();
        await chooseRole('scout');
        await send();
        expect(transport.call.mock.calls.some(([request]) => request.method === RPC_METHODS.CAPABILITIES_DETECT && request.machineId === 'machine_1' && request.serverId === serverId)).toBe(true);
        expect(emittedStarts[0]).toMatchObject({ roleId: 'scout' });
    });

    async function configureSecret() {
        const profile = AIBackendProfileSchema.parse({ id: 'work', name: 'Work', envVarRequirements: [{ name: 'ANTHROPIC_API_KEY', required: true, kind: 'secret' }] });
        secretAvailable = true;
        publishProfile(profile);
        getStorage().setState((state) => ({ sessions: { session_1: { ...state.sessions.session_1!, metadata: { ...state.sessions.session_1!.metadata!, profileId: 'work' } } } }));
        await mount();
        await screen.pressByTestIdAsync('execution-run-secret-overlay-edit');
        const params = record(modal.show.mock.calls.at(-1)?.[0]);
        const onResolve = record(params.props).onResolve as (value: unknown) => void;
        await act(async () => onResolve({ action: 'selectSaved', envVarName: 'ANTHROPIC_API_KEY', secretId: secretRef }));
        await settle();
    }
    it('admits a comparison dialog review through the same Saved Secret target checks as the launcher', async () => {
        protocolSupported = false;
        const profile = AIBackendProfileSchema.parse({ id: 'work', name: 'Work', envVarRequirements: [{ name: 'ANTHROPIC_API_KEY', required: true, kind: 'secret' }] });
        secretAvailable = true;
        publishProfile(profile);
        getStorage().setState((state) => ({ sessions: { session_1: { ...state.sessions.session_1!, metadata: { ...state.sessions.session_1!.metadata!, profileId: 'work' } } } }));
        screen = await renderScreen(<StartReviewDialog sessionId="session_1" serverId={serverId} cwd="/repo"
            comparison={{ kind: 'workingTree' }} comparisonId="captured-1" scopeLabel="Pending changes"
            defaultWalkthrough={false} onClose={vi.fn()} onStarted={vi.fn()} />);
        await settle();
        await screen.pressByTestIdAsync('execution-run-secret-overlay-edit');
        const onResolve = record(record(modal.show.mock.calls.at(-1)?.[0]).props).onResolve as (value: unknown) => void;
        await act(async () => onResolve({ action: 'selectSaved', envVarName: 'ANTHROPIC_API_KEY', secretId: secretRef }));
        await settle();
        await waitFor(() => expect(screen.findByTestId('start-review-start')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('start-review-start');
        await settle();
        expect(emittedStarts).toEqual([]);
        expect(screen.getTextContent()).toContain(t('sessionDrafts.executionRunStart.secretReferenceOverlayUpdateRequired'));
    });
    it('guides an unconfirmed comparison Start to Runs and Session resume without resending', async () => {
        const onStarted = vi.fn();
        const onClose = vi.fn();
        startRelayFailure = { error: 'RPC target disconnected after request submission', errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN };
        screen = await renderScreen(<StartReviewDialog sessionId="session_1" serverId={serverId} cwd="/repo"
            comparison={{ kind: 'workingTree' }} comparisonId="captured-1" scopeLabel="Pending changes"
            defaultWalkthrough={false} onClose={onClose} onStarted={onStarted} />);
        await settle();
        await waitFor(() => expect(screen.findByTestId('start-review-start')?.props.disabled,
            JSON.stringify({ text: screen.getTextContent(), rpc: transport.call.mock.calls.map(([request]) => request.method) })).toBe(false));
        await act(async () => screen.changeTextByTestId('start-review-instructions', 'Keep this review request'));
        await screen.pressByTestIdAsync('start-review-start');
        await waitFor(() => expect(screen.getTextContent()).toContain('sessionDrafts.executionRunStart.submittedUnknown'));
        expect(screen.getTextContent()).not.toContain(startRelayFailure.error);
        expect(emittedStarts).toHaveLength(1);
        expect(outbound).toEqual([]);
        expect(onStarted).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.findByTestId('start-review-instructions')?.props.value).toBe('Keep this review request');
        await settle();
        expect(emittedStarts).toHaveLength(1);
    });
    it('translates a structured-output model refusal through the actual comparison Start', async () => {
        const onStarted = vi.fn();
        const onClose = vi.fn();
        const code = 'model_structured_output_unsupported';
        startResults.push({ ok: false, error: code, errorCode: code,
            details: withExecutionRunStartFailureDetails({ modelId: 'default', structuredOutput: 'unknown' }, 'noRunCreated') });
        screen = await renderScreen(<StartReviewDialog sessionId="session_1" serverId={serverId} cwd="/repo"
            comparison={{ kind: 'workingTree' }} comparisonId="captured-1" scopeLabel="Pending changes"
            defaultWalkthrough={false} onClose={onClose} onStarted={onStarted} />);
        await settle();
        await waitFor(() => expect(screen.findByTestId('start-review-start')?.props.disabled).toBe(false));
        await act(async () => screen.changeTextByTestId('start-review-instructions', 'Keep this review request'));
        await screen.pressByTestIdAsync('start-review-start');
        await waitFor(() => expect(screen.getTextContent()).toContain(t('walkthrough.generationFailure.modelUnavailable')));
        expect(screen.getTextContent()).not.toContain(code);
        expect(emittedStarts).toHaveLength(1);
        expect(outbound).toEqual([]);
        expect(onStarted).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.findByTestId('start-review-instructions')?.props.value).toBe('Keep this review request');
    });
    it('resumes the stopped host on its exact Home before the comparison dialog starts a review', async () => {
        getStorage().setState((state) => ({ sessions: { session_1: { ...state.sessions.session_1!, active: false,
            metadata: { ...state.sessions.session_1!.metadata!, claudeSessionId: 'native-session-1' } } } }));
        screen = await renderScreen(<StartReviewDialog sessionId="session_1" serverId={serverId} cwd="/repo"
            comparison={{ kind: 'workingTree' }} comparisonId="captured-1" scopeLabel="Pending changes"
            defaultWalkthrough={false} onClose={vi.fn()} onStarted={vi.fn()} />);
        await settle();
        await waitFor(() => expect(screen.findByTestId('start-review-start')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('start-review-start');
        await waitFor(() => expect(emittedStarts, JSON.stringify({ text: screen.getTextContent(), rpc: transport.call.mock.calls.map(([request]) => request), http: home.requests.map((request) => request.path) })).toHaveLength(1));
        const resume = transport.call.mock.calls.findIndex(([request]) => request.method === RPC_METHODS.SPAWN_HAPPY_SESSION || request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE);
        const review = transport.call.mock.calls.findIndex(([request]) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_START
            || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1);
        expect(resume).toBeGreaterThanOrEqual(0);
        expect(resume).toBeLessThan(review);
        expect(transport.call.mock.calls[resume]?.[0]).toMatchObject({ machineId: 'machine_1', serverId,
            payload: { sessionId: 'session_1', spawnNonce: expect.stringMatching(/^execution-run-host-/) } });
        expect(emittedStarts[0]).toMatchObject({ intent: 'review', intentInput: { comparisonId: 'captured-1' } });
    });
    it('preflights a selected Saved Secret and creates no Run when the daemon lacks support', async () => {
        protocolSupported = false;
        await configureSecret();
        await send();
        expect(emittedStarts).toEqual([]);
        expect(screen.findByTestId('execution-run-conversation-error')?.props.children).toBe(t('sessionDrafts.executionRunStart.secretReferenceOverlayUpdateRequired'));
        expect(composer().canSendMessages).toBe(true);
        protocolSupported = true;
        await send();
        expect(emittedStarts).toHaveLength(1);
        expect(emittedStarts[0]).toMatchObject({ secretReferenceOverlay: { v: 1, bindings: { ANTHROPIC_API_KEY: { ref: secretRef } } } });
    });
    it('forwards a value-free Saved Secret overlay after exact-target acceptance', async () => {
        await configureSecret();
        await send();
        expect(emittedStarts[0]).toMatchObject({ secretReferenceOverlay: { v: 1, bindings: { ANTHROPIC_API_KEY: { ref: secretRef } } } });
        expect(JSON.stringify(emittedStarts)).not.toContain('sealed-secret');
    });
    it('does not create a Run when a Saved Secret selection becomes unavailable', async () => {
        await configureSecret();
        secretAvailable = false;
        await act(async () => { await refreshSavedSecretCatalog({ serverId, accountId: 'account_1' }); });
        await settle();
        await type('Keep this secret-bound draft');
        expect(composer().isSendDisabled).toBe(true);
        expect(emittedStarts).toEqual([]);
        expect(input().props.value).toBe('Keep this secret-bound draft');
    });
});
