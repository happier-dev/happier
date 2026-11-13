import * as React from 'react';
import { StyleSheet } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryScopeTargetV1 } from '@happier-dev/protocol/actions/executor/types';
import {
  MEMORY_ARCHIVE_TOPIC_TITLE_V1,
  MemoryDocBodyV1Schema,
  type MemoryDocBodyV1,
  type MemoryFactV1,
} from '@happier-dev/protocol/prompts/library/memoryDocV1';
import {
  MemoryDocReadResultV1Schema,
  type MemoryDuplicateChoiceRequiredV1,
} from '@happier-dev/protocol/prompts/library/memoryActionsV1';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import { ArtifactReadBatchHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { CurrentCursorResponseSchema } from '@happier-dev/protocol/changes';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { Socket } from 'socket.io-client';
import { createArtifactBodyUpdateFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import {
  PROMPT_LIBRARY_ROWS_ROUTE_V1,
  PromptLibraryCatalogKeyV1Schema,
  PromptLibraryRowMutationV1Schema,
  PromptLibraryRecordV1Schema,
  type PromptLibraryRecordV1,
} from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import {
  ProjectAccountOrganizationV1Schema,
  ProjectAccountRowMutationRequestV1Schema,
  PROJECT_ACCOUNT_ROWS_ROUTE_V1,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  createMachineFixture,
  createPlainMachineRowFixture,
} from '@/dev/testkit/fixtures/machineFixtures';
import { getServerProfileById, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';

import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import {
  configureConnectedServerSocketBoundary,
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { HappierDisclosure } from '@happier-dev/plugin-ui/presentation';
import { readPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import type { MemoryDocumentSource } from './useMemoryDocument';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({ push: vi.fn(), navigate: vi.fn() }));
// Machine RPC is the external daemon transport; selection, custody and summary logic stay real.
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({ machineRpcWithServerScope: machineRpc }),
);
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: navigation }).module;
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key: string, options?: Record<string, unknown>) =>
      key === 'memoryContext.memory.factCount'
        ? `${options?.count} facts`
        : key,
  });
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  // The forget/Undo cases explicitly accept the canonical destructive-action dialog.
  return createModalModuleMock({ confirmResult: true }).module;
});

vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);

// HTTP, persistence, device credentials and the reachable cold Socket transport are the boundaries.
// The memory hook, Actions front door, codecs, admission and Artifact CAS owners stay real.
const memorySockets: Array<Readonly<{ socket: Socket; serverUrl: string | undefined }>> = [];
function configureMemorySocket(socket: Socket, serverUrl?: string) {
  configureConnectedServerSocketBoundary(socket);
  memorySockets.push({ socket, serverUrl });
}
installDisconnectedServerSocketBoundary(configureMemorySocket);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { ItemRowActions } = await import('@/components/ui/lists/ItemRowActions');
const { InlineAddExpander } =
  await import('@/components/ui/forms/InlineAddExpander');
const { ItemList } = await import('@/components/ui/lists/ItemList');
const { memoryDocumentActions } =
  await import('@/sync/ops/promptLibrary/memoryDocuments');
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { createDefaultActionExecutor } =
  await import('@/sync/ops/actions/defaultActionExecutor');
const { useMemoryDocument } = await import('./useMemoryDocument');
const { useMemoryDocumentSummary } = await import('./useMemoryDocumentSummary');
const { MemoryDocumentBody } = await import('./MemoryDocumentBody');
const { MemoryDocumentScreen } = await import('./MemoryDocumentScreen');
const { ContextMemorySection } =
  await import('@/components/settings/prompts/context/ContextMemorySection');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { SessionMemorySection, selectSessionMemory } =
  await import('@/components/sessions/work/memory/SessionMemorySection');
const { useSessionContextLayers } =
  await import('@/components/sessions/work/context/useSessionContextLayers');
const { Modal } = await import('@/modal');
const baseline = storage.getState();
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null =
  null;
let webLocks: ReturnType<typeof installWebLockManagerMock>;
let caseSignal: AbortSignal;

beforeEach(async ({ signal }) => {
  caseSignal = signal;
  vi.mocked(Modal.alert).mockClear();
  webLocks = installWebLockManagerMock();
  await homes.reset();
  storage.setState(baseline, true);
  serverId = await homes.addHome({
    name: 'Memory Home',
    serverUrl: 'https://memory-body.test',
    accountId: 'account-a',
  });
  // Match the admitted local Settings baseline: the Home harness otherwise answers null/version 0.
  homes.answer(serverId, 'GET /v2/account/settings', {
    body: { content: { t: 'plain', v: {} }, version: 1 },
  });
  homes.answer(serverId, '/v1/account/encryption/currentness', {
    body: createPlainAccountEncryptionCurrentnessFixture(),
  });
  connection = await restoreServerAccountForTest({
    serverUrl: 'https://memory-body.test',
    accountId: 'account-a',
    request: homes.request,
    configureSocket: configureMemorySocket,
  });
  installHomeGovernanceBoundaries(homes);
  const scope = { serverId, accountId: 'account-a' };
  storage.getState().applySettingsForScope(scope, baseline.settings, 1);
  storage.getState().activateProfileScope(scope);
});
afterEach(async () => {
  machineRpc.mockReset();
  setReducedMotionPreferenceOverride(null);
  standardCleanup();
  await connection?.dispose();
  connection = null;
  const { serverScopedRpcSocketPool } =
    await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
  await serverScopedRpcSocketPool.stopAll();
  navigation.push.mockClear();
  navigation.navigate.mockClear();
  webLocks.restore();
  installHomeGovernanceBoundaries(homes);
});

const fact = (id: string, text: string): MemoryFactV1 => ({
  id,
  text,
  createdAtMs: 1_000,
  sourceSessionRef: null,
});

function selectSummaryDaemon(
  homeId: string,
  serverIdentityId: string,
  accountId = 'account-a',
  machineId = 'memory-machine',
) {
  const machine = createMachineFixture({
    id: machineId,
    activeAt: Date.now(),
  });
  // Real inventory refresh must retain the same explicitly selected daemon.
  homes.answer(homeId, '/v1/machines', {
    body: [createPlainMachineRowFixture({ id: machine.id, accountId })],
  });
  storage.setState((state) => ({
    isDataReady: true,
    ...(homeId === serverId ? { machines: { [machine.id]: machine } } : {}),
    machineListByServerId: {
      ...state.machineListByServerId,
      [homeId]: [machine],
    },
    machineListStatusByServerId: {
      ...state.machineListStatusByServerId,
      [homeId]: 'idle',
    },
    settings: {
      ...state.settings,
      machineAdministrationTargetsLocalV1: {
        'memory.settings': { serverIdentityId, machineId: machine.id },
      },
    },
  }));
}

function summaryStatus(
  ref: PromptDocArtifactRefV1,
  revision: { headerVersion: number; bodyVersion: number },
) {
  return {
    v: 1,
    enabled: true,
    indexMode: 'deep',
    hintsIndexReady: false,
    deepIndexReady: true,
    activeIndexReady: true,
    embeddingsEnabled: false,
    embeddingsMode: 'disabled',
    embeddingsPresetId: null,
    embeddingsProviderKind: null,
    embeddingsModelId: null,
    embeddingsRuntimeState: 'unavailable',
    embeddingsUsingFallback: false,
    tier1DbPath: null,
    deepDbPath: '/memory/deep.sqlite',
    tier1DbBytes: null,
    deepDbBytes: 1,
    documents: {
      state: 'ready',
      facts: [
        // Same-id ambient coverage must never replace the qualified document's counts.
        {
          ref: { ...ref, serverId },
          revision,
          loadedFactCount: 99,
          indexedFactCount: 99,
        },
        { ref, revision, loadedFactCount: 2, indexedFactCount: 7 },
      ],
    },
  };
}

async function seedDocument(
  body: MemoryDocBodyV1,
): Promise<PromptDocArtifactRefV1> {
  const artifactId = await sync.createArtifactWithHeader(
    { v: 1, kind: 'memory_doc.v1', title: 'Account memory' },
    JSON.stringify(body),
  );
  homes.answer(
    serverId,
    '/v1/public-shares?' +
      new URLSearchParams({ subjectKind: 'artifact', subjectId: artifactId }),
    { body: { publicShares: [] } },
  );
  return { kind: 'doc', serverId, artifactId };
}
async function settleInitialArtifactInventory() {
  if (!connection)
    throw new Error('Expected the admitted Memory Account fixture');
  // Inventory is demand-driven. Complete this fixture's own header read before
  // measuring the separate document-body read, rather than waiting for a viewer.
  await sync.fetchArtifactsList({ signal: caseSignal });
  expect(storage.getState().artifactsLoaded).toBe(true);
}
/** Count physical body demand across both authenticated Artifact read forms. */
function bodyReadsSince(start: number): string[] {
  return homes.requests.slice(start).flatMap(request => {
    if (request.path === '/v1/artifacts/read') {
      const input = ArtifactReadBatchHttpInputV1Schema.parse(request.input);
      return 'projection' in input ? [] : input.artifactIds;
    }
    const match = /^\/v1\/artifacts\/([^/]+)$/.exec(request.path);
    return match && request.method === 'GET' ? [decodeURIComponent(match[1]!)] : [];
  });
}
async function deliverMemoryBodyUpdate(ref: PromptDocArtifactRefV1) {
  const boundary = homes.artifacts(ref.serverId ?? serverId);
  const row = boundary.read(ref.artifactId);
  if (!row) throw new Error('Expected a committed Memory Artifact');
  const cursorResponse = await boundary.handle('/v2/cursor');
  if (!cursorResponse?.ok) throw new Error('Expected the committed Home Account cursor');
  const { cursor } = CurrentCursorResponseSchema.parse(await cursorResponse.json());
  const packet = createArtifactBodyUpdateFixture(row, cursor);
  const home = getServerProfileById(ref.serverId ?? serverId);
  if (!home) throw new Error('Expected the qualified Memory Home');
  // Sync uses Socket.onAny. Deliver through that real network listener on this exact Home.
  const readSocket = () => memorySockets.slice().reverse().find(candidate => candidate.socket.connected && candidate.serverUrl
    && canonicalizeServerUrl(candidate.serverUrl) === canonicalizeServerUrl(home.serverUrl)
    && candidate.socket.listenersAny().length > 0)?.socket;
  await settled(() => expect(readSocket(), 'The restored Home must have its real Sync update listener').toBeDefined());
  const socket = readSocket();
  if (!socket) throw new Error('Expected the qualified Home Socket');
  await act(async () => {
    await Promise.all(socket.listenersAny().map(listener => listener('update', packet)));
  });
}
function storedBody(ref: PromptDocArtifactRefV1): MemoryDocBodyV1 {
  return MemoryDocBodyV1Schema.parse(
    JSON.parse(
      homes.artifacts(serverId).readPlainBody(ref.artifactId) ?? 'null',
    ),
  );
}

function Host(
  props: Readonly<{
    documentRef?: PromptDocArtifactRefV1;
    topic?: string;
    composing?: boolean;
    collapsed?: number;
    sessionTarget?: Parameters<typeof MemoryDocumentBody>[0]['sessionTarget'];
    scopeTarget?: MemoryScopeTargetV1;
    onCreatedMemory?: Parameters<
      typeof MemoryDocumentBody
    >[0]['onCreatedMemory'];
    onDuplicateReview?: Parameters<
      typeof MemoryDocumentBody
    >[0]['onDuplicateReview'];
    preparationBasis?: string;
    inUse?: boolean;
  }>,
) {
  const [composing, setComposing] = React.useState(props.composing ?? false);
  const source = useMemoryDocument({
    ref: props.documentRef ?? null,
    serverId,
    topic: props.topic,
  });
  return (
    <MemoryDocumentBody
      testID="memory"
      source={source}
      serverId={serverId}
      collapsedFactCount={props.collapsed}
      composing={composing}
      onComposingChange={setComposing}
      sessionTarget={props.sessionTarget}
      scopeTarget={props.scopeTarget}
      onCreatedMemory={props.onCreatedMemory}
      onDuplicateReview={props.onDuplicateReview}
      preparationBasis={props.preparationBasis}
      inUse={props.inUse}
      emptyText="empty"
    />
  );
}

function boundaryDiagnostic() {
  return (
    'Memory HTTP boundary: ' +
    JSON.stringify({
      scope: storage.getState().profileScope,
      paths: homes.requests.map(({ path, input }) => ({
        path,
        mutation: input !== null,
      })),
      artifacts: homes
        .artifacts(serverId)
        .list()
        .map((row) => ({
          id: row.id,
          headerVersion: row.headerVersion,
          bodyVersion: row.bodyVersion,
          body: homes.artifacts(serverId).readPlainBody(row.id),
        })),
      refusals: vi.mocked(Modal.alert).mock.calls.map(([, message]) => message),
    })
  );
}
async function settled(check: () => void) {
  const signal = caseSignal;
  try {
    // Inherit the case's runner deadline through the incumbent Home harness.
    await waitForHomeGovernance(async () => {
      // Flush before asserting: a rejecting act callback skips React's queue flush.
      // A timed-out case must not enter act or inspect the next case's shared boundary.
      signal.throwIfAborted();
      await flushHookEffects();
      signal.throwIfAborted();
      check();
    });
  } catch (error) {
    if (error instanceof Error && !signal.aborted) {
      error.message += '\n' + boundaryDiagnostic();
    }
    throw error;
  }
}
async function savedDraft(screen: Awaited<ReturnType<typeof renderScreen>>) {
  // Refusal is terminal too: assert success outside the retry loop, instead of hiding it until the runner expires.
  await settled(() =>
    expect(
      !screen.findByTestId('memory.draft') ||
        vi.mocked(Modal.alert).mock.calls.length > 0,
    ).toBe(true),
  );
  expect(
    Boolean(screen.findByTestId('memory.draft')),
    boundaryDiagnostic(),
  ).toBe(false);
  expect(vi.mocked(Modal.alert).mock.calls, boundaryDiagnostic()).toEqual([]);
}
async function forgetOutcome(screen: Awaited<ReturnType<typeof renderScreen>>) {
  // A pending approval or refusal is terminal too; report it rather than hiding it
  // behind the case deadline while waiting for a notice that cannot arrive.
  await settled(() =>
    expect(
      Boolean(
        readPresentationNotice()?.undo ||
        screen.findByTestId('memory.pending') ||
        screen.findByTestId('memory.refused') ||
        screen.findByTestId('memory.conflict') ||
        vi.mocked(Modal.alert).mock.calls.length,
      ),
    ).toBe(true),
  );
  expect(
    screen.findByTestId('memory.pending'),
    boundaryDiagnostic(),
  ).toBeNull();
  expect(
    screen.findByTestId('memory.refused'),
    boundaryDiagnostic(),
  ).toBeNull();
  expect(
    screen.findByTestId('memory.conflict'),
    boundaryDiagnostic(),
  ).toBeNull();
  expect(vi.mocked(Modal.alert).mock.calls, boundaryDiagnostic()).toEqual([]);
}
/** A fact's place in the list: `expanded` false while its row collapses after an accepted forget. */
function factSlot(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  id: string,
) {
  return (
    screen
      .findAllByType(HappierDisclosure)
      .find((node) => node.props.testID === `memory.fact.${id}.slot`) ?? null
  );
}
async function renderDocument(
  ref: PromptDocArtifactRefV1,
  props: Omit<React.ComponentProps<typeof Host>, 'documentRef'> = {},
) {
  if (!connection)
    throw new Error('Expected the admitted Memory Account fixture');
  const screen = await renderScreen(
    <InjectedAuthProvider credentials={connection.credentials}>
      <Host documentRef={ref} {...props} />
    </InjectedAuthProvider>,
  );
  await settled(() =>
    expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe(
      'ready',
    ),
  );
  return screen;
}
async function readMemory(ref: PromptDocArtifactRefV1, topic?: string) {
  const result = await createDefaultActionExecutor().execute(
    'memory.read',
    { ref, ...(topic ? { topic } : {}) },
    { serverId, surface: 'ui' },
  );
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error);
  return MemoryDocReadResultV1Schema.parse(result.result);
}

it('restores the Memory rail width beside an admitted fact', async () => {
  if (!connection)
    throw new Error('Expected the Memory Home connection fixture');
  const ref = await seedDocument({
    v: 1,
    index: [fact('one', 'Verify signatures.')],
    topics: [],
  });
  storage
    .getState()
    .applyLocalSettings({ collectionRailWidthsV1: { memory: 350 } });
  const screen = await renderScreen(
    <InjectedAuthProvider credentials={connection.credentials}>
      <MemoryDocumentScreen
        artifactId={ref.artifactId}
        serverId={serverId}
        factId="one"
      />
    </InjectedAuthProvider>,
  );
  await settled(() =>
    expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe(
      'ready',
    ),
  );
  const layout = screen.findHostByTestId('memory-document.layout');
  await act(async () =>
    layout!.props.onLayout({
      nativeEvent: { layout: { width: 1200, height: 800 } },
    }),
  );
  const divider = screen.findHostByTestId(
    'memory-document.layout-resize-handle',
  );
  expect(divider?.props.accessibilityValue.now).toBe(350);
});

