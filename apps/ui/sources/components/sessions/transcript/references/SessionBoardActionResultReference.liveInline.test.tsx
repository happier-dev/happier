import * as React from 'react';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ApprovalRequestV2Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1} from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { SessionSystemRecordStoredSchema, type SessionSystemRecordStored } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { tryWriteServerEnabledBitInPlace} from '@happier-dev/protocol/features/serverEnabledBit';
import { SessionBoardMutationV1Schema, SessionBoardMutationResultV1Schema } from '@happier-dev/protocol/sessions/board';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { SessionEffectiveAccessV1Schema } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';

import { createTestSessionTranscriptSource, flushHookEffects, makeToolCall, renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createSessionSystemRecordHttpFixture,
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SessionBoardContinuityProvider } from '@/components/sessions/board/SessionBoardContinuity';
import { SessionBoardControllerOwner, SessionBoardControllerProvider, useMountedSessionBoardController } from '@/components/sessions/board/SessionBoardControllerProvider';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { useSessionCallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/useSessionCallerHostedHtmlRuntime';
import {
  createSessionBoardActionsPort,
  projectSessionBoard,
} from '@/sync/domains/session/board';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { BrowserFrameEngineConfig } from '@/components/browser/frame/types';

import { SessionBoardActionResultReference } from './SessionBoardActionResultReference';
import { loadPluginUiHostSupport } from '@/components/plugins/hostApi/loadPluginUiHostSupport';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storage';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { SessionCompanionPresentationBridge, type SessionPresentationIntentApplier } from '@/components/sessions/companion/presentation/SessionCompanionPresentationBridge';
import { SessionCompanionRevealPortProvider } from '@/components/sessions/companion/presentation/SessionCompanionRevealPort';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { ToolView } from '@/components/tools/shell/views/ToolView';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { createTranscriptRendererContentDemand, TranscriptRendererContentDemandProvider, TranscriptRendererRowContentDemandProvider } from '@/components/sessions/transcript/viewport/visibility/TranscriptRowContentDemand';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { TranscriptRowSeqProvider } from '@/components/sessions/transcript/attribution/SessionTranscriptAgentAttributionContext';

vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ confirmResult: true }).module;
});
// The physical browser frame is the only substituted boundary: transcript demand, the
// controller, primary-mount resolution, the widget host and the hosted adapter stay real.
const frames = vi.hoisted(() => ({ active: 0, maximum: 0 }));
vi.mock('@/components/browser/frame/BrowserViewFrame.web', () => ({
  BrowserViewFrame: (props: Readonly<{ engine: BrowserFrameEngineConfig }>) => {
    const [document] = React.useState(() => ({}));
    // An unavailable/error renderer is not a live HTML body.
    expect(props.engine).toMatchObject({ kind: 'webIframe', html: expect.any(String) });
    React.useEffect(() => {
      frames.active += 1;
      frames.maximum = Math.max(frames.maximum, frames.active);
      return () => {
        frames.active -= 1;
      };
    }, []);
    return React.createElement('BrowserViewFrame', { document });
  },
}));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');

