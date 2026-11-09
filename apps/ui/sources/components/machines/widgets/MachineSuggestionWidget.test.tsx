import {
  renderWithSessionTranscriptSource,
  createTestSessionTranscriptSource,
  flushHookEffects,
} from '@/dev/testkit';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_TOKEN_FULL_GRANT_V1} from '@happier-dev/protocol/auth/apiTokenGrant';
import {
  ApprovalRequestSchema,
  ApprovalRequestV2Schema,
  type ApprovalRequestV2,
} from '@happier-dev/protocol/approvals/approvalRequestV1';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import {
  StrictJsonValueSchema} from '@happier-dev/protocol/json/strictJsonValue';
import {
  buildApprovalRequestArtifactHeaderV1} from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import {
  computeExternalActionRequestEnvelopeDigestV1,
  signExternalActionApprovalInputV1} from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import {
  ExternalActionRequestEnvelopeV1Schema,
  ExternalActionResponseEnvelopeV1Schema} from '@happier-dev/protocol/actions/externalActionApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type {
  MachineStorageTrashMoveInputV1,
  PileApplyResultV1,
  PileReviewV1,
} from '@happier-dev/protocol/storage/storageV1';
import tweetnacl from 'tweetnacl';

import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createServerScopedMachineRpcBoundaryMock } from '@/dev/testkit/mocks/serverScopedRpc';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import {
  createMachineFixture,
  createPlainMachineRowFixture,
} from '@/dev/testkit/fixtures/machineFixtures';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Real boundaries only: the Home (artifacts, machine census) and the Machine network. The card, the
// approval decision owner, the Action front door, narrowing and the storage clients all run for real.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
const daemonRpc = vi.hoisted(() =>
  vi.fn<Parameters<typeof createServerScopedMachineRpcBoundaryMock>[0]>(),
);
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => createServerScopedMachineRpcBoundaryMock(daemonRpc),
);

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    View: (props: any) => React.createElement('View', props, props.children),
    Pressable: (props: any) =>
      React.createElement('Pressable', props, props.children),
    ActivityIndicator: (props: any) =>
      React.createElement('ActivityIndicator', props, null),
  });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@expo/vector-icons', () => ({
  Ionicons: (props: any) => React.createElement('Ionicons', props, null),
}));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: { push: vi.fn() } }).module;
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock().module;
});

await loadSyncSingletonForTests();
const { MachineSuggestionWidget } = await import('./MachineSuggestionWidget');
const { WidgetPresentationProvider } = await import('@happier-dev/plugin-ui');
const { getWidgetSizeFootprintV1 } = await import('@happier-dev/protocol/widgets');
const { storage } = await import('@/sync/domains/state/storage');
const { createSessionFixture } =
  await import('@/dev/testkit/fixtures/sessionFixtures');
const initialState = storage.getState();

const GB = 1_000_000_000;
const MACHINE = 'machine-exact';
const ids = [
  'wt-merged',
  'node-modules',
  'turbo',
  'runtime-build',
  'playwright',
  'old-wt',
] as const;
const ref = (itemId: string) => ({
  itemId,
  path: `/Users/leeroy/happier/${itemId}`,
  identity: {
    dev: '1',
    ino: `${ids.indexOf(itemId as never) + 2}`,
    kind: 'directory' as const,
  },
  collectedAt: 1,
  collectedBy: { accountId: 'account-1', kind: 'agent' as const },
});
const proposalArgs: MachineStorageTrashMoveInputV1 = {
  machineId: MACHINE,
  items: ids.map((itemId) => ({
    ref: ref(itemId),
    expect: `claimed-${itemId}`,
    claimedVerdict: 'safe' as const,
    reason: { code: 'rebuilds' as const },
  })),
};
const size = (bytes: number) => ({
  allocatedBytes: bytes,
  freesBytes: bytes,
  sharedBytes: 0,
  sharedExtentsUnmeasured: false,
  atLeast: false,
});

let homeId: string;
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;
let checkExpect: (itemId: string) => string;

