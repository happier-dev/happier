import 'fake-indexeddb/auto';
import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen as renderCanonicalScreen } from '@/dev/testkit/render/renderScreen';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture, createReadyMachineAgentInventoryFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit';
import { quotaTestProviderUsageSnapshot, quotaTestProviderUsageResponse } from '@/hooks/server/connectedServices/qualifiedConnectedAccountQuotaTestHarness';
import { writeProviderAccountUsageRecordIdToMetadata } from '@happier-dev/protocol/sessions/metadata/providerAccountUsageRefsV1';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { PendingRequestedActionV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { ManagedOpaquePresetReadV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { PENDING_INPUT_PROTOCOL_VERSION_V3 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { MINIMUM_CLI_PENDING_QUEUE_V2_VERSION } from '@/utils/system/versionUtils';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { SessionModelSelectionIntentV1Schema } from '@happier-dev/protocol/providers/selection/v1';
import { SessionCreationCorrespondenceV1ReadSchema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { projectComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { SessionDraftReadRequestV2Schema, SessionDraftMutateRequestV2Schema, SessionDraftMutateResponseV2Schema, type SessionDraftRecordV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { SESSION_HUMAN_PRESENCE_VISIBLE_REPLACE_EVENT, SessionHumanPresenceVisibleReplaceV1Schema, SessionHumanPresenceVisibleReplaceResultV1Schema } from '@happier-dev/protocol/sessions';
import { BUNDLED_CANONICAL_AGENT_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { SessionComposerModel, SessionComposerRenderer } from '@/components/sessions/composer/sessionComposerModel';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';

/**
 * Typing stays local to the mounted input while the real draft persists and restores.
 * Submission then resolves and acknowledges through the actual Home/Sync owners.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const platformState = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'web' }));
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    View: 'View', Text: 'Text', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator',
    useWindowDimensions: () => ({ width: 1200, height: 800 }),
    Platform: { get OS() { return platformState.os; }, select: (spec: Record<string, unknown>) => spec[platformState.os] ?? spec.default },
  });
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => {
  const { getPreferredLanguage } = await import('@/text/preferredLanguage');
  return (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => {
    const locale = getPreferredLanguage();
    return locale === 'en' ? key : `${locale}:${key}`;
  } });
});
vi.mock('@/modal', async () =>
  (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: vi.fn(), back: vi.fn() }, pathname: '/',
  }).module);
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('react-native-safe-area-context', () => ({
  initialWindowMetrics: {
    frame: { x: 0, y: 0, width: 0, height: 0 },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  },
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@react-navigation/native', () => ({
  ...createReactNavigationNativeMock(), useFocusEffect: () => {}, useIsFocused: () => true,
}));

// Observe shell slots without mounting their separate transcript/native renderers.
// All Session, Account, draft, readiness, feature and send decisions remain real.
vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
  AgentContentView: (props: { input?: React.ReactNode; content?: React.ReactNode; placeholder?: React.ReactNode }) =>
    React.createElement('AgentContentView', props, props.content, props.placeholder, props.input),
}));
vi.mock('@/components/sessions/shell/view/SessionPaneHeader', () => ({ SessionPaneHeader: () => null }));
vi.mock('@/components/sessions/transcript/ChatList', () => ({ ChatList: () => null }));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({ EmptyMessages: () => null }));
vi.mock('@/components/ui/forms/Deferred', () => ({
  Deferred: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
}));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({ SessionHeaderActionMenu: () => null }));

vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({ AttachmentFilePicker: () => null }));
vi.mock('@/components/ui/code/editor/CodeEditor', () => ({ CodeEditor: () => null }));
vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: (props: Record<string, unknown>) => React.createElement('AgentInput', props),
}));

const { installSessionPaneRuntimeTestHarness } = await import('../panes/sessionPaneRuntimeTestHarness');
const submittedMessages: Array<Readonly<{
  localId: string;
  content: ReturnType<typeof SessionStoredMessageContentSchema.parse>;
  requestedAction: ReturnType<typeof PendingRequestedActionV1Schema.parse>;
}>> = [];
const composerInventory = createReadyMachineAgentInventoryFixture([
  { agentId: 'codex', title: 'Codex' }, { agentId: 'claude', title: 'Claude' },
]);
const composerProjection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
  protocolVersion: 1,
  projection: { ...composerInventory.projection,
    agentsById: Object.fromEntries(Object.entries(composerInventory.projection.agentsById).map(([id, declaration]) => [id, {
      ...declaration, identity: id === 'codex' || id === 'claude' ? BUNDLED_CANONICAL_AGENT_DECLARATIONS[id]?.identity : undefined,
    }])),
  },
});
let composerInventoryEnabled = false;
const composerProjectionRequests: string[] = [];
const guardKeepRequests: Array<{ targetId: string; input: unknown }> = [];
const pendingComposerProjections = new Map<string, ReturnType<typeof createDeferred<typeof composerProjection>>>();
// The Home HTTP boundary acknowledges real draft writes; controller/repository logic stays real.
const draftRecords = new Map<string, SessionDraftRecordV2>();
let heldDraftWrite: ReturnType<typeof createDeferred<void>> | null = null;
let heldDraftRead: ReturnType<typeof createDeferred<void>> | null = null;
let draftWritesStarted = 0;
let syncDraftCase = false;
let pendingEditCase = false;
let providerUsageRead: (() => Promise<Response>) | null = null;
let managedWakeRead: (() => Response) | null = null;
beforeEach(({ task }) => {
  draftRecords.clear(); heldDraftWrite = null; heldDraftRead = null; draftWritesStarted = 0; providerUsageRead = null; managedWakeRead = null;
  // Only the new cases extend their external Home contracts; preserve existing local-draft fixtures.
  syncDraftCase = task.name.includes('first draft-status') || task.name.includes('before its draft read lands');
  pendingEditCase = task.name.includes('real queued submission');
});
const runtime = installSessionPaneRuntimeTestHarness({
  configureSocket: socket => {
    if (!pendingEditCase) return;
    const emitWithAck = vi.mocked(socket.emitWithAck).getMockImplementation();
    vi.mocked(socket.emitWithAck).mockImplementation(async (event, payload: unknown) => {
      if (event === SESSION_HUMAN_PRESENCE_VISIBLE_REPLACE_EVENT) {
        const request = SessionHumanPresenceVisibleReplaceV1Schema.parse(payload);
        return SessionHumanPresenceVisibleReplaceResultV1Schema.parse({
          v: 1, ok: true, admittedSessionIds: request.sessionIds,
          ...(request.locations ? { admittedLocations: request.locations } : {}),
          ...(request.pendingMessageEdits ? { admittedPendingMessageEdits: request.pendingMessageEdits } : {}),
        });
      }
      return emitWithAck?.(event, payload);
    });
  },
  features: () => {
    const features = createRootLayoutFeaturesResponse(syncDraftCase
      ? { features: { sessions: { enabled: true, drafts: { enabled: true } } } }
      : undefined);
    features.capabilities.session.pendingInput = { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V3 };
    return features;
  },
  rpc: async (method, _input, targetId) => {
    if (method === RPC_METHODS.MACHINES_GUARD_IDLE_STOP_KEEP_RUNNING) {
      guardKeepRequests.push({ targetId, input: _input });
      return { status: 'kept' };
    }
    if (composerInventoryEnabled) {
      if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
        composerProjectionRequests.push(targetId);
        return await (pendingComposerProjections.get(targetId)?.promise ?? composerProjection);
      }
      if (method === RPC_METHODS.CAPABILITIES_DETECT) return composerInventory.capabilities;
    }
    throw new RpcError('Daemon method unavailable', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
  },
  request: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/machines/managed/actions/get' && managedWakeRead) return managedWakeRead();
    if (path === '/v4/connect/qualified/provider-account-usage/record' && providerUsageRead) return providerUsageRead();
    if (/^\/v[12]\/account\/session-drafts\//.test(path)) {
      if (path.endsWith('/list')) { await heldDraftRead?.promise; return Response.json({ items: [...draftRecords.values()] }); }
      if (path.endsWith('/read')) {
        await heldDraftRead?.promise;
        const request = SessionDraftReadRequestV2Schema.parse(JSON.parse(String(init?.body)));
        const record = draftRecords.get(JSON.stringify(request.address));
        return Response.json(record ? { status: 'present', record } : { status: 'absent' });
      }
      if (path.endsWith('/mutate')) {
        const request = SessionDraftMutateRequestV2Schema.parse(JSON.parse(String(init?.body)));
        draftWritesStarted += 1;
        await heldDraftWrite?.promise;
        const key = JSON.stringify(request.address);
        const previous = draftRecords.get(key);
        const record = { address: request.address, content: request.content, revision: (previous?.revision ?? 0) + 1,
          createdAt: previous?.createdAt ?? 1, updatedAt: (previous?.updatedAt ?? 0) + 1 };
        draftRecords.set(key, record);
        return Response.json(SessionDraftMutateResponseV2Schema.parse({ status: 'updated', record }));
      }
    }
    const machineResponse = createPlainMachineReadHttpResponseFixture(new URL(String(url)).pathname, init, 'account-a');
    if (machineResponse) return machineResponse;
    if (new URL(String(url)).pathname !== '/v2/sessions/s1/pending') return null;
    if ((init?.method ?? 'GET') === 'GET') return Response.json({ pending: submittedMessages.map(message => ({
      ...message, messageRole: 'user', status: 'queued', createdAt: 1, updatedAt: 1, position: 1,
    })) });
    if (init?.method !== 'POST') throw new Error('Unexpected Pending write method');
    const body: unknown = JSON.parse(String(init.body));
    if (!body || typeof body !== 'object' || !('localId' in body) || typeof body.localId !== 'string'
      || !('content' in body) || !('requestedAction' in body)) throw new Error('Expected the real Pending submission envelope');
    const message = {
      localId: body.localId,
      content: SessionStoredMessageContentSchema.parse(body.content),
      requestedAction: PendingRequestedActionV1Schema.parse(body.requestedAction),
    };
    submittedMessages.push(message);
    return Response.json({ localId: message.localId, requestedAction: message.requestedAction,
      pending: { ...message, messageRole: 'user', status: 'queued', createdAt: 1, updatedAt: 1, position: 1 } });
  },
});
const { storage } = await import('@/sync/domains/state/storage');
const { commitPreferredLanguage } = await import('@/text/preferredLanguage');
const sessionUtils = await import('@/utils/sessions/sessionUtils');
const shellRenders = vi.spyOn(sessionUtils, 'useSessionStatus');
const resolver = await import('@/sync/domains/input/slashCommands/resolveSessionComposerSend');
const resolveSessionComposerSendSpy = vi.spyOn(resolver, 'resolveSessionComposerSend');
// Pass-through observations retain the real controller, coordinator, Action and submit owners.
const coordinator = await import('@/components/sessions/composer/composerSubmissionCoordinator');
const submitComposerSnapshotSpy = vi.spyOn(coordinator, 'submitComposerSnapshot');
const transcriptActions = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
const submitAppSessionComposerMessageSpy = vi.spyOn(transcriptActions, 'submitAppSessionComposerMessage');
const summaryModels = await import('@happier-dev/protocol/actions/settings/scmDiffSummaryModels');
const buildSummaryProfiles = vi.spyOn(summaryModels, 'buildScmDiffSummaryModelProfiles');
const { SessionView } = await import('./SessionView');
const { SessionComposerAgentInput } = await import('@/components/sessions/composer/SessionComposerAgentInput');
const { SessionModelDiscoveryDetail } = await import('@/components/sessions/modelPicker/SessionModelDiscoveryDetail');
const { ChatList } = await import('@/components/sessions/transcript/ChatList');
const { getSessionComposerDraftSnapshot, flushSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
await loadSyncSingletonForTests();
const { sync } = await import('@/sync/sync');

function surfaceElement(renderComposer?: SessionComposerRenderer) {
  return <SessionView id="s1" routeServerId={runtime.serverId} surfaceFocusedOverride surfaceVisibleOverride
    {...(renderComposer ? { renderComposer } : {})} />;
}

function renderScreen() {
  return renderCanonicalScreen(surfaceElement(), { wrapper: runtime.Wrapper });
}

/** The composer text the mounted AgentInput is given: a string, or the live source its text leaf subscribes to. */
function composerText(agentInput: Readonly<{ props: Readonly<Record<string, unknown>> }>): string {
  const value: unknown = agentInput.props.value;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'getPrompt' in value && typeof value.getPrompt === 'function') {
    const prompt: unknown = value.getPrompt();
    if (typeof prompt === 'string') return prompt;
  }
  throw new Error('AgentInput was given no composer text');
}

function findAgentInput(screen: Awaited<ReturnType<typeof renderScreen>>) {
  const inputs = screen.tree.findAllByType('AgentInput' as React.ElementType);
  return inputs[inputs.length - 1]!;
}

async function typeCharacters(screen: Awaited<ReturnType<typeof renderScreen>>, from: string, text: string) {
  let typed = from;
  for (const character of text) {
    typed += character;
    const next = typed;
    await renderer.act(async () => { findAgentInput(screen).props.onChangeText(next); });
  }
  return typed;
}

function storedDraftText(): unknown {
  const scope = runtime.accountScope;
  if (!scope) throw new Error('Expected the restored composer Account');
  return getSessionComposerDraftSnapshot(scope, { kind: 'session', sessionId: 's1' })?.composer.text.value;
}

function publishSessionOwnerMetadata(
  update: (metadata: NonNullable<ReturnType<typeof readSessionOwnerMetadataView>>) => NonNullable<ReturnType<typeof readSessionOwnerMetadataView>>,
) {
  const current = storage.getState().sessions.s1;
  const metadata = readSessionOwnerMetadataView(current);
  if (!metadata) throw new Error('Expected the real Session owner metadata projection');
  const next = update(metadata);
  storage.getState().applySessions([{ ...current, metadataVersion: current.metadataVersion + 1,
    ...(current.metadataLayoutVersion === 1 ? { ownerMetadataView: next } : { metadata: next }),
    composerOptionsInput: projectComposerOptionsInputV1(next),
  }]);
}

describe('SessionView composer typing', () => {
  beforeEach(async () => {
    commitPreferredLanguage('en');
    platformState.os = 'ios';
    submittedMessages.length = 0;
    composerInventoryEnabled = false;
    composerProjectionRequests.length = 0;
    guardKeepRequests.length = 0;
    pendingComposerProjections.clear();
    resolveSessionComposerSendSpy.mockClear();
    submitComposerSnapshotSpy.mockClear();
    submitAppSessionComposerMessageSpy.mockClear();
    storage.setState({
      settings: { ...settingsDefaults, experiments: true },
      localSettings: { ...storage.getState().localSettings, uiMultiPanePanelsEnabled: false },
    });
    storage.getState().applySessions([createSessionFixture({
      id: 's1', serverId: runtime.serverId, active: true,
      pendingVersion: 1, pendingCount: 0,
      metadata: { machineId: 'm1', host: 'test-home', flavor: 'codex', path: '/tmp', homeDir: '/tmp',
        version: MINIMUM_CLI_PENDING_QUEUE_V2_VERSION },
      agentState: { controlledByUser: true },
    })]);
    storage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: Date.now(),
      access: createPlainMachineRowFixture({ id: 'm1', accountId: 'account-a' }).access })], true, {
      sourceServerId: runtime.serverId,
    });
    const scope = runtime.accountScope;
    if (!scope) throw new Error('Expected the restored fixture Account');
    await publishMachineInventoryForTest(scope, [storage.getState().machines.m1!]);
    expect((await sync.ensureSessionVisibleForMessageRoute('s1', {
      serverId: runtime.serverId, forceRefresh: true, hydrateMessages: false,
    })).kind).toBe('available');
  });

  it('keeps the mounted composer usable when managed wake returns an opaque preset row without a launch', async () => {
    const homeId = runtime.serverIdentityId;
    const { default: nacl } = await import('tweetnacl');
    const { encodeBase64 } = await import('@happier-dev/protocol/crypto/base64');
    const installationPublicKey = encodeBase64(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5)).publicKey, 'base64url');
    const controller = { machineId: 'controller', installationId: 'installation' };
    const managed = ManagedOpaquePresetReadV1Schema.parse({
      machine: { id: 'managed-opaque', homeId, custodianAccountId: 'account-a',
        preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' }, controller,
        controllerAccess: { custodian: { accountId: 'account-a' }, installationPublicKey },
        allocation: 'bound', creationState: 'active', enrolledMachineId: 'm1',
        desired: 'start', desiredWhen: 'now', intentRevision: 1,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true },
      presetContent: { content: { t: 'plain', v: { v: 1, name: 'Private preset' } }, recipientEnvelope: null },
    });
    managedWakeRead = () => Response.json(managed);
    const session = storage.getState().sessions.s1;
    const requestedAt = session.activeAt + 1;
    storage.getState().applySessions([{ ...session, active: false,
      pendingActivationAuthorization: { status: 'waiting', requestId: 'wake-request', requestedAt,
        managedWakeTargetV1: { homeId, managedId: managed.machine.id, enrolledMachineId: 'm1',
          expectedIntentRevision: 1, controller, reason: 'admitted-work',
          origin: { kind: 'session-input', session: { homeId, sessionId: 's1' },
            pendingRequestId: 'wake-request', requestedAt } } } }]);
    const screen = await renderScreen();
    try {
      await vi.waitFor(() => expect(findAgentInput(screen).props.statusBadges)
        .toEqual(expect.arrayContaining([expect.objectContaining({ testID: 'session.managedWake.deliveryUnknown.badge' })])));
      await typeCharacters(screen, '', 'Still editable');
      expect(composerText(findAgentInput(screen))).toBe('Still editable');
    } finally { await screen.unmount(); }
  });

  it('explains a refused /fork from the mounted composer and retains its draft without sending agent input', async () => {
    storage.setState({ settings: { ...storage.getState().settings,
      actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.fork': { disabledSurfaces: ['ui'] } } }),
    } });
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.alert).mockClear();
    const screen = await renderScreen();
    try {
      await typeCharacters(screen, '', '/fork');
      await renderer.act(async () => { await findAgentInput(screen).props.onSend(); });
      await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledWith('common.error', 'actionConfirmations.turnedOffUnnamedMessage'));
      expect(composerText(findAgentInput(screen))).toBe('/fork');
      expect(submittedMessages).toEqual([]);
    } finally {
      await screen.unmount();
    }
  });

  it('opens a retained Custom ACP Session without offering a model picker for its abstract Agent', async () => {
    // The Home refresh projects the explicit presentation from the owner fixture too.
    publishSessionOwnerMetadata(metadata => ({ ...metadata, flavor: 'custom-acp', agentPresentation: { agentId: 'custom-acp' } }));
    expect(readSessionOwnerMetadataView(storage.getState().sessions.s1)?.flavor).toBe('custom-acp');
    const current = storage.getState().sessions.s1;
    storage.getState().applySessions([{ ...current, metadataVersion: current.metadataVersion + 1,
      metadata: { v: 1, path: '/repo', host: 'test-host', agentPresentation: { agentId: 'custom-acp' } },
    }]);
    const screen = await renderScreen();
    try {
      expect(findAgentInput(screen).props.modelContentOverride).toBeUndefined();
    } finally {
      await screen.unmount();
    }
  });

  it('builds zero walkthrough model profiles across twelve composer renders without a picker', async () => {
    buildSummaryProfiles.mockClear();
    const screen = await renderScreen();
    try {
      for (let index = 0; index < 12; index += 1) {
        await renderer.act(async () => {
          publishSessionOwnerMetadata(metadata => ({ ...metadata, name: `Composer render ${index}` }));
        });
      }
      expect(buildSummaryProfiles, 'a composer without a walkthrough picker consumes no model profiles').toHaveBeenCalledTimes(0);
    } finally {
      await screen.unmount();
    }
  });

  it('reads the Session creation record once across composer renders that leave the Session unchanged', async () => {
    const screen = await renderScreen();
    const parses = vi.spyOn(SessionCreationCorrespondenceV1ReadSchema, 'safeParse');
    try {
      const rendersBefore = shellRenders.mock.calls.length;
      for (let index = 0; index < 6; index += 1) {
        await renderer.act(async () => {
          storage.setState({ localSettings: { ...storage.getState().localSettings, uiFontScale: index % 2 === 0 ? 1.1 : 1 } });
        });
      }
      expect(shellRenders.mock.calls.length - rendersBefore, 'the composer controller rendered').toBeGreaterThanOrEqual(6);
      expect(parses, 'an unchanged Session is not re-parsed per composer render').toHaveBeenCalledTimes(0);
    } finally {
      parses.mockRestore();
      await screen.unmount();
    }
  });

  it('adds no controller renders when a Session open revalidates equal provider readings', async () => {
    const base = quotaTestProviderUsageSnapshot();
    const recordKey = { ...base.recordKey, providerId: 'codex' };
    const snapshot = { ...base, providerId: 'codex', recordKey, recordId: buildProviderAccountUsageRecordId(recordKey) };
    storage.getState().applySettingsLocal({ featureToggles: { connectedServices: true, 'connectedServices.quotas': true } });
    publishSessionOwnerMetadata(metadata => ({ ...metadata, ...writeProviderAccountUsageRecordIdToMetadata(metadata, {
      recordId: snapshot.recordId, updatedAtMs: snapshot.observedAtMs,
    }) }));
    const reads = vi.fn(async () => Response.json(quotaTestProviderUsageResponse(snapshot)));
    providerUsageRead = reads;
    const first = await renderScreen();
    await flushHookEffects({ cycles: 12, turns: 12 });
    expect(reads).toHaveBeenCalledTimes(1);
    await first.unmount();
    const held = createDeferred<Response>();
    reads.mockImplementationOnce(() => held.promise);
    const screen = await renderScreen();
    try {
      await flushHookEffects({ cycles: 12, turns: 12 });
      expect(reads).toHaveBeenCalledTimes(2);
      const beforeAnswer = shellRenders.mock.calls.length;
      await renderer.act(async () => held.resolve(Response.json(quotaTestProviderUsageResponse({
        ...snapshot, observedAtMs: snapshot.observedAtMs + 1,
      }))));
      await flushHookEffects({ cycles: 12, turns: 12 });
      expect(shellRenders.mock.calls.length - beforeAnswer, 'equal revalidation after Session open').toBe(0);
      const beforeWake = shellRenders.mock.calls.length;
      reads.mockImplementationOnce(async () => Response.json(quotaTestProviderUsageResponse({
        ...snapshot, observedAtMs: snapshot.observedAtMs + 2,
      })));
      await renderer.act(async () => publishHomeAccountChange(runtime.serverId,
        [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
      await flushHookEffects({ cycles: 12, turns: 12 });
      expect(reads).toHaveBeenCalledTimes(3);
      expect(shellRenders.mock.calls.length - beforeWake, 'loading and observation stamps are not controller facts').toBe(0);
      // A real reading must still reach the controller through the same HTTP producer.
      const beforeChange = shellRenders.mock.calls.length;
      reads.mockImplementationOnce(async () => Response.json(quotaTestProviderUsageResponse({
        ...snapshot, meters: [{ ...snapshot.meters[0]!, used: 51, remainingPct: 49 }],
      })));
      await renderer.act(async () => publishHomeAccountChange(runtime.serverId,
        [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
      await flushHookEffects({ cycles: 12, turns: 12 });
      expect(reads).toHaveBeenCalledTimes(4);
      expect(shellRenders.mock.calls.length - beforeChange).toBeGreaterThan(0);
    } finally { await screen.unmount(); }
  });

  it('keeps the composer controller still when an Account update only advances the profile timestamp', async () => {
    const screen = await renderScreen();
    try {
      const rendersBefore = shellRenders.mock.calls.length;
      for (let index = 1; index <= 3; index += 1) {
        await renderer.act(async () => {
          const profile = storage.getState().profile;
          storage.getState().applyProfile({ ...profile, timestamp: profile.timestamp + index });
        });
      }
      expect(shellRenders.mock.calls.length - rendersBefore).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it('mounts the Session body before its draft read lands, then mounts the composer once it does', async () => {
    heldDraftRead = createDeferred<void>();
    // The Account's whole draft collection has not finished hydrating (a cold open).
    const draftsReadyBefore = storage.getState().isSessionDraftsReady;
    storage.setState({ isSessionDraftsReady: false });
    const element = <SessionView id="s1" routeServerId={runtime.serverId} surfaceFocusedOverride surfaceVisibleOverride
      headerAccessory={React.createElement('SessionHeaderAccessoryMark', { label: 'body' })} />;
    const screen = await renderCanonicalScreen(element, { wrapper: runtime.Wrapper });
    const headerShown = () => screen.tree.findAll(node => Object.is(node.type, 'SessionHeaderAccessoryMark')).length;
    const composerShown = () => screen.tree.findAllByType(SessionComposerAgentInput).length;
    try {
      await renderer.act(async () => { await new Promise(resolve => setTimeout(resolve, 1000)); });
      expect(headerShown(), 'the Session body is mounted while its draft read is still pending').toBe(1);
      expect(composerShown(), 'the editor waits for its own draft').toBe(0);
      await renderer.act(async () => { heldDraftRead!.resolve(); });
      await vi.waitFor(() => expect(composerShown()).toBe(1));
    } finally {
      heldDraftRead?.resolve();
      await screen.unmount();
      storage.setState({ isSessionDraftsReady: draftsReadyBefore });
    }
  });

  it('keeps the composer controller still when only the Session header changes, and shows the new header', async () => {
    // Every composer controller run publishes a new composer model to the slot's renderer.
    const publishedComposers = new Set<SessionComposerModel>();
    const renderComposer: SessionComposerRenderer = composer => { publishedComposers.add(composer); return composer.content; };
    const withHeader = (label: string) => <SessionView id="s1" routeServerId={runtime.serverId} surfaceFocusedOverride surfaceVisibleOverride
      renderComposer={renderComposer} headerAccessory={React.createElement('SessionHeaderAccessoryMark', { label })} />;
    const screen = await renderCanonicalScreen(withHeader('first'), { wrapper: runtime.Wrapper });
    const headerLabels = () => screen.tree.findAll(node => Object.is(node.type, 'SessionHeaderAccessoryMark')).map(node => node.props.label);
    try {
      await renderer.act(async () => { await new Promise(resolve => setTimeout(resolve, 1500)); });
      expect(headerLabels()).toEqual(['first']);
      const publishedBefore = publishedComposers.size;
      for (const label of ['second', 'third']) {
        await screen.update(withHeader(label));
        expect(headerLabels(), 'the header shows its own current content').toEqual([label]);
      }
      expect(publishedComposers.size - publishedBefore, 'a header-only change re-ran the composer controller').toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it('retains the real submit failure and destination through composer admission without clearing the draft', async () => {
    const screen = await renderScreen();
    const typed = await typeCharacters(screen, '', 'keep this rejected draft');
    await renderer.act(async () => {
      publishSessionOwnerMetadata(metadata => ({ ...metadata, version: '0.0.1' }));
    });
    await renderer.act(async () => { findAgentInput(screen).props.onSend({ deliveryIntent: 'server_pending' }); });
    await vi.waitFor(() => expect(submitAppSessionComposerMessageSpy).toHaveBeenCalledTimes(1));
    const submitted = await submitAppSessionComposerMessageSpy.mock.results[0]!.value;
    expect(submitted.type).toBe('rejected');
    expect(submitted.errorCode).toBe('PENDING_QUEUE_UNSUPPORTED');
    expect(submitted.errorMessage).toBeTruthy();
    await vi.waitFor(() => expect(submitComposerSnapshotSpy).toHaveBeenCalledTimes(1));
    const admission = await submitComposerSnapshotSpy.mock.results[0]!.value;
    expect(admission).toMatchObject({
      status: 'rejected',
      reason: {
        type: submitted.type,
        errorMessage: submitted.errorMessage,
        ...(submitted.errorCode !== undefined ? { errorCode: submitted.errorCode } : {}),
        callerSurface: 'session_composer',
        destination: 'sessionAgent',
      },
    });
    expect(composerText(findAgentInput(screen))).toBe(typed);
    expect(storedDraftText()).toBe(typed);
    expect(submittedMessages).toHaveLength(0);
    await screen.unmount();
  });

  it('withdraws a Guard countdown on the first draft edit with one Keep per warning, without Session content churn', async () => {
    const stopAt = Date.now() + 300_000;
    publishSessionOwnerMetadata(metadata => ({ ...metadata,
      sessionGuardStateV1: { v: 1, kind: 'stopping', rule: 'idle_sessions', stopAt } }));
    const screen = await renderScreen();
    const contentVersion = storage.getState().sessions.s1.metadataVersion;
    const first = await typeCharacters(screen, '', 'the first real typing burst');
    await vi.waitFor(() => expect(guardKeepRequests).toHaveLength(1));
    expect(guardKeepRequests[0]).toMatchObject({ targetId: 'm1', input: { machineId: 'm1', sessionId: 's1' } });
    await typeCharacters(screen, first, ' and another hundred edits'.repeat(5));
    expect(guardKeepRequests).toHaveLength(1);
    expect(storage.getState().sessions.s1.metadataVersion).toBe(contentVersion);
    await renderer.act(async () => {
      publishSessionOwnerMetadata(metadata => ({ ...metadata, sessionGuardStateV1: undefined }));
    });
    // A later warning is a new generation; the current draft still stays local.
    await renderer.act(async () => {
      publishSessionOwnerMetadata(metadata => ({ ...metadata,
        sessionGuardStateV1: { v: 1, kind: 'stopping', rule: 'idle_sessions', stopAt: stopAt + 300_000 } }));
    });
    expect(guardKeepRequests).toHaveLength(1);
    await typeCharacters(screen, composerText(findAgentInput(screen)), ' another edit');
    await vi.waitFor(() => expect(guardKeepRequests).toHaveLength(2));
    await screen.unmount();
  });

  it('keeps the first draft-status transition out of transcript layout while text and draft advance', async () => {
    const screen = await renderScreen();
    heldDraftWrite = createDeferred<void>();
    const readLayout = () => screen.tree.findAllByType('AgentContentView' as React.ElementType).at(-1)!.props;
    let previous = readLayout();
    let layoutUpdates = 0;
    let typed = '';
    for (const character of 'hello') {
      typed = await typeCharacters(screen, typed, character);
      const next = readLayout();
      if (next !== previous) layoutUpdates += 1;
      previous = next;
    }
    expect(composerText(findAgentInput(screen))).toBe(typed);
    expect(storedDraftText()).toBe(typed);
    const scope = runtime.accountScope;
    if (!scope) throw new Error('Expected the real draft Account scope');
    const flush = flushSessionDraft({ scope, address: { kind: 'session', sessionId: 's1' } });
    await renderer.act(async () => { await vi.waitFor(() => expect(draftWritesStarted).toBeGreaterThan(0)); });
    if (readLayout() !== previous) layoutUpdates += 1;
    previous = readLayout();
    heldDraftWrite.resolve();
    await renderer.act(async () => { expect(await flush).toMatchObject({ status: 'clean' }); });
    if (readLayout() !== previous) layoutUpdates += 1;
    expect(layoutUpdates).toBe(0);
    await screen.unmount();
  });

  it('keeps the composer host out of the first draft-status sync of a typing burst', async () => {
    const screen = await renderScreen();
    heldDraftWrite = createDeferred<void>();
    // The first key turns an empty draft into a real one and starts its remote flush; the rest
    // of the burst types while that write is in flight, then the write is acknowledged.
    const first = await typeCharacters(screen, '', 'h');
    await renderer.act(async () => { await vi.waitFor(() => expect(draftWritesStarted).toBeGreaterThan(0)); });
    const hostRendersBefore = shellRenders.mock.calls.length;
    const typed = await typeCharacters(screen, first, 'ello world');
    heldDraftWrite.resolve();
    const scope = runtime.accountScope;
    if (!scope) throw new Error('Expected the real draft Account scope');
    await renderer.act(async () => {
      expect(await flushSessionDraft({ scope, address: { kind: 'session', sessionId: 's1' } })).toMatchObject({ status: 'clean' });
    });
    expect(storedDraftText()).toBe(typed);
    // pending -> clean (and back) is not a badge the composer shows, so the host does not render for it.
    expect(shellRenders.mock.calls.length - hostRendersBefore).toBe(0);
    await screen.unmount();
  });

  it('keeps typing out of the loaded shell while the draft persists, restores and submits', async () => {
    const screen = await renderScreen();
    expect(screen.tree.findAllByType('AgentInput' as React.ElementType)).toHaveLength(1);

    const first = await typeCharacters(screen, '', 'hello');
    const rendersAfterFirstBurst = shellRenders.mock.calls.length;
    const typed = await typeCharacters(screen, first, ' world, typed');
    expect(shellRenders.mock.calls.length - rendersAfterFirstBurst).toBe(0);
    expect(composerText(findAgentInput(screen))).toBe('hello world, typed');
    expect(storedDraftText()).toBe(typed);

    // An unsent draft restores across a real same-Account mount lifetime.
    await screen.unmount();
    const reopened = await renderScreen();
    expect(composerText(findAgentInput(reopened))).toBe(typed);
    expect(storedDraftText()).toBe(typed);

    // The actual resolver and send path read the restored input, then clear only on acceptance.
    await renderer.act(async () => { findAgentInput(reopened).props.onSend(); });
    await vi.waitFor(() => expect(submittedMessages).toHaveLength(1));
    expect(resolveSessionComposerSendSpy).toHaveBeenCalledWith(expect.objectContaining({ input: typed }));
    expect(submittedMessages[0]).toMatchObject({
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: typed } } },
    });
    await vi.waitFor(() => {
      expect(composerText(findAgentInput(reopened))).toBe('');
      expect(storedDraftText() ?? '').toBe('');
    });
    await reopened.unmount();
  });

  it('edits a real queued submission without rendering the unrelated transcript layout per character', async () => {
    const screen = await renderScreen();
    await typeCharacters(screen, '', 'queued original');
    await renderer.act(async () => { await findAgentInput(screen).props.onSend(); });
    await vi.waitFor(() => expect(submittedMessages).toHaveLength(1));
    await vi.waitFor(() => expect(storage.getState().sessionPending.s1?.messages).toHaveLength(1));
    await vi.waitFor(() => expect(composerText(findAgentInput(screen))).toBe(''));
    const message = storage.getState().sessionPending.s1!.messages[0]!;
    await renderer.act(async () => {
      await screen.tree.findByType(ChatList).props.onEditPendingMessage({ id: message.id, text: message.text, message });
    });
    expect(composerText(findAgentInput(screen))).toBe('queued original');
    const readFrame = () => {
      let node = screen.tree.findAllByType('AgentContentView' as React.ElementType).at(-1)?.parent;
      while (node && !('sessionStatusState' in node.props)) node = node.parent;
      return node?.props ?? {};
    };
    // This boundary refuses plugin describe. Its one establishing→unavailable
    // publication is a real fact change, not work caused by the following edits.
    await vi.waitFor(() => expect(readFrame().sessionPluginRuntime?.phase).toBe('unavailable'));
    const previousFrame = readFrame();
    const previousLayout = screen.tree.findAllByType('AgentContentView' as React.ElementType).at(-1)!.props;
    const edited = await typeCharacters(screen, 'queued original', ' edited');
    expect(composerText(findAgentInput(screen))).toBe(edited);
    expect(storage.getState().sessionPending.s1!.messages[0]!.text).toBe('queued original');
    const frame = readFrame();
    const changed = Object.keys(frame).filter(key => !Object.is(frame[key], previousFrame[key]));
    expect(screen.tree.findAllByType('AgentContentView' as React.ElementType).at(-1)!.props, changed.join(', ')).toBe(previousLayout);
    await screen.unmount();
  });

  it('retains populated composer catalog and model props across host rerenders while Agent, target, readiness and model changes remain fresh', async () => {
    composerInventoryEnabled = true;
    const firstMachineId = 'composer-producer-first';
    const secondMachineId = 'composer-producer-second';
    const firstProjection = createDeferred<typeof composerProjection>();
    const secondProjection = createDeferred<typeof composerProjection>();
    pendingComposerProjections.set(firstMachineId, firstProjection);
    pendingComposerProjections.set(secondMachineId, secondProjection);
    const modelIntent = (modelId: string, updatedAt: number) => SessionModelSelectionIntentV1Schema.parse({
      v: 1, updatedAt,
      selection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId },
    });
    storage.getState().applyMachines([
      createMachineFixture({ id: firstMachineId, activeAt: Date.now(),
        access: createPlainMachineRowFixture({ id: firstMachineId, accountId: 'account-a' }).access }),
      createMachineFixture({ id: secondMachineId, activeAt: Date.now(),
        access: createPlainMachineRowFixture({ id: secondMachineId, accountId: 'account-a' }).access }),
    ], true, { sourceServerId: runtime.serverId });
    const scope = runtime.accountScope;
    if (!scope) throw new Error('Expected the restored fixture Account');
    await publishMachineInventoryForTest(scope, [
      storage.getState().machines[firstMachineId]!, storage.getState().machines[secondMachineId]!,
    ]);
    publishSessionOwnerMetadata(metadata => ({ ...metadata, machineId: firstMachineId,
      modelSelectionIntentV1: modelIntent('producer-first-model', 10) }));
    expect(readSessionOwnerMetadataView(storage.getState().sessions.s1)?.machineId).toBe(firstMachineId);
    const host: SessionComposerRenderer = composer => React.createElement('SessionComposerHost', null, composer.content);
    const screen = await renderCanonicalScreen(surfaceElement(host), { wrapper: runtime.Wrapper });
    const readProducerProps = () => screen.tree.findByType(SessionComposerAgentInput).props as React.ComponentProps<typeof SessionComposerAgentInput>;
    const readModelDetail = () => {
      const content = readProducerProps().modelContentOverride;
      if (!React.isValidElement<{ children: React.ReactNode }>(content)) throw new Error('Expected populated Session model content');
      const detail = React.Children.only(content.props.children);
      if (!React.isValidElement<React.ComponentProps<typeof SessionModelDiscoveryDetail>>(detail)
        || detail.type !== SessionModelDiscoveryDetail) throw new Error('Expected the real deferred model discovery detail');
      return detail;
    };
    try {
      await vi.waitFor(() => expect(composerProjectionRequests).toContain(firstMachineId));
      expect(readProducerProps().agentCatalogIdentity?.current).not.toBe(true);
      await renderer.act(async () => { firstProjection.resolve(composerProjection); });
      await vi.waitFor(() => expect(readProducerProps().agentCatalogIdentity).toMatchObject({
        entry: { identity: BUNDLED_CANONICAL_AGENT_DECLARATIONS.codex?.identity }, machineId: firstMachineId, serverId: runtime.serverId, current: true,
      }));
      expect(readModelDetail().props).toMatchObject({ agentId: 'codex', selectedModelId: 'producer-first-model' });
      const initial = readProducerProps();
      const rendersBefore = shellRenders.mock.calls.length;
      await screen.update(surfaceElement(composer => host(composer)));
      expect(shellRenders.mock.calls.length).toBeGreaterThan(rendersBefore);
      const refreshed = readProducerProps();
      for (const key of ['composerFileScope', 'sessionTypingPresence', 'agentCatalogIdentity', 'modelContentOverride',
        'statusBadges', 'extraActionChips', 'attachmentRowItems'] as const) {
        expect.soft(refreshed[key], key).toBe(initial[key]);
      }

      // A non-name daemon detail replaces the real Machine row, but changes none
      // of this Session's badges (in particular, there is no managed-wake banner).
      const machineBeforeDetail = storage.getState().machines[firstMachineId]!;
      await renderer.act(async () => {
        storage.getState().applyMachines([{ ...machineBeforeDetail,
          metadataVersion: machineBeforeDetail.metadataVersion + 1,
          metadata: { ...machineBeforeDetail.metadata!, happyCliVersion: 'producer-detail-update' },
        }], false, {
          sourceServerId: runtime.serverId,
        });
      });
      const machineAfterDetail = storage.getState().machines[firstMachineId]!;
      expect(machineAfterDetail).not.toBe(machineBeforeDetail);
      expect(getMachineSentenceName(machineAfterDetail)).toBe(getMachineSentenceName(machineBeforeDetail));
      expect(machineAfterDetail.availability).toEqual(machineBeforeDetail.availability);
      expect(readProducerProps().sessionTypingPresence).toEqual(refreshed.sessionTypingPresence);
      expect.soft(readProducerProps().statusBadges, 'Machine detail without a managed-wake badge').toBe(refreshed.statusBadges);

      await renderer.act(async () => {
        publishSessionOwnerMetadata(metadata => ({ ...metadata, modelSelectionIntentV1: modelIntent('producer-next-model', 11) }));
      });
      expect(readModelDetail().props.selectedModelId).toBe('producer-next-model');
      expect(readProducerProps().modelContentOverride).not.toBe(initial.modelContentOverride);

      await renderer.act(async () => {
        publishSessionOwnerMetadata(metadata => ({ ...metadata, machineId: secondMachineId }));
      });
      await vi.waitFor(() => expect(composerProjectionRequests).toContain(secondMachineId));
      expect(readProducerProps().agentCatalogIdentity?.current).not.toBe(true);
      await renderer.act(async () => { secondProjection.resolve(composerProjection); });
      await vi.waitFor(() => expect(readProducerProps().agentCatalogIdentity).toMatchObject({
        machineId: secondMachineId, current: true,
      }));
      expect(readProducerProps().composerFileScope).toMatchObject({ machineId: secondMachineId });
      expect(readModelDetail().props.discovery(settingsDefaults).selectedMachineId).toBe(secondMachineId);
      expect(readProducerProps().statusBadges).toEqual(initial.statusBadges);
      expect(readProducerProps().statusBadges).toBe(initial.statusBadges);

      await renderer.act(async () => {
        publishSessionOwnerMetadata(({ modelSelectionIntentV1: _previousModel, ...metadata }) => ({ ...metadata, flavor: 'claude' }));
      });
      await vi.waitFor(() => expect(readProducerProps().agentCatalogIdentity?.entry.identity).toEqual(BUNDLED_CANONICAL_AGENT_DECLARATIONS.claude?.identity));
      expect(readModelDetail().props.agentId).toBe('claude');
    } finally {
      // Release transport fixtures even if an assertion fails while a request is pending.
      firstProjection.resolve(composerProjection);
      secondProjection.resolve(composerProjection);
      await screen.unmount();
      composerInventoryEnabled = false;
    }
  });

  it('retains unchanged composer producer props across a host rerender while workspace and permission changes remain fresh', async () => {
    const host: SessionComposerRenderer = composer => React.createElement('SessionComposerHost', null, composer.content);
    const screen = await renderCanonicalScreen(surfaceElement(host), { wrapper: runtime.Wrapper });
    const readProducerProps = () => screen.tree.findByType(SessionComposerAgentInput).props as React.ComponentProps<typeof SessionComposerAgentInput>;
    try {
      const initial = readProducerProps();
      expect(initial.composerFileScope).toMatchObject({ serverId: runtime.serverId, machineId: 'm1', rootPath: '/tmp' });
      expect(initial.sessionTypingPresence).toEqual({ serverId: runtime.serverId, canSubmitAgentInput: true });
      expect(initial.extraActionChips?.length).toBeGreaterThan(0);
      expect(initial.attachmentRowItems).toEqual([]);
      expect(Array.isArray(initial.statusBadges)).toBe(true);
      const rendersBefore = shellRenders.mock.calls.length;
      // Same mounted host and source state; only its caller-owned render callback
      // changes so the real loaded controller, not a reconstructed hook, reruns.
      await screen.update(surfaceElement(composer => host(composer)));
      expect(shellRenders.mock.calls.length).toBeGreaterThan(rendersBefore);
      const refreshed = readProducerProps();
      for (const key of ['composerFileScope', 'sessionTypingPresence', 'statusBadges', 'extraActionChips', 'attachmentRowItems', 'statusRegions', 'instrumentQuota', 'connectionStatus', 'inputPersistence'] as const) {
        expect.soft(refreshed[key], key).toBe(initial[key]);
      }
      // The existing input callback still writes to the live draft after the
      // producer descriptors have survived a parent update.
      await renderer.act(async () => { initial.onChangeText?.('retained callback draft'); });
      expect(composerText(findAgentInput(screen))).toBe('retained callback draft');
      expect(storedDraftText()).toBe('retained callback draft');
      await renderer.act(async () => {
        initial.inputPersistence?.onSelectionChangePersist?.({ start: 1, end: 1 }, 'retained callback draft'.length);
      });
      await screen.update(surfaceElement(composer => host(composer)));
      expect(readProducerProps().inputPersistence?.initialSelection).toEqual({ start: 1, end: 1 });

      // Opt-in Action placement is a real presentation input, not draft state.
      const hasReviewShortcut = () => readProducerProps().extraActionChips?.some(chip => chip.key === 'session-action:review.start');
      expect(hasReviewShortcut()).toBe(false);
      await renderer.act(async () => {
        const settings = storage.getState().settings;
        storage.setState({ settings: { ...settings, featureToggles: { ...settings.featureToggles, 'execution.runs': true },
          actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'review.start': { enabledPlacements: ['agent_input_chips'] } } }) } });
      });
      expect.soft(hasReviewShortcut(), 'Action placement activated').toBe(true);
      await renderer.act(async () => {
        storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: settingsDefaults.actionsSettingsV1 } });
      });
      expect.soft(hasReviewShortcut(), 'Action placement withdrawn').toBe(false);

      // Stable descriptors must still refresh copy when a ready locale is activated.
      const linkedFileTitle = () => readProducerProps().extraActionChips
        ?.find(chip => chip.controlId === 'linkedFiles')?.collapsedContentPopover?.title;
      expect(linkedFileTitle()).toBe('common.linkFile');
      await renderer.act(async () => { commitPreferredLanguage('fr'); });
      expect.soft(linkedFileTitle(), 'ready locale activated').toBe('fr:common.linkFile');
      await renderer.act(async () => { commitPreferredLanguage('en'); });

      await renderer.act(async () => {
        publishSessionOwnerMetadata(metadata => ({ ...metadata, path: '/tmp/other-workspace' }));
      });
      expect(readProducerProps().composerFileScope).toMatchObject({ serverId: runtime.serverId, machineId: 'm1', rootPath: '/tmp/other-workspace' });
      expect(readProducerProps().composerFileScope).not.toBe(initial.composerFileScope);
      await renderer.act(async () => {
        const current = storage.getState().sessions.s1;
        storage.getState().applySessions([{ ...current, access: createSessionAccessFixture('view') }]);
      });
      expect(readProducerProps().sessionTypingPresence).toEqual({ serverId: runtime.serverId, canSubmitAgentInput: false });
      expect(readProducerProps().sessionTypingPresence).not.toBe(initial.sessionTypingPresence);
      expect(composerText(findAgentInput(screen))).toBe('retained callback draft');
    } finally {
      await screen.unmount();
    }
  });

  it('retains the composer connection line and restore payload across a host rerender with equal facts', async () => {
    publishSessionOwnerMetadata(metadata => ({ ...metadata,
      sessionGuardStateV1: { v: 1, kind: 'stopping', rule: 'idle_sessions', stopAt: Date.now() + 300_000 } }));
    const host: SessionComposerRenderer = composer => React.createElement('SessionComposerHost', null, composer.content);
    const screen = await renderCanonicalScreen(surfaceElement(host), { wrapper: runtime.Wrapper });
    const readProducerProps = () => screen.tree.findByType(SessionComposerAgentInput).props as React.ComponentProps<typeof SessionComposerAgentInput>;
    try {
      await typeCharacters(screen, '', 'abc');
      await renderer.act(async () => { readProducerProps().inputPersistence?.onSelectionChangePersist?.({ start: 1, end: 1 }, 3); });
      await screen.update(surfaceElement(composer => host(composer)));
      const initial = readProducerProps();
      // The guard's Keep running action rides the connection line.
      expect(initial.connectionStatus?.action?.label).toBe('machineGuard.session.keepRunning');
      await renderer.act(async () => { readProducerProps().inputPersistence?.onSelectionChangePersist?.({ start: 2, end: 2 }, 3); });
      const rendersBefore = shellRenders.mock.calls.length;
      await screen.update(surfaceElement(composer => host(composer)));
      expect(shellRenders.mock.calls.length).toBeGreaterThan(rendersBefore);
      const refreshed = readProducerProps();
      // Equal facts keep the props identical, so the memoized input chrome does not re-render.
      expect.soft(refreshed.connectionStatus, 'connectionStatus').toBe(initial.connectionStatus);
      expect.soft(refreshed.inputPersistence, 'inputPersistence').toBe(initial.inputPersistence);
      // The restore payload still reads the latest persisted selection when a composer mounts.
      expect(refreshed.inputPersistence?.initialSelection).toEqual({ start: 2, end: 2 });
    } finally {
      await screen.unmount();
    }
  });

  it('hosts the same composer contract in the screen or a sheet without copying the draft or send path', async () => {
    let placement = 'SessionComposerHost';
    const models: SessionComposerModel[] = [];
    const renderComposer: SessionComposerRenderer = composer => {
      models.push(composer);
      return React.createElement(placement, null, composer.content);
    };
    const screen = await renderCanonicalScreen(surfaceElement(renderComposer), { wrapper: runtime.Wrapper });
    expect(screen.tree.findAllByType('SessionComposerHost' as React.ElementType)).toHaveLength(1);
    await typeCharacters(screen, '', 'Ask about this selection');
    const before = findAgentInput(screen).props;
    const beforeModel = models.at(-1);
    expect(beforeModel).toBeDefined();

    placement = 'PhoneAskSheetHost';
    await screen.update(surfaceElement(composer => renderComposer(composer)));
    expect(screen.tree.findAllByType('AgentInput' as React.ElementType)).toHaveLength(1);
    expect(screen.tree.findAllByType('PhoneAskSheetHost' as React.ElementType)).toHaveLength(1);
    const inSheet = findAgentInput(screen).props;
    expect(composerText({ props: inSheet })).toBe('Ask about this selection');
    // The host changes; the real controller's handlers and selected agent/model do not.
    for (const key of ['onSend', 'onChangeText', 'onAbort', 'agentType', 'modelMode', 'attachmentRowItems']) {
      expect(before).toHaveProperty(key);
      expect(inSheet[key], key).toEqual(before[key]);
    }
    // Presentation closures may refresh on any render; compare the controls and choices they present.
    const describeChip = (chip: AgentInputExtraActionChip) => ({
      key: chip.key,
      controlId: chip.controlId,
      labelPolicy: chip.labelPolicy,
      title: chip.collapsedOptionsPopover?.title ?? chip.collapsedContentPopover?.title,
      selectedOptionId: chip.collapsedOptionsPopover?.selectedOptionId,
    });
    expect(inSheet.extraActionChips.map(describeChip)).toEqual(before.extraActionChips.map(describeChip));
    expect(models.at(-1)?.ref).toBe(beforeModel?.ref);
    expect(models.at(-1)?.address).toBe(beforeModel?.address);
    expect(models.at(-1)?.focus).toBe(beforeModel?.focus);
    expect(models.at(-1)?.ref).toEqual({ kind: 'session', sessionId: 's1' });
    expect(storedDraftText()).toBe('Ask about this selection');
    await renderer.act(async () => { findAgentInput(screen).props.onSend(); });
    await vi.waitFor(() => expect(submittedMessages).toHaveLength(1));
    expect(submittedMessages[0]).toMatchObject({
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Ask about this selection' } } },
    });
    await vi.waitFor(() => expect(composerText(findAgentInput(screen))).toBe(''));

    placement = 'SessionComposerHost';
    await screen.update(surfaceElement(composer => renderComposer(composer)));
    expect(screen.tree.findAllByType('AgentInput' as React.ElementType)).toHaveLength(1);
    expect(composerText(findAgentInput(screen))).toBe('');
    await screen.unmount();
  });

  it('keeps the composer usable when a web render has no DOM selection source', async () => {
    platformState.os = 'web';
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      const { Platform } = await import('react-native');
      expect(Platform.OS).toBe('web');
      expect(typeof document).toBe('undefined');
      screen = await renderScreen();
      expect(screen.tree.findAllByType('AgentInput' as React.ElementType)).toHaveLength(1);
      await typeCharacters(screen, '', 'A draft without DOM selection');
      expect(composerText(findAgentInput(screen))).toBe('A draft without DOM selection');
    } finally {
      await screen?.unmount();
      platformState.os = 'ios';
    }
  });
});