it.each(['private', 'grant', 'public', 'unknown'] as const)(
  'publishes the admitted Memory audience (%s) without inferring privacy from ownership',
  async (audience) => {
    // Measure the display read, not the separate cold inventory hydration that changes its refresh basis.
    await settleInitialArtifactInventory();
    const ref = await seedDocument({
      v: 1,
      index: [fact('one', 'Verify payment signatures.')],
      topics: [],
    });
    if (audience === 'grant')
      homes
        .artifacts(serverId)
        .seedAccountGrant(ref.artifactId, 'teammate', 'view');
    if (audience === 'public')
      homes.artifacts(serverId).replaceStoredRow({
        ...homes.artifacts(serverId).read(ref.artifactId)!,
        publicAudience: 'retained',
      });
    if (audience === 'unknown')
      homes.answer(serverId, `/v1/artifacts/${ref.artifactId}/access/grants`, {
        status: 503,
        body: { error: 'database_connection_unavailable' },
      });
    const requestStart = homes.requests.length;
    const hook = await renderHook(() => useMemoryDocument({ ref, serverId }));
    await settled(() => expect(hook.getCurrent().status).toBe('ready'));
    expect(hook.getCurrent().view).toMatchObject({
      access: 'owner',
      shared: audience === 'unknown' ? null : audience !== 'private',
    });
    expect(
      homes.requests
        .slice(requestStart)
        .filter(
          (request) => request.path === `/v1/artifacts/${ref.artifactId}`,
        ),
    ).toHaveLength(1);
    expect(hook.getCurrent().view).toMatchObject({
      audience:
        audience === 'unknown'
          ? null
          : {
              shared: audience !== 'private',
              team: null,
              publicLink: audience === 'public',
              grants:
                audience === 'grant'
                  ? [
                      expect.objectContaining({
                        principal: { kind: 'account', accountId: 'teammate' },
                      }),
                    ]
                  : [],
            },
    });
    expect(hook.getCurrent().target === null).toBe(audience === 'unknown');
    await hook.unmount();
  },
);

it('invites a first decision on an empty Memory page and opens the existing draft', async () => {
  await settleInitialArtifactInventory();
  const ref = await seedDocument({ v: 1, index: [], topics: [] });
  if (!connection) throw new Error('Expected the Memory Home connection fixture');
  const screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}>
    <MemoryDocumentScreen artifactId={ref.artifactId} serverId={serverId} />
  </InjectedAuthProvider>);
  await settled(() => expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe('ready'));
  await screen.pressByTestIdAsync('memory-document.add-decision');
  expect(screen.findByTestId('memory-document.draft')).toBeTruthy();
  await screen.unmount();
});

it('explains an unknown audience, keeps saving unavailable and retries the admitted audience read', async () => {
  await settleInitialArtifactInventory();
  const ref = await seedDocument({ v: 1, index: [fact('one', 'Keep this decision.')], topics: [] });
  const grantsPath = `/v1/artifacts/${ref.artifactId}/access/grants`;
  homes.answer(serverId, grantsPath, { status: 503, body: { error: 'database_connection_unavailable' } });
  if (!connection) throw new Error('Expected the Memory Home connection fixture');
  const screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}>
    <MemoryDocumentScreen artifactId={ref.artifactId} serverId={serverId} />
  </InjectedAuthProvider>);
  await settled(() => expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe('ready'));
  expect(screen.findByTestId('memory-document.sharingUnknown')).toBeTruthy();
  expect(screen.findByTestId('memory-document.remember')).toBeNull();
  const reads = homes.requests.filter(request => request.path === grantsPath).length;
  const retry = screen.findByTestId('memory-document.retryAudience')!.find(node => typeof node.props?.onPress === 'function');
  await act(async () => { await retry.props.onPress(); });
  await settled(() => expect(homes.requests.filter(request => request.path === grantsPath).length).toBeGreaterThan(reads));
  expect(screen.findByTestId('memory-document.remember')).toBeNull();
  await screen.unmount();
});

it('does not reread a cold displayed Memory when its unchanged inventory header arrives', async () => {
  const ref = await seedDocument({ v: 1, index: [fact('one', 'Verify payment signatures.')], topics: [] });
  // Model a direct URL before the header inventory arrives, rather than seeding beyond the read boundary.
  storage.setState({ artifacts: {} });
  const start = homes.requests.length;
  const hook = await renderHook(() => useMemoryDocument({ ref, serverId }));
  await settled(() => expect(hook.getCurrent().status).toBe('ready'));
  expect(hook.getCurrent().view?.facts).toMatchObject([{ id: 'one' }]);
  await act(async () => { await settleInitialArtifactInventory(); });
  expect(storage.getState().artifacts[ref.artifactId]).toMatchObject({ headerVersion: 1, access: 'owner' });
  await settled(() => expect(hook.getCurrent().status).toBe('ready'));
  expect(bodyReadsSince(start)).toEqual([ref.artifactId]);
  expect(homes.requests.slice(start).filter(request => request.path === `/v1/artifacts/${ref.artifactId}/access/grants`)).toHaveLength(1);
  await hook.unmount();
});

it('opens only the displayed Memory body for a permitted non-owner reader', async () => {
  await settleInitialArtifactInventory();
  const ref = await seedDocument({ v: 1, index: [fact('permitted', 'Keep the shared policy.')], topics: [] });
  // The real Artifact boundary admits this reader by its stored grant, not by a hand-built read result.
  const artifacts = homes.artifacts(serverId);
  artifacts.replaceStoredRow({ ...artifacts.read(ref.artifactId)!, ownerAccountId: 'memory-author' });
  artifacts.seedAccountGrant(ref.artifactId, 'account-a', 'view');
  const start = homes.requests.length;
  const hook = await renderHook(() => useMemoryDocument({ ref, serverId }));
  await settled(() => expect(hook.getCurrent().status).toBe('ready'));
  expect(hook.getCurrent().view).toMatchObject({ access: 'view', shared: true,
    facts: [{ id: 'permitted', text: 'Keep the shared policy.' }] });
  expect(hook.getCurrent().target).toBeNull();
  expect(bodyReadsSince(start)).toEqual([ref.artifactId]);
  await hook.unmount();
});

it('reads one changed Memory body through the real socket wake and ignores unrelated Artifact wakes', async () => {
  await settleInitialArtifactInventory();
  const ref = await seedDocument({ v: 1, index: [fact('one', 'Keep the original policy.')], topics: [] });
  const hook = await renderHook(() => useMemoryDocument({ ref, serverId }));
  await settled(() => expect(hook.getCurrent().status).toBe('ready'));
  const start = homes.requests.length;
  const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
  await act(async () => {
    for (let index = 0; index < 5; index++) publishHomeAccountChange(serverId, [`unrelated-${index}`], { changeKinds: ['artifact'] });
  });
  expect(bodyReadsSince(start)).toEqual([]);
  const artifacts = homes.artifacts(serverId);
  const original = artifacts.read(ref.artifactId)!;
  if (original.bodyVersion === undefined) throw new Error('Expected the remote body revision');
  const { openArtifactPrivateRevisionMetadata, sealArtifactPrivateRevisionMetadata } = await import('@/sync/domains/artifacts/accountArtifactEnvelope');
  const provenance = await openArtifactPrivateRevisionMetadata({ mode: 'plain', artifactId: original.id,
    bodyVersion: original.bodyVersion, provenance: original.provenance });
  // Remote writes must advance the private metadata's bound revision with the body.
  const privateMetadata = provenance ? { provenance: await sealArtifactPrivateRevisionMetadata({ mode: 'plain',
    artifactId: original.id, bodyVersion: original.bodyVersion + 1, provenance }),
    provenanceDataEncryptionKey: original.provenanceDataEncryptionKey } : {};
  const response = await artifacts.handle(`/v1/artifacts/${ref.artifactId}`, { method: 'POST', body: JSON.stringify({
    expectedBodyVersion: original.bodyVersion,
    body: encodePlainArtifactStoredContent({ body: JSON.stringify(MemoryDocBodyV1Schema.parse({
      v: 1, index: [fact('two', 'Use the revised policy.')], topics: [],
    })) }), ...privateMetadata,
  }) });
  expect(response?.ok).toBe(true);
  const changed = artifacts.read(ref.artifactId)!;
  await deliverMemoryBodyUpdate(ref);
  await settled(() => expect(hook.getCurrent().view?.facts).toMatchObject([{ id: 'two', text: 'Use the revised policy.' }]));
  expect(storage.getState().artifacts[ref.artifactId]?.bodyVersion).toBe(changed.bodyVersion);
  expect(bodyReadsSince(start)).toEqual([ref.artifactId]);
  expect(homes.requests.slice(start).filter(request => request.path === `/v1/artifacts/${ref.artifactId}/access/grants`)).toHaveLength(1);
  await hook.unmount();
});

it.each(['reviewed', 'project'] as const)('keeps Memory save preparation (%s) to one body and one fresh exposure read without refreshing the displayed document', async target => {
  await settleInitialArtifactInventory();
  const ref = await seedDocument({ v: 1, index: [fact('one', 'Verify payment signatures.')], topics: [] });
  const hook = await renderHook(() => useMemoryDocument({ ref, serverId }));
  await settled(() => expect(hook.getCurrent().status).toBe('ready'));
  const displayed = hook.getCurrent().view!;
  if (target === 'project') serveProjectContext(false, false, [{ id: 'project.memory', ref, enabled: true, placement: 'system_append' }]);
  const executor = createDefaultActionExecutor();
  const requestStart = homes.requests.length;
  let prepared: Awaited<ReturnType<typeof executor.prepare>> | undefined;
  await act(async () => {
    prepared = await executor.prepare('memory.remember', {
      ...(target === 'project' ? { scope: 'project' as const, projectRef: { serverId, projectKey: 'project' } }
        : { ref, expectedRevision: displayed.revision }),
      text: 'Keep the reviewed webhook policy.',
    }, { surface: 'ui', serverId, authority: 'present_user', actionCaller: { kind: 'host' } });
  });
  expect(prepared).toMatchObject({ kind: 'ready' });
  await settled(() => expect(hook.getCurrent().status).toBe('ready'));
  const requests = homes.requests.slice(requestStart);
  expect(bodyReadsSince(requestStart)).toEqual([ref.artifactId]);
  expect(requests.filter(request => request.path === `/v1/artifacts/${ref.artifactId}/access/grants`)).toHaveLength(1);
  expect(hook.getCurrent().view).toBe(displayed);
  expect(storedBody(ref).index).toHaveLength(1);
  await hook.unmount();
});

it.each(['Build', MEMORY_ARCHIVE_TOPIC_TITLE_V1])(
  'reads %s facts and their audience from one admitted body',
  async (topic) => {
    await settleInitialArtifactInventory();
    const ref = await seedDocument({
      v: 1,
      index: [],
      topics: [
        {
          title: topic,
          summary: 'Saved topic',
          facts: [fact('topic-fact', 'Use the reviewed topic fact.')],
        },
      ],
    });
    const requestStart = homes.requests.length;
    const hook = await renderHook(() =>
      useMemoryDocument({ ref, serverId, topic }),
    );
    await settled(() => expect(hook.getCurrent().status).toBe('ready'));
    expect(hook.getCurrent().view).toMatchObject({
      facts: [expect.objectContaining({ id: 'topic-fact' })],
      topic: { title: topic },
      access: 'owner',
      audience: { shared: false },
    });
    expect(
      homes.requests
        .slice(requestStart)
        .filter(
          (request) => request.path === `/v1/artifacts/${ref.artifactId}`,
        ),
    ).toHaveLength(1);
    await hook.unmount();
  },
);

it('does not claim the Project Team holds an individually shared Memory grant', async () => {
  const ref = await seedDocument({
    v: 1,
    index: [fact('one', 'Verify signatures.')],
    topics: [],
  });
  homes.artifacts(serverId).seedAccountGrant(ref.artifactId, 'bob', 'view');
  if (!connection) throw new Error('Expected Account fixture');
  const project = {
    name: 'Payments',
    teamName: 'Unrelated Team',
    searchScope: {
      type: 'project' as const,
      projectRef: { serverId, projectKey: 'payments' },
    },
    href: () => '/projects/payments/memory',
  };
  const screen = await renderScreen(
    <InjectedAuthProvider credentials={connection.credentials}>
      <MemoryDocumentScreen
        artifactId={ref.artifactId}
        serverId={serverId}
        project={project}
      />
    </InjectedAuthProvider>,
  );
  await settled(() =>
    expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe(
      'ready',
    ),
  );
  const { PageHeader } = await import('@/components/ui/layout/PageHeader');
  const audience = screen
    .findAllByType(PageHeader)
    .flatMap((node) => node.props.meta ?? [])
    .find((entry) => entry.testID === 'memory-document.audience');
  expect(audience?.text).toBe('memoryContext.memory.accessShared');
});

it('refreshes the admitted Memory audience after a grant-only Account change', async () => {
  const ref = await seedDocument({
    v: 1,
    index: [fact('one', 'Verify payment signatures.')],
    topics: [],
  });
  const hook = await renderHook(() => useMemoryDocument({ ref, serverId }));
  await settled(() => expect(hook.getCurrent().status).toBe('ready'));
  expect(hook.getCurrent().view?.shared).toBe(false);
  homes
    .artifacts(serverId)
    .seedAccountGrant(ref.artifactId, 'teammate', 'view');
  const { publishHomeAccountChange } =
    await import('@/sync/runtime/orchestration/homeAccountChange');
  await React.act(async () => {
    publishHomeAccountChange(serverId, [ref.artifactId], {
      changeKinds: ['artifact'],
    });
  });
  await settled(() => expect(hook.getCurrent().view?.shared).toBe(true));
  await hook.unmount();
});

it.each([
  {
    title:
      'cancels pending Memory reads across bearer renewal while retaining the displayed Account',
    replaceCredentials: true,
  },
  {
    title:
      'adopts a successor Memory read when the admitted credentials are unchanged',
    replaceCredentials: false,
  },
])('$title', async ({ replaceCredentials }) => {
  if (!connection)
    throw new Error('Expected the admitted Memory Account fixture');
  const ref = await seedDocument({
    v: 1,
    index: [fact('one', 'Keep the original custody.')],
    topics: [],
  });
  const hook = await renderHook(() => useMemoryDocument({ ref, serverId }));
  await settled(() => expect(hook.getCurrent().status).toBe('ready'));
  const originalTarget = hook.getCurrent().target;
  expect(originalTarget).toBeTruthy();
  const path = '/v1/artifacts/' + ref.artifactId;
  const response = await homes
    .artifacts(serverId)
    .handle(path, { method: 'GET' });
  if (!response)
    throw new Error('Expected the real Artifact boundary response');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  homes.answer(serverId, path, {
    body: await response.json(),
    respondAfter: held,
  });
  const reads = () =>
    homes.requests.filter(
      (request) => request.path === path && request.input === null,
    ).length;
  const before = reads();
  let first!: ReturnType<ReturnType<typeof useMemoryDocument>['refresh']>;
  let successor!: ReturnType<ReturnType<typeof useMemoryDocument>['refresh']>;
  try {
    await React.act(async () => {
      first = hook.getCurrent().refresh();
    });
    await settled(() => expect(reads()).toBeGreaterThan(before));
    const afterFirst = reads();
    await React.act(async () => {
      successor = hook.getCurrent().refresh();
    });
    await settled(() => expect(reads()).toBeGreaterThan(afterFirst));
    if (replaceCredentials)
      await React.act(async () => {
        expect(
          await TokenStorage.setCredentialsForServerUrl(
            'https://memory-body.test',
            { serverId },
            {
              ...connection!.credentials,
              token: `${connection!.credentials.token}-replacement`,
            },
          ),
        ).toBe(true);
      });
  } finally {
    await React.act(async () => {
      release();
      await Promise.all([first, successor]);
    });
  }
  if (replaceCredentials) {
    expect(await first).toBeNull();
    expect(await successor).toBeNull();
  } else {
    const target = await successor;
    expect(target?.accountId).toBe('account-a');
    expect(await first).toBe(target);
    expect(reads() - before).toBe(2);
  }
  expect(originalTarget?.isCurrent()).toBe(true);
  await settled(() => expect(hook.getCurrent().status).toBe('ready'));
  expect(hook.getCurrent().target?.accountId).toBe('account-a');
  expect(hook.getCurrent().target?.isCurrent()).toBe(true);
  await hook.unmount();
});

it('reads document content through memory.read admission instead of bypassing a disabled UI Action', async () => {
  const settings = {
    ...baseline.settings,
    actionsSettingsV1: ActionsSettingsV1Schema.parse({
      v: 1,
      actions: { 'memory.read': { disabledSurfaces: ['ui'] } },
    }),
  };
  homes.answer(serverId, 'GET /v2/account/settings', {
    body: { content: { t: 'plain', v: settings }, version: 2 },
  });
  storage
    .getState()
    .applySettingsForScope({ serverId, accountId: 'account-a' }, settings, 2);
  const ref = await seedDocument({
    v: 1,
    index: [fact('one', 'One')],
    topics: [],
  });
  const hook = await renderHook(() => useMemoryDocument({ ref, serverId }));
  await settled(() => expect(hook.getCurrent().status).toBe('unavailable'));
  await hook.unmount();
});

