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
import { AccountPetListResponseV1Schema, AccountProfileSchema, AutomationDefinitionListResponseSchema, createPlainSessionOwnerMetadataEnvelopeV1, CurrentCursorResponseSchema, projectSessionSharedMetadataV1, SessionOwnerMetadataV1Schema, V2SessionListResponseSchema } from '@happier-dev/protocol';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentsListActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

const actionModuleLoader = vi.hoisted(() => ({
  createDefaultExecutor: null as typeof import('@/sync/ops/actions/defaultActionExecutor').createDefaultActionExecutor | null,
}));
// Metro's call-time require is a module-loading boundary absent in Vitest.
// Supply the actual loaded executor through the original factory's supported
// injection port; no executor, policy, replay or mounted runtime is replaced.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  return { ...actual, createFrontDoorActionExecute: (
    executor?: Parameters<typeof actual.createFrontDoorActionExecute>[0],
    options?: Parameters<typeof actual.createFrontDoorActionExecute>[1],
  ) => actual.createFrontDoorActionExecute(executor ?? actionModuleLoader.createDefaultExecutor?.(options), options) };
});

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

// The Home/daemon network is the boundary. Its bounded command and ACK use
// the real mounted UI runtime, exact-address target and viewer reducer below.
installDisconnectedServerSocketBoundary((socket) => {
  socket.connected = true;
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
actionModuleLoader.createDefaultExecutor = createDefaultActionExecutor;
const { storage } = await import('@/sync/domains/state/storage');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { FeedResponseSchema } = await import('@/sync/domains/social/feedTypes');
const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
const { standardCleanup } = await import('@/dev/testkit/cleanup/standardCleanup');
const { CurrentSessionPresentationRuntime } = await import('../presentation/CurrentSessionPresentationRuntime');
const { registerSessionPresentationOnlyTarget } = await import('../presentation/sessionComposerPresentationTargets');
const { setFocusedSessionId, resetSessionSurfaceVisibilityForTests } = await import('@/sync/domains/session/sessionSurfaceVisibility');
const { useOptionalSessionViewerController } = await import('./SessionViewerController');
const { SessionViewerControllerProvider } = await import('./SessionViewerControllerProvider');
const initialState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let boundarySnapshot: unknown;

describe('Session viewer semantic Action ingress', () => {
  beforeEach(async () => { await home.reset(); outgoing.length = 0; boundClientId = ''; revision = 0; settle = null; });
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
    const sessionsAnswer = () => ({ body: V2SessionListResponseSchema.parse({
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
    const request = createServerFetchAtEndpoint({ endpointUrl: 'https://viewer-action.test', credentials: { token } });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://viewer-action.test', accountId: 'alice', credentials: { token },
      request: (url, init) => request(String(url), init) });
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
    function Wrapper(props: React.PropsWithChildren) {
      return <SessionViewerControllerProvider sessionId="session-a" serverId={serverId} phone={false} canPresentSource={() => true} openDocked={() => undefined}>
        <CurrentSessionPresentationRuntime />{props.children}
      </SessionViewerControllerProvider>;
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
    try {
      stage = 'exact binding';
      await waitForHomeGovernance(() => expect(boundClientId).not.toBe(''));
      const execute = createDefaultActionExecutor();
      stage = 'literal Action command/ACK';
      const admitted = await act(async () => execute.execute('session.presentation.apply', {
        intent: { kind: 'viewer.open', source: 'computer' },
      }, { surface: 'ui', serverId, defaultSessionId: 'session-a' }));
      const admittedStatus = admitted.ok
        ? admitted.result && typeof admitted.result === 'object' && 'status' in admitted.result ? admitted.result.status : null
        : admitted.errorCode;
      expect(admittedStatus, JSON.stringify(admitted)).toBe('applied');
      await act(async () => hook.getCurrent().port.apply({ kind: 'viewer.close' }));
      for (const [intent, expected] of [
        [{ kind: 'viewer.open', source: 'computer' }, { mode: 'floating', source: 'computer' }],
        [{ kind: 'viewer.source.select', source: 'browser' }, { mode: 'floating', source: 'browser' }],
        [{ kind: 'viewer.expand' }, { mode: 'expanded', source: 'browser' }],
        [{ kind: 'viewer.restore' }, { mode: 'floating', source: 'browser' }],
        [{ kind: 'viewer.close' }, { mode: 'closed' }],
      ] as const) {
        stage = intent.kind;
        const result = await act(async () => hook.getCurrent().requestSemantic(intent));
        expect(result).toMatchObject({ ok: true, result: { status: 'applied' } });
        expect(hook.getCurrent().state).toMatchObject(expected);
      }
      const count = outgoing.filter((packet) => packet.method === 'session-a:session.presentation.apply').length;
      stage = 'repeated semantic open';
      await act(async () => hook.getCurrent().requestSemantic({ kind: 'viewer.open', source: 'browser' }));
      expect(hook.getCurrent().state).toMatchObject({ mode: 'floating', source: 'browser' });
      const afterUiOpen = count + 1;
      await act(async () => hook.getCurrent().apply({ kind: 'viewer.dock' }));
      expect(hook.getCurrent().state.mode).toBe('docked');
      expect(outgoing.filter((packet) => packet.method === 'session-a:session.presentation.apply')).toHaveLength(afterUiOpen);
      stage = 'Ask policy';
      await home.requireUiApproval(serverId, 'session.presentation.apply');
      const deferred = await hook.getCurrent().requestSemantic({ kind: 'viewer.close' });
      expect(deferred).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
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
      const approved = await act(async () => execute.execute('approval.request.decide', {
        artifactId: deferred.result.artifactId, decision: 'approve',
      }, { surface: 'ui', serverId, defaultSessionId: 'caller-claimed-other-session' }));
      expect(approved).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(hook.getCurrent().state.mode).toBe('closed');
      const afterApproval = afterUiOpen + 1;
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
