import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY,
  CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
  CurrentSessionPresentationAckV1Schema,
  CurrentSessionPresentationActionInputV1Schema,
  CurrentSessionPresentationActionResultV1Schema,
  CurrentSessionPresentationBindV1Schema,
  CurrentSessionPresentationBindResultV1Schema,
  CurrentSessionPresentationStateV1Schema,
  type CurrentSessionPresentationStateV1,
} from '@happier-dev/protocol/sessions/presentation/currentSessionPresentationV1';
import { AccountPetListResponseV1Schema} from '@happier-dev/protocol/pets/accountLibrary';
import { AccountProfileSchema} from '@happier-dev/protocol/account/profile';
import { AutomationDefinitionListResponseSchema} from '@happier-dev/protocol/automations/automationApiV3';
import { createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { CurrentCursorResponseSchema} from '@happier-dev/protocol/changes';
import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentsListActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/utils/platform/responsive', () => ({ useDeviceType: () => 'desktop' }));

const home = createHomeGovernanceHarness();
// The device's transactional record store is an external browser boundary;
// the real Sync pending-outbox bootstrap must finish before mounting its owner.
vi.stubGlobal('indexedDB', new IDBFactory());
installHomeGovernanceBoundaries(home);
const outgoing: SocketRpcRequestPayload[] = [];
let boundClientId = '';
let revision = 0;
let publish: (state: CurrentSessionPresentationStateV1) => void;
let settle: ((value: unknown) => void) | null = null;
let sessionRpcAvailable = true;

// The Home/daemon network is the boundary. Its bounded command and ACK use
// the real mounted UI runtime, exact-address target and viewer reducer below.
installDisconnectedServerSocketBoundary((socket) => {
  configureConnectedServerSocketBoundary(socket);
  vi.spyOn(socket, 'timeout').mockReturnValue(socket);
  vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: SocketRpcRequestPayload) => {
    if (event !== SOCKET_RPC_EVENTS.CALL) return { ok: true };
    outgoing.push(payload);
    const method = payload.method.slice('session-a:'.length);
    if (method === CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD) {
      boundClientId = CurrentSessionPresentationBindV1Schema.parse(payload.params).clientId;
      return { ok: true, result: CurrentSessionPresentationBindResultV1Schema.parse({
        status: 'bound', sessionId: 'session-a', hostNonce: 'viewer-host', revision,
      }) };
    }
    if (method === 'session.presentation.apply') {
      if (!sessionRpcAvailable) return { ok: false, error: 'session_rpc_unavailable', errorCode: 'session_rpc_unavailable' };
      const { intent } = CurrentSessionPresentationActionInputV1Schema.parse(payload.params);
      return await new Promise((resolve) => {
        settle = resolve;
        publish({ v: 1, hostNonce: 'viewer-host', revision: ++revision, statuses: [], widgets: [],
          command: { id: `command-${revision}`, clientId: boundClientId, kind: 'presentation.apply', intent } });
      });
    }
    if (method === CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD) {
      const ack = CurrentSessionPresentationAckV1Schema.parse(payload.params);
      const result = ack.result;
      settle?.({ ok: true, result: CurrentSessionPresentationActionResultV1Schema.parse({
        ...result, revision: `viewer-host:${revision}`,
      }) });
      settle = null;
      publish({ v: 1, hostNonce: 'viewer-host', revision: ++revision, statuses: [], widgets: [] });
    }
    return { ok: true, result: { status: 'accepted' } };
  });
});