it('asks for a Memory Machine instead of failing the counts when none is chosen, without fabricating counts', async () => {
  const ref = await seedDocument({
    v: 1,
    index: [fact('one', 'One'), fact('two', 'Two')],
    topics: [
      {
        title: 'detail',
        summary: 'More facts',
        facts: [fact('three', 'Three')],
      },
    ],
  });
  const screen = await renderDocument(ref);
  const rendered = screen.getTextContent();
  expect(rendered).toContain('memoryContext.memory.countsNeedMachine');
  expect(screen.findByTestId('memory.machine.state')).toBeTruthy();
  expect(screen.findByTestId('memory.summaryUnavailable')).toBeNull();
  expect(rendered).not.toContain('memoryContext.memory.countsUnavailable');
  expect(rendered).not.toContain('common.unavailable');
  expect(rendered).not.toContain('2 facts');
  expect(machineRpc).not.toHaveBeenCalled();
  await screen.unmount();
});

it('keeps an honest error with Retry when the chosen Memory Machine fails to answer the counts', async () => {
  const ref = await seedDocument({
    v: 1,
    index: [fact('one', 'One')],
    topics: [],
  });
  await setServerProfileIdentityForUrl(
    'https://memory-body.test',
    'srv_memory_body',
  );
  selectSummaryDaemon(serverId, 'srv_memory_body');
  await sync.refreshMachines();
  machineRpc.mockRejectedValue(new Error('daemon failed'));
  const screen = await renderDocument(ref);
  await settled(() =>
    expect(screen.findByTestId('memory.summaryUnavailable')).toBeTruthy(),
  );
  expect(screen.getTextContent()).toContain(
    'memoryContext.memory.countsUnavailable',
  );
  expect(screen.findByTestId('memory.machine.state')).toBeNull();
  await screen.unmount();
});

it('says it is offline once and keeps the retained facts, instead of an error with Retry on the counts', async () => {
  const ref = await seedDocument({
    v: 1,
    index: [fact('one', 'One')],
    topics: [],
  });
  await setServerProfileIdentityForUrl(
    'https://memory-body.test',
    'srv_memory_body',
  );
  selectSummaryDaemon(serverId, 'srv_memory_body');
  await sync.refreshMachines();
  machineRpc.mockRejectedValue(new Error('daemon failed'));
  await act(async () =>
    storage.getState().setEndpointConnectivity({
      status: 'offline',
      reason: null,
      attempt: 1,
      nextRetryAt: null,
      lastConnectedAt: Date.UTC(2026, 9, 28, 10, 40),
      lastDisconnectedAt: Date.UTC(2026, 9, 28, 10, 42),
      lastErrorMessage: null,
    }),
  );
  const screen = await renderDocument(ref);
  await settled(() =>
    expect(screen.findByTestId('memory.offline')).toBeTruthy(),
  );
  expect(screen.getTextContent()).toContain('memoryContext.memory.offlineHeld');
  expect(screen.getTextContent()).toContain('One');
  // Retained rows keep full strength: the one offline line carries the state (SurfaceFreshnessLine: rows never dim).
  const slot = factSlot(screen, 'one');
  expect(slot).not.toBeNull();
  const dimmed = slot!.findAll((node) => {
    const opacity = StyleSheet.flatten(node.props.style)?.opacity;
    return typeof opacity === 'number' && opacity < 1;
  });
  expect(dimmed).toEqual([]);
  expect(screen.findByTestId('memory.summaryUnavailable')).toBeNull();
  await screen.unmount();
});

describe('a save that cannot be written', () => {
  async function saveWithWriteRefused(offline: boolean) {
    const ref = await seedDocument({ v: 1, index: [fact('one', 'One')], topics: [] });
    const screen = await renderDocument(ref, { composing: true });
    if (offline) {
      await act(async () =>
        storage.getState().setEndpointConnectivity({
          status: 'offline', reason: null, attempt: 1, nextRetryAt: null,
          lastConnectedAt: null, lastDisconnectedAt: null, lastErrorMessage: null,
        }),
      );
    }
    homes.answer(serverId, 'POST /v1/artifacts/' + ref.artifactId, { status: 500, body: { error: 'write_failed' } });
    await act(async () => {
      screen.changeTextByTestId('memory.draft', 'A fact that cannot be saved');
    });
    const path = '/v1/artifacts/' + ref.artifactId;
    const writes = () => homes.requests.filter((request) => request.path === path && request.input !== null).length;
    const before = writes();
    await screen.pressByTestIdAsync('memory.draft.save');
    await settled(() => expect(writes()).toBeGreaterThan(before));
    // The attempt has ended once the form is editable again.
    await settled(() => expect(screen.findByType(InlineAddExpander).props.saveDisabled).toBe(false));
    return screen;
  }

  it('is told in place when the Home is reachable', async () => {
    const screen = await saveWithWriteRefused(false);
    await settled(() => expect(screen.findByTestId('memory.refused')).toBeTruthy());
    await screen.unmount();
  });

  it('is part of the one offline line while offline: the draft stays, no second notice', async () => {
    const screen = await saveWithWriteRefused(true);
    await flushHookEffects();
    expect(screen.findByTestId('memory.offline')).toBeTruthy();
    expect(screen.findByTestId('memory.refused')).toBeNull();
    expect(screen.findByTestId('memory.draft')).toBeTruthy();
    await screen.unmount();
  });
});

it('says a switched-off memory has no counts, instead of an error with Retry, a Machine choice or invented counts', async () => {
  const ref = await seedDocument({
    v: 1,
    index: [fact('one', 'One'), fact('two', 'Two')],
    topics: [],
  });
  const screen = await renderDocument(ref, { inUse: false });
  await settled(() =>
    expect(screen.findByTestId('memory.summaryOff')).toBeTruthy(),
  );
  const rendered = screen.getTextContent();
  expect(rendered).toContain('memoryContext.memory.countsOff');
  expect(screen.findByTestId('memory.summaryUnavailable')).toBeNull();
  expect(screen.findByTestId('memory.machine.state')).toBeNull();
  expect(rendered).not.toContain('common.retry');
  expect(rendered).not.toContain('memoryContext.memory.countsNeedMachine');
  expect(rendered).not.toContain('memoryContext.memory.alwaysRemembered');
  expect(rendered).not.toContain('0 facts');
  expect(machineRpc).not.toHaveBeenCalled();
  await screen.unmount();
});

it('shows unavailable counts instead of a permanent skeleton when the selected daemon never answers', async () => {
  const ref = await seedDocument({
    v: 1,
    index: [fact('one', 'One')],
    topics: [],
  });
  await setServerProfileIdentityForUrl(
    'https://memory-body.test',
    'srv_memory_body',
  );
  selectSummaryDaemon(serverId, 'srv_memory_body');
  await sync.refreshMachines();
  machineRpc.mockReturnValue(new Promise(() => {}));
  const screen = await renderDocument(ref);
  await settled(() => expect(machineRpc).toHaveBeenCalled());
  const rendered = screen.getTextContent();
  expect(rendered).not.toContain('common.loading');
  expect(screen.findByTestId('memory.summaryUnavailable')).toBeTruthy();
  expect(screen.findByTestId('memory.summary')).toBeNull();
  expect(rendered).not.toContain('memoryContext.memory.alwaysRemembered');
  await screen.unmount();
});