function signed(request: ApprovalRequestV2): ApprovalRequestV2 {
  const origin = request.executionOriginV1;
  if (
    !origin.machineId ||
    !origin.target ||
    !origin.serverIdentityId ||
    !origin.accountId ||
    !origin.principalId ||
    !origin.credentialId
  ) {
    throw new Error('API admission fixture is incomplete');
  }
  const authorization = {
    v: 1 as const,
    token: 'approval-invocation-authorization',
    binding: {
      serverIdentityId: origin.serverIdentityId,
      accountId: origin.accountId,
      custodianAccountId: origin.accountId,
      installationId: 'installation-exact',
      principalId: origin.principalId,
      credentialId: origin.credentialId,
      grant: API_TOKEN_FULL_GRANT_V1,
      machineId: origin.machineId,
      actionId: request.actionId,
      requestId: origin.requestId,
      target: origin.target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({
        v: 1,
        requestId: origin.requestId,
        target: origin.target,
        input: StrictJsonValueSchema.parse(request.actionArgs),
      }),
    },
  };
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
  return ApprovalRequestV2Schema.parse({
    ...request,
    executionOriginV1: {
      ...origin,
      externalActionExecutionAuthorization: authorization,
      externalActionInputSignature: signExternalActionApprovalInputV1({
        authorizationToken: authorization.token,
        actionId: request.actionId,
        target: origin.target,
        input: request.actionArgs,
        privateKey: key.secretKey,
      }),
    },
  });
}

function proposal(
  overrides: Partial<ApprovalRequestV2> = {},
): ApprovalRequestV2 {
  const base: ApprovalRequestV2 = {
    v: 2,
    status: 'open',
    createdAtMs: 1,
    updatedAtMs: 1,
    createdBy: { surface: 'system', sessionId: 'session-1' },
    requestedSurface: 'api',
    executionOriginV1: {
      v: 1,
      authority: 'account_automation',
      surface: 'api',
      caller: { kind: 'host' },
      serverId: 'local-A',
      serverIdentityId: 'srv_stable-home-a',
      accountId: 'account-1',
      principalId: 'principal-1',
      credentialId: 'credential-1',
      sessionId: 'session-1',
      machineId: MACHINE,
      target: { kind: 'session', sessionId: 'session-1' },
      actionId: 'machines.storage.trash.move',
      requestId: 'request-1',
    },
    actionId: 'machines.storage.trash.move',
    actionArgs: proposalArgs,
    summary: 'Find 20 GB to free on leeroy-mbp',
  };
  return overrides.status && overrides.status !== 'open'
    ? ApprovalRequestV2Schema.parse({ ...signed(base), ...overrides })
    : signed(base);
}

async function seed(request: ApprovalRequestV2, artifactId = 'approval-1') {
  const response = await home.artifacts(homeId).handle('/v1/artifacts', {
    method: 'POST',
    body: JSON.stringify({
      id: artifactId,
      header: encodePlainArtifactStoredContent(
        buildApprovalRequestArtifactHeaderV1(request),
      ),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }),
  });
  expect(response?.ok).toBe(true);
}

const readApproval = () =>
  ApprovalRequestSchema.parse(
    JSON.parse(home.artifacts(homeId).readPlainBody('approval-1') ?? 'null'),
  );
const calls = (method: string) =>
  daemonRpc.mock.calls
    .map(([call]) => call)
    .filter((call) => call.method === method);

/** The widget reads the Home's approval Artifacts from the one artifacts store, as the Inbox does. */
function putArtifact(request: ApprovalRequestV2) {
  storage.setState({
    isDataReady: true,
    artifacts: {
      'approval-1': {
        id: 'approval-1',
        header: buildApprovalRequestArtifactHeaderV1(request),
        body: JSON.stringify(request),
        title: null,
        headerVersion: 1,
        seq: 1,
        createdAt: Date.now() - 12 * 60_000,
        updatedAt: Date.now(),
        isDecrypted: true,
      } as never,
    },
  });
}

async function render(size: 'small' | 'full', request: ApprovalRequestV2 | null) {
  if (request) {
    await seed(request);
    putArtifact(request);
  }
  return renderWithSessionTranscriptSource(
    <WidgetPresentationProvider value={{ size, footprint: getWidgetSizeFootprintV1('home', size)! }}>
      <MachineSuggestionWidget input={{ machine: { serverId: homeId, machineId: MACHINE } }} serverId={homeId} testID="widget" />
    </WidgetPresentationProvider>,
    createTestSessionTranscriptSource({ sessionId: 'session-1' }),
  );
}

const SUMMARY_NO_SUGGESTIONS = {
  revision: 1, sizedAt: 1,
  volumes: [{ volume: { volumeId: 'mac', mountPath: '/', label: 'Macintosh HD' }, totalBytes: 994 * GB, freeBytes: 412 * GB, happierBytes: 96 * GB, pileBytes: 0, trashBytes: 0 }],
  categories: [], suggestionsTop: [], pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 },
  wholeDisk: { enabled: false, scans: [] },
};