const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
// The shell's renderer-presence answer: this client can mount caller HTML.
const available = () => ({ kind: 'available' as const });
const pluginRuntime = {
  pluginUiProjection: null,
  pluginBrowserProjection: null,
  phase: 'unavailable' as const,
  interactionEnabled: false,
  machineId: null,
  accountLifetime: null,
  serverId: 'unused',
  platform: 'web' as const,
};
// A desktop shell with no Board host on screen: Details closed, no Board sidebar, no Companion rail.
async function prepare(height: Readonly<Record<string, string>>, viewer: 'owner' | 'view' = 'view') {
  // Await the real physical frame's cold generated module outside mount assertions.
  await import('@/components/plugins/hostedWeb/guestBootstrap.generated');
  // The browser's Location is the platform boundary; runtime admission and its request controller stay real.
  vi.stubGlobal('location', { origin: 'https://app.example.test', href: 'https://app.example.test/' });
  const item = {
    v: 1,
    destination: 'transcript',
    title: 'Experiment',
    frame: 'frameless',
    height,
    source: {
      kind: 'hostedHtml',
      source: artifactHtmlBundleFromBodyV1('<main>Live result</main>'),
    },
  };
  const record = SessionSystemRecordStoredSchema.parse({
    id: 'visual-record',
    address: {
      owner: 'host',
      namespace: 'surface',
      kind: 'item.v1',
      localId: 'visual',
    },
    content: { t: 'plain', v: item },
    revision,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  });
  const records: SessionSystemRecordStored[] = [SessionSystemRecordStoredSchema.parse({
    ...record, id: 'layout-record', address: { ...record.address, kind: 'layout.v1', localId: 'layout' },
    content: { t: 'plain', v: { v: 1, tabs: [{ id: 'view-a', title: 'A', items: [] }] } },
  })];
  const boundary = {
    sessionId: 'session-1',
    records,
    effectiveAccess: SessionEffectiveAccessV1Schema.parse({
      v: 1,
      level: 'owner',
      sources: [{ kind: 'owner' }],
      capabilities: projectSessionAccessCapabilitiesV1({
        owner: true,
        grants: [],
      }),
    }),
  };
  const fixture = createSessionSystemRecordHttpFixture(boundary);
  const mutations: Array<ReturnType<typeof SessionBoardMutationV1Schema.parse>> = [];
  // Board inventory reads (the host list route), as distinct from a reply's exact item read.
  const listReads: string[] = [];
  // The exact Session's by-id read; a test may make it fail transiently after the reply loaded.
  const sessionReads = { count: 0, fail: false };
  const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'reader', encryptionMode: 'plain' });
  const features = createRootLayoutFeaturesResponse();
  if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Missing Board feature declaration');
  const connection = await restoreServerAccountForTest({
    serverUrl: 'https://inline-live.test',
    serverIdentityId: 'srv_inline-live',
    accountId: 'reader',
    request: createSessionReadBatchFetchBoundary(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
      if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
      if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (new URL(String(url)).pathname === '/v2/sessions/session-1/board' && init?.method === 'PUT') {
        const mutation = SessionBoardMutationV1Schema.parse(JSON.parse(String(init.body)));
        mutations.push(mutation);
        if (mutation.operation === 'remove_item') {
          records.splice(records.findIndex(row => row.address.kind === 'item.v1' && row.address.localId === mutation.itemId), 1);
          return Response.json(SessionBoardMutationResultV1Schema.parse({ operation: mutation.operation,
            itemId: mutation.itemId, outcome: 'removed' }));
        }
        if (mutation.operation === 'update_layout') {
          const layoutIndex = records.findIndex(row => row.address.kind === 'layout.v1');
          records[layoutIndex] = SessionSystemRecordStoredSchema.parse({ ...records[layoutIndex], content: mutation.layoutContent });
          return Response.json(SessionBoardMutationResultV1Schema.parse({ operation: mutation.operation,
            outcome: 'updated', layoutRevision: record.revision }));
        }
        if (mutation.operation !== 'upsert_item') throw new Error('Expected the visual publication mutation');
        records.push(SessionSystemRecordStoredSchema.parse({ ...record, content: mutation.itemContent }));
        return Response.json(SessionBoardMutationResultV1Schema.parse({ operation: mutation.operation,
          itemId: mutation.itemId, outcome: 'created', itemRevision: record.revision }));
      }
      if (path.endsWith('/turns')) return Response.json({ error: 'not_found' }, { status: 404 });
      if (path === '/v2/sessions/session-1' && (init?.method ?? 'GET') === 'GET') {
        sessionReads.count += 1;
        if (sessionReads.fail) return Response.json({ error: 'server_unavailable' }, { status: 503 });
      }
      if (path.endsWith('/system-records')) listReads.push(new URL(String(url)).search);
      return await artifacts.handle(`${path}${new URL(String(url)).search}`, init) ?? fixture.request(url);
    }),
  });
  onTestFinished(async () => {
    standardCleanup();
    await connection.dispose();
    vi.unstubAllGlobals();
  });
  primeServerFeaturesSnapshot({ serverId: connection.home.id, snapshot: { status: 'ready', features } });
  const actionInput = getActionSpec('session.board.item.upsert').inputSchema.parse({ sessionId: 'session-1',
    itemId: 'visual', expectedItemRevision: null, destination: 'transcript', item });
  const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
  const executed = await createDefaultActionExecutor().execute('session.board.item.upsert', actionInput,
    { serverId: connection.home.id, surface: 'ui', authority: 'present_user' });
  expect(executed, JSON.stringify(executed)).toMatchObject({ ok: true });
  if (!executed.ok) throw new Error(`Visual publication failed: ${executed.errorCode}`);
  // The canonical UI front door confirms the present user's intent, then returns
  // its mutation acknowledgement. A durable Inbox request is a separate policy.
  const outputSchema = getActionSpec('session.board.item.upsert').outputSchema;
  if (!outputSchema) throw new Error('Visual publication must declare its Action result contract');
  const acknowledged = outputSchema.parse(executed.result);
  expect(records.filter(row => row.address.kind === 'item.v1')).toHaveLength(1);
  if (viewer === 'view') boundary.effectiveAccess = SessionEffectiveAccessV1Schema.parse({ v: 1, level: 'view',
    sources: [{ kind: 'direct', shareId: 'reader-grant' }], capabilities: projectSessionAccessCapabilitiesV1({
      owner: false, grants: [{ accessLevel: 'view', canApprovePermissions: false }],
    }) });
  const session = storage.getState().sessions['session-1'];
  if (!session) throw new Error('The published Session must be hydrated before reader admission');
  storage.getState().applySessions([{ ...session, access: createSessionAccessFixture(viewer) }]);
  const tool = makeToolCall({
    name: 'session_board_item_upsert',
    state: 'completed',
    input: actionInput,
    result: acknowledged,
  });
  const credentials = await TokenStorage.getCredentialsForServerUrl(connection.home.serverUrl, { serverId: connection.home.id });
  return { tool, serverId: connection.home.id, records, artifacts, fixture, credentials, mutations, listReads, sessionReads, executor: createDefaultActionExecutor() };
}