it('keeps last-known counts for the same document and preparation basis while a later revision has no status answer', async () => {
  const ref = await seedDocument({
    v: 1,
    index: [fact('one', 'One')],
    topics: [],
  });
  await setServerProfileIdentityForUrl(
    'https://memory-body.test',
    'srv_memory_body',
  );
  selectSummaryDaemon(serverId, 'srv_memory_body');
  await sync.refreshMachines();
  const response = summaryStatus(ref, { headerVersion: 1, bodyVersion: 1 });
  const initial = {
    ...response,
    documents: {
      ...response.documents,
      facts: response.documents.facts.slice(1),
    },
  };
  let refreshing = false;
  machineRpc.mockImplementation(() =>
    refreshing ? new Promise(() => {}) : Promise.resolve(initial),
  );
  const screen = await renderDocument(ref, { preparationBasis: 'initial' });
  const statusReads = () =>
    machineRpc.mock.calls.filter(
      ([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_STATUS,
    );
  await settled(() => expect(statusReads().length).toBeGreaterThan(0));
  await flushHookEffects();
  const view = screen.findByType(MemoryDocumentBody).props.source.view;
  expect(
    screen.getTextContent(),
    JSON.stringify({
      ref: view?.ref,
      revision: view?.revision,
      response: initial.documents,
      requests: machineRpc.mock.calls.map(([request]) => ({
        serverId: request.serverId,
        method: request.method,
        payload: request.payload,
      })),
    }),
  ).toContain('7 facts');
  const readsBeforeRefresh = statusReads().length;
  refreshing = true;
  const current = screen.findByType(MemoryDocumentBody).props.source.target.expectedRevision;
  await act(async () => {
    expect(await createDefaultActionExecutor().execute('memory.remember', {
      ref, expectedRevision: current, text: 'Another fact in the same context.',
    }, { serverId, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
  });
  await deliverMemoryBodyUpdate(ref);
  await settled(() =>
    expect(statusReads().length).toBeGreaterThan(readsBeforeRefresh),
  );
  expect(screen.getTextContent()).toContain('7 facts');
  expect(screen.findByTestId('memory.summaryUnavailable')).toBeNull();
  await screen.unmount();
});

it('reads summary status only for a changed Account, custody, target, scope or document identity', async () => {
  const ref = await seedDocument({ v: 1, index: [fact('one', 'One')], topics: [] });
  await setServerProfileIdentityForUrl('https://memory-body.test', 'srv_memory_body');
  selectSummaryDaemon(serverId, 'srv_memory_body');
  await sync.refreshMachines();
  const document = await renderHook(() => useMemoryDocument({ ref, serverId }));
  await settled(() => expect(document.getCurrent().status).toBe('ready'));
  const admitted = document.getCurrent();
  if (!admitted.view || !admitted.draftCustody) throw new Error('Expected admitted Memory document');
  machineRpc.mockResolvedValue(summaryStatus(ref, admitted.view.revision));
  const clone = () => ({ ...admitted,
    view: { ...admitted.view!, ref: { ...admitted.view!.ref }, revision: { ...admitted.view!.revision } },
    draftCustody: { ...admitted.draftCustody!, scope: { ...admitted.draftCustody!.scope } },
  });
  let source = clone();
  const initialProps: { source: typeof source; sessionId?: string } = { source };
  const hook = await renderHook((props: typeof initialProps) =>
    useMemoryDocumentSummary({ source: props.source, serverId,
      scope: props.sessionId ? { type: 'session', sessionId: props.sessionId } : { type: 'global' } }),
  { initialProps });
  const reads = () => machineRpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_STATUS);
  expect(reads()).toHaveLength(1);
  for (let i = 0; i < 5; i++) await hook.rerender({ source: clone() });
  expect(reads()).toHaveLength(1);
  source = clone();
  source.view.revision.bodyVersion += 1;
  await hook.rerender({ source });
  expect(reads()).toHaveLength(2);
  source = { ...source, draftCustody: { ...source.draftCustody, key: 'successor-custody' } };
  await hook.rerender({ source });
  expect(reads()).toHaveLength(3);
  source = { ...source, draftCustody: { ...source.draftCustody,
    scope: { ...source.draftCustody.scope, accountId: 'successor-account' } } };
  await hook.rerender({ source });
  expect(reads()).toHaveLength(4);
  await hook.rerender({ source, sessionId: 'session-summary' });
  expect(reads()).toHaveLength(5);
  const machine = createMachineFixture({ id: 'successor-machine', activeAt: Date.now() });
  homes.answer(serverId, '/v1/machines', {
    body: [createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a' })],
  });
  await act(async () => storage.setState(state => ({
    machines: { ...state.machines, [machine.id]: machine },
    machineListByServerId: { ...state.machineListByServerId, [serverId]: [machine] },
    settings: { ...state.settings, machineAdministrationTargetsLocalV1: {
      'memory.settings': { serverIdentityId: 'srv_memory_body', machineId: machine.id },
    } },
  })));
  await sync.refreshMachines();
  await settled(() => expect(reads()).toHaveLength(6));
  expect(reads().at(-1)?.[0]).toMatchObject({ machineId: 'successor-machine' });
  await hook.unmount();
  expect(reads().at(-1)?.[0].signal.aborted).toBe(true);
  await document.unmount();
});

it('owns last-known counts in the summary reader and retires them with Account custody', async () => {
  const ref = await seedDocument({ v: 1, index: [fact('one', 'One')], topics: [] });
  await setServerProfileIdentityForUrl('https://memory-body.test', 'srv_memory_body');
  selectSummaryDaemon(serverId, 'srv_memory_body');
  await sync.refreshMachines();
  const document = await renderHook(() => useMemoryDocument({ ref, serverId }));
  await settled(() => expect(document.getCurrent().status).toBe('ready'));
  const source = document.getCurrent();
  if (!source.view || !source.draftCustody) throw new Error('Expected admitted Memory document');
  const response = summaryStatus(ref, source.view.revision);
  machineRpc.mockResolvedValue({ ...response, documents: { ...response.documents, facts: response.documents.facts.slice(1) } });
  const hook = await renderHook((props: { source: MemoryDocumentSource; basis: string }) =>
    useMemoryDocumentSummary({ source: props.source, serverId, preparationBasis: props.basis }),
  { initialProps: { source, basis: 'initial' } });
  await settled(() => expect(hook.getCurrent()).toMatchObject({ state: 'ready', indexedFactCount: 7 }));
  machineRpc.mockReturnValue(new Promise(() => {}));
  const revised = { ...source, view: { ...source.view,
    revision: { ...source.view.revision, bodyVersion: source.view.revision.bodyVersion + 1 } } };
  await hook.rerender({ source: revised, basis: 'initial' });
  expect(hook.getCurrent()).toMatchObject({ state: 'ready', indexedFactCount: 7 });
  const replacement = { ...revised, draftCustody: { ...source.draftCustody,
    scope: { ...source.draftCustody.scope, accountId: 'account-b' } } };
  await hook.rerender({ source: replacement, basis: 'initial' });
  expect(hook.getCurrent().state).toBe('unavailable');
  await hook.unmount();
  await document.unmount();
});

it('does not present one Machine coverage count while its replacement Machine status is pending', async () => {
  const ref = await seedDocument({ v: 1, index: [fact('one', 'One')], topics: [] });
  await setServerProfileIdentityForUrl('https://memory-body.test', 'srv_memory_body');
  selectSummaryDaemon(serverId, 'srv_memory_body');
  await sync.refreshMachines();
  const document = await renderHook(() => useMemoryDocument({ ref, serverId }));
  await settled(() => expect(document.getCurrent().status).toBe('ready'));
  const source = document.getCurrent();
  if (!source.view) throw new Error('Expected admitted Memory document');
  const response = summaryStatus(ref, source.view.revision);
  machineRpc.mockResolvedValue({ ...response, documents: { ...response.documents, facts: response.documents.facts.slice(1) } });
  const hook = await renderHook(() => useMemoryDocumentSummary({ source, serverId }));
  await settled(() => expect(hook.getCurrent()).toMatchObject({ state: 'ready', indexedFactCount: 7 }));
  machineRpc.mockReturnValue(new Promise(() => {}));
  await act(async () => selectSummaryDaemon(serverId, 'srv_memory_body', 'account-a', 'replacement-machine'));
  await sync.refreshMachines();
  await settled(() => expect(machineRpc.mock.calls.at(-1)?.[0].machineId).toBe('replacement-machine'));
  expect(hook.getCurrent()).toMatchObject({ state: 'unavailable', cause: { reason: 'status_pending', target: { machineId: 'replacement-machine' } } });
  await hook.unmount();
  await document.unmount();
});

it('keeps a retained cached Session title out of a Memory row when source access is denied, without reading sources for the list', async () => {
  if (!connection)
    throw new Error('Expected the Memory Home connection fixture');
  const source = { serverId, sessionId: 'denied-source-session' };
  const cached = createSessionFixture({
    id: source.sessionId,
    encryptionMode: 'plain',
    metadata: {
      path: '/private',
      host: 'host',
      summary: { text: 'Retained private source title', updatedAt: 1 },
    },
  });
  storage.getState().applySessions([cached]);
  homes.answer(serverId, `/v2/sessions/${source.sessionId}`, {
    status: 403,
    body: { error: 'forbidden' },
  });
  const ref = await seedDocument({
    v: 1,
    index: [
      {
        ...fact('from-session', 'Use the shared build script.'),
        sourceSessionRef: source,
      },
    ],
    topics: [],
  });
  const screen = await renderScreen(
    <InjectedAuthProvider credentials={connection.credentials}>
      <MemoryDocumentScreen artifactId={ref.artifactId} serverId={serverId} />
    </InjectedAuthProvider>,
  );
  await settled(() =>
    expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe(
      'ready',
    ),
  );
  expect(screen.getTextContent()).not.toContain(
    'Retained private source title',
  );
  expect(
    screen.findByTestId('memory-document.fact.from-session.source'),
  ).not.toBeNull();
  expect(
    homes.requests.some((request) => request.path.includes(source.sessionId)
      || request.path === '/v2/sessions/read-batch'),
  ).toBe(false);
  await screen.unmount();
});

it.each([false, true])(
  'opens a qualified fact source before its Session is loaded on this client (decision: %s)',
  async (decision) => {
    if (!connection)
      throw new Error('Expected the Memory Home connection fixture');
    const source = { serverId, sessionId: 'unloaded-source-session' };
    const ref = await seedDocument({
      v: 1,
      index: [
        {
          ...fact('from-session', 'Use the shared build script.'),
          sourceSessionRef: source,
          ...(decision
            ? {
                decision: {
                  reason: 'Exact committed source',
                  approvedBy: null,
                  sourceMessageRef: {
                    kind: 'session' as const,
                    session: source,
                    messageId: 'committed-source',
                  },
                },
              }
            : {}),
        },
        fact('manual', 'Keep release notes concise.'),
      ],
      topics: [],
    });
    expect(storage.getState().sessions[source.sessionId]).toBeUndefined();
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={connection.credentials}>
        <MemoryDocumentScreen artifactId={ref.artifactId} serverId={serverId} />
      </InjectedAuthProvider>,
    );
    await settled(() =>
      expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe(
        'ready',
      ),
    );
    expect(
      Boolean(screen.findByTestId('memory-document.fact.manual.source')),
    ).toBe(false);
    expect(
      Boolean(screen.findByTestId('memory-document.fact.from-session.source')),
    ).toBe(true);
    await screen.pressByTestIdAsync('memory-document.fact.from-session.source');
    // The real navigation owner must carry the fact's Home, not require a loaded Session/title.
    expect(navigation.navigate).toHaveBeenCalledWith(
      `/session/${source.sessionId}${decision ? '/message/server%3Acommitted-source' : ''}?serverId=${encodeURIComponent(serverId)}`,
      expect.anything(),
    );
    await screen.unmount();
  },
);

/** Coding-row HTTP/CAS boundary: the actual catalog reader and attachment writer run above it. */
function serveAccountContext(
  conflict = false,
  entries: Extract<
    PromptLibraryRecordV1,
    { key: 'coding' }
  >['value']['entries'] = [],
) {
  let record: Extract<PromptLibraryRecordV1, { key: 'coding' }> = {
    key: 'coding',
    value: { v: 1, scope: { kind: 'coding' }, entries },
  };
  let revision = 4;
  homes.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, {
    select: () => ({
      body: {
        status: 'listed',
        rows: [
          { key: 'coding', revision, content: { t: 'plain', v: record } },
          ...PromptLibraryCatalogKeyV1Schema.options
            .filter((key) => key !== 'coding')
            .map((key) => ({ key, revision: 1, content: null })),
        ],
      },
    }),
  });
  homes.answer(serverId, 'POST ' + PROMPT_LIBRARY_ROWS_ROUTE_V1 + '/coding', {
    select: (input) => {
      const mutation = PromptLibraryRowMutationV1Schema.parse(input);
      if (conflict || mutation.expectedRevision !== revision)
        return {
          status: 409,
          body: { status: 'conflict', revision: revision + 1 },
        };
      if (mutation.content?.t !== 'plain')
        throw new Error('Expected plain coding row');
      const next = PromptLibraryRecordV1Schema.parse(mutation.content.v);
      if (next.key !== 'coding') throw new Error('Expected coding row');
      record = next;
      revision += 1;
      return { body: { status: 'updated', revision, cursor: revision } };
    },
  });
  return { read: () => record.value.entries };
}

/** Personal Project row HTTP/CAS boundary, retaining its neighboring organization fields. */
function serveProjectContext(
  conflict = false,
  withWorkspace = false,
  entries: Extract<
    PromptLibraryRecordV1,
    { key: 'coding' }
  >['value']['entries'] = [],
) {
  const key = {
    kind: 'project-organization' as const,
    serverId,
    projectKey: 'project',
  };
  let value = ProjectAccountOrganizationV1Schema.parse({
    pinned: true,
    hidden: true,
    promptStack: entries,
  });
  let revision = 4;
  homes.answer(serverId, 'POST ' + PROJECT_ACCOUNT_ROWS_ROUTE_V1 + '/list', {
    select: () => ({
      body: createPlainProjectAccountRowListFixture({
        organizations: [{ key, value, revision }],
        ...(withWorkspace
          ? {
              workspaceRefs: [
                {
                  id: 'workspace',
                  serverId,
                  projectKey: 'project',
                  machineId: 'machine',
                  rootPath: '/repo',
                  createdAtMs: 1,
                },
              ],
            }
          : {}),
      }),
    }),
  });
  homes.answer(serverId, 'POST ' + PROJECT_ACCOUNT_ROWS_ROUTE_V1 + '/mutate', {
    select: (input) => {
      const mutation =
        ProjectAccountRowMutationRequestV1Schema.parse(input).mutations[0]!;
      if (conflict || mutation.expectedRevision !== revision)
        return { body: { status: 'conflict', key, revision: revision + 1 } };
      if (
        mutation.content?.t !== 'plain' ||
        !mutation.content.v ||
        typeof mutation.content.v !== 'object' ||
        !('value' in mutation.content.v)
      ) {
        throw new Error('Expected plain Project organization');
      }
      value = ProjectAccountOrganizationV1Schema.parse(
        mutation.content.v.value,
      );
      revision += 1;
      return {
        body: {
          status: 'updated',
          rows: [{ key, content: mutation.content, revision }],
          cursor: revision,
        },
      };
    },
  });
  return { read: () => value };
}

describe('MemoryDocumentBody', () => {
  it.each(['session', 'account', 'project'] as const)(
    'uses the admitted shared audience in the %s Memory access label',
    async (surface) => {
      if (!connection) throw new Error('Missing admitted Account fixture');
      const ref = await seedDocument({
        v: 1,
        index: [fact('shared-note', 'Verify payment signatures.')],
        topics: [],
      });
      homes
        .artifacts(serverId)
        .seedAccountGrant(ref.artifactId, 'teammate', 'view');
      const entry = {
        id: surface === 'session' ? 'session.memory' : 'account.memory',
        ref,
        enabled: true,
        placement: 'system_append' as const,
      };
      serveAccountContext(false, [entry]);
      let element: React.ReactElement;
      if (surface === 'session') {
        const base = createSessionFixture();
        if (!base.metadata) throw new Error('Missing owner metadata');
        const session = createSessionFixture({
          id: 's1',
          serverId,
          metadataVersion: 9,
          metadata: {
            ...base.metadata,
            bot: { kind: 'bot' },
            work: { memoryEnabled: true, promptStack: [entry] },
          },
        });
        element = (
          <SessionMemorySection session={session} serverId={serverId} />
        );
      } else if (surface === 'account') {
        const { PromptStackEditorScreen } =
          await import('@/components/settings/prompts/stacks/PromptStackEditorScreen');
        element = <PromptStackEditorScreen surface="coding" title="Context" />;
      } else {
        serveProjectContext(false, false, [entry]);
        const { ProjectContextBody } =
          await import('@/components/projects/context/ProjectContextBody');
        element = (
          <ProjectContextBody
            workspaceRef={{
              id: 'workspace',
              serverId,
              projectKey: 'project',
              machineId: 'machine',
              rootPath: '/repo',
              createdAtMs: 1,
            }}
          />
        );
      }
      const screen = await renderScreen(
        <InjectedAuthProvider credentials={connection.credentials}>
          {element}
        </InjectedAuthProvider>,
      );
      await settled(() =>
        expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe(
          'ready',
        ),
      );
      expect(screen.findByType(MemoryDocumentBody).props.footer).toContain(
        'memoryContext.memory.accessShared',
      );
      expect(screen.findByType(MemoryDocumentBody).props.footer).not.toContain(
        'memoryContext.memory.accessPrivate',
      );
      await screen.unmount();
    },
  );
  it('keeps foreign Context navigation on its admitted Home while its write target is withdrawn and the active Home is offline', async () => {
    const original = await seedDocument({
      v: 1,
      index: Array.from({ length: 5 }, (_, i) =>
        fact('f' + i, 'Foreign fact ' + i),
      ),
      topics: [{ title: 'releases', summary: 'Release details', facts: [] }],
    });
    const foreignHome = await homes.addHome({
      name: 'Foreign memory',
      serverUrl: 'https://foreign-memory.test',
      accountId: 'foreign-a',
      active: false,
    });
    homes.answer(foreignHome, '/v1/account/encryption/currentness', {
      body: createPlainAccountEncryptionCurrentnessFixture(),
    });
    const stored = homes.artifacts(serverId).read(original.artifactId)!;
    const created = await homes.artifacts(foreignHome).handle('/v1/artifacts', {
      method: 'POST',
      body: JSON.stringify({
        id: stored.id,
        header: stored.header,
        body: stored.body,
        dataEncryptionKey: stored.dataEncryptionKey,
      }),
    });
    expect(created?.ok).toBe(true);
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(homes.request);
    const ref = { ...original, serverId: foreignHome };
    if (!connection) throw new Error('Missing admitted Account fixture');
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={connection.credentials}>
        <ItemList>
          <ContextMemorySection
            testID="context.memory"
            title="Memory"
            description="Memory"
            serverId={serverId}
            entry={{
              id: 'account.memory',
              ref,
              enabled: true,
              placement: 'system_append',
            }}
            footer="Memory"
            emptyText="empty"
          />
        </ItemList>
      </InjectedAuthProvider>,
    );
    await settled(() =>
      expect(
        screen.findByType(MemoryDocumentBody).props.source.status,
      ).not.toBe('loading'),
    );
    expect(
      screen.findByType(MemoryDocumentBody).props.source.status,
      boundaryDiagnostic(),
    ).toBe('ready');
    const bodyTestId = screen.findByType(MemoryDocumentBody).props.testID;
    await act(async () => storage.getState().setEndpointConnectivity({
      status: 'offline', reason: null, attempt: 1, nextRetryAt: null,
      lastConnectedAt: 1, lastDisconnectedAt: 2, lastErrorMessage: null,
    }));
    expect(screen.findByTestId(`${bodyTestId}.offline`)).toBeNull();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    homes.answer(foreignHome, '/v1/artifacts/' + ref.artifactId, {
      status: 503,
      body: { error: 'offline' },
      respondAfter: held,
    });
    let pending!: ReturnType<ReturnType<typeof useMemoryDocument>['refresh']>;
    await React.act(async () => {
      pending = screen.findByType(MemoryDocumentBody).props.source.refresh();
    });
    try {
      for (const status of ['refreshing', 'unavailable']) {
        expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe(
          status,
        );
        if (status === 'unavailable') expect(screen.findByTestId(`${bodyTestId}.unavailable`)).not.toBeNull();
        expect(
          screen.findByType(MemoryDocumentBody).props.source.target,
        ).toBeNull();
        const href =
          '/settings/prompts/memory/' +
          ref.artifactId +
          '?serverId=' +
          encodeURIComponent(foreignHome);
        await screen.pressByTestIdAsync('context.memory.showAll');
        expect(navigation.push).toHaveBeenLastCalledWith(href);
        await screen.pressByTestIdAsync('context.memory.topic.releases');
        expect(navigation.push).toHaveBeenLastCalledWith(
          href + '&topic=releases',
        );
        await React.act(async () => {
          release();
          await pending;
        });
      }
    } finally {
      await React.act(async () => {
        release();
        await pending;
      });
    }
  });

  it.each([
    {
      remoteAccess: 'view' as const,
      localAccess: null,
      readOnly: true,
      shared: true,
    },
    {
      remoteAccess: 'edit' as const,
      localAccess: 'view' as const,
      readOnly: false,
      shared: true,
    },
    {
      remoteAccess: 'owner' as const,
      localAccess: 'view' as const,
      readOnly: false,
      shared: false,
    },
  ])(
    'Work uses qualified memory access $remoteAccess instead of ambient $localAccess',
    async ({ remoteAccess, localAccess, readOnly, shared }) => {
      const original = await seedDocument({
        v: 1,
        index: [fact('foreign-fact', 'Qualified fact')],
        topics: [],
      });
      await setServerProfileIdentityForUrl(
        'https://memory-body.test',
        'srv_memory_body',
      );
      const foreignHome = await homes.addHome({
        name: 'Foreign memory',
        serverUrl: 'https://foreign-memory.test',
        serverIdentityId: 'srv_foreign_memory',
        accountId: 'foreign-a',
        active: false,
      });
      homes.answer(foreignHome, '/v1/account/encryption/currentness', {
        body: createPlainAccountEncryptionCurrentnessFixture(),
      });
      const stored = homes.artifacts(serverId).read(original.artifactId)!;
      if (stored.bodyVersion === undefined)
        throw new Error('Missing stored Artifact body revision');
      await homes.artifacts(foreignHome).handle('/v1/artifacts', {
        method: 'POST',
        body: JSON.stringify({
          id: stored.id,
          header: stored.header,
          body: stored.body,
          dataEncryptionKey: stored.dataEncryptionKey,
        }),
      });
      if (remoteAccess !== 'owner') {
        homes
          .artifacts(foreignHome)
          .replaceStoredRow({
            ...homes.artifacts(foreignHome).read(original.artifactId)!,
            ownerAccountId: 'another-owner',
          });
        homes
          .artifacts(foreignHome)
          .seedAccountGrant(original.artifactId, 'foreign-a', remoteAccess);
      }
      const ref = { ...original, serverId: foreignHome };
      serveAccountContext(false, [
        {
          id: 'account.memory',
          ref,
          enabled: true,
          placement: 'system_append',
        },
      ]);
      if (localAccess)
        storage
          .getState()
          .applyArtifacts([
            {
              ...storage.getState().artifacts[original.artifactId]!,
              access: localAccess,
            },
          ]);
      else storage.getState().deleteArtifact(original.artifactId);
      const base = createSessionFixture();
      if (!base.metadata || !connection)
        throw new Error('Missing admitted Session/Account fixture');
      const session = createSessionFixture({
        id: 's1',
        serverId,
        metadataVersion: 9,
        metadata: { ...base.metadata, work: { memoryEnabled: true } },
      });
      storage.getState().applySessions([session]);
      selectSummaryDaemon(serverId, 'srv_memory_body');
      machineRpc.mockResolvedValue(
        summaryStatus(ref, {
          headerVersion: stored.headerVersion,
          bodyVersion: stored.bodyVersion,
        }),
      );
      const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
      setRuntimeFetch(homes.request);
      const screen = await renderScreen(
        <InjectedAuthProvider credentials={connection.credentials}>
          <SessionMemorySection session={session} serverId={serverId} />
        </InjectedAuthProvider>,
      );
      await settled(() =>
        expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe(
          'ready',
        ),
      );
      await settled(() => expect(screen.getTextContent()).toContain('7 facts'));
      expect(machineRpc).toHaveBeenCalled();
      machineRpc.mock.calls.forEach(([request]) =>
        expect(request).toMatchObject({
          serverId: 'srv_memory_body',
          accountId: 'account-a',
          machineId: 'memory-machine',
          method: RPC_METHODS.DAEMON_MEMORY_STATUS,
          payload: { scope: { type: 'session', sessionId: 's1' } },
        }),
      );
      expect(screen.getTextContent()).toContain('2 facts');
      expect(screen.getTextContent()).not.toContain('99 facts');
      expect(screen.findByType(MemoryDocumentBody).props.readOnly).toBe(
        readOnly,
      );
      expect(Boolean(screen.findByTestId('session-work-memory.remember'))).toBe(
        !readOnly,
      );
      expect(screen.findByType(MemoryDocumentBody).props.footer).toContain(
        shared
          ? 'memoryContext.memory.writesAskFirst'
          : 'memoryContext.memory.writesWithoutAsking',
      );
      await screen.unmount();
      machineRpc.mockClear();
      selectSummaryDaemon(foreignHome, 'srv_foreign_memory', 'foreign-a');
      const page = await renderScreen(
        <InjectedAuthProvider credentials={connection.credentials}>
          <MemoryDocumentScreen
            artifactId={ref.artifactId}
            serverId={foreignHome}
          />
        </InjectedAuthProvider>,
      );
      await settled(() =>
        expect(page.findByType(MemoryDocumentBody).props.source.status).toBe(
          'ready',
        ),
      );
      await settled(() => expect(page.getTextContent()).toContain('7 facts'));
      expect(machineRpc).toHaveBeenCalled();
      machineRpc.mock.calls.forEach(([request]) =>
        expect(request).toMatchObject({
          serverId: 'srv_foreign_memory',
          accountId: 'foreign-a',
          payload: { scope: { type: 'global' } },
        }),
      );
      expect(page.findByType(MemoryDocumentBody).props.readOnly).toBe(readOnly);
      expect(Boolean(page.findByTestId('memory-document.remember'))).toBe(
        !readOnly,
      );
    },
  );

  it('never retains equal-id facts or a reviewed target when a mounted read switches Homes', async () => {
    const ref = await seedDocument({
      v: 1,
      index: [fact('home-a-fact', 'Only Home A knows this.')],
      topics: [],
    });
    const homeB = await homes.addHome({
      name: 'Other memory Home',
      serverUrl: 'https://other-memory.test',
      accountId: 'account-b',
      active: false,
    });
    homes.answer(homeB, '/v1/artifacts/' + ref.artifactId, {
      status: 503,
      body: { error: 'offline' },
    });
    const seen: ReturnType<typeof useMemoryDocument>[] = [];
    const hook = await renderHook(
      (documentRef: PromptDocArtifactRefV1) => {
        const value = useMemoryDocument({ ref: documentRef, serverId });
        seen.push(value);
        return value;
      },
      { initialProps: ref },
    );
    await settled(() => expect(hook.getCurrent().status).toBe('ready'));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    homes.answer(serverId, '/v1/artifacts/' + ref.artifactId, {
      body: homes.artifacts(serverId).read(ref.artifactId),
      respondAfter: held,
    });
    let pending!: ReturnType<ReturnType<typeof useMemoryDocument>['refresh']>;
    await React.act(async () => {
      pending = hook.getCurrent().refresh();
    });
    await settled(() => expect(hook.getCurrent().status).toBe('refreshing'));
    seen.length = 0;
    await hook.rerender({ ...ref, serverId: homeB });
    await settled(() => expect(hook.getCurrent().status).toBe('unavailable'));
    await React.act(async () => {
      release();
      await pending;
    });
    expect(
      seen.every((value) => value.view === null && value.target === null),
    ).toBe(true);
    expect(hook.getCurrent()).toMatchObject({
      status: 'unavailable',
      view: null,
      target: null,
      stale: false,
    });
  });

  it('preserves an unpublished Memory draft when the same Account renews its bearer', async () => {
    if (!connection) throw new Error('Missing admitted Account fixture');
    const ref = await seedDocument({ v: 1, index: [fact('one', 'Published fact')], topics: [] });
    const screen = await renderDocument(ref);
    const actions: readonly ItemAction[] = screen.findByType(ItemRowActions).props.actions;
    await act(async () => actions.find(action => action.id === 'edit')!.onPress!());
    await act(async () => screen.changeTextByTestId('memory.draft', 'Unpublished revision'));
    // Same parsed principal and identical Plain Account material; only the bearer bytes change.
    const renewed = { ...connection.credentials, token: connection.credentials.token.replace(/\.[^.]+$/, '.renewed') };
    const renewal: { rollback: Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>> } = { rollback: null };
    try {
      await act(async () => {
        renewal.rollback = await TokenStorage.setCredentialsForServerUrlWithRollback('https://memory-body.test',
          { serverId, preserveHistoricalEncryption: true }, renewed);
      });
      expect(renewal.rollback).not.toBeNull();
      await settled(() => expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe('ready'));
      expect(screen.findByTestId('memory.draft')?.props.value).toBe('Unpublished revision');
      expect(storedBody(ref).index[0]?.text).toBe('Published fact');
    } finally {
      await screen.unmount();
      await renewal.rollback?.rollback();
    }
  });

  it('retires a mounted memory view and reviewed revision when the same Home replaces its Account', async () => {
    const ref = await seedDocument({
      v: 1,
      index: [fact('account-a-fact', 'Private to Account A.')],
      topics: [],
    });
    const hook = await renderHook(() => useMemoryDocument({ ref, serverId }));
    await settled(() => expect(hook.getCurrent().status).toBe('ready'));
    const screen = await renderDocument(ref);
    const actions: readonly ItemAction[] =
      screen.findByType(ItemRowActions).props.actions;
    await React.act(async () => {
      actions.find((action) => action.id === 'edit')!.onPress!();
    });
    await React.act(async () => {
      screen.changeTextByTestId('memory.draft', 'Account A private draft');
    });
    expect(screen.findByTestId('memory.draft')?.props.value).toBe(
      'Account A private draft',
    );
    await connection?.dispose();
    connection = null;
    await homes.switchAccount(serverId, 'account-b');
    homes.answer(serverId, '/v1/artifacts/' + ref.artifactId, {
      status: 503,
      body: { error: 'offline' },
    });
    connection = await restoreServerAccountForTest({
      serverUrl: 'https://memory-body.test',
      accountId: 'account-b',
      request: homes.request,
    });
    installHomeGovernanceBoundaries(homes);
    await React.act(async () => {
      const scope = { serverId, accountId: 'account-b' };
      storage.getState().applySettingsForScope(scope, baseline.settings, 1);
      storage.getState().activateProfileScope(scope);
    });
    await hook.rerender();
    expect(hook.getCurrent().view).toBeNull();
    expect(hook.getCurrent().target).toBeNull();
    await settled(() => expect(hook.getCurrent().status).toBe('unavailable'));
    expect(screen.findByType(MemoryDocumentBody).props.source.view).toBeNull();
    expect(
      screen.findByType(MemoryDocumentBody).props.source.target,
    ).toBeNull();
    expect(Boolean(screen.findByTestId('memory.draft'))).toBe(false);
  });

  it.each(['same-fact', 'missing-fact'] as const)(
    'retires Account A private draft when Account B can edit the same shared document (%s)',
    async (replacement) => {
      const original = fact('shared-fact', 'Published shared fact.');
      const ref = await seedDocument({ v: 1, index: [original], topics: [] });
      if (!connection) throw new Error('Missing admitted Account fixture');
      const screen = await renderScreen(
        <InjectedAuthProvider credentials={connection.credentials}>
          <MemoryDocumentScreen
            artifactId={ref.artifactId}
            serverId={serverId}
          />
        </InjectedAuthProvider>,
      );
      await settled(() =>
        expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe(
          'ready',
        ),
      );
      const mountedBody = screen.findByType(MemoryDocumentBody);
      const actions: readonly ItemAction[] =
        screen.findByType(ItemRowActions).props.actions;
      await React.act(async () => {
        actions.find((action) => action.id === 'edit')!.onPress!();
      });
      await React.act(async () => {
        screen.changeTextByTestId(
          'memory-document.draft',
          'Account A unpublished private draft',
        );
      });
      const retiredSave: () => void =
        screen.findByType(InlineAddExpander).props.onSave;
      if (replacement === 'missing-fact') {
        const target =
          screen.findByType(MemoryDocumentBody).props.source.target;
        expect(
          await memoryDocumentActions.forget(target, original.id),
        ).toMatchObject({ ok: true });
      }
      const published = storedBody(ref);
      await connection?.dispose();
      connection = null;
      await homes.switchAccount(serverId, 'account-b');
      // B really reads and can edit A's shared document. Neither an unavailable read nor
      // shared-memory approval may hide reuse of A's unpublished draft under B's writer.
      homes
        .artifacts(serverId)
        .seedAccountGrant(ref.artifactId, 'account-b', 'edit');
      const replacementSettings = {
        ...baseline.settings,
        actionsSettingsV1: ActionsSettingsV1Schema.parse({
          v: 1,
          approvalWaivedSurfaces: {
            'memory.update': ['ui'],
            'memory.remember': ['ui'],
          },
        }),
      };
      homes.answer(serverId, 'GET /v2/account/settings', {
        body: {
          content: { t: 'plain', v: replacementSettings },
          version: 2,
        },
      });
      connection = await restoreServerAccountForTest({
        serverUrl: 'https://memory-body.test',
        accountId: 'account-b',
        request: homes.request,
      });
      installHomeGovernanceBoundaries(homes);
      const replacementConnection = connection;
      await React.act(async () => {
        const scope = { serverId, accountId: 'account-b' };
        storage.getState().applySettingsForScope(scope, replacementSettings, 2);
        storage.getState().activateProfileScope(scope);
        screen.update(
          <InjectedAuthProvider credentials={replacementConnection.credentials}>
            <MemoryDocumentScreen
              artifactId={ref.artifactId}
              serverId={serverId}
            />
          </InjectedAuthProvider>,
        );
      });
      await settled(() => {
        const source = screen.findByType(MemoryDocumentBody).props.source;
        expect(source.status).toBe('ready');
        expect(source.view.access).toBe('edit');
        expect(source.target.accountId).toBe('account-b');
      });
      expect(screen.findByType(MemoryDocumentBody)).toBe(mountedBody);
      expect(Boolean(screen.findByTestId('memory-document.draft'))).toBe(false);
      const requestIndex = homes.requests.length;
      await React.act(async () => {
        retiredSave();
      });
      await flushHookEffects();
      expect(
        homes.requests
          .slice(requestIndex)
          .filter(
            (request) =>
              request.path === '/v1/artifacts/' + ref.artifactId &&
              request.input !== null,
          ),
        boundaryDiagnostic(),
      ).toEqual([]);
      expect(storedBody(ref)).toEqual(published);
      await screen.pressByTestIdAsync('memory-document.remember');
      expect(screen.findByTestId('memory-document.draft')?.props.value).toBe(
        '',
      );
      await screen.pressByTestIdAsync('memory-document.draft.cancel');
    },
  );

  it.each(['old', 'displayed'] as const)('qualifies retained Memory custody by the displayed Home after an in-place switch (%s Account changes)', async changedHome => {
    const original = await seedDocument({ v: 1, index: [fact('private', 'Home-qualified content')], topics: [] });
    const foreignHome = await homes.addHome({ name: 'Other Memory Home', serverUrl: 'https://memory-custody.test',
      accountId: 'foreign-a', active: false });
    homes.answer(foreignHome, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    const stored = homes.artifacts(serverId).read(original.artifactId)!;
    const created = await homes.artifacts(foreignHome).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
      id: stored.id, header: stored.header, body: stored.body, dataEncryptionKey: stored.dataEncryptionKey,
    }) });
    expect(created?.ok).toBe(true);
    await homes.addHome({ name: 'Viewing Home', serverUrl: 'https://memory-viewer.test', accountId: 'viewer', active: false });
    await connection?.dispose();
    connection = await restoreServerAccountForTest({ serverUrl: 'https://memory-viewer.test', accountId: 'viewer', request: homes.request });
    const viewingScope = storage.getState().profileScope;
    installHomeGovernanceBoundaries(homes);
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(homes.request);
    const hook = await renderHook((ref: PromptDocArtifactRefV1) => useMemoryDocument({ ref, serverId }), { initialProps: original });
    await settled(() => expect(hook.getCurrent().status).toBe('ready'));
    const previous = hook.getCurrent();
    await hook.rerender({ ...original, serverId: foreignHome });
    await settled(() => expect(hook.getCurrent().target?.accountId).toBe('foreign-a'));
    expect.soft(previous.target?.isCurrent()).toBe(false);
    const displayed = hook.getCurrent();
    expect(displayed.target?.isCurrent()).toBe(true);
    await act(async () => homes.switchAccount(changedHome === 'old' ? serverId : foreignHome, 'replacement-account'));
    expect(storage.getState().profileScope).toEqual(viewingScope);
    expect.soft(displayed.target?.isCurrent()).toBe(changedHome === 'old');
    expect.soft(displayed.draftCustody?.isCurrent()).toBe(changedHome === 'old');
    await hook.unmount();
    expect(displayed.target?.isCurrent()).toBe(false);
  });

  it('retires a foreign Home memory view when its credentials change without changing the focused Account', async () => {
    const original = await seedDocument({
      v: 1,
      index: [fact('foreign-private', 'Only the foreign Account knows this.')],
      topics: [],
    });
    const foreignHome = await homes.addHome({
      name: 'Foreign memory',
      serverUrl: 'https://foreign-memory.test',
      accountId: 'foreign-a',
      active: false,
    });
    homes.answer(foreignHome, '/v1/account/encryption/currentness', {
      body: createPlainAccountEncryptionCurrentnessFixture(),
    });
    const stored = homes.artifacts(serverId).read(original.artifactId)!;
    const created = await homes.artifacts(foreignHome).handle('/v1/artifacts', {
      method: 'POST',
      body: JSON.stringify({
        id: stored.id,
        header: stored.header,
        body: stored.body,
        dataEncryptionKey: stored.dataEncryptionKey,
      }),
    });
    expect(created?.ok).toBe(true);
    installHomeGovernanceBoundaries(homes);
    // Connection restoration's default HTTP boundary admits only its focused Home.
    // This case deliberately reads a second Home through the same real transport.
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(homes.request);
    const ref = { ...original, serverId: foreignHome };
    const hook = await renderHook(() => useMemoryDocument({ ref, serverId }));
    await settled(() => expect(hook.getCurrent().status).not.toBe('loading'));
    expect(hook.getCurrent().status, boundaryDiagnostic()).toBe('ready');
    expect(hook.getCurrent().view?.facts[0]?.id).toBe('foreign-private');
    homes.answer(foreignHome, '/v1/artifacts/' + ref.artifactId, {
      status: 503,
      body: { error: 'offline' },
    });
    await React.act(async () => {
      await homes.switchAccount(foreignHome, 'foreign-b');
    });
    expect(storage.getState().profileScope).toEqual({
      serverId,
      accountId: 'account-a',
    });
    expect(hook.getCurrent().view).toBeNull();
    expect(hook.getCurrent().target).toBeNull();
    await settled(() => expect(hook.getCurrent().status).toBe('unavailable'));
  });

  it('keeps an unavailable Project unresolved instead of selecting Account memory, then accepts verified empty', async () => {
    const ref = await seedDocument({ v: 1, index: [], topics: [] });
    serveAccountContext(false, [
      { id: 'account.memory', ref, enabled: true, placement: 'system_append' },
    ]);
    homes.answer(serverId, 'POST ' + PROJECT_ACCOUNT_ROWS_ROUTE_V1 + '/list', {
      status: 503,
      body: { error: 'offline' },
    });
    // Work projects the admitted rows; the Account Sync owner performs acquisition.
    await expect(sync.refreshProjectAccountRows()).rejects.toThrow();
    const metadata = {
      machineId: 'machine',
      workspaceId: 'workspace',
      projectId: 'project',
      path: '/repo',
      work: { memoryEnabled: true },
    };
    const hook = await renderHook(() =>
      useSessionContextLayers({
        sessionId: 's1',
        serverId,
        ownerMetadata: metadata,
        metadataVersion: 9,
      }),
    );
    await settled(() => {
      expect(hook.getCurrent().project.status).toBe('unavailable');
      expect(hook.getCurrent().account).toHaveLength(1);
    });
    expect(selectSessionMemory(hook.getCurrent(), serverId)).toMatchObject({
      resolving: true,
      ref: null,
      scope: 'project',
    });
    const base = createSessionFixture();
    if (!base.metadata || !connection)
      throw new Error('Missing admitted Session/Account fixture');
    const session = createSessionFixture({
      id: 's1',
      serverId,
      metadataVersion: 9,
      metadata: { ...base.metadata, ...metadata },
    });
    storage.getState().applySessions([session]);
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={connection.credentials}>
        <SessionMemorySection session={session} serverId={serverId} />
      </InjectedAuthProvider>,
    );
    await settled(() =>
      expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe(
        'unavailable',
      ),
    );
    expect(screen.findByType(MemoryDocumentBody).props.footer).toBeUndefined();
    expect(Boolean(screen.findByTestId('session-work-memory.remember'))).toBe(
      false,
    );
    homes.answer(serverId, 'POST ' + PROJECT_ACCOUNT_ROWS_ROUTE_V1 + '/list', {
      body: createPlainProjectAccountRowListFixture({
        workspaceRefs: [
          {
            id: 'workspace',
            serverId,
            projectKey: 'project',
            machineId: 'machine',
            rootPath: '/repo',
            createdAtMs: 1,
          },
        ],
      }),
    });
    await React.act(async () => {
      await sync.refreshProjectAccountRows();
    });
    await settled(() => {
      expect(hook.getCurrent().project.status).toBe('ready');
      expect(selectSessionMemory(hook.getCurrent(), serverId)).toMatchObject({
        resolving: false,
        ref,
        scope: 'account',
      });
    });
    // A completed attachment-list read is not a completed kind/header read.
    expect(
      selectSessionMemory(
        {
          ...hook.getCurrent(),
          project: {
            ...hook.getCurrent().project,
            rows: [
              {
                layer: 'project',
                entry: {
                  id: 'project.document',
                  ref,
                  enabled: true,
                  placement: 'system_append',
                },
                title: null,
                kind: 'unknown',
                presentationStatus: 'loading',
                on: false,
                off: null,
                currentPresentation: () => ({
                  kind: 'unknown',
                  title: null,
                  headerKind: null,
                  access: null,
                }),
              },
            ],
          },
        },
        serverId,
      ),
    ).toMatchObject({ resolving: true, ref: null, scope: 'project' });
  });

  it('Work keeps the first saved memory reachable after attachment conflict and reuses it for the next fact', async () => {
    serveAccountContext(true);
    if (!connection) throw new Error('Missing admitted Account');
    const base = createSessionFixture();
    if (!base.metadata) throw new Error('Missing Session metadata fixture');
    const session = createSessionFixture({
      id: 's1',
      serverId,
      metadataVersion: 9,
      metadata: { ...base.metadata, work: { memoryEnabled: true } },
    });
    storage.getState().applySessions([session]);
    // Exact Session read at the genuine network boundary; ordinary Session writes target Account here.
    const row = SessionCurrentProjectionRecordV1Schema.parse({
      ...V2SessionRecordSchema.parse({
        id: 's1',
        seq: 0,
        active: false,
        activeAt: 0,
        createdAt: 1,
        updatedAt: 1,
        encryptionMode: 'plain',
        metadataLayoutVersion: 0,
        share: null,
        metadata: JSON.stringify(session.metadata),
        metadataVersion: 9,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: null,
      }),
      effectiveAccess: {
        v: 1,
        level: 'owner',
        sources: [{ kind: 'owner' }],
        capabilities: session.access!.capabilities,
      },
      responsibleAccountId: null,
      responsibleAccount: null,
    });
    homes.answer(serverId, 'GET /v2/sessions/s1?accessProjectionVersion=1', {
      body: { session: row },
    });
    homes.answer(serverId, 'GET /v2/sessions/s1', { body: { session: row } });
    homes.answer(serverId, 'GET /v1/sessions/s1/turns', {
      body: SessionTurnsProjectionV1Schema.parse({
        v: 1,
        sessionId: session.id,
        updatedAt: session.updatedAt,
        turns: [],
      }),
    });
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={connection.credentials}>
        <SessionMemorySection session={session} serverId={serverId} />
      </InjectedAuthProvider>,
    );
    await settled(() =>
      expect(
        screen.findByTestId('session-work-memory.remember')?.props.disabled,
        boundaryDiagnostic(),
      ).toBe(false),
    );
    await screen.pressByTestIdAsync('session-work-memory.remember');
    await React.act(async () => {
      screen.changeTextByTestId(
        'session-work-memory.doc.draft',
        'Keep this first fact.',
      );
    });
    await screen.pressByTestIdAsync('session-work-memory.doc.draft.save');
    await settled(() =>
      expect(
        !screen.findByTestId('session-work-memory.doc.draft') ||
          vi.mocked(Modal.alert).mock.calls.length > 0,
      ).toBe(true),
    );
    expect(vi.mocked(Modal.alert).mock.calls, boundaryDiagnostic()).toEqual([]);
    expect(
      screen.findByTestId('session-work-memory.doc.conflict'),
      boundaryDiagnostic(),
    ).toBeNull();
    await settled(() =>
      expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe(
        'ready',
      ),
    );
    const rows = homes.artifacts(serverId).list();
    expect(rows).toHaveLength(1);
    const ref = { kind: 'doc' as const, artifactId: rows[0]!.id, serverId };
    expect(
      screen.findByType(MemoryDocumentBody).props.source.target.ref,
    ).toEqual(ref);
    homes.answer(
      serverId,
      '/v1/public-shares?' +
        new URLSearchParams({
          subjectKind: 'artifact',
          subjectId: ref.artifactId,
        }),
      { body: { publicShares: [] } },
    );
    await screen.pressByTestIdAsync('session-work-memory.remember');
    await React.act(async () => {
      screen.changeTextByTestId(
        'session-work-memory.doc.draft',
        'Add to the same saved document.',
      );
    });
    await screen.pressByTestIdAsync('session-work-memory.doc.draft.save');
    await settled(() =>
      expect(
        !screen.findByTestId('session-work-memory.doc.draft') ||
          vi.mocked(Modal.alert).mock.calls.length > 0,
      ).toBe(true),
    );
    expect(vi.mocked(Modal.alert).mock.calls, boundaryDiagnostic()).toEqual([]);
    expect(storedBody(ref).index, boundaryDiagnostic()).toHaveLength(2);
    expect(homes.artifacts(serverId).list()).toHaveLength(1);

    const mountedBody = screen.findByType(MemoryDocumentBody);
    const firstFact = storedBody(ref).index[0]!;
    await connection.dispose();
    connection = null;
    await homes.switchAccount(serverId, 'account-b');
    const nextConnection = await restoreServerAccountForTest({
      serverUrl: 'https://memory-body.test',
      accountId: 'account-b',
      request: homes.request,
    });
    connection = nextConnection;
    installHomeGovernanceBoundaries(homes);
    await React.act(async () => {
      const scope = { serverId, accountId: 'account-b' };
      storage.getState().applySettingsForScope(scope, baseline.settings, 1);
      storage.getState().activateProfileScope(scope);
      screen.update(
        <InjectedAuthProvider credentials={nextConnection.credentials}>
          <SessionMemorySection session={session} serverId={serverId} />
        </InjectedAuthProvider>,
      );
    });
    await settled(() =>
      expect(
        screen.findByType(MemoryDocumentBody).props.source.status,
      ).not.toBe('loading'),
    );
    expect(
      screen.findByType(MemoryDocumentBody).props.source.status,
      boundaryDiagnostic(),
    ).toBe('none');
    expect(
      Boolean(
        screen.findByTestId('session-work-memory.doc.fact.' + firstFact.id),
      ),
    ).toBe(false);
    expect(screen.findByType(MemoryDocumentBody) === mountedBody).toBe(true);
  });

  it('a mounted Work layer follows a real Project edit without changing association or Settings version', async () => {
    const project = serveProjectContext(false, true);
    serveAccountContext();
    const ref = await seedDocument({ v: 1, index: [], topics: [] });
    await sync.refreshProjectAccountRows();
    const metadata = {
      machineId: 'machine',
      workspaceId: 'workspace',
      projectId: 'project',
      path: '/repo',
      work: { memoryEnabled: true },
    };
    const hook = await renderHook(() =>
      useSessionContextLayers({
        sessionId: 's1',
        serverId,
        ownerMetadata: metadata,
        metadataVersion: 9,
      }),
    );
    await settled(() => expect(hook.getCurrent().project.status).toBe('ready'));
    expect(hook.getCurrent().project.rows).toEqual([]);
    const result = await createDefaultActionExecutor().execute(
      'projects.context.update',
      {
        target: { serverId, projectKey: 'project' },
        expectedRevision: 4,
        intent: {
          kind: 'attach',
          entry: {
            id: 'project.memory',
            ref,
            enabled: true,
            placement: 'system_append',
          },
        },
      },
      { surface: 'ui', serverId },
    );
    expect(result).toMatchObject({ ok: true, result: { ok: true } });
    expect(project.read().promptStack).toHaveLength(1);
    await settled(() =>
      expect(hook.getCurrent().project.rows).toMatchObject([
        { entry: { id: 'project.memory' }, kind: 'memory' },
      ]),
    );
    expect(storage.getState().settingsVersion).toBe(1);
  });

  it('keeps unavailable Account and Profile catalogs explicit rather than reporting inherited empty', async () => {
    serveAccountContext();
    const hook = await renderHook(() =>
      useSessionContextLayers({
        sessionId: 's1',
        serverId,
        ownerMetadata: {
          profileId: 'selected-profile',
          work: { memoryEnabled: true },
        },
        metadataVersion: 9,
      }),
    );
    const { getPromptLibraryCatalogValue } =
      await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
    await settled(() =>
      expect(
        getPromptLibraryCatalogValue(
          { serverId, accountId: 'account-a' },
          'coding',
        ).status,
      ).toBe('ready'),
    );
    const { applyPromptLibraryCatalogSnapshot } =
      await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
    const { applyProfileCatalogSnapshot } =
      await import('@/sync/store/settings/profileCatalogSnapshot');
    await React.act(async () => {
      const scope = { serverId, accountId: 'account-a' };
      applyPromptLibraryCatalogSnapshot(
        scope,
        {
          catalog: { status: 'unavailable', reason: 'forbidden' },
          rawSettings: {},
          sourceSettingsVersion: 1,
        },
        true,
      );
      applyProfileCatalogSnapshot(
        scope,
        { status: 'unavailable', reason: 'forbidden' },
        true,
      );
    });
    expect(hook.getCurrent()).toMatchObject({
      accountStatus: 'unavailable',
      profile: { status: 'unavailable' },
    });
    expect(selectSessionMemory(hook.getCurrent(), serverId)).toMatchObject({
      resolving: true,
      ref: null,
    });
  });
  it('shows the index first — key facts, then topics — and a topic opens its own page', async () => {
    const ref = await seedDocument({
      v: 1,
      index: [
        fact('f1', 'Releases ship from release/0.3.'),
        fact('f2', 'Changelog order: Features, Fixes.'),
      ],
      topics: [
        { title: 'releases', summary: 'How releases are cut.', facts: [] },
        { title: 'archive', summary: 'x', facts: [] },
      ],
    });
    const screen = await renderDocument(ref, { collapsed: 1 });
    expect(Boolean(screen.findByTestId('memory.fact.f1'))).toBe(true);
    expect(Boolean(screen.findByTestId('memory.fact.f2'))).toBe(false);
    const href =
      '/settings/prompts/memory/' +
      ref.artifactId +
      '?serverId=' +
      encodeURIComponent(serverId);
    await screen.pressByTestIdAsync('memory.showAll');
    expect(navigation.push).toHaveBeenLastCalledWith(href);
    await screen.pressByTestIdAsync('memory.topic.releases');
    expect(navigation.push).toHaveBeenLastCalledWith(href + '&topic=releases');
    expect(Boolean(screen.findByTestId('memory.topic.archive'))).toBe(true);
  });

  it('remembers into an optional topic and re-reads the persisted fact', async () => {
    const ref = await seedDocument({ v: 1, index: [], topics: [] });
    const screen = await renderDocument(ref, { composing: true });
    await React.act(async () => {
      screen.changeTextByTestId(
        'memory.draft',
        '  Ana reviews sync changes.  ',
      );
    });
    await React.act(async () => {
      screen.changeTextByTestId('memory.draftTopic', 'reviews');
    });
    await screen.pressByTestIdAsync('memory.draft.save');
    await settled(() =>
      expect(Boolean(screen.findByTestId('memory.draft'))).toBe(false),
    );
    expect(await readMemory(ref, 'reviews')).toMatchObject({
      topic: {
        title: 'reviews',
        facts: [
          {
            id: expect.any(String),
            text: 'Ana reviews sync changes.',
            sourceSessionRef: null,
          },
        ],
      },
    });
    expect(storedBody(ref)).toMatchObject({
      index: [],
      topics: [
        { title: 'reviews', facts: [{ text: 'Ana reviews sync changes.' }] },
      ],
    });
    await settled(() =>
      expect(Boolean(screen.findByTestId('memory.topic.reviews'))).toBe(true),
    );
  });

  it('keeps the typed draft open when the real write owner requires a duplicate choice', async () => {
    const ref = await seedDocument({
      v: 1,
      index: [fact('existing', 'Use PostgreSQL for storage')],
      topics: [],
    });
    const reviews: MemoryDuplicateChoiceRequiredV1[] = [];
    const screen = await renderDocument(ref, {
      composing: true,
      onDuplicateReview: (review) => {
        reviews.push(review);
      },
    });
    const before = storedBody(ref);
    await React.act(async () => {
      screen.changeTextByTestId(
        'memory.draft',
        'Prefer PostgreSQL for storage',
      );
    });
    await screen.pressByTestIdAsync('memory.draft.save');
    await settled(() => expect(reviews).toHaveLength(1));
    expect(reviews[0]).toMatchObject({
      ref,
      candidates: [{ factId: 'existing', match: 'related' }],
    });
    await settled(() =>
      expect(screen.findByTestId('memory.draft')?.props.value).toBe(
        'Prefer PostgreSQL for storage',
      ),
    );
    expect(storedBody(ref)).toEqual(before);
    expect(vi.mocked(Modal.alert).mock.calls).toEqual([]);
    // The same form leads with the saved fact and asks for the effect; Replace supersedes it.
    expect(
      Boolean(screen.findByTestId('memory.draft.duplicate.candidate.existing')),
    ).toBe(true);
    // Saved vs New in one comparison: the New line is the draft as it is now, and the effect line
    // follows the chosen option.
    expect(
      screen.findByTestId('memory.draft.duplicate.new')?.props.children,
    ).toBe('Prefer PostgreSQL for storage');
    await React.act(async () => {
      screen.changeTextByTestId(
        'memory.draft',
        'Prefer PostgreSQL 17 for storage',
      );
    });
    expect(
      screen.findByTestId('memory.draft.duplicate.new')?.props.children,
    ).toBe('Prefer PostgreSQL 17 for storage');
    const effect = () =>
      screen.findByTestId('memory.draft.duplicate.effect')?.props.children;
    const updateEffect = effect();
    expect(typeof updateEffect).toBe('string');
    await screen.pressByTestIdAsync('memory.draft.duplicate.choice:replace');
    expect(effect()).not.toBe(updateEffect);
    await React.act(async () => {
      screen.changeTextByTestId(
        'memory.draft',
        'Prefer PostgreSQL for storage',
      );
    });
    await screen.pressByTestIdAsync('memory.draft.save');
    await savedDraft(screen);
    const after = storedBody(ref);
    expect(after.index.map((entry) => entry.text)).toEqual([
      'Prefer PostgreSQL for storage',
    ]);
    expect(after.index[0]?.supersedes).toBe('existing');
  });

  it('with no document yet, the first fact reaches the Session target and its Account attachment', async () => {
    const account = serveAccountContext();
    const template = createSessionFixture();
    if (!template.metadata) throw new Error('Missing Session metadata fixture');
    // Retained non-Bot Sessions default memory off; this is an enabled Session's remember surface.
    const session = createSessionFixture({
      id: 's1',
      serverId,
      metadataVersion: 7,
      metadata: { ...template.metadata, work: { memoryEnabled: true } },
    });
    storage.getState().applySessions([session]);
    const row = SessionCurrentProjectionRecordV1Schema.parse({
      ...V2SessionRecordSchema.parse({
        id: session.id,
        createdAt: 1,
        updatedAt: 1,
        seq: 1,
        active: false,
        activeAt: 1,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataLayoutVersion: 0,
        metadata: JSON.stringify(session.metadata),
        metadataVersion: 7,
        agentState: null,
        agentStateVersion: 1,
        share: null,
      }),
      effectiveAccess: {
        v: 1,
        level: 'owner',
        sources: [{ kind: 'owner' }],
        capabilities: session.access!.capabilities,
      },
      responsibleAccountId: null,
      responsibleAccount: null,
    });
    // The default Home features negotiate current Session access; answer that exact HTTP projection.
    homes.answer(serverId, 'GET /v2/sessions/s1?accessProjectionVersion=1', {
      body: { session: row },
    });
    homes.answer(serverId, 'GET /v2/sessions/s1', { body: { session: row } });
    homes.answer(serverId, 'GET /v1/sessions/s1/turns', {
      body: SessionTurnsProjectionV1Schema.parse({
        v: 1,
        sessionId: session.id,
        updatedAt: session.updatedAt,
        turns: [],
      }),
    });
    const screen = await renderScreen(
      <Host
        composing
        sessionTarget={{
          sessionId: 's1',
          serverId,
          expectedMetadataRevision: 7,
        }}
      />,
    );
    await React.act(async () => {
      screen.changeTextByTestId('memory.draft', 'Prefers short commits.');
    });
    await screen.pressByTestIdAsync('memory.draft.save');
    await savedDraft(screen);
    const attached = account
      .read()
      .find((entry) => entry.id === 'account.memory');
    expect(attached).toBeTruthy();
    if (!attached || attached.ref.kind !== 'doc')
      throw new Error('Missing Account memory attachment');
    const attachedRef: PromptDocArtifactRefV1 = {
      ...attached.ref,
      kind: attached.ref.kind,
    };
    expect(storedBody(attachedRef)).toMatchObject({
      index: [{ text: 'Prefers short commits.' }],
    });
  });

  it.each(['remember', 'edit'] as const)(
    'a real Artifact CAS conflict refreshes the current version and keeps what was typed (%s)',
    async (operation) => {
      const ref = await seedDocument({
        v: 1,
        index: [fact('f1', 'Old fact')],
        topics: [],
      });
      const screen = await renderDocument(ref, {
        composing: operation === 'remember',
      });
      if (operation === 'edit') {
        const actions: readonly ItemAction[] =
          screen.findByType(ItemRowActions).props.actions;
        await React.act(async () => {
          actions.find((action) => action.id === 'edit')!.onPress!();
        });
      }
      const target = screen.findByType(MemoryDocumentBody).props.source.target;
      if (!target) throw new Error('Missing reviewed Memory target');
      homes.artifacts(serverId).beforeNextUpdate(async () => {
        // A normal competing Edit replaces the active ID and archives the original.
        // Exercise that canonical Action rather than manually keeping the original active ID.
        expect(
          await memoryDocumentActions.update(target, {
            factId: 'f1',
            text: 'Concurrent fact',
          }),
        ).toMatchObject({ ok: true });
      });
      await React.act(async () => {
        screen.changeTextByTestId('memory.draft', 'Updated preference');
      });
      await screen.pressByTestIdAsync('memory.draft.save');
      await settled(() => {
        expect(Boolean(screen.findByTestId('memory.conflict'))).toBe(true);
        expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe(
          'ready',
        );
        expect(
          screen.findByType(MemoryDocumentBody).props.source.view.facts[0]
            ?.text,
        ).toBe('Concurrent fact');
      });
      const current = storedBody(ref);
      expect(current.index).toEqual([
        expect.objectContaining({ text: 'Concurrent fact', supersedes: 'f1' }),
      ]);
      expect(current.index[0]?.id).not.toBe('f1');
      expect(
        current.topics.find((section) => section.title === 'archive')?.facts,
      ).toEqual([fact('f1', 'Old fact')]);
      expect(
        Boolean(screen.findByTestId(`memory.fact.${current.index[0]!.id}`)),
      ).toBe(true);
      expect(screen.findByTestId('memory.draft')?.props.value).toBe(
        'Updated preference',
      );
      // Comparing the version we edited must not discard or resubmit our draft.
      await screen.pressByTestIdAsync('memory.conflict-action');
      expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
        props: expect.objectContaining({ artifactId: ref.artifactId,
          compareFromBodyVersion: target.expectedRevision.bodyVersion, canRestore: false }),
      }));
      expect(screen.findByTestId('memory.draft')?.props.value).toBe('Updated preference');
      await screen.pressByTestIdAsync('memory.draft.cancel');
      expect(Boolean(screen.findByTestId('memory.draft'))).toBe(false);
      expect(storedBody(ref)).toEqual(current);
    },
  );

  it('archived facts are read-only', async () => {
    const ref = await seedDocument({
      v: 1,
      index: [],
      topics: [
        {
          title: 'archive',
          summary: 's',
          facts: [fact('old', 'Changelog order: Features, Fixes.')],
        },
      ],
    });
    const screen = await renderDocument(ref, { topic: 'archive' });
    expect(Boolean(screen.findByTestId('memory.fact.old'))).toBe(true);
    expect(Boolean(screen.findByTestId('memory.fact.old.more'))).toBe(false);
  });

  it.each([undefined, 'Build'])(
    'Undo restores original identity, expiry and provenance to its original section (%s)',
    async (topic) => {
      const original: MemoryFactV1 = {
        id: 'original',
        text: 'Use the build script.',
        createdAtMs: 1_000,
        expiresAtMs: Date.now() + 600_000,
        sourceSessionRef: {
          serverId: 'source-home',
          sessionId: 'source-session',
        },
      };
      const ref = await seedDocument({
        v: 1,
        index: topic ? [] : [original],
        topics: topic
          ? [{ title: topic, summary: 'Build details', facts: [original] }]
          : [],
      });
      const screen = await renderDocument(ref, { topic });
      const before =
        screen.findByType(MemoryDocumentBody).props.source.view.revision;
      const actions: readonly ItemAction[] =
        screen.findByType(ItemRowActions).props.actions;
      await React.act(async () => {
        actions.find((action) => action.id === 'forget')!.onPress!();
      });
      await forgetOutcome(screen);
      await settled(() => {
        // The accepted forget collapses the row in place (lab `c-mem` Motion); it leaves once closed.
        expect(factSlot(screen, 'original')?.props.expanded).toBe(false);
        // Undo is offered on the app's one notice owner, not on a card of this section's own.
        expect(readPresentationNotice()?.undo).toBeTruthy();
        const source = screen.findByType(MemoryDocumentBody).props.source;
        expect(source.status).toBe('ready');
        expect(source.target.expectedRevision.bodyVersion).toBeGreaterThan(
          before.bodyVersion,
        );
      });
      expect(
        storedBody(ref).topics.find((section) => section.title === 'archive')
          ?.facts,
      ).toEqual([original]);
      const afterForget =
        screen.findByType(MemoryDocumentBody).props.source.target
          .expectedRevision;
      await React.act(async () => {
        readPresentationNotice()!.undo!.run();
      });
      expect(readPresentationNotice()).toBeNull();
      await settled(() => {
        const source = screen.findByType(MemoryDocumentBody).props.source;
        const restored =
          source.status === 'ready' &&
          source.target?.expectedRevision.bodyVersion > afterForget.bodyVersion;
        const refused =
          screen.findByTestId('memory.conflict') ||
          screen.findByTestId('memory.refused') ||
          vi.mocked(Modal.alert).mock.calls.length > 0;
        expect(Boolean(restored || refused)).toBe(true);
      });
      expect(
        Boolean(screen.findByTestId('memory.conflict')),
        boundaryDiagnostic(),
      ).toBe(false);
      expect(
        Boolean(screen.findByTestId('memory.refused')),
        boundaryDiagnostic(),
      ).toBe(false);
      expect(vi.mocked(Modal.alert).mock.calls, boundaryDiagnostic()).toEqual(
        [],
      );
      const source = screen.findByType(MemoryDocumentBody).props.source;
      expect(source.status).toBe('ready');
      expect(source.target.expectedRevision.bodyVersion).toBeGreaterThan(
        afterForget.bodyVersion,
      );
      expect(Boolean(screen.findByTestId('memory.fact.original'))).toBe(true);
      // Undo puts the row back where it was, open.
      expect(factSlot(screen, 'original')?.props.expanded).toBe(true);
      const restored = await readMemory(ref, topic);
      expect(
        'topic' in restored ? restored.topic.facts : restored.body.index,
      ).toEqual([original]);
      expect(await readMemory(ref, 'archive')).toMatchObject({
        topic: { facts: [] },
      });
      const persisted = storedBody(ref);
      expect(
        topic
          ? persisted.topics.find((section) => section.title === topic)?.facts
          : persisted.index,
      ).toEqual([original]);
      expect([
        ...persisted.index,
        ...persisted.topics.flatMap((section) => section.facts),
      ]).toEqual([original]);
    },
  );

  it('an Undo that meets a related saved fact asks the duplicate choice in place and restores with it', async () => {
    const ref = await seedDocument({
      v: 1,
      index: [
        fact('kept', 'Use PostgreSQL for storage'),
        fact('gone', 'Prefer PostgreSQL for storage'),
      ],
      topics: [],
    });
    const screen = await renderDocument(ref);
    const actions: readonly ItemAction[] =
      screen.findAllByType(ItemRowActions)[1]!.props.actions;
    await React.act(async () => {
      actions.find((action) => action.id === 'forget')!.onPress!();
    });
    await forgetOutcome(screen);
    await settled(() => expect(readPresentationNotice()?.undo).toBeTruthy());
    await React.act(async () => {
      readPresentationNotice()!.undo!.run();
    });
    // The restore found the related fact: the same comparison opens, naming the fact coming back.
    await settled(() =>
      expect(Boolean(screen.findByTestId('memory.restore.duplicate'))).toBe(
        true,
      ),
    );
    expect(
      screen.findByTestId('memory.restore.duplicate.new')?.props.children,
    ).toBe('Prefer PostgreSQL for storage');
    expect(
      Boolean(screen.findByTestId('memory.restore.duplicate.candidate.kept')),
    ).toBe(true);
    expect(storedBody(ref).index.map((entry) => entry.id)).toEqual(['kept']);
    await screen.pressByTestIdAsync(
      'memory.restore.duplicate.choice:keep_both',
    );
    await screen.pressByTestIdAsync('memory.restore.save');
    await settled(() =>
      expect(Boolean(screen.findByTestId('memory.restore.duplicate'))).toBe(
        false,
      ),
    );
    expect(
      storedBody(ref)
        .index.map((entry) => entry.id)
        .sort(),
    ).toEqual(['gone', 'kept']);
  });

  it.each([undefined, 'Checkout'])('renews an expired fact with an explicit date through memory.update, keeping its placement and history (%s)', async (topic) => {
    const expiredAt = Date.now() - 86_400_000;
    const old: MemoryFactV1 = {
      ...fact('lapsed', 'Checkout copy says won’t be charged twice'),
      expiresAtMs: expiredAt,
    };
    const ref = await seedDocument({ v: 1, index: topic ? [] : [old],
      topics: topic ? [{ title: topic, summary: 'Checkout decisions', facts: [old] }] : [] });
    // The read projection keeps an expired fact out of the index and shows it on the Archive page,
    // still stored where it was saved; that is where it is renewed.
    const index = await renderDocument(ref);
    expect(Boolean(index.findByTestId('memory.fact.lapsed'))).toBe(false);
    await index.unmount();
    const screen = await renderDocument(ref, { topic: MEMORY_ARCHIVE_TOPIC_TITLE_V1 });
    // An expired fact offers Renew in its row; a renewal is the same edit form, with its expiry.
    await screen.pressByTestIdAsync('memory.fact.lapsed.renew');
    expect(screen.findByTestId('memory.draft')?.props.value).toBe(old.text);
    expect(Boolean(screen.findByTestId('memory.draft.expiry:date'))).toBe(true);
    // Nothing changes until the person saves: the expired fact stays out of context meanwhile.
    const before = storedBody(ref);
    expect(topic ? before.topics.find(section => section.title === topic)?.facts : before.index).toEqual([old]);
    await screen.pressByTestIdAsync('memory.draft.save');
    await savedDraft(screen);
    const after = storedBody(ref);
    const renewed = topic ? after.topics.find(section => section.title === topic)!.facts : after.index;
    if (topic) expect(after.index).toEqual([]);
    expect(renewed).toHaveLength(1);
    expect(renewed[0]).toMatchObject({
      text: old.text,
      supersedes: 'lapsed',
    });
    expect(renewed[0]!.expiresAtMs).toBeGreaterThan(Date.now());
    expect(
      after.topics.find(
        (section) => section.title === MEMORY_ARCHIVE_TOPIC_TITLE_V1,
      )?.facts,
    ).toEqual([old]);
  });

  it('does not offer Renew for a forgotten fact whose expiry has passed', async () => {
    const original = { ...fact('forgotten', 'Keep the release checklist'), expiresAtMs: Date.now() - 86_400_000 };
    const expired = { ...fact('expired', 'Review the deployment window'), expiresAtMs: original.expiresAtMs };
    const ref = await seedDocument({ v: 1, index: [original, expired], topics: [] });
    const document = await renderDocument(ref);
    const target = document.findByType(MemoryDocumentBody).props.source.target;
    expect(await memoryDocumentActions.forget(target, original.id)).toMatchObject({ ok: true });
    await document.unmount();
    const archive = await renderDocument(ref, { topic: MEMORY_ARCHIVE_TOPIC_TITLE_V1 });
    expect(Boolean(archive.findByTestId('memory.fact.forgotten'))).toBe(true);
    expect(Boolean(archive.findByTestId('memory.fact.forgotten.renew'))).toBe(false);
    expect(Boolean(archive.findByTestId('memory.fact.expired.renew'))).toBe(true);
    await archive.unmount();
    if (!connection) throw new Error('Missing admitted Account fixture');
    for (const selected of [original, expired]) {
      const eligible = selected.id === expired.id;
      const detail = await renderScreen(
        <InjectedAuthProvider credentials={connection.credentials}>
          <MemoryDocumentScreen artifactId={ref.artifactId} serverId={serverId}
            topic={MEMORY_ARCHIVE_TOPIC_TITLE_V1} factId={selected.id} editFactId={selected.id} />
        </InjectedAuthProvider>,
      );
      await settled(() => expect(detail.findByType(MemoryDocumentBody).props.source.status).toBe('ready'));
      // Direct edit links and the detail's Edit/Expires actions share the row's eligibility.
      expect(Boolean(detail.findByTestId('memory-document.factDetail.edit'))).toBe(eligible);
      expect(detail.findAllByTestId('memory-document.factDetail.expires').some(node => typeof node.props.onPress === 'function')).toBe(eligible);
      await settled(() => expect(Boolean(detail.findByTestId('memory-document.draft'))).toBe(eligible));
      await detail.unmount();
    }
  });

  it('keeps a requested edit form in view when a stacked page also names the fact', async () => {
    // A wide window lands on a fact and its Edit adds the form to the list; narrowing then stacks the
    // panes, and the form must stay on screen instead of the fact's page covering it.
    const saved = fact('saved', 'Freeze deploys on Fridays');
    const ref = await seedDocument({ v: 1, index: [saved], topics: [] });
    if (!connection) throw new Error('Missing admitted Account fixture');
    const page = await renderScreen(
      <InjectedAuthProvider credentials={connection.credentials}>
        <MemoryDocumentScreen artifactId={ref.artifactId} serverId={serverId}
          factId={saved.id} editFactId={saved.id} />
      </InjectedAuthProvider>,
    );
    await settled(() => expect(Boolean(page.findByTestId('memory-document.draft'))).toBe(true));
    expect(page.findHostByTestId('memory-document.list-pane')!.props['aria-hidden']).toBeUndefined();
    expect(page.findHostByTestId('memory-document.detail-pane')!.props['aria-hidden']).toBe(true);
    await page.unmount();
  });

  it('changes a saved fact’s expiry to Never from its edit form', async () => {
    const dated: MemoryFactV1 = {
      ...fact('dated', 'Freeze deploys on Fridays'),
      expiresAtMs: Date.now() + 5 * 86_400_000,
    };
    const ref = await seedDocument({ v: 1, index: [dated], topics: [] });
    const screen = await renderDocument(ref);
    const actions: readonly ItemAction[] =
      screen.findByType(ItemRowActions).props.actions;
    expect(Boolean(screen.findByTestId('memory.fact.dated.renew'))).toBe(false);
    await React.act(async () => {
      actions.find((action) => action.id === 'edit')!.onPress!();
    });
    await screen.pressByTestIdAsync('memory.draft.expiry:never');
    await screen.pressByTestIdAsync('memory.draft.save');
    await savedDraft(screen);
    const after = storedBody(ref);
    expect(after.index).toHaveLength(1);
    expect(after.index[0]).toMatchObject({
      text: dated.text,
      supersedes: 'dated',
    });
    expect(after.index[0]!.expiresAtMs).toBeUndefined();
  });

  it('opens a duplicate candidate’s saved fact and source in the same form, then Back keeps the draft and effect', async () => {
    const saved: MemoryFactV1 = {
      ...fact('existing', 'Use PostgreSQL for storage'),
      createdAtMs: Date.now() - 86_400_000,
    };
    const ref = await seedDocument({ v: 1, index: [saved], topics: [] });
    const screen = await renderDocument(ref, { composing: true });
    await React.act(async () => {
      screen.changeTextByTestId(
        'memory.draft',
        'Prefer PostgreSQL for storage',
      );
    });
    await screen.pressByTestIdAsync('memory.draft.save');
    await settled(() =>
      expect(
        Boolean(
          screen.findByTestId('memory.draft.duplicate.candidate.existing'),
        ),
      ).toBe(true),
    );
    await screen.pressByTestIdAsync('memory.draft.duplicate.choice:replace');
    await screen.pressByTestIdAsync(
      'memory.draft.duplicate.candidate.existing.view',
    );
    // The saved fact reads from the reviewed document, in the same form.
    await settled(() =>
      expect(Boolean(screen.findByTestId('memory.draft.savedFact.saved'))).toBe(
        true,
      ),
    );
    // The comparison steps aside while the saved fact is open; its state stays mounted for Back.
    expect(screen.findByTestId('memory.draft.savedFact')).toBeTruthy();
    await screen.pressByTestIdAsync('memory.draft.savedFact.back');
    expect(screen.findByTestId('memory.draft')?.props.value).toBe(
      'Prefer PostgreSQL for storage',
    );
    expect(
      Boolean(screen.findByTestId('memory.draft.duplicate.candidate.existing')),
    ).toBe(true);
    await screen.pressByTestIdAsync('memory.draft.save');
    await savedDraft(screen);
    expect(storedBody(ref).index[0]).toMatchObject({
      text: 'Prefer PostgreSQL for storage',
      supersedes: 'existing',
    });
  });

  it('under reduced motion a forgotten fact leaves at once and its neighbours stay', async () => {
    setReducedMotionPreferenceOverride(true);
    const ref = await seedDocument({
      v: 1,
      index: [fact('gone', 'Forget me.'), fact('kept', 'Keep me.')],
      topics: [],
    });
    const screen = await renderDocument(ref);
    const actions: readonly ItemAction[] =
      screen.findAllByType(ItemRowActions)[0]!.props.actions;
    await React.act(async () => {
      actions.find((action) => action.id === 'forget')!.onPress!();
    });
    await forgetOutcome(screen);
    await settled(() => {
      expect(readPresentationNotice()?.undo).toBeTruthy();
      expect(factSlot(screen, 'gone')).toBeNull();
    });
    expect(factSlot(screen, 'kept')?.props.expanded).toBe(true);
  });

  it('a fact that lands while the list is open arrives with a wash; facts read first do not', async () => {
    const ref = await seedDocument({
      v: 1,
      index: [fact('first', 'Already here.')],
      topics: [],
    });
    const screen = await renderDocument(ref);
    expect(Boolean(screen.findByTestId('memory.fact.first.arrived'))).toBe(
      false,
    );
    const before =
      screen.findByType(MemoryDocumentBody).props.source.target
        .expectedRevision;
    let written!: Awaited<
      ReturnType<ReturnType<typeof createDefaultActionExecutor>['execute']>
    >;
    await React.act(async () => {
      written = await createDefaultActionExecutor().execute(
        'memory.remember',
        {
          ref,
          expectedRevision: before,
          text: 'Landed while watching.',
        },
        { serverId, surface: 'ui', authority: 'present_user' },
      );
    });
    expect(written, JSON.stringify(written)).toMatchObject({ ok: true });
    await deliverMemoryBodyUpdate(ref);
    await settled(() =>
      expect(
        screen.findByType(MemoryDocumentBody).props.source.view.facts,
      ).toHaveLength(2),
    );
    const landed = screen
      .findByType(MemoryDocumentBody)
      .props.source.view.facts.find(
        (entry: MemoryFactV1) => entry.text === 'Landed while watching.',
      );
    expect(
      Boolean(screen.findByTestId(`memory.fact.${landed.id}.arrived`)),
    ).toBe(true);
    expect(Boolean(screen.findByTestId('memory.fact.first.arrived'))).toBe(
      false,
    );
  });

  it('Undo refuses a concurrent document change instead of rebasing the archived fact', async () => {
    const original = fact('original', 'Keep the original fact.');
    const ref = await seedDocument({ v: 1, index: [original], topics: [] });
    const screen = await renderDocument(ref);
    const actions: readonly ItemAction[] =
      screen.findByType(ItemRowActions).props.actions;
    await React.act(async () => {
      actions.find((action) => action.id === 'forget')!.onPress!();
    });
    await forgetOutcome(screen);
    await settled(() => {
      expect(factSlot(screen, 'original')?.props.expanded).toBe(false);
      expect(readPresentationNotice()?.undo).toBeTruthy();
      expect(
        screen.findByType(MemoryDocumentBody).props.source.target,
      ).toBeTruthy();
    });
    const undo = readPresentationNotice()!.undo!;
    const afterForget =
      screen.findByType(MemoryDocumentBody).props.source.target
        .expectedRevision;
    let concurrent!: Awaited<
      ReturnType<ReturnType<typeof createDefaultActionExecutor>['execute']>
    >;
    await React.act(async () => {
      concurrent = await createDefaultActionExecutor().execute(
        'memory.remember',
        {
          ref,
          expectedRevision: afterForget,
          text: 'A concurrent fact.',
        },
        { serverId, surface: 'ui', authority: 'present_user' },
      );
    });
    expect(concurrent, JSON.stringify(concurrent)).toMatchObject({ ok: true });
    await deliverMemoryBodyUpdate(ref);
    const beforeUndo = storedBody(ref);
    const revisionBeforeUndo = (await readMemory(ref)).revision;
    await settled(() => {
      const source = screen.findByType(MemoryDocumentBody).props.source;
      expect(source.status).toBe('ready');
      expect(source.target?.expectedRevision).toEqual(revisionBeforeUndo);
    });
    await React.act(async () => {
      undo.run();
    });
    await settled(() =>
      expect(
        Boolean(
          screen.findByTestId('memory.conflict') ||
          screen.findByTestId('memory.refused') ||
          vi.mocked(Modal.alert).mock.calls.length > 0,
        ),
      ).toBe(true),
    );
    expect(
      Boolean(screen.findByTestId('memory.conflict')),
      boundaryDiagnostic(),
    ).toBe(true);
    expect(
      Boolean(screen.findByTestId('memory.refused')),
      boundaryDiagnostic(),
    ).toBe(false);
    expect(vi.mocked(Modal.alert).mock.calls, boundaryDiagnostic()).toEqual([]);
    expect(readPresentationNotice()).toBeNull();
    expect(storedBody(ref)).toEqual(beforeUndo);
    expect((await readMemory(ref)).revision).toEqual(revisionBeforeUndo);
    expect(beforeUndo.index).toEqual([
      expect.objectContaining({ text: 'A concurrent fact.' }),
    ]);
    expect(
      beforeUndo.topics.find((section) => section.title === 'archive')?.facts,
    ).toEqual([original]);
  });

  it.each(['current', 'retired'] as const)(
    'Undo retains Account custody when its replacement can edit the same shared document (%s target)',
    async (targetKind) => {
      const original = fact('original', 'Keep the original fact.');
      const ref = await seedDocument({ v: 1, index: [original], topics: [] });
      const screen = await renderDocument(ref);
      const actions: readonly ItemAction[] =
        screen.findByType(ItemRowActions).props.actions;
      await React.act(async () => {
        actions.find((action) => action.id === 'forget')!.onPress!();
      });
      await forgetOutcome(screen);
      await settled(() => {
        expect(readPresentationNotice()?.undo).toBeTruthy();
        expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe(
          'ready',
        );
        expect(
          storedBody(ref).topics.find((section) => section.title === 'archive')
            ?.facts,
        ).toEqual([original]);
      });
      const undo = readPresentationNotice()!.undo!;
      const restoreTarget =
        screen.findByType(MemoryDocumentBody).props.source.target;
      const afterForget = restoreTarget.expectedRevision;
      await connection?.dispose();
      connection = null;
      await homes.switchAccount(serverId, 'account-b');
      // B's real edit grant admits current B writes through the same HTTP/CAS owner;
      // it must not let a retained A intent borrow that writer.
      homes
        .artifacts(serverId)
        .seedAccountGrant(ref.artifactId, 'account-b', 'edit');
      // B explicitly allows this UI Action. Sharing's Ask-first default must not mask
      // whether a retained A intent borrows B's admitted writer.
      const replacementSettings = {
        ...baseline.settings,
        actionsSettingsV1: ActionsSettingsV1Schema.parse({
          v: 1,
          approvalWaivedSurfaces: { 'memory.update': ['ui'] },
        }),
      };
      homes.answer(serverId, 'GET /v2/account/settings', {
        body: {
          content: { t: 'plain', v: replacementSettings },
          version: 2,
        },
      });
      connection = await restoreServerAccountForTest({
        serverUrl: 'https://memory-body.test',
        accountId: 'account-b',
        request: homes.request,
      });
      installHomeGovernanceBoundaries(homes);
      await React.act(async () => {
        const scope = { serverId, accountId: 'account-b' };
        storage.getState().applySettingsForScope(scope, replacementSettings, 2);
        storage.getState().activateProfileScope(scope);
      });
      await settled(() => {
        const source = screen.findByType(MemoryDocumentBody).props.source;
        expect(source.status).toBe('ready');
        expect(source.view.access).toBe('edit');
        expect(source.target.expectedRevision).toEqual(afterForget);
      });
      if (targetKind === 'current') {
        const currentTarget =
          screen.findByType(MemoryDocumentBody).props.source.target;
        const currentResult = await memoryDocumentActions.restore(
          currentTarget,
          original.id,
        );
        expect(currentResult, JSON.stringify(currentResult)).toMatchObject({
          ok: true,
          result: { ok: true, artifactId: ref.artifactId, factId: original.id },
        });
        expect(storedBody(ref).index).toEqual([original]);
        expect(
          storedBody(ref).topics.find((section) => section.title === 'archive')
            ?.facts,
        ).toEqual([]);
        expect((await readMemory(ref)).revision.bodyVersion).toBeGreaterThan(
          afterForget.bodyVersion,
        );
        return;
      }
      const beforeUndo = storedBody(ref);
      const requestIndex = homes.requests.length;
      await React.act(async () => {
        undo.run();
      });
      await settled(() => {
        const source = screen.findByType(MemoryDocumentBody).props.source;
        const restored =
          source.status === 'ready' &&
          source.target?.expectedRevision.bodyVersion > afterForget.bodyVersion;
        const refused =
          screen.findByTestId('memory.refused') ||
          vi.mocked(Modal.alert).mock.calls.length > 0;
        expect(Boolean(restored || refused)).toBe(true);
      });
      expect(
        Boolean(screen.findByTestId('memory.refused')),
        boundaryDiagnostic(),
      ).toBe(true);
      expect(readPresentationNotice()).toBeNull();
      expect(
        homes.requests
          .slice(requestIndex)
          .filter(
            (request) =>
              request.path === '/v1/artifacts/' + ref.artifactId &&
              request.input !== null,
          ),
        boundaryDiagnostic(),
      ).toEqual([]);
      // The document adapter retains the same Account custody even if a caller invokes it
      // without the notice's pre-issuance currentness check.
      const retiredResult = await memoryDocumentActions.restore(
        restoreTarget,
        original.id,
      );
      expect(retiredResult.ok).toBe(false);
      if (!retiredResult.ok)
        expect(retiredResult.errorCode).toBe('action_account_scope_changed');
      expect(
        homes.requests
          .slice(requestIndex)
          .filter(
            (request) =>
              request.path === '/v1/artifacts/' + ref.artifactId &&
              request.input !== null,
          ),
        boundaryDiagnostic(),
      ).toEqual([]);
      expect(storedBody(ref)).toEqual(beforeUndo);
      expect((await readMemory(ref)).revision).toEqual(afterForget);
    },
  );

  it.each(['account', 'project'] as const)(
    'remembers the first %s scope fact and attaches the actual persisted document',
    async (scope) => {
      const account = scope === 'account' ? serveAccountContext() : null;
      const project = scope === 'project' ? serveProjectContext() : null;
      const target: MemoryScopeTargetV1 =
        scope === 'account'
          ? { scope }
          : { scope, projectRef: { serverId, projectKey: 'project' } };
      const created =
        vi.fn<
          NonNullable<React.ComponentProps<typeof Host>['onCreatedMemory']>
        >();
      const screen = await renderScreen(
        <Host composing scopeTarget={target} onCreatedMemory={created} />,
      );
      await React.act(async () => {
        screen.changeTextByTestId(
          'memory.draft',
          'Use the shared build script.',
        );
      });
      await screen.pressByTestIdAsync('memory.draft.save');
      await savedDraft(screen);
      const attached = (
        account?.read() ??
        project?.read().promptStack ??
        []
      ).find((entry) => entry.id === scope + '.memory');
      expect(attached).toBeTruthy();
      if (!attached || attached.ref.kind !== 'doc')
        throw new Error('Missing scope memory attachment');
      const attachedRef: PromptDocArtifactRefV1 = {
        ...attached.ref,
        kind: attached.ref.kind,
      };
      expect(created).toHaveBeenCalledWith({
        ref: attached.ref,
        attachment: 'attached',
        factId: storedBody(attachedRef).index[0]!.id,
      });
      expect(await readMemory(attachedRef)).toMatchObject({
        body: {
          index: [
            { text: 'Use the shared build script.', sourceSessionRef: null },
          ],
        },
      });
      expect(storedBody(attachedRef).index).toMatchObject([
        { text: 'Use the shared build script.' },
      ]);
      if (project)
        expect(project.read()).toMatchObject({ pinned: true, hidden: true });
    },
  );

  it.each(['account', 'project'] as const)(
    'preserves the durable fact and exact receipt after a %s scope attachment conflict',
    async (scope) => {
      const account = scope === 'account' ? serveAccountContext(true) : null;
      const project = scope === 'project' ? serveProjectContext(true) : null;
      const target: MemoryScopeTargetV1 =
        scope === 'account'
          ? { scope }
          : { scope, projectRef: { serverId, projectKey: 'project' } };
      const created =
        vi.fn<
          NonNullable<React.ComponentProps<typeof Host>['onCreatedMemory']>
        >();
      const screen = await renderScreen(
        <Host composing scopeTarget={target} onCreatedMemory={created} />,
      );
      await React.act(async () => {
        screen.changeTextByTestId('memory.draft', 'A durable unattached fact.');
      });
      await screen.pressByTestIdAsync('memory.draft.save');
      await settled(() => {
        expect(Boolean(screen.findByTestId('memory.conflict'))).toBe(false);
        expect(Boolean(screen.findByTestId('memory.draft'))).toBe(false);
      });
      expect(account?.read() ?? project?.read().promptStack).toEqual([]);
      const rows = homes.artifacts(serverId).list();
      expect(rows).toHaveLength(1);
      const ref = { kind: 'doc' as const, serverId, artifactId: rows[0]!.id };
      expect(created).toHaveBeenCalledWith({
        ref,
        attachment: 'conflict',
        factId: storedBody(ref).index[0]!.id,
      });
      expect(await readMemory(ref)).toMatchObject({
        body: { index: [{ text: 'A durable unattached fact.' }] },
      });
      expect(storedBody(ref).index).toMatchObject([
        { text: 'A durable unattached fact.' },
      ]);
    },
  );

  it('offers the first fact as one empty state on a page of its own memory, and the section once writing starts', async () => {
    serveAccountContext();
    if (!connection) throw new Error('Missing admitted test Account');
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={connection.credentials}>
        <ItemList>
          <ContextMemorySection
            testID="context.memory"
            title="Key facts"
            description="Facts any session can use"
            serverId={serverId}
            entry={null}
            scopeTarget={{ scope: 'account' }}
            footer="Account"
            emptyText="empty"
            firstUse={{ title: 'Nothing yet', reason: 'Save a decision from any message.' }}
          />
        </ItemList>
      </InjectedAuthProvider>,
    );
    await settled(() =>
      expect(screen.findByTestId('context.memory.firstUse')).toBeTruthy(),
    );
    // One state replaces the section: no section chrome, no second line of nothing.
    expect(screen.findByTestId('context.memory.search')).toBeNull();
    expect(screen.findByTestId('context.memory.none')).toBeNull();
    await screen.pressByTestIdAsync('context.memory.firstUse-action');
    await settled(() =>
      expect(screen.findByTestId('context.memory.draft')).toBeTruthy(),
    );
    expect(screen.findByTestId('context.memory.firstUse')).toBeNull();
    await screen.unmount();
  });

  it('Context displays the exact saved document after attachment conflict and retires it when its Home Account changes', async () => {
    const account = serveAccountContext(true);
    if (!connection) throw new Error('Missing admitted test Account');
    const detach = vi.fn();
    const budget = vi.fn();
    const scopeTarget = { scope: 'account' } as const;
    const section = (
      <ItemList>
        <ContextMemorySection
          testID="context.memory"
          title="Memory"
          description="Account memory"
          serverId={serverId}
          entry={null}
          scopeTarget={scopeTarget}
          footer="Account"
          emptyText="empty"
          onDetach={detach}
          onBudgetChange={budget}
        />
      </ItemList>
    );
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={connection.credentials}>
        {section}
      </InjectedAuthProvider>,
    );
    await screen.pressByTestIdAsync('context.memory.remember');
    await React.act(async () => {
      screen.changeTextByTestId(
        'context.memory.draft',
        'Preserve the exact saved document.',
      );
    });
    await screen.pressByTestIdAsync('context.memory.draft.save');
    await settled(() => {
      expect(Boolean(screen.findByTestId('context.memory.conflict'))).toBe(
        false,
      );
      expect(Boolean(screen.findByTestId('context.memory.draft'))).toBe(false);
      expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe(
        'ready',
      );
    });
    const rows = homes.artifacts(serverId).list();
    expect(rows).toHaveLength(1);
    const ref = { kind: 'doc' as const, serverId, artifactId: rows[0]!.id };
    const original = storedBody(ref).index[0]!;
    expect(original.text).toBe('Preserve the exact saved document.');
    expect(
      Boolean(screen.findByTestId('context.memory.fact.' + original.id)),
    ).toBe(true);
    expect(
      screen.findByType(MemoryDocumentBody).props.source.target.ref,
    ).toEqual(ref);
    expect(account.read()).toEqual([]);
    expect(Boolean(screen.findByTestId('context.memory.detach'))).toBe(false);
    expect(Boolean(screen.findByTestId('context.memory.load'))).toBe(false);
    expect(detach).not.toHaveBeenCalled();
    expect(budget).not.toHaveBeenCalled();

    const mountedBody = screen.findByType(MemoryDocumentBody);
    await connection.dispose();
    connection = null;
    await homes.switchAccount(serverId, 'account-b');
    const nextConnection = await restoreServerAccountForTest({
      serverUrl: 'https://memory-body.test',
      accountId: 'account-b',
      request: homes.request,
    });
    connection = nextConnection;
    installHomeGovernanceBoundaries(homes);
    await React.act(async () => {
      const scope = { serverId, accountId: 'account-b' };
      storage.getState().applySettingsForScope(scope, baseline.settings, 1);
      storage.getState().activateProfileScope(scope);
      screen.update(
        <InjectedAuthProvider credentials={nextConnection.credentials}>
          {section}
        </InjectedAuthProvider>,
      );
    });
    await settled(() => {
      expect(storage.getState().profileScope).toEqual({
        serverId,
        accountId: 'account-b',
      });
    });
    expect(
      Boolean(screen.findByTestId('context.memory.fact.' + original.id)),
    ).toBe(false);
    expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe(
      'none',
    );
    // The Account boundary clears the receipt in the same mounted surface; a remount would hide that bug.
    expect(screen.findByType(MemoryDocumentBody) === mountedBody).toBe(true);
  });

  it('keeps a failed first Memory read and Retry visible while offline without retained content', async () => {
    if (!connection) throw new Error('Missing admitted Account fixture');
    const source = { status: 'unavailable', view: null, stale: false, target: null,
      draftCustody: null, refresh: async () => null } satisfies MemoryDocumentSource;
    const screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}>
      <MemoryDocumentBody testID="unretained-memory" source={source} serverId={serverId}
        composing={false} onComposingChange={() => {}} emptyText="empty" />
    </InjectedAuthProvider>);
    await act(async () => storage.getState().setEndpointConnectivity({
      status: 'offline', reason: null, attempt: 1, nextRetryAt: null,
      lastConnectedAt: 1, lastDisconnectedAt: 2, lastErrorMessage: null,
    }));
    expect(screen.findByTestId('unretained-memory.unavailable')).not.toBeNull();
    expect(screen.findByTestId('unretained-memory.unavailable-action')).not.toBeNull();
    expect(screen.findByTestId('unretained-memory.offline')).toBeNull();
  });
});