const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { storage } = await import('@/sync/domains/state/storage');
const { loadAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { FeedResponseSchema } = await import('@/sync/domains/social/feedTypes');
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
const { flushHookEffects } = await import('@/dev/testkit/hooks/flushHookEffects');
const { standardCleanup } = await import('@/dev/testkit/cleanup/standardCleanup');
const { CurrentSessionPresentationRuntime } = await import('../presentation/CurrentSessionPresentationRuntime');
const { registerSessionPresentationOnlyTarget } = await import('../presentation/sessionComposerPresentationTargets');
const { setFocusedSessionId, resetSessionSurfaceVisibilityForTests } = await import('@/sync/domains/session/sessionSurfaceVisibility');
const { useOptionalSessionViewerController } = await import('./SessionViewerController');
const { SessionViewerScope } = await import('./SessionViewerScope');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
const { useOpenSessionComputerScreen } = await import('@/components/computer/useOpenSessionComputerScreen');
const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
const initialState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let boundarySnapshot: unknown;

describe('Session viewer semantic Action ingress', () => {
  beforeEach(async () => { await home.reset(); outgoing.length = 0; boundClientId = ''; revision = 0; settle = null; sessionRpcAvailable = true; });
  afterEach(async () => {
    // Failure hooks run after teardown; retain the observed live owner first.
    boundarySnapshot = {
      boundClientId, pendingRpc: settle !== null, methods: outgoing.map((packet) => packet.method),
      session: storage.getState().sessions['session-a'], profileScope: storage.getState().profileScope,
      profileId: storage.getState().profile.id, isDataReady: storage.getState().isDataReady,
      requests: home.requests.map((request) => request.path),
    };
    standardCleanup(); await connection?.dispose(); connection = null;
    resetSessionSurfaceVisibilityForTests(); storage.setState(initialState, true); vi.restoreAllMocks();
  });

  it('applies all five semantic Actions through the exact bound mounted owner and keeps geometry local', async () => {
    let stage = 'Home restoration';
    onTestFailed(() => console.error('Viewer Action boundary failure', JSON.stringify({ stage, boundarySnapshot })));
    const serverId = await home.addHome({ name: 'Viewer Home', serverUrl: 'https://viewer-action.test', accountId: 'alice' });
    const token = home.findByServerUrl('https://viewer-action.test')!.token!;
    let serverPresentation: CurrentSessionPresentationStateV1 = { v: 1, hostNonce: 'viewer-host', revision: 0, statuses: [], widgets: [] };
    const ownerMetadata = createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({
      v: 1, workspace: { path: '/viewer/project', machineId: 'machine-1' },
    }));
    const sessionsAnswer = () => ({ body: createSessionListSourceFixture({
      sessions: [{ id: 'session-a', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        encryptionMode: 'plain', metadataLayoutVersion: 1, metadataVersion: 1,
        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: {} })), ownerMetadata,
        agentState: JSON.stringify({ [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: serverPresentation }),
        agentStateVersion: serverPresentation.revision + 1, dataEncryptionKey: null, share: null }],
      nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
    }) });
    // HTTP refresh and the live AgentState stream must describe the same Home
    // Session; otherwise the real Sync correctly retires a storage-only fixture.
    home.answer(serverId, '/v2/sessions/active?limit=500', { select: sessionsAnswer });
    home.answer(serverId, '/v2/sessions?includeAttention=true&limit=50', { select: sessionsAnswer });
    home.answer(serverId, '/v2/sessions/metadata-upgrades', { body: { sessionIds: [] } });
    home.answer(serverId, '/v1/account/profile', { body: AccountProfileSchema.parse({ ...profileDefaults, id: 'alice' }) });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    home.answer(serverId, '/v2/cursor', { body: CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }) });
    home.answer(serverId, '/v1/kv?prefix=todo.&limit=1000', { body: { items: [] } });
    home.answer(serverId, '/v1/machines', { body: [] });
    home.answer(serverId, '/v1/account/pets', { body: AccountPetListResponseV1Schema.parse({ ok: true, pets: [] }) });
    home.answer(serverId, '/v1/feed?limit=100', { body: FeedResponseSchema.parse({ items: [], hasMore: false }) });
    home.answer(serverId, '/v3/automations?limit=100', { body: AutomationDefinitionListResponseSchema.parse({ automations: [], nextCursor: null }) });
    home.answer(serverId, `POST ${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']}`, {
      body: PluginAvailabilityIntentsListActionOutputV1Schema.parse({
        availabilityCursor: 0, pluginIds: [], intentReads: [], failedPluginIds: [],
      }),
    });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://viewer-action.test', accountId: 'alice', credentials: { token },
      request: (url, init) => home.request(url, init) });
    stage = 'real Account bootstrap';
    await waitForHomeGovernance(() => {
      expect(storage.getState().profileScope?.accountId).toBe('alice');
      expect(storage.getState().profile.id).toBe('alice');
      expect(storage.getState().isDataReady).toBe(true);
    });
    publish = (state) => {
      serverPresentation = CurrentSessionPresentationStateV1Schema.parse(state);
      storage.setState((current) => ({ sessions: { ...current.sessions,
        'session-a': createSessionFixture({ ...current.sessions['session-a'], id: 'session-a', serverId, active: true,
          agentStateVersion: state.revision + 1, agentState: { [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: state } }),
      } }));
    };
    publish(serverPresentation);
    setFocusedSessionId('session-a', serverId);
    const onlineMachine = createMachineFixture({ id: 'machine-1', active: true, activeAt: Date.now() });
    storage.getState().applyMachines([onlineMachine], true, { sourceServerId: serverId });
    observeMachinePresenceForTest({ serverId, accountId: 'alice' }, ['machine-1']);
    const ingress: {
      pane: ReturnType<typeof useAppPaneScope> | null;
      openFromWatch: ReturnType<typeof useOpenSessionComputerScreen>;
    } = { pane: null, openFromWatch: null };
    function IngressProbe() {
      ingress.pane = useAppPaneScope(createSessionPaneScopeId('session-a', serverId));
      ingress.openFromWatch = useOpenSessionComputerScreen({ sessionId: 'session-a', serverId });
      return null;
    }
    function Wrapper(props: React.PropsWithChildren) {
      return <AppPaneProvider><SessionViewerScope sessionId="session-a" serverId={serverId}>
        <CurrentSessionPresentationRuntime />
        <IngressProbe />
        {props.children}
      </SessionViewerScope></AppPaneProvider>;
    }
    stage = 'mounted owner';
    const hook = await renderHook(() => useOptionalSessionViewerController()!, { wrapper: Wrapper });
    const unregister = registerSessionPresentationOnlyTarget({ sessionId: 'session-a', serverId }, {
      isCurrent: () => true, applySessionPresentationIntent: (intent) => {
        switch (intent.kind) {
          case 'viewer.open': case 'viewer.close': case 'viewer.source.select': case 'viewer.expand': case 'viewer.restore':
            return hook.getCurrent().port.apply(intent);
          default: return { status: 'unavailable' };
        }
      },
    });
    let unmounted = false;
    const pressHeader = async () => {
      // The header's ⋯ Computer entry and the rail's launcher call the one opener.
      await act(async () => { ingress.openFromWatch?.open(); });
      await flushHookEffects();
    };
    const setPresentationPolicy = async (enabled: boolean) => {
      const current = storage.getState();
      const scope = current.settingsScope;
      if (!scope) throw new Error('Expected mounted Account settings scope');
      const settings = { ...current.settings,
        actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { 'session.presentation.apply': { enabled } } }),
      };
      const version = (loadAccountSettings(scope).version ?? 0) + 1;
      home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version } });
      await act(async () => current.applySettingsForScope(scope, settings, version));
    };
    try {
      stage = 'exact binding';
      await waitForHomeGovernance(() => expect(boundClientId).not.toBe(''));
      stage = 'offline header disabled policy';
      await setPresentationPolicy(false);
      await pressHeader();
      expect(hook.getCurrent().state.mode).toBe('closed');
      expect(await hook.getCurrent().requestSemantic({ kind: 'viewer.open', source: 'computer' })).toMatchObject({ ok: false });
      await setPresentationPolicy(true);
      const execute = createDefaultActionExecutor();
      stage = 'literal Action command/ACK';
      let admitted!: ActionExecuteResult;
      await act(async () => { admitted = await execute.execute('session.presentation.apply', {
        intent: { kind: 'viewer.open', source: 'computer' },
      }, { surface: 'ui', serverId, defaultSessionId: 'session-a' }); });
      const admittedStatus = admitted.ok
        ? admitted.result && typeof admitted.result === 'object' && 'status' in admitted.result ? admitted.result.status : null
        : admitted.errorCode;
      expect(admittedStatus, JSON.stringify(admitted)).toBe('applied');
      await act(async () => { await hook.getCurrent().port.apply({ kind: 'viewer.close' }); });
      for (const [intent, expected] of [
        [{ kind: 'viewer.open', source: 'computer' }, { mode: 'floating', source: 'computer' }],
        [{ kind: 'viewer.source.select', source: 'browser' }, { mode: 'floating', source: 'browser' }],
        [{ kind: 'viewer.expand' }, { mode: 'expanded', source: 'browser' }],
        [{ kind: 'viewer.restore' }, { mode: 'floating', source: 'browser' }],
        [{ kind: 'viewer.close' }, { mode: 'closed' }],
      ] as const) {
        stage = intent.kind;
        let result!: ActionExecuteResult;
        await act(async () => { result = await hook.getCurrent().requestSemantic(intent); });
        expect(result.ok && CurrentSessionPresentationActionResultV1Schema.parse(result.result), JSON.stringify(result)).toMatchObject({ status: 'applied' });
        expect(hook.getCurrent().state).toMatchObject(expected);
      }
      const count = outgoing.filter((packet) => packet.method === 'session-a:session.presentation.apply').length;
      stage = 'repeated semantic open';
      await act(async () => { await hook.getCurrent().requestSemantic({ kind: 'viewer.open', source: 'browser' }); });
      expect(hook.getCurrent().state).toMatchObject({ mode: 'floating', source: 'browser' });
      stage = 'reachable Machine header';
      await act(async () => { storage.setState({
        machines: { 'machine-1': onlineMachine }, machineListByServerId: { [serverId]: [onlineMachine] },
      }); });
      await pressHeader();
      await waitForHomeGovernance(() => expect(hook.getCurrent().state).toMatchObject({ mode: 'floating', source: 'computer' }));
      const afterUiOpen = count;
      await act(async () => { await hook.getCurrent().requestSemantic({ kind: 'viewer.open', source: 'browser' }); });
      await act(async () => { await hook.getCurrent().apply({ kind: 'viewer.dock' }); });
      expect(hook.getCurrent().state.mode).toBe('docked');
      expect(ingress.pane!.scopeState!.details.isOpen).toBe(false);
      stage = 'docked header source handoff';
      await pressHeader();
      expect(hook.getCurrent().state).toMatchObject({ mode: 'docked', source: 'computer' });
      expect(ingress.pane!.scopeState!.details.isOpen).toBe(true);
      stage = 'docked semantic Browser source handoff';
      await act(async () => { await hook.getCurrent().requestSemantic({ kind: 'viewer.source.select', source: 'browser' }); });
      expect(ingress.pane!.scopeState!.right).toMatchObject({ isOpen: true, activeTabId: 'browser' });
      await act(async () => { ingress.pane!.closeDetails(); });
      stage = 'docked transcript Watch source handoff';
      expect(ingress.openFromWatch?.open).toBeTypeOf('function');
      await act(async () => { ingress.openFromWatch!.open(); });
      await waitForHomeGovernance(() => expect(hook.getCurrent().state).toMatchObject({ mode: 'docked', source: 'computer' }));
      expect(ingress.pane!.scopeState!.details.isOpen).toBe(true);
      expect(outgoing.filter((packet) => packet.method === 'session-a:session.presentation.apply')).toHaveLength(afterUiOpen);
      stage = 'Ask policy';
      await home.requireUiApproval(serverId, 'session.presentation.apply');
      const deferred = await hook.getCurrent().requestSemantic({ kind: 'viewer.close' });
      expect(deferred, JSON.stringify(deferred)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(hook.getCurrent().state.mode).toBe('docked');
      expect(outgoing.filter((packet) => packet.method === 'session-a:session.presentation.apply')).toHaveLength(afterUiOpen);
      if (!deferred.ok || !deferred.result || typeof deferred.result !== 'object'
        || !('artifactId' in deferred.result) || typeof deferred.result.artifactId !== 'string') {
        throw new Error('Expected the canonical pending approval Artifact');
      }
      for (const surface of ['api', 'plugin'] as const) {
        stage = `${surface} refusal`;
        const refused = await execute.execute('approval.request.decide', {
          artifactId: deferred.result.artifactId, decision: 'approve',
        }, { surface, serverId, authority: 'present_user', defaultSessionId: 'session-a' });
        expect(refused).toMatchObject({ ok: false });
        expect(hook.getCurrent().state.mode).toBe('docked');
        expect(outgoing.filter((packet) => packet.method === 'session-a:session.presentation.apply')).toHaveLength(afterUiOpen);
      }
      stage = 'trusted UI approval replay';
      const artifactId = deferred.result.artifactId;
      let approved!: ActionExecuteResult;
      await act(async () => { approved = await execute.execute('approval.request.decide', {
        artifactId, decision: 'approve',
      }, { surface: 'ui', serverId, defaultSessionId: 'caller-claimed-other-session' }); });
      expect(approved).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(hook.getCurrent().state.mode).toBe('closed');
      const afterApproval = afterUiOpen + 1;
      expect(outgoing.filter((packet) => packet.method === 'session-a:session.presentation.apply')).toHaveLength(afterApproval);

      stage = 'offline header Ask policy';
      sessionRpcAvailable = false;
      const offlineMachine = createMachineFixture({ id: 'machine-1', active: false });
      await act(async () => { storage.setState({
        machines: { 'machine-1': offlineMachine }, machineListByServerId: { [serverId]: [offlineMachine] },
      }); });
      const artifactsBefore = home.requestsFor('/v1/artifacts').length;
      // An offline Machine keeps the launcher, disabled with its presence reason.
      expect(ingress.openFromWatch?.disabledReason).toEqual(expect.any(String));
      await pressHeader();
      expect(hook.getCurrent().state.mode).toBe('closed');
      expect(home.requestsFor('/v1/artifacts')).toHaveLength(artifactsBefore);
      // Launcher availability does not replace the already-mounted viewer's semantic authority.
      await act(async () => { await hook.getCurrent().requestSemantic({ kind: 'viewer.open', source: 'computer' }); });
      await waitForHomeGovernance(() => expect(home.requestsFor('/v1/artifacts').length).toBeGreaterThan(artifactsBefore));
      expect(outgoing.filter((packet) => packet.method === 'session-a:session.presentation.apply')).toHaveLength(afterApproval);

      stage = 'offline viewer open and Close without Session RPC';
      await setPresentationPolicy(true);
      await act(async () => { await hook.getCurrent().requestSemantic({ kind: 'viewer.open', source: 'computer' }); });
      await waitForHomeGovernance(() => expect(hook.getCurrent().state).toMatchObject({ mode: 'floating', source: 'computer' }));
      let closed!: ActionExecuteResult;
      await act(async () => { closed = await hook.getCurrent().requestSemantic({ kind: 'viewer.close' }); });
      expect(closed.ok && CurrentSessionPresentationActionResultV1Schema.parse(closed.result)).toMatchObject({ status: 'applied' });
      expect(hook.getCurrent().state.mode).toBe('closed');
      expect(outgoing.filter((packet) => packet.method === 'session-a:session.presentation.apply')).toHaveLength(afterApproval);
      const retiredRequest = hook.getCurrent().requestSemantic;
      unregister(); await hook.unmount(); unmounted = true;
      await expect(retiredRequest({ kind: 'viewer.close' })).resolves.toMatchObject({
        ok: false, errorCode: 'current_session_presentation_not_current',
      });
      expect(outgoing.filter((packet) => packet.method === 'session-a:session.presentation.apply')).toHaveLength(afterApproval);
    } finally {
      unregister(); if (!unmounted) await hook.unmount(); await connection?.dispose(); connection = null;
    }
  });
});
