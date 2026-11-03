import 'fake-indexeddb/auto';
import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen as renderCanonicalScreen } from '@/dev/testkit/render/renderScreen';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createPlainMachineReadHttpResponseFixture, createReadyMachineAgentInventoryFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { PendingRequestedActionV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { PENDING_INPUT_PROTOCOL_VERSION_V3 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { MINIMUM_CLI_PENDING_QUEUE_V2_VERSION } from '@/utils/system/versionUtils';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { SessionModelSelectionIntentV1Schema } from '@happier-dev/protocol/providers/selection/v1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
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
  AgentContentView: (props: { input?: React.ReactNode }) => React.createElement('AgentContentView', props, props.input),
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({ ChatHeaderView: () => null }));
vi.mock('@/components/sessions/transcript/ChatList', () => ({ ChatList: () => null }));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({ EmptyMessages: () => null }));
vi.mock('@/components/ui/forms/Deferred', () => ({
  Deferred: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
}));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({ SessionHeaderActionMenu: () => null }));
vi.mock('@/components/voice/surface/VoiceSurface', () => ({ VoiceSurface: () => null }));
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
const pendingComposerProjections = new Map<string, ReturnType<typeof createDeferred<typeof composerProjection>>>();
const runtime = installSessionPaneRuntimeTestHarness({
  features: () => {
    const features = createRootLayoutFeaturesResponse();
    features.capabilities.session.pendingInput = { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V3 };
    return features;
  },
  rpc: async (method, _input, targetId) => {
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
const { SessionView } = await import('./SessionView');
const { SessionComposerAgentInput } = await import('@/components/sessions/composer/SessionComposerAgentInput');
const { SessionModelDiscoveryDetail } = await import('@/components/sessions/modelPicker/SessionModelDiscoveryDetail');
const { getSessionComposerDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
await loadSyncSingletonForTests();
const { sync } = await import('@/sync/sync');

function surfaceElement(renderComposer?: SessionComposerRenderer) {
  return <SessionView id="s1" routeServerId={runtime.serverId} surfaceFocusedOverride surfaceVisibleOverride
    {...(renderComposer ? { renderComposer } : {})} />;
}

function renderScreen() {
  return renderCanonicalScreen(surfaceElement(), { wrapper: runtime.Wrapper });
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
  }]);
}

describe('SessionView composer typing', () => {
  beforeEach(async () => {
    commitPreferredLanguage('en');
    platformState.os = 'ios';
    submittedMessages.length = 0;
    composerInventoryEnabled = false;
    composerProjectionRequests.length = 0;
    pendingComposerProjections.clear();
    resolveSessionComposerSendSpy.mockClear();
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
    storage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: Date.now() })], true, {
      sourceServerId: runtime.serverId,
    });
    expect((await sync.ensureSessionVisibleForMessageRoute('s1', {
      serverId: runtime.serverId, forceRefresh: true, hydrateMessages: false,
    })).kind).toBe('available');
  });

  it('opens a retained Custom ACP Session without offering a model picker for its abstract Agent', async () => {
    publishSessionOwnerMetadata(metadata => ({ ...metadata, flavor: 'custom-acp' }));
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

  it('keeps typing out of the loaded shell while the draft persists, restores and submits', async () => {
    const screen = await renderScreen();
    expect(screen.tree.findAllByType('AgentInput' as React.ElementType)).toHaveLength(1);

    const first = await typeCharacters(screen, '', 'hello');
    const rendersAfterFirstBurst = shellRenders.mock.calls.length;
    const typed = await typeCharacters(screen, first, ' world, typed');
    expect(shellRenders.mock.calls.length - rendersAfterFirstBurst).toBe(0);
    expect(findAgentInput(screen).props.value).toBe('hello world, typed');
    expect(storedDraftText()).toBe(typed);

    // An unsent draft restores across a real same-Account mount lifetime.
    await screen.unmount();
    const reopened = await renderScreen();
    expect(findAgentInput(reopened).props.value).toBe(typed);
    expect(storedDraftText()).toBe(typed);

    // The actual resolver and send path read the restored input, then clear only on acceptance.
    await renderer.act(async () => { findAgentInput(reopened).props.onSend(); });
    await vi.waitFor(() => expect(submittedMessages).toHaveLength(1));
    expect(resolveSessionComposerSendSpy).toHaveBeenCalledWith(expect.objectContaining({ input: typed }));
    expect(submittedMessages[0]).toMatchObject({
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: typed } } },
    });
    await vi.waitFor(() => {
      expect(findAgentInput(reopened).props.value).toBe('');
      expect(storedDraftText() ?? '').toBe('');
    });
    await reopened.unmount();
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
      createMachineFixture({ id: firstMachineId, activeAt: Date.now() }),
      createMachineFixture({ id: secondMachineId, activeAt: Date.now() }),
    ], true, { sourceServerId: runtime.serverId });
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
      for (const key of ['composerFileScope', 'sessionTypingPresence', 'statusBadges', 'extraActionChips', 'attachmentRowItems'] as const) {
        expect.soft(refreshed[key], key).toBe(initial[key]);
      }
      // The existing input callback still writes to the live draft after the
      // producer descriptors have survived a parent update.
      await renderer.act(async () => { initial.onChangeText?.('retained callback draft'); });
      expect(findAgentInput(screen).props.value).toBe('retained callback draft');
      expect(storedDraftText()).toBe('retained callback draft');
      await renderer.act(async () => {
        initial.inputPersistence?.onSelectionChangePersist?.({ start: 1, end: 1 }, 'retained callback draft'.length);
      });
      await screen.update(surfaceElement(composer => host(composer)));
      expect(readProducerProps().inputPersistence?.initialSelection).toEqual({ start: 1, end: 1 });
      expect.soft(readProducerProps().inputExpansion, 'selection does not replace expansion controls').toBe(initial.inputExpansion);

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
      expect(findAgentInput(screen).props.value).toBe('retained callback draft');
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
    expect(inSheet.value).toBe('Ask about this selection');
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
    await vi.waitFor(() => expect(findAgentInput(screen).props.value).toBe(''));

    placement = 'SessionComposerHost';
    await screen.update(surfaceElement(composer => renderComposer(composer)));
    expect(screen.tree.findAllByType('AgentInput' as React.ElementType)).toHaveLength(1);
    expect(findAgentInput(screen).props.value).toBe('');
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
      expect(findAgentInput(screen).props.value).toBe('A draft without DOM selection');
    } finally {
      await screen?.unmount();
      platformState.os = 'ios';
    }
  });
});