function TranscriptBoardOwner(props: React.ComponentProps<typeof SessionBoardControllerOwner>) {
  const mounted = useMountedSessionBoardController(props.address);
  return mounted ? <SessionBoardControllerProvider {...props.address}>
    {props.children}
  </SessionBoardControllerProvider> : <SessionBoardControllerOwner {...props} />;
}

function bodiesInReply(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): number {
  const reply = screen.findByTestId(testID)!;
  return reply.findAll(node => String(node.type) === 'BrowserViewFrame').length;
}

/** One Session shell with the transcript repeating the same acknowledged visual in two replies. */
function Transcript(
  props: Readonly<{
    tool: ToolCall;
    serverId: string;
    demand: readonly [boolean, boolean];
    canEdit?: boolean;
    actions?: ReturnType<typeof createSessionBoardActionsPort>;
    onPresentation?: (result: ActionExecuteResult) => void;
    children?: React.ReactNode;
  }>,
) {
  const address = React.useMemo(
    () => ({ serverId: props.serverId, sessionId: 'session-1' }),
    [props.serverId],
  );
  const callerRuntime = useSessionCallerHostedHtmlRuntime(props.serverId, 'session-1', pluginRuntime);
  const binding = React.useMemo(
    () => ({
      status: 'ready' as const,
      snapshot: projectSessionBoard({
        layout: {
          revision,
          outcome: {
            status: 'ready',
            value: { v: 1, tabs: [{ id: 'view-a', title: 'A', items: [] }] },
          },
        },
        items: new Map(),
        capabilities: { readTranscript: true, editSessionRecords: props.canEdit === true },
        freshness: 'fresh',
        reachability: 'reachable',
        loading: 'idle',
        incomplete: false,
      } satisfies Parameters<typeof projectSessionBoard>[0]),
    }),
    [props.canEdit],
  );
  const actions = React.useMemo(
    () => props.actions ?? createSessionBoardActionsPort(address),
    [address, props.actions],
  );
  const applierRef = React.useRef<SessionPresentationIntentApplier | null>(null);
  const accountId = storage.getState().profileScope!.accountId;
  // Compose the shell's current-client Action port with the real bridge below.
  const executor = React.useMemo(() => createDefaultActionExecutor({ currentSessionPresentationApply: {
    ...address, accountId,
    isCurrent: () => {
      const scope = storage.getState().profileScope;
      return !!scope && areServerProfileIdentifiersEquivalent(scope.serverId, address.serverId) && scope.accountId === accountId;
    },
    apply: async ({ input }) => {
      const result = applierRef.current?.(input.intent) ?? { status: 'unavailable' as const };
      return result.status === 'applied' || result.status === 'unchanged'
        ? { status: result.status, revision: 'mounted-transcript' }
        : { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    },
  } }), [accountId, address]);
  return (
    <SessionBoardContinuityProvider
      sessionId={address.sessionId}
      serverId={address.serverId}
    >
      <TranscriptBoardOwner
        address={address}
        input={{ ...address, binding, actions, resolveSourceAvailability: available }}
        binding={binding}
        actions={actions}
        pluginRuntime={{ ...pluginRuntime, serverId: address.serverId }}
        callerHostedHtmlRuntime={callerRuntime}
      >
        <SessionCompanionPresentationBridge {...address} applierRef={applierRef}
          openBoard={() => ({ status: 'unavailable' })} revealBoardItem={() => ({ status: 'applied' })}
          returnToChat={() => ({ status: 'unchanged' })} openFullSurface={() => ({ status: 'unavailable' })} />
        <SessionCompanionRevealPortProvider address={address} openFullSurface={() => {}}
          revealAfterMutation={() => {}} revealBoardItem={widgetId => {
            void executor.execute('session.presentation.apply', { intent: { kind: 'board.item.reveal', widgetId } },
              { surface: 'ui', authority: 'present_user', serverId: props.serverId, expectedAccountId: accountId, defaultSessionId: address.sessionId })
              .then(result => { props.onPresentation?.(result); });
          }}
          showItemInChat={async (widgetId, occurrenceId) => {
            const result = await executor.execute('session.presentation.apply', { intent: { kind: 'chat.item.show', widgetId, occurrenceId } },
              { surface: 'ui', authority: 'present_user', serverId: props.serverId, expectedAccountId: accountId, defaultSessionId: address.sessionId });
            props.onPresentation?.(result);
          }}>
        <View testID="reply-1">
          <TranscriptRowSeqProvider value={1}>
          <SessionBoardActionResultReference
            tool={props.tool}
            serverId={props.serverId}
            sessionId="session-1"
            contentDemand={props.demand[0]}
          />
          </TranscriptRowSeqProvider>
        </View>
        <View testID="reply-2">
          <TranscriptRowSeqProvider value={2}>
          <SessionBoardActionResultReference
            tool={props.tool}
            serverId={props.serverId}
            sessionId="session-1"
            contentDemand={props.demand[1]}
          />
          </TranscriptRowSeqProvider>
        </View>
        {props.children}
        </SessionCompanionRevealPortProvider>
      </TranscriptBoardOwner>
    </SessionBoardContinuityProvider>
  );
}

/** One reply in the production Session owner, with no Board or Companion host on screen. */
function RuntimeTranscript(props: Readonly<{ tool: ToolCall; serverId: string; credentials: AuthCredentials | null }>) {
  const navigation = { push: () => {}, replace: () => {}, back: () => {} };
  const address = React.useMemo(() => ({ serverId: props.serverId, sessionId: 'session-1' }), [props.serverId]);
  return <InjectedAuthProvider credentials={props.credentials}><AppPaneProvider>
    <DestinationInstanceHost tabId="visual-session" ref={{ kind: 'session', params: { id: 'session-1', serverId: props.serverId } }}
      pathname="/session/session-1" focused visible navigation={navigation}>
      <SessionBoardControllerProvider {...address}>
        <SessionCompanionRevealPortProvider address={address} openFullSurface={() => {}}
          revealAfterMutation={() => {}} revealBoardItem={() => {}}>
          <TranscriptRowSeqProvider value={1}>
            <SessionBoardActionResultReference tool={props.tool} serverId={props.serverId} sessionId="session-1" contentDemand />
          </TranscriptRowSeqProvider>
        </SessionCompanionRevealPortProvider>
      </SessionBoardControllerProvider>
    </DestinationInstanceHost>
  </AppPaneProvider></InjectedAuthProvider>;
}

function WorkspaceTranscript(props: React.ComponentProps<typeof Transcript> & Readonly<{ focused: boolean; visible: boolean; credentials: AuthCredentials | null }>) {
  const navigation = { push: () => {}, replace: () => {}, back: () => {} };
  return <InjectedAuthProvider credentials={props.credentials}><AppPaneProvider>
    <DestinationInstanceHost tabId="visual-session" ref={{ kind: 'session', params: { id: 'session-1', serverId: props.serverId } }}
      pathname="/session/session-1" focused={props.focused} visible={props.visible} navigation={navigation}>
      <Transcript {...props} />
    </DestinationInstanceHost>
    <DestinationInstanceHost tabId="other-tab" ref={{ kind: 'session', params: { id: 'session-2', serverId: props.serverId } }}
      pathname="/session/session-2" focused={!props.focused} visible navigation={navigation}>
      <View />
    </DestinationInstanceHost>
  </AppPaneProvider></InjectedAuthProvider>;
}

describe('live inline transcript visuals', () => {
  it('keeps the newest occurrence when an older row becomes demanded later', async () => {
    const { tool, serverId } = await prepare({ mode: 'auto', fallback: 'regular' });
    const screen = await renderScreen(<Transcript tool={tool} serverId={serverId} demand={[false, true]} />);
    await act(async () => { await loadPluginUiHostSupport(); });
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(bodiesInReply(screen, 'reply-2')).toBe(1);
    });
    await screen.update(<Transcript tool={tool} serverId={serverId} demand={[true, true]} />);
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(bodiesInReply(screen, 'reply-2')).toBe(1);
    });
    expect(bodiesInReply(screen, 'reply-1')).toBe(0);
  });

  it('releases an approved cards-mode visual read and execution candidacy when row demand withdraws', async () => {
    const { tool, serverId, fixture } = await prepare({ mode: 'auto', fallback: 'regular' });
    const approval = ApprovalRequestV2Schema.parse({
      v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 3,
      createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'agent',
      origin: { kind: 'transcript_tool_call', sessionId: 'session-1', messageId: 'asked-row', toolCallId: 'asked-tool',
        toolName: 'session_board_item_upsert', toolInput: tool.input },
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
        caller: { kind: 'session', sessionId: 'session-1', starterDepth: 0, turnDepth: 0 },
        serverId, sessionId: 'session-1', machineId: 'machine-1', actionId: 'session.board.item.upsert', requestId: 'asked-visual' },
      actionId: 'session.board.item.upsert', actionArgs: tool.input, summary: 'Show experiment',
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, effectAttempted: true, ok: true, result: tool.result },
    });
    const requests = [{ artifact: { id: 'asked-visual', header: buildApprovalRequestArtifactHeaderV1(approval) }, approval }];
    const pendingTool = { ...tool, id: 'asked-tool', result: {
      kind: 'approval_request_created', artifactId: 'asked-visual', actionId: 'session.board.item.upsert',
    } };
    const source = createTestSessionTranscriptSource({ serverId, sessionId: 'session-1' });
    const demand = createTranscriptRendererContentDemand();
    demand.publish(['asked-row']);
    const address = { serverId, sessionId: 'session-1' };
    let mounted: ReturnType<typeof useMountedSessionBoardController> = null;
    const Probe = () => { mounted = useMountedSessionBoardController(address); return null; };
    const screen = await renderScreen(<Transcript tool={tool} serverId={serverId} demand={[false, false]}>
      <SessionTranscriptSourceProvider source={source}>
        <TranscriptRendererContentDemandProvider demand={demand}>
          <TranscriptRendererRowContentDemandProvider itemKey="asked-row">
            <View testID="cards-reply">
            <ToolView tool={pendingTool} metadata={null} serverId={serverId} sessionId="session-1"
              messageId="asked-row" approvalRequests={requests} />
            </View>
          </TranscriptRendererRowContentDemandProvider>
        </TranscriptRendererContentDemandProvider>
      </SessionTranscriptSourceProvider>
      <Probe />
    </Transcript>);
    await act(async () => { await loadPluginUiHostSupport(); });
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(mounted?.resolveInlineTranscriptOccurrence('visual')).toEqual(expect.any(String));
    });
    const occurrence = mounted!.resolveInlineTranscriptOccurrence('visual');
    expect(occurrence).not.toBeNull();
    expect(screen.findByTestId('approval-prompt-card')).toBeNull();
    const repository = getSyncSingleton().readSessionSystemRecordObservation(address)!.repository;
    const itemAddress = { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' } as const;
    const query = { type: 'read', address: itemAddress } as const;
    const reads = fixture.recordReads.length;

    await act(async () => { demand.publish([]); });
    expect(mounted!.resolveInlineTranscriptOccurrence('visual')).toBeNull();
    // The retained row is not read demand. An addressed change stays stale until it is visible again.
    await act(async () => { repository.invalidate(address, [itemAddress]); });
    expect(repository.getSnapshot(address, query).freshness).toBe('stale');
    expect(fixture.recordReads).toHaveLength(reads);

    await act(async () => { demand.publish(['asked-row']); });
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(mounted!.resolveInlineTranscriptOccurrence('visual')).toBe(occurrence);
      expect(repository.getSnapshot(address, query).freshness).toBe('fresh');
    });
    expect(fixture.recordReads.length).toBeGreaterThan(reads);
  });

  it('keeps one runner in a visible unfocused workspace tab, reloads it on Show here, and retires hidden tabs', async () => {
    frames.active = 0;
    frames.maximum = 0;
    const { tool, serverId, credentials } = await prepare({ mode: 'auto', fallback: 'regular' });
    let presentation: ActionExecuteResult | undefined;
    const view = (focused: boolean, visible: boolean) => <WorkspaceTranscript
      tool={tool} serverId={serverId} credentials={credentials} demand={[true, true]} focused={focused} visible={visible}
      onPresentation={result => { presentation = result; }} />;
    const screen = await renderScreen(view(false, true));
    await act(async () => { await loadPluginUiHostSupport(); });
    const framesIn = (testID: string) => bodiesInReply(screen, testID);
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(framesIn('reply-2')).toBe(1);
    });
    const document = screen.tree.root.findByType('BrowserViewFrame').props.document;
    const showHere = screen.findByTestId('reply-1')!.findAll((node) =>
      node.props.testID === 'transcript-board-widget-visual-open-here')[0]!;
    await act(async () => { showHere.props.onPress(); });
    await vi.waitFor(() => expect(presentation).toBeDefined());
    expect(presentation, JSON.stringify(presentation)).toMatchObject({ ok: true, result: { status: 'applied' } });
    await vi.waitFor(() => expect(framesIn('reply-1')).toBe(1));
    expect(screen.tree.root.findByType('BrowserViewFrame').props.document).not.toBe(document);
    expect(framesIn('reply-2')).toBe(0);
    await screen.update(view(true, true));
    expect(framesIn('reply-1')).toBe(1);
    await screen.update(view(false, false));
    expect(frames.active).toBe(0);
    await screen.update(view(false, true));
    await vi.waitFor(() => expect(framesIn('reply-2')).toBe(1));
    expect(frames.maximum).toBe(1);
  });

  it('runs the latest demanded occurrence and releases it when demand leaves', async () => {
    frames.active = 0;
    frames.maximum = 0;
    const { tool, serverId } = await prepare({
      mode: 'auto',
      fallback: 'regular',
    });
    const screen = await renderScreen(
      <Transcript tool={tool} serverId={serverId} demand={[true, true]} />,
    );
    const framesIn = (testID: string) => bodiesInReply(screen, testID);

    // Keep cold SDK transformation outside the frame assertion's polling budget,
    // while exercising the real async preparation and React publication path.
    await act(async () => { await loadPluginUiHostSupport(); });
    // The transcript is the only host drawing it, so a reply runs it live, and only one does.
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(frames.active).toBe(1);
    });
    expect(framesIn('reply-2')).toBe(1);
    expect(framesIn('reply-1')).toBe(0);
    // The other reply says where the visual runs instead of drawing an empty card.
    expect(
      screen.findByTestId('transcript-board-widget-visual-elsewhere'),
    ).not.toBeNull();

    // The live reply scrolls away: its body is released and the reply still on screen takes it.
    await screen.update(
      <Transcript tool={tool} serverId={serverId} demand={[true, false]} />,
    );
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(framesIn('reply-1')).toBe(1);
    });
    expect(frames.active).toBe(1);
    expect(frames.maximum).toBe(1);

    await act(async () => {
      await screen.update(
        <Transcript tool={tool} serverId={serverId} demand={[false, false]} />,
      );
    });
    expect(frames.active).toBe(0);
  });

  it('lets a reply that runs elsewhere show here: one compact line, then the live body moves to it', async () => {
    frames.active = 0;
    frames.maximum = 0;
    const { tool, serverId } = await prepare({ mode: 'fixed', size: 'tall' });
    let presentation: ActionExecuteResult | undefined;
    const screen = await renderScreen(<Transcript tool={tool} serverId={serverId} demand={[true, true]}
      onPresentation={result => { presentation = result; }} />);
    const framesIn = (testID: string) => bodiesInReply(screen, testID);
    await act(async () => { await loadPluginUiHostSupport(); });
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(framesIn('reply-2')).toBe(1);
    });
    // The reply that does not run it is a compact line that offers the move, not a box of the
    // declared height around one sentence.
    const elsewhereBody = () => screen.tree.root
      .findAll((node) => node.props.testID === 'reply-1')
      .at(0)!
      .findAll((node) => node.props.testID === 'transcript-board-widget-visual-body')[0];
    const bodyHeight = () => Object.assign({}, ...[elsewhereBody()?.props.style].flat(Infinity).filter(Boolean)).height;
    expect(bodyHeight()).toBeUndefined();
    const showHere = () => screen.tree.root
      .findAll((node) => node.props.testID === 'reply-1')
      .at(0)!
      .findAll((node) => node.props.testID === 'transcript-board-widget-visual-open-here')[0];
    expect(showHere()).toBeTruthy();

    await act(async () => { showHere()!.props.onPress?.(); });
    await vi.waitFor(() => expect(presentation).toBeDefined());
    expect(presentation, JSON.stringify(presentation)).toMatchObject({ ok: true, result: { status: 'applied' } });
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(framesIn('reply-1')).toBe(1);
    });
    expect(framesIn('reply-2')).toBe(0);
    expect(frames.maximum).toBe(1);
    expect(screen.findByTestId('transcript-board-widget-visual-elsewhere')).not.toBeNull();
  });

  it('answers the matching Agent intent through the same owner and is typed unavailable with no reply on screen', async () => {
    const { tool, serverId } = await prepare({ mode: 'auto', fallback: 'regular' });
    let mounted: ReturnType<typeof useMountedSessionBoardController> = null;
    const Probe = () => { mounted = useMountedSessionBoardController({ serverId, sessionId: 'session-1' }); return null; };
    const screen = await renderScreen(
      <Transcript tool={tool} serverId={serverId} demand={[false, false]}><Probe /></Transcript>,
    );
    expect(mounted!.showInlineTranscriptItem('visual')).toBe('unavailable');
    await screen.update(
      <Transcript tool={tool} serverId={serverId} demand={[true, true]}><Probe /></Transcript>,
    );
    await vi.waitFor(() => expect(mounted!.resolveInlineTranscriptOccurrence('visual')).not.toBeNull());
    const first = mounted!.resolveInlineTranscriptOccurrence('visual');
    // Selecting the latest demanded occurrence is explicit and becomes unchanged on repetition.
    expect(mounted!.showInlineTranscriptItem('visual')).toBe('applied');
    await vi.waitFor(() => expect(mounted!.showInlineTranscriptItem('visual')).toBe('unchanged'));
    expect(mounted!.resolveInlineTranscriptOccurrence('visual')).toBe(first);

  });

  it('opens the current readable hosted-HTML transcript item before the bulk Board inventory catches up', async () => {
    const { tool, serverId } = await prepare({ mode: 'auto', fallback: 'regular' });
    let presentation: ActionExecuteResult | undefined;
    const screen = await renderScreen(
      <Transcript tool={tool} serverId={serverId} demand={[true, false]}
        onPresentation={result => { presentation = result; }} />,
    );
    await act(async () => { await loadPluginUiHostSupport(); });
    await vi.waitFor(() => expect(screen.findByTestId('transcript-board-item-visual-open')).not.toBeNull());
    await screen.pressByTestIdAsync('transcript-board-item-visual-open');
    await vi.waitFor(() => expect(presentation).toBeDefined());
    expect(presentation, JSON.stringify(presentation)).toMatchObject({ ok: true, result: { status: 'applied' } });
  });

  it("sizes a reply by the item's declared height, not a transcript-local clamp", async () => {
    const { tool, serverId } = await prepare({ mode: 'fixed', size: 'tall' });
    const screen = await renderScreen(
      <Transcript tool={tool} serverId={serverId} demand={[true, false]} />,
    );
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('transcript-board-widget-visual-body'),
      ).not.toBeNull(),
    );
    const body = screen.findByTestId('transcript-board-widget-visual-body')!;
    const style = Object.assign(
      {},
      ...[body.props.style].flat(Infinity).filter(Boolean),
    ) as { height?: number };
    // `tall` is the item's declared size; the old transcript bounds capped every visual at 320.
    expect(style.height).toBe(440);
  });

  it('pins a transcript visual to the Board as the same item, through the existing layout operation', async () => {
    const { tool, serverId, records, artifacts, executor } = await prepare({ mode: 'auto', fallback: 'regular' }, 'owner');
    const address = { serverId, sessionId: 'session-1' };
    const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
    const actions = createSessionBoardActionsPort({ ...address, execute: createFrontDoorActionExecute(executor) });
    const itemBefore = records.find(row => row.address.kind === 'item.v1');
    const screen = await renderScreen(
      <Transcript tool={tool} serverId={serverId} demand={[true, false]} canEdit actions={actions} />,
    );
    const readPin = () => screen.tree.root.findAllByType(ItemRowActions)
      .find((node) => node.props.overflowTriggerTestID === 'transcript-board-widget-visual-actions')
      ?.props.actions.find((action: { id: string }) => action.id === 'pin-to-board');
    await vi.waitFor(() => expect(readPin()).toBeTruthy());
    // Pin is a present-user reversible edit: the canonical policy applies it directly.
    const priorApprovals = new Set(artifacts.list().map(row => row.id));
    await act(async () => { readPin()?.onPress?.(); });
    await vi.waitFor(() => expect(records.find(row => row.address.kind === 'layout.v1')?.content).toMatchObject({
      t: 'plain', v: { tabs: [{ id: 'view-a', items: [{ itemId: 'visual' }] }] },
    }));
    expect(artifacts.list().some(row => !priorApprovals.has(row.id))).toBe(false);
    expect(records.filter(row => row.address.kind === 'item.v1')).toEqual([itemBefore]);
  });

  it('starts the Board read on the first menu open from the Session authority the reply already holds', async () => {
    const { tool, serverId, credentials, listReads, sessionReads } = await prepare({ mode: 'auto', fallback: 'regular' }, 'owner');
    const screen = await renderScreen(<RuntimeTranscript tool={tool} serverId={serverId} credentials={credentials} />);
    await act(async () => { await loadPluginUiHostSupport(); });
    await vi.waitFor(() => expect(screen.findByTestId('transcript-board-widget-visual-body')).not.toBeNull());
    await flushHookEffects({ cycles: 6 });
    // The reply is on screen, so this Session's record authority is current. Live, a list-only
    // publication then leaves the stored Session display-only (route hydration owed) and its by-id
    // read fails transiently on a loaded Home: the menu's Board facts must not wait on that hydration.
    const readsBefore = sessionReads.count;
    sessionReads.fail = true;
    const stored = storage.getState().sessions['session-1']!;
    act(() => { storage.setState(state => ({ sessions: { ...state.sessions, 'session-1': { ...stored, metadataProjection: 'displayOnly' } } })); });
    const readMenu = () => screen.tree.root.findAllByType(ItemRowActions)
      .find((node) => node.props.overflowTriggerTestID === 'transcript-board-widget-visual-actions')
      ?.props.actions as ReadonlyArray<{ id: string; disabled?: boolean; destructive?: boolean }> | undefined;
    await screen.pressByTestIdAsync('transcript-board-widget-visual-actions');
    await vi.waitFor(() => expect(readMenu()?.find(action => action.id === 'remove')).toMatchObject({ destructive: true }));
    expect(readMenu()?.find(action => action.id === 'remove')?.disabled).not.toBe(true);
    expect(listReads).toHaveLength(1);
    expect(sessionReads.count).toBe(readsBefore);
  });

  it('deletes a transcript-only visual and opens its network editor from the reply with no Board open (B-01)', async () => {
    const { tool, serverId, records, credentials, mutations, listReads } = await prepare({ mode: 'auto', fallback: 'regular' }, 'owner');
    // The production Session owner: its Board binding is observed from the same Home, not a fixture snapshot.
    const screen = await renderScreen(<RuntimeTranscript tool={tool} serverId={serverId} credentials={credentials} />);
    await act(async () => { await loadPluginUiHostSupport(); });
    const menuNode = () => screen.tree.root.findAllByType(ItemRowActions)
      .find((node) => node.props.overflowTriggerTestID === 'transcript-board-widget-visual-actions');
    const readMenu = () => menuNode()?.props.actions as ReadonlyArray<{ id: string; destructive?: boolean; onPress?: () => void }> | undefined;
    await vi.waitFor(() => expect(screen.findByTestId('transcript-board-widget-visual-body')).not.toBeNull());
    await flushHookEffects({ cycles: 6 });
    // A reply merely on screen reads only its own item: the Board's inventory waits for its menu.
    expect(listReads).toEqual([]);
    await screen.pressByTestIdAsync('transcript-board-widget-visual-actions');
    await vi.waitFor(() => expect(readMenu()?.find(action => action.id === 'remove')).toMatchObject({ destructive: true }));
    expect(listReads.length).toBeGreaterThan(0);
    await act(async () => { readMenu()?.find(action => action.id === 'network')?.onPress?.(); });
    await vi.waitFor(() => expect(screen.findByTestId('transcript-board-widget-visual.network')).not.toBeNull());
    await act(async () => { readMenu()?.find(action => action.id === 'remove')?.onPress?.(); });
    await vi.waitFor(() => expect(mutations.filter(mutation => mutation.operation === 'remove_item')).toMatchObject([
      { operation: 'remove_item', itemId: 'visual', expectedItemRevision: revision },
    ]));
    expect(records.some(row => row.address.kind === 'item.v1')).toBe(false);
  });
});