describe('MachineSuggestionWidget', () => {
  beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    await home.reset();
    homeId = await home.addHome({ name: 'Home A', serverUrl: 'https://suggestion-home.example', serverIdentityId: 'srv_stable-home-a', accountId: 'account-1', currentAccount: true });
    const machineRow = { ...createPlainMachineRowFixture({ id: MACHINE, accountId: 'account-1' }), installationId: 'installation-exact' };
    home.answer(homeId, 'GET /v1/machines', { body: [machineRow] });
    // The batch-read HTTP harness resolves exact rows, as approval execution does.
    home.answer(homeId, `GET /v1/machines/${MACHINE}`, { body: { machine: machineRow } });
    home.answer(homeId, 'POST /v1/actions/approval.request.decide', {
      select: raw => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(raw);
        return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.decide',
          requestId: request.requestId, execution: { ok: true, result: { status: 'executed' } } }) };
      },
    });
    storage.setState({
      sessions: { 'session-1': createSessionFixture({ id: 'session-1', serverId: homeId }) },
      machines: {},
      machineListByServerId: { [homeId]: [createMachineFixture({ id: MACHINE, activeAt: Date.now(), storageMode: 'plain', isShared: false })] },
      machineListStatusByServerId: { [homeId]: 'idle' },
    });
    daemonRpc.mockReset();
    daemonRpc.mockImplementation(async (call) => {
      const payload = (call.payload ?? {}) as { refs?: ReadonlyArray<{ itemId: string }>; items?: unknown[] };
      switch (call.method) {
        case RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK: {
          const review: PileReviewV1 = {
            items: (payload.refs ?? []).map((entry) => ({ ref: ref(entry.itemId), expect: `claimed-${entry.itemId}`, verdict: 'safe',
              reason: { code: 'rebuilds' }, size: size(GB), absorbs: [] })),
            staying: [], countedOnceBytes: 6 * GB, totalFreesBytes: 6 * GB, trashVolumes: [],
          };
          return review;
        }
        case RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE: return { revision: 2, declinedCount: payload.items?.length ?? 0 };
        case RPC_METHODS.DAEMON_STORAGE_WATCH: return new Promise(() => {});
        case RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET: return SUMMARY_NO_SUGGESTIONS;
        case RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED: return { ok: true, result: { status: 'executed' } };
        default: return undefined;
      }
    });
  });
  afterEach(async () => {
    standardCleanup();
    await home.reset();
    storage.setState(initialState, true);
    webLocks?.restore();
    webLocks = undefined;
  });

  it('shows only Review and Not now where the items are not all visible (Small)', async () => {
    const screen = await render('small', proposal());
    await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)).toHaveLength(1));
    await vi.waitFor(() => expect(screen.findByTestId('widget.review')).toBeTruthy());
    expect(screen.findByTestId('widget.notNow')).toBeTruthy();
    expect(screen.findByTestId('widget.approve')).toBeNull();
  });

  it('keeps the mounted proposal check on unrelated Artifact updates and checks the operands of a new proposal', async () => {
    const request = proposal();
    const screen = await render('full', request);
    await vi.waitFor(() => expect(screen.findByTestId('widget.approve')?.props.disabled).toBe(false));
    expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)).toHaveLength(1);
    await act(async () => {
      const artifacts = storage.getState().artifacts;
      const selected = artifacts['approval-1']!;
      if (!selected.isDecrypted) throw new Error('Selected proposal is not readable');
      storage.setState({ artifacts: { ...artifacts, unrelated: { ...selected, id: 'unrelated',
        isDecrypted: true, header: { title: null, kind: 'note' }, body: 'An unrelated note changed', updatedAt: Date.now() } } });
    });
    expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)).toHaveLength(1);
    expect(screen.findByTestId('widget.approve')?.props.disabled).toBe(false);
    await act(async () => {
      const artifacts = storage.getState().artifacts;
      const selected = artifacts['approval-1']!;
      if (!selected.isDecrypted) throw new Error('Selected proposal is not readable');
      storage.setState({ artifacts: { ...artifacts, 'approval-1': { ...selected,
        header: { ...selected.header! }, updatedAt: Date.now() } } });
    });
    expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)).toHaveLength(1);
    const changed = signed({ ...request, updatedAtMs: 2,
      executionOriginV1: { ...request.executionOriginV1, requestId: 'request-2' },
      actionArgs: { ...proposalArgs, items: proposalArgs.items.slice(0, 2) } });
    // Admitted operands stay immutable: a genuine changed proposal is a new approval Artifact.
    await seed(changed, 'approval-2');
    await act(async () => {
      const artifacts = storage.getState().artifacts;
      const selected = artifacts['approval-1']!;
      if (!selected.isDecrypted) throw new Error('Selected proposal is not readable');
      storage.setState({ artifacts: { ...artifacts, 'approval-2': { ...selected, id: 'approval-2',
        header: { ...selected.header!, ...buildApprovalRequestArtifactHeaderV1(changed) },
        body: JSON.stringify(changed), createdAt: Date.now(), updatedAt: Date.now() } } });
    });
    await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)).toHaveLength(2));
    expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)[1]?.payload).toMatchObject({ refs: proposalArgs.items.slice(0, 2).map(item => ({ itemId: item.ref.itemId, path: item.ref.path })) });
    await screen.unmount();
  });

  it('approves eight visible items at Full through the existing decision owner', async () => {
    const items = [...proposalArgs.items, ...['cache-seven', 'cache-eight'].map(itemId => ({
      ref: ref(itemId), expect: `claimed-${itemId}`, claimedVerdict: 'safe' as const, reason: { code: 'rebuilds' as const },
    }))];
    const request = signed(ApprovalRequestV2Schema.parse({ ...proposal(), actionArgs: { ...proposalArgs, items } }));
    const screen = await render('full', request);
    await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)).toHaveLength(1));
    await vi.waitFor(() => expect(screen.findByTestId('widget.approve')).toBeTruthy());
    await vi.waitFor(() => expect(screen.findByTestId('widget.approve')?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync('widget.approve');
    await vi.waitFor(async () => {
      await flushHookEffects();
      // Consent is committed before replay admission: wait for the actual HTTP
      // decision and the widget's settled handler, not that transient label.
      expect(home.requestsFor('/v1/actions/approval.request.decide')).toHaveLength(1);
      expect(screen.findByTestId('widget.approve')?.props.disabled).toBe(false);
      expect(readApproval()).toMatchObject({ status: 'approved', decision: { kind: 'approve' } });
      expect(readApproval().execution).toBeUndefined();
    });
    const decision = (readApproval() as ApprovalRequestV2).decision;
    const kept = (decision?.narrowedInput as { items: Array<{ ref: { itemId: string } }> }).items;
    expect(kept.map((item) => item.ref.itemId)).toEqual(items.map(item => item.ref.itemId));
  });

  it('keeps a nine-item proposal open for Review when Full cannot show the entire consent set', async () => {
    const items = [...proposalArgs.items, ...['cache-seven', 'cache-eight', 'cache-nine'].map(itemId => ({
      ref: ref(itemId), expect: `claimed-${itemId}`, claimedVerdict: 'safe' as const, reason: { code: 'rebuilds' as const },
    }))];
    const request = signed(ApprovalRequestV2Schema.parse({ ...proposal(), actionArgs: { ...proposalArgs, items } }));
    const screen = await render('full', request);
    await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)).toHaveLength(1));
    await vi.waitFor(() => expect(screen.findByTestId('widget.row.cache-eight')).toBeTruthy());
    expect(screen.findByTestId('widget.row.cache-nine')).toBeNull();
    expect(screen.findByTestId('widget.approve')).toBeNull();
    expect(screen.findByTestId('widget.review')).toBeTruthy();
    expect(readApproval().status).toBe('open');
  });

  it('with nothing proposed and nothing verified, invites an agent instead of drawing zero', async () => {
    const screen = await render('small', null);
    await vi.waitFor(() => expect(screen.findByTestId('widget.empty')).toBeTruthy());
    expect(screen.getTextContent()).toContain('machines.widgets.body.suggestion.noneTitle');
    expect(screen.getTextContent()).not.toContain('0 GB');
  });

  it('shows the Safe preview when larger Caution items fill the general summary preview', async () => {
    const safe = { itemId: 'safe-cache', kind: 'suggestion', categoryId: 'caches', title: 'Rebuildable cache',
      evidence: ['managed_cache_root'], path: '/cache/safe', size: size(GB), verdict: 'safe',
      reason: { code: 'rebuilds' }, collectable: true };
    const previous = daemonRpc.getMockImplementation()!;
    daemonRpc.mockImplementation(async call => call.method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET
      ? { ...SUMMARY_NO_SUGGESTIONS, suggestionsTop: [{ ...safe, itemId: 'caution-cache', path: '/cache/caution',
          verdict: 'caution', reason: { code: 'not_rebuildable' } }], suggestionsSafeTop: [safe], suggestionsTotalCount: 1200,
          suggestionsSafeTotalCount: 1100, suggestionsSafeFreesBytes: 42 * GB }
      : previous(call));
    const screen = await render('full', null);
    await vi.waitFor(() => expect(screen.findByTestId('widget.row.safe-cache')).toBeTruthy());
    expect(screen.findByTestId('widget.empty')).toBeNull();
    expect(screen.findByTestId('widget.row.caution-cache')).toBeNull();
    expect(screen.getTextContent()).toContain('42');
  });
});
