import {
  renderWithSessionTranscriptSource,
  createTestSessionTranscriptSource,
  findAllHostTestInstances,
  pressTestInstanceAsync,
  renderHook,
  flushHookEffects,
} from '@/dev/testkit';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
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
import { MachineStorageCategoryListResultV1Schema, PileApplyResultV1Schema, PileReviewV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { MachineStorageDeleteNowInputV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { resolveApprovalRequestExecutionInput } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { MachineGuardActivityListV1Schema } from '@happier-dev/protocol/machines/guard/activityV1';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import tweetnacl from 'tweetnacl';
import { createMachineGuardViewFixture } from '@/sync/domains/machines/guard/guardViewFixtures';

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
  return createTextModuleMock();
});
vi.mock('@/components/ui/text/Text', () => ({
  Text: (props: any) => React.createElement('Text', props, props.children),
}));
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock().module;
});

await loadSyncSingletonForTests();
const { Modal } = await import('@/modal');
const { t } = await import('@/text');
const { formatMachineBytes } = await import('@/components/machines/vitals/machineVitalsPresentation');
const { ApprovalPromptCard } =
  await import('@/components/tools/shell/approvals/ApprovalPromptCard');
const { storage } = await import('@/sync/domains/state/storage');
const { useResourceProposalCheck } = await import('./useResourceProposalCheck');
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
let uiMovedItems: string[];

function signed(request: ApprovalRequestV2, installationId = 'installation-exact'): ApprovalRequestV2 {
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
      installationId,
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

async function render(request: ApprovalRequestV2, seedFirst = true, artifactId = 'approval-1') {
  if (seedFirst) await seed(request, artifactId);
  return renderWithSessionTranscriptSource(
    <ApprovalPromptCard
      artifact={{ id: artifactId, header: { title: null, serverId: homeId } }}
      approval={request}
      sessionId="session-1"
      canApprove
    />,
    createTestSessionTranscriptSource({
      sessionId: 'session-1',
      interaction: { canSendMessages: true, canApprovePermissions: true },
      actions: {
        respondToPermission: async () => {},
        answerUserAction: async () => {},
        abort: async () => {},
        submitMessage: async () => {},
      },
    }),
  );
}

describe('resource proposal card', () => {
  beforeEach(async () => {
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
    webLocks = installWebLockManagerMock();
    await home.reset();
    (await import('@/sync/domains/machines/storage/machineStorageStore')).machineStorageStore.reset();
    (await import('@/sync/domains/machines/guard/machineGuardStore')).machineGuardStore.reset();
    homeId = await home.addHome({
      name: 'Home A',
      serverUrl: 'https://proposal-home.example',
      serverIdentityId: 'srv_stable-home-a',
      accountId: 'account-1',
      currentAccount: true,
    });
    const machineRow = {
      ...createPlainMachineRowFixture({
        id: MACHINE,
        accountId: 'account-1',
      }),
      installationId: 'installation-exact',
    };
    home.answer(homeId, 'GET /v1/machines', { body: [machineRow] });
    // The external Action transport reads its exact Machine by id (read-batch over this row).
    home.answer(homeId, `GET /v1/machines/${MACHINE}`, { body: { machine: machineRow } });
    home.answer(homeId, 'POST /v1/actions/approval.request.decide', {
      select: raw => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(raw);
        return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.decide',
          requestId: request.requestId, execution: { ok: true, result: { status: 'executed' } } }) };
      },
    });
    storage.setState({
      sessions: {
        'session-1': createSessionFixture({
          id: 'session-1',
          serverId: homeId,
        }),
      },
      machines: {},
      machineListByServerId: {
        [homeId]: [
          createMachineFixture({
            id: MACHINE,
            activeAt: Date.now(),
            storageMode: 'plain',
            isShared: false,
          }),
        ],
      },
      machineListStatusByServerId: { [homeId]: 'idle' },
    });
    checkExpect = (itemId) => `claimed-${itemId}`;
    uiMovedItems = [];
    daemonRpc.mockReset();
    daemonRpc.mockImplementation(async (call) => {
      const payload = (call.payload ?? {}) as {
        refs?: ReadonlyArray<{ itemId: string }>;
        items?: unknown[];
        entryIds?: string[];
      };
      switch (call.method) {
        case RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK: {
          const review: PileReviewV1 = {
            items: (payload.refs ?? []).map((entry) => ({
              ref: ref(entry.itemId),
              expect: checkExpect(entry.itemId),
              verdict: 'safe',
              reason: { code: 'rebuilds' },
              size: size(GB),
              absorbs: [],
            })),
            staying: [],
            countedOnceBytes: 6 * GB,
            totalFreesBytes: 6 * GB,
            trashVolumes: [],
          };
          return review;
        }
        case RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE:
          return { revision: 2, declinedCount: payload.items?.length ?? 0 };
        case RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE: {
          const items = (payload.items ?? []) as Array<{ ref: { itemId: string } }>;
          uiMovedItems = items.map(item => item.ref.itemId);
          return { batchId: 'batch-ui', mode: 'trash', inTrashBytes: items.length * GB, freedBytes: 0,
            trashEntryIds: items.map(item => `entry-ui-${item.ref.itemId}`),
            outcomes: items.map((item) => ({ itemId: item.ref.itemId, status: 'moved' })) };
        }
        case RPC_METHODS.MACHINES_PROCESSES_START_AGAIN:
          return { status: 'started' };
        case RPC_METHODS.MACHINES_GUARD_GET:
          return createMachineGuardViewFixture();
        case RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST:
          return MachineGuardActivityListV1Schema.parse({ entries: [], counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 1 });
        case RPC_METHODS.DAEMON_GUARD_ACTIVITY_WATCH:
          return new Promise(resolve => {
            if (call.signal?.aborted) resolve({ changed: false });
            else call.signal?.addEventListener('abort', () => resolve({ changed: false }), { once: true });
          });
        case RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST:
          return MachineStorageCategoryListResultV1Schema.parse({ revision: 1, sizedAt: 1, categoryId: 'trash', items: [],
            trashEntries: [...ids.slice(0, 5).map(itemId => ({ entryId: `entry-${itemId}`, batchId: 'batch-1', volumeId: 'disk',
              originalPath: ref(itemId).path, title: itemId, size: size(GB), movedAt: 1,
              movedBy: { accountId: 'account-1', kind: 'agent' }, emptiesAt: null, restorable: true })),
              ...uiMovedItems.map(itemId => ({ entryId: `entry-ui-${itemId}`, batchId: 'batch-ui', volumeId: 'disk',
                originalPath: ref(itemId).path, title: itemId, size: size(GB), movedAt: 1,
                movedBy: { accountId: 'account-1', kind: 'person' }, emptiesAt: null, restorable: true }))] });
        case RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE:
          return { outcomes: (payload.entryIds ?? []).map(entryId => ({ entryId, status: 'restored' })) };
        case RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY:
          return {
            outcomes: ids
              .slice(0, 5)
              .map((itemId) => ({
                entryId: `entry-${itemId}`,
                status: 'deleted',
              })),
            freedBytes: 5 * GB,
          };
        case RPC_METHODS.DAEMON_STORAGE_WATCH:
          return new Promise(() => {});
        case RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED:
          return { ok: true, result: { status: 'executed' } };
        default:
          return undefined;
      }
    });
  });
  afterEach(async () => {
    standardCleanup();
    (await import('@/sync/domains/machines/storage/machineStorageStore')).machineStorageStore.reset();
    (await import('@/sync/domains/machines/guard/machineGuardStore')).machineGuardStore.reset();
    await home.reset();
    storage.setState(initialState, true);
    webLocks?.restore();
    webLocks = undefined;
  });

  it('withholds a storage check when the captured Home is unknown instead of borrowing the focused Home', async () => {
    const base = proposal();
    const request = signed({ ...base,
      executionOriginV1: { ...base.executionOriginV1, serverIdentityId: 'srv_unknown-home' },
    });
    const screen = await render(request);
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-check-unavailable')).toBeTruthy());
    expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(true);
    expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)).toHaveLength(0);
  });

  it('checks an agent Delete-now Artifact and executes only the selected subset through the canonical decision and storage front doors', async () => {
    // This network fixture stands in for an already-approved daemon replay. Its UI adapter must
    // admit the effect through policy, rather than impersonating a separate caller confirmation.
    home.answer(homeId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1: {
      v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.storage.deleteNow': ['ui'] },
    } } }, version: 1 } });
    const items = proposalArgs.items.slice(0, 2).map(({ ref, expect }) => ({ ref, expect }));
    const base = proposal();
    const request = signed({ ...base, actionId: 'machines.storage.deleteNow',
      requestedSurface: 'agent', actionArgs: MachineStorageDeleteNowInputV1Schema.parse({ machineId: MACHINE, items }),
      executionOriginV1: { ...base.executionOriginV1, actionId: 'machines.storage.deleteNow', surface: 'api',
        caller: { kind: 'session', sessionId: 'session-1', starterDepth: 0, turnDepth: 0 } } });
    const remaining = new Set(items.map(item => item.ref.itemId));
    let executed: PileApplyResultV1 | null = null;
    // The exact daemon is a network boundary. It consumes the recorded choice with the same
    // replay admission owner, then the real Storage Action adapter reaches the machine effect.
    home.answer(homeId, 'POST /v1/actions/approval.request.decide', { select: async raw => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(raw);
      const approved = readApproval();
      const replay = resolveApprovalRequestExecutionInput(approved);
      if (!replay.ok) throw new Error(replay.errorCode);
      const input = MachineStorageDeleteNowInputV1Schema.parse(replay.input);
      const { deleteMachineStorageNowViaAction } = await import('@/sync/domains/machines/storage/machineRpc');
      const result = await deleteMachineStorageNowViaAction({ ...input, serverId: homeId,
        expectedAccountId: 'account-1' });
      if (!result.ok) throw new Error(result.reason);
      executed = result.value;
      return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.decide',
        requestId: envelope.requestId, execution: { ok: true, result: { status: 'executed', execution: {
          executedAtMs: Date.now(), ok: true, result: executed,
        } } } }) };
    } });
    const previousRpc = daemonRpc.getMockImplementation()!;
    daemonRpc.mockImplementation(async call => {
      if (call.method !== RPC_METHODS.DAEMON_STORAGE_DELETE_NOW) return previousRpc(call);
      const input = MachineStorageDeleteNowInputV1Schema.parse(call.payload);
      input.items.forEach(item => remaining.delete(item.ref.itemId));
      return PileApplyResultV1Schema.parse({ batchId: 'permanent-batch', mode: 'delete', inTrashBytes: 0,
        freedBytes: input.items.length * GB, outcomes: input.items.map(item => ({ itemId: item.ref.itemId, status: 'deleted' })) });
    });
    const screen = await render(request);
    await vi.waitFor(() => expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(false));
    expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)).toHaveLength(1);
    await screen.pressByTestIdAsync('resource-proposal-item-wt-merged');
    await screen.pressByTestIdAsync('approval-prompt-approve');
    await vi.waitFor(() => expect([...remaining]).toEqual(['wt-merged']));
    expect(readApproval()).toMatchObject({ actionArgs: { items }, decision: { authority: 'present_user',
      narrowedInput: { items: [items[1]] } } });
    expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE)).toHaveLength(0);
    expect(calls(RPC_METHODS.DAEMON_STORAGE_DELETE_NOW)[0]?.payload).toMatchObject({ items: [items[1]] });
    await screen.unmount();
    const settled = ApprovalRequestV2Schema.parse({ ...readApproval(), status: 'executed', updatedAtMs: Date.now(),
      execution: { executedAtMs: Date.now(), ok: true, result: executed } });
    const receipt = await render(settled, false);
    await vi.waitFor(() => expect(receipt.findByTestId('resource-proposal-pile')).toBeTruthy());
    expect(receipt.getTextContent()).toContain('1 GB');
    expect(receipt.findByTestId('machine-storage-pile-undo')).toBeNull();
    expect(receipt.findByTestId('machine-storage-pile-empty')).toBeNull();
    expect(calls(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST)).toHaveLength(0);
    await receipt.unmount();
  });

  it('starts refreshed Caution unticked and permits an explicit tick without another acknowledgement or check', async () => {
    const previousRpc = daemonRpc.getMockImplementation()!;
    daemonRpc.mockImplementation(async call => {
      const result = await previousRpc(call);
      if (call.method !== RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK) return result;
      const review = PileReviewV1Schema.parse(result);
      return { ...review, items: review.items.map(item => ({ ...item, verdict: 'caution' as const })) };
    });
    const screen = await render(proposal());
    await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('machineStorage.verdicts.caution')));
    expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(true);
    await screen.pressByTestIdAsync('resource-proposal-item-wt-merged');
    expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(false);
    expect(screen.findByTestId('resource-proposal-stale')).toBeNull();
    expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)).toHaveLength(1);
    await screen.pressByTestIdAsync('approval-prompt-approve');
    await vi.waitFor(() => expect(readApproval()).toMatchObject({ status: 'approved', decision: { kind: 'approve' } }));
    // Approval needs no second read or separate verdict acknowledgement (R41).
    expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)).toHaveLength(1);
    await screen.unmount();
  });

  it('keeps the tick the person removed while the current-facts check was still running', async () => {
    const previousRpc = daemonRpc.getMockImplementation()!;
    let releaseCheck: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseCheck = resolve; });
    daemonRpc.mockImplementation(async call => {
      const result = await previousRpc(call);
      if (call.method === RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK) await held;
      return result;
    });
    const screen = await render(proposal());
    await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)).toHaveLength(1));
    await screen.pressByTestIdAsync('resource-proposal-item-wt-merged');
    await act(async () => { releaseCheck(); });
    await vi.waitFor(() => expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync('approval-prompt-approve');
    await vi.waitFor(() => expect(readApproval()).toMatchObject({ status: 'approved', decision: { kind: 'approve' } }));
    const decision = readApproval().v === 2 ? (readApproval() as ApprovalRequestV2).decision : undefined;
    const kept = (decision?.narrowedInput as { items: Array<{ ref: { itemId: string } }> }).items;
    expect(kept.map((item) => item.ref.itemId)).toEqual(ids.slice(1));
    await screen.unmount();
  });

  it('approves 5 of 6 with refreshed expectations, then remembers the sixth as declined', async () => {
    checkExpect = (itemId) => `fresh-${itemId}`;
    const screen = await render(proposal());
    // The facts changed since the agent looked: nothing is approvable until it is checked again.
    await vi.waitFor(() =>
      expect(screen.findByTestId('resource-proposal-stale')).toBeTruthy(),
    );
    await screen.pressByTestIdAsync('resource-proposal-check-again');
    await vi.waitFor(() =>
      expect(screen.findByTestId('resource-proposal-stale')).toBeNull(),
    );
    await vi.waitFor(() => expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync('resource-proposal-item-old-wt');
    await screen.pressByTestIdAsync('approval-prompt-approve');
    await vi.waitFor(() =>
      expect(readApproval()).toMatchObject({
        status: 'approved',
        decision: { kind: 'approve' },
      }),
    );
    const decision =
      readApproval().v === 2
        ? (readApproval() as ApprovalRequestV2).decision
        : undefined;
    const kept = (
      decision?.narrowedInput as {
        items: Array<{ ref: { itemId: string }; expect: string }>;
      }
    ).items;
    expect(kept.map((item) => item.ref.itemId)).toEqual(ids.slice(0, 5));
    expect(kept.map((item) => item.expect)).toEqual(
      ids.slice(0, 5).map((itemId) => `fresh-${itemId}`),
    );
    await vi.waitFor(() =>
      expect(
        calls(RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE),
      ).toHaveLength(1),
    );
    expect(
      calls(RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE)[0]!.payload,
    ).toMatchObject({
      machineId: MACHINE,
      items: [{ ref: { itemId: 'old-wt' }, expect: 'fresh-old-wt' }],
    });
  });

  it('declines every item on Not now and changes nothing', async () => {
    const screen = await render(proposal());
    await vi.waitFor(() =>
      expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)).toHaveLength(1),
    );
    // The header chip reflects this Action's own setting for the asking caller (default: Ask first).
    expect(screen.findByTestId('resource-proposal-mode-ask_first')).toBeTruthy();
    await screen.pressByTestIdAsync('approval-prompt-reject');
    await vi.waitFor(() =>
      expect(readApproval()).toMatchObject({ status: 'rejected' }),
    );
    await vi.waitFor(() =>
      expect(
        calls(RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE),
      ).toHaveLength(1),
    );
    const declined = (
      calls(RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE)[0]!.payload as {
        items: Array<{ ref: { itemId: string } }>;
      }
    ).items;
    expect(declined.map((item) => item.ref.itemId)).toEqual([...ids]);
    expect(calls(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)).toHaveLength(0);
  });

  it('withholds approval while an item changed since the agent proposed it', async () => {
    checkExpect = (itemId) =>
      itemId === 'turbo' ? 'grew-turbo' : `claimed-${itemId}`;
    const screen = await render(proposal());
    await vi.waitFor(() =>
      expect(screen.findByTestId('resource-proposal-stale')).toBeTruthy(),
    );
    await screen.pressByTestIdAsync('approval-prompt-approve');
    // Give a (wrongly) admitted decision every chance to land before asserting nothing moved.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(readApproval().status).toBe('open');
    expect(calls(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)).toHaveLength(0);
  });

  it('says "in Trash" after the move and "freed" only once the Trash is emptied', async () => {
    const result: PileApplyResultV1 = {
      batchId: 'batch-1',
      mode: 'trash',
      inTrashBytes: 5 * GB,
      freedBytes: 0,
      outcomes: [
        ...ids
          .slice(0, 5)
          .map((itemId) => ({ itemId, status: 'moved' as const })),
        {
          itemId: 'old-wt',
          status: 'skipped' as const,
          reason: { code: 'changed_since_review' as const },
        },
      ],
    };
    const screen = await render(
      proposal({
        status: 'executed',
        updatedAtMs: 3,
        decision: {
          kind: 'approve',
          decidedAtMs: 2,
          authority: 'present_user',
          narrowedInput: StrictJsonValueSchema.parse(proposalArgs),
        },
        execution: { executedAtMs: 3, ok: true, result },
      }),
    );
    await vi.waitFor(() =>
      expect(screen.getTextContent()).toContain('machineStorage.pile.inTrash'),
    );
    expect(screen.getTextContent()).not.toContain('machineStorage.pile.freed');
    expect(screen.findByTestId('resource-proposal-item-old-wt')).toBeTruthy();
    vi.mocked(Modal.confirm).mockClear().mockResolvedValueOnce(false);
    await screen.pressByTestIdAsync('machine-storage-pile-empty');
    await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalled());
    expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY)).toHaveLength(0);
    expect(screen.getTextContent()).not.toContain('machineStorage.pile.freed');
    await screen.pressByTestIdAsync('machine-storage-pile-empty');
    await vi.waitFor(() =>
      expect(screen.getTextContent()).toContain('machineStorage.pile.freed'),
    );
    expect(
      calls(RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY)[0]!.payload,
    ).toMatchObject({ machineId: MACHINE, entryIds: ids.slice(0, 5).map(itemId => `entry-${itemId}`) });
  });

  it('retries an unavailable receipt when reopening supplies a fresh approval snapshot, but retains settled outcomes', async () => {
    const entryId = 'entry-reopened';
    const result = PileApplyResultV1Schema.parse({ batchId: 'batch-reopened', mode: 'trash', inTrashBytes: GB, freedBytes: 0,
      outcomes: [{ itemId: ids[0], status: 'moved' }], trashEntryIds: [entryId] });
    const request = proposal({ status: 'executed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' },
      execution: { executedAtMs: 3, ok: true, result } });
    const boundary = daemonRpc.getMockImplementation()!;
    let activityAvailable = false;
    daemonRpc.mockImplementation(async call => {
      if (call.method === RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST) return MachineStorageCategoryListResultV1Schema.parse({
        revision: 1, sizedAt: 1, categoryId: 'trash', items: [], trashEntries: [],
      });
      if (call.method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST) {
        if (!activityAvailable) throw new Error('Activity unavailable');
        return MachineGuardActivityListV1Schema.parse({ entries: [{ v: 1, id: `${entryId}-trash_moved`, kind: 'trash_moved',
          at: 1, undoneAt: 4, rule: 'approved_proposal', outcome: 'done', attribution: { kind: 'unknown' } }],
          counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 5 });
      }
      return boundary(call);
    });
    const screen = await render(request);
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-receipt-unavailable')).toBeTruthy());
    // Unavailable must be the settled failed read, not the credential owner's
    // initial resolving phase; otherwise reopening races the first real read.
    expect(calls(RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST)).toHaveLength(1);
    activityAvailable = true;
    const reopen = () => act(async () => screen.update(<ApprovalPromptCard
        artifact={{ id: 'approval-1', header: { title: null, serverId: homeId } }}
        approval={ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)))} sessionId="session-1" canApprove
      />));
    // The exact-Home artifact reader fetches a new snapshot on focus without remounting the retained page.
    await reopen();
    await vi.waitFor(() => expect(calls(RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST)).toHaveLength(2));
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-restored')).toBeTruthy());
    expect(calls(RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST)).toHaveLength(2);
    await reopen();
    expect(screen.findByTestId('resource-proposal-restored')).toBeTruthy();
    expect(calls(RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST)).toHaveLength(2);
  });

  it.each(['emptied', 'restored', 'mixed', 'mixed_closed', 'expired', 'older', 'page_failure', 'activity_failure'] as const)(
    're-derives the %s receipt on remount from correlated Trash and Activity only', async (state) => {
      const entryIds = ids.slice(0, 5).map(itemId => `entry-${itemId}`);
      const result = PileApplyResultV1Schema.parse({ batchId: 'batch-remount', mode: 'trash', inTrashBytes: 5 * GB, freedBytes: 0,
        outcomes: ids.slice(0, 5).map(itemId => ({ itemId, status: 'moved' })),
        ...(state === 'older' ? {} : { trashEntryIds: entryIds }) });
      const request = proposal({ status: 'executed', updatedAtMs: 3,
        decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' },
        execution: { executedAtMs: 3, ok: true, result } });
      const boundary = daemonRpc.getMockImplementation()!;
      daemonRpc.mockImplementation(async call => {
        if (call.method === RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST) {
          const cursor = (call.payload as { cursor?: string }).cursor;
          if (state === 'page_failure' && cursor) throw new Error('Second page unavailable');
          const remaining = (state === 'mixed' || state === 'page_failure') && cursor ? [entryIds[4]!] : [];
          return MachineStorageCategoryListResultV1Schema.parse({ revision: 1, sizedAt: 1, categoryId: 'trash', items: [],
            ...(!cursor && (state === 'mixed' || state === 'page_failure') ? { nextCursor: 'page-2' } : {}),
            trashEntries: remaining.map(entryId => ({ entryId, batchId: result.batchId, volumeId: 'disk',
              originalPath: '/cache/current', title: 'Cache', size: size(GB), movedAt: 1,
              movedBy: { accountId: 'account-1', kind: 'agent' }, emptiesAt: null, restorable: true })) });
        }
        if (call.method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST) {
          if (state === 'activity_failure') throw new Error('Activity unavailable');
          const deleted = state === 'emptied' ? entryIds : state === 'mixed' ? entryIds.slice(0, 2)
            : state === 'mixed_closed' ? entryIds.slice(0, 3) : [];
          const restored = state === 'restored' ? entryIds : state === 'mixed' ? [entryIds[2]!]
            : state === 'mixed_closed' ? entryIds.slice(3) : [];
          return MachineGuardActivityListV1Schema.parse({ entries: [
            ...deleted.map(entryId => ({ v: 1, id: `${entryId}-trash_emptied`, kind: 'trash_emptied', at: 4,
              rule: 'approved_proposal', outcome: 'done', attribution: { kind: 'unknown' }, freedBytes: GB / 2 })),
            ...restored.map(entryId => ({ v: 1, id: `${entryId}-trash_moved`, kind: 'trash_moved', at: 1, undoneAt: 4,
              rule: 'approved_proposal', outcome: 'done', attribution: { kind: 'unknown' } })),
            { v: 1, id: 'unrelated-trash_emptied', kind: 'trash_emptied', at: 4, freedBytes: 99 * GB,
              rule: 'approved_proposal', outcome: 'done', attribution: { kind: 'unknown' } },
          ], counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 5 });
        }
        return boundary(call);
      });
      // Each mount gets the same durable approval, with no local follow-up state.
      const first = await render(request);
      await vi.waitFor(() => expect(calls(RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST)).toHaveLength(1));
      await first.unmount();
      const screen = await render(request, false);
      await vi.waitFor(() => expect(calls(RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST)).toHaveLength(2));
      if (state === 'emptied') {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('machineStorage.pile.freed(amount=2.5 GB)'));
        expect(screen.getTextContent()).not.toContain('machineStorage.pile.inTrash');
      } else if (state === 'restored') {
        await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-restored')).toBeTruthy());
      } else if (state === 'mixed') {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('machineStorage.pile.inTrash(count=1)'));
        expect(screen.getTextContent()).toContain('resourceProposal.receiptFreed(count=2,amount=1 GB)');
        expect(screen.getTextContent()).toContain('resourceProposal.receiptRestored(count=1)');
        expect(screen.getTextContent()).toContain('resourceProposal.receiptUnknown(count=1)');
        await screen.pressByTestIdAsync('machine-storage-pile-undo');
        await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE)[0]?.payload).toMatchObject({ entryIds: [entryIds[4]] }));
        expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE)[0]?.payload).not.toHaveProperty('batchId');
      } else if (state === 'mixed_closed') {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('resourceProposal.receiptFreed(count=3,amount=1.5 GB)'));
        expect(screen.getTextContent()).toContain('resourceProposal.receiptRestored(count=2)');
        expect(screen.getTextContent()).not.toContain('machineStorage.pile.inTrash');
        expect(screen.findByTestId('resource-proposal-receipt-unavailable')).toBeNull();
      } else {
        await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-receipt-unavailable')).toBeTruthy());
        expect(screen.getTextContent()).not.toContain('machineStorage.pile.freed');
        expect(screen.getTextContent()).not.toContain('machineStorage.pile.inTrash');
      }
      if (state !== 'mixed') {
        expect(screen.findByTestId('machine-storage-pile-undo')).toBeNull();
        expect(screen.findByTestId('machine-storage-pile-empty')).toBeNull();
      }
      expect(calls(RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST)[0]?.payload).toMatchObject({ range: '30d', filter: 'all' });
    },
  );

  it('retains an occupied Undo refusal per entry and retries only that entry beside the occupant', async () => {
    const result = PileApplyResultV1Schema.parse({ batchId: 'batch-1', mode: 'trash', inTrashBytes: GB, freedBytes: 0,
      trashEntryIds: ids.slice(0, 2).map(itemId => `entry-${itemId}`),
      outcomes: ids.slice(0, 2).map(itemId => ({ itemId, status: 'moved' })) });
    const request = proposal({ status: 'executed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' },
      execution: { executedAtMs: 3, ok: true, result } });
    const boundary = daemonRpc.getMockImplementation()!;
    daemonRpc.mockImplementation(async call => {
      if (call.method !== RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE) return boundary(call);
      const payload = call.payload as { entryIds: string[]; beside?: true };
      return { outcomes: payload.entryIds.map(entryId => entryId === 'entry-wt-merged' && !payload.beside
        ? { entryId, status: 'refused', reason: { code: 'destination_occupied' } }
        : { entryId, status: 'restored', path: `/cache/${entryId}${payload.beside ? ' (restored)' : ''}` }) };
    });
    const hook = await renderHook(() => useResourceProposalCheck(request, homeId));
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(hook.getCurrent()?.undo).toBeTypeOf('function');
    });
    await act(async () => { expect(await hook.getCurrent()!.undo!()).toBe(false); });
    expect(hook.getCurrent()!.restoreOutcomes['entry-wt-merged']).toMatchObject({ status: 'refused', reason: { code: 'destination_occupied' } });
    expect(hook.getCurrent()!.restoreEntries).toEqual([
      expect.objectContaining({ entryId: 'entry-wt-merged', originalPath: ref('wt-merged').path }),
    ]);
    expect(hook.getCurrent()!.display).toMatchObject({ kind: 'trashed' });
    const callsBefore = calls(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE).length;
    await act(async () => { expect(await hook.getCurrent()!.putBackBeside!('entry-node-modules')).toBe(false); });
    expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE)).toHaveLength(callsBefore);
    await act(async () => { expect(await hook.getCurrent()!.putBackBeside!('entry-wt-merged')).toBe(true); });
    expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE).at(-1)?.payload).toMatchObject({ entryIds: ['entry-wt-merged'], beside: true });
    expect(hook.getCurrent()!.restoreOutcomes['entry-wt-merged']).toMatchObject({ status: 'restored', path: '/cache/entry-wt-merged (restored)' });
    expect(hook.getCurrent()!.display).toMatchObject({ kind: 'restored' });
  });

  it('names the refused item on the receipt with its reason, offers Put back beside it, and shows where it went', async () => {
    const result = PileApplyResultV1Schema.parse({ batchId: 'batch-1', mode: 'trash', inTrashBytes: GB, freedBytes: 0,
      trashEntryIds: ids.slice(0, 2).map(itemId => `entry-${itemId}`),
      outcomes: ids.slice(0, 2).map(itemId => ({ itemId, status: 'moved' })) });
    const request = proposal({ status: 'executed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' },
      execution: { executedAtMs: 3, ok: true, result } });
    const boundary = daemonRpc.getMockImplementation()!;
    daemonRpc.mockImplementation(async call => {
      if (call.method !== RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE) return boundary(call);
      const payload = call.payload as { entryIds: string[]; beside?: true };
      return { outcomes: payload.entryIds.map(entryId => entryId === 'entry-wt-merged' && !payload.beside
        ? { entryId, status: 'refused', reason: { code: 'destination_occupied' } }
        : { entryId, status: 'restored', path: `/cache/${entryId}${payload.beside ? ' (restored)' : ''}` }) };
    });
    const screen = await render(request);
    await vi.waitFor(() => expect(screen.findByTestId('machine-storage-pile-undo')).toBeTruthy());
    expect(screen.findByTestId('resource-proposal-restore')).toBeNull();
    await screen.pressByTestIdAsync('machine-storage-pile-undo');
    await vi.waitFor(() => expect(screen.findByTestId('machine-storage-restore-recovery-entry-wt-merged-beside')).toBeTruthy());
    // Joined by entry id: only the refused entry is named, and the restored one is not.
    expect(screen.getTextContent()).toContain('wt-merged');
    expect(screen.getTextContent()).toContain('machineStorage.page.putBackOccupied');
    expect(screen.findByTestId('machine-storage-restore-recovery-entry-node-modules')).toBeNull();
    await screen.pressByTestIdAsync('machine-storage-restore-recovery-entry-wt-merged-beside');
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('machineStorage.page.putBackAs(path=/cache/entry-wt-merged (restored))'));
    expect(screen.findByTestId('machine-storage-restore-recovery-entry-wt-merged-beside')).toBeNull();
    expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE).at(-1)?.payload).toMatchObject({ entryIds: ['entry-wt-merged'], beside: true });
  });

  it('keeps partial Empty and Restore outcomes scoped to the remaining entries with only real freed bytes', async () => {
    const entryIds = ['first', 'second', 'third'];
    const result = PileApplyResultV1Schema.parse({ batchId: 'batch-partial', mode: 'trash', inTrashBytes: GB, freedBytes: 0, trashEntryIds: entryIds,
      outcomes: ids.slice(0, 3).map(itemId => ({ itemId, status: 'moved' })) });
    const boundary = daemonRpc.getMockImplementation()!;
    daemonRpc.mockImplementation(async call => {
      if (call.method === RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST) return MachineStorageCategoryListResultV1Schema.parse({
        revision: 1, sizedAt: 1, categoryId: 'trash', items: [], trashEntries: entryIds.map(entryId => ({ entryId,
          batchId: result.batchId, volumeId: 'disk', originalPath: `/cache/${entryId}`, title: entryId, size: size(GB),
          movedAt: 1, movedBy: { accountId: 'account-1', kind: 'agent' }, emptiesAt: null, restorable: true })) });
      if (call.method === RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY) return { freedBytes: GB / 2, outcomes: [
        { entryId: 'first', status: 'deleted' }, { entryId: 'second', status: 'failed' }, { entryId: 'third', status: 'refused' }] };
      if (call.method === RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE) return { outcomes: [
        { entryId: 'second', status: 'restored' }, { entryId: 'third', status: 'failed' }] };
      return boundary(call);
    });
    const screen = await render(proposal({ status: 'executed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' }, execution: { executedAtMs: 3, ok: true, result } }));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('machineStorage.pile.inTrash(count=3)'));
    expect(screen.getTextContent()).not.toContain('3 GB');
    await screen.pressByTestIdAsync('machine-storage-pile-empty');
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('machineStorage.pile.inTrash(count=2)'));
    // Per-entry allocated sizes cannot prove a union after partial effects (hardlinks/clones).
    expect(screen.getTextContent()).not.toContain('2 GB');
    expect(screen.getTextContent()).toContain('resourceProposal.receiptFreed(count=1,amount=500 MB)');
    await screen.pressByTestIdAsync('machine-storage-pile-undo');
    await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE)[0]?.payload).toMatchObject({ entryIds: ['second', 'third'] }));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('machineStorage.pile.inTrash(count=1)'));
    expect(screen.findByTestId('resource-proposal-restored')).toBeNull();
    expect(screen.getTextContent()).toContain('resourceProposal.receiptRestored(count=1)');
    expect(screen.getTextContent()).toContain('resourceProposal.receiptFreed(count=1,amount=500 MB)');
  });

  it('acquires two receipts for A and one for B once per scope across partial effects and remount', async () => {
    const otherMachine = 'receipt-machine-b';
    const rows = [
      { ...createPlainMachineRowFixture({ id: MACHINE, accountId: 'account-1' }), installationId: 'installation-exact' },
      { ...createPlainMachineRowFixture({ id: otherMachine, accountId: 'account-1' }), installationId: 'installation-b' },
    ];
    home.answer(homeId, 'GET /v1/machines', { body: rows });
    home.answer(homeId, `GET /v1/machines/${otherMachine}`, { body: { machine: rows[1] } });
    storage.setState({ machineListByServerId: { [homeId]: [
      ...(storage.getState().machineListByServerId[homeId] ?? []),
      createMachineFixture({ id: otherMachine, activeAt: Date.now(), storageMode: 'plain', isShared: false }),
    ] } });
    const entries = ['first', 'second', 'third', 'other-a', 'other-b'];
    const remaining = new Set(entries);
    const activity: Array<Record<string, unknown>> = [];
    const result = (batchId: string, entryIds: string[]) => PileApplyResultV1Schema.parse({
      batchId, mode: 'trash', inTrashBytes: GB, freedBytes: 0, trashEntryIds: entryIds,
      outcomes: entryIds.map((_, index) => ({ itemId: ids[index]!, status: 'moved' })),
    });
    const executed = (value: PileApplyResultV1) => proposal({ status: 'executed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' },
      execution: { executedAtMs: 3, ok: true, result: value } });
    const first = executed(result('partial-a', entries.slice(0, 3)));
    const secondBase = executed(result('other-a', ['other-a']));
    const second = signed({ ...secondBase, executionOriginV1: { ...secondBase.executionOriginV1, requestId: 'receipt-request-2' } });
    const thirdBase = executed(result('other-b', ['other-b']));
    const third = signed({ ...thirdBase, actionArgs: { ...proposalArgs, machineId: otherMachine },
      executionOriginV1: { ...thirdBase.executionOriginV1, machineId: otherMachine, requestId: 'receipt-request-b' } }, 'installation-b');
    const original = daemonRpc.getMockImplementation()!;
    daemonRpc.mockImplementation(async call => {
      if (call.method === RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST) {
        const forMachine = call.machineId === otherMachine ? ['other-b'] : entries.slice(0, 4);
        return MachineStorageCategoryListResultV1Schema.parse({ revision: activity.length + 1, sizedAt: 1,
          categoryId: 'trash', items: [], trashEntries: forMachine.filter(entryId => remaining.has(entryId)).map(entryId => ({
            entryId, batchId: entryId === 'other-a' || entryId === 'other-b' ? entryId : 'partial-a', volumeId: 'disk',
            originalPath: `/cache/${entryId}`, title: entryId, size: size(GB), movedAt: 1,
            movedBy: { accountId: 'account-1', kind: 'agent' }, emptiesAt: null, restorable: true,
          })) });
      }
      if (call.method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST) return MachineGuardActivityListV1Schema.parse({
        entries: call.machineId === otherMachine ? [] : activity,
        counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: activity.length + 1,
      });
      if (call.method === RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY) {
        remaining.delete('first');
        activity.push({ v: 1, id: 'first-trash_emptied', kind: 'trash_emptied', at: 4,
          rule: 'approved_proposal', outcome: 'done', attribution: { kind: 'unknown' }, freedBytes: GB / 2 });
        return { freedBytes: GB / 2, outcomes: [
          { entryId: 'first', status: 'deleted' }, { entryId: 'second', status: 'failed' }, { entryId: 'third', status: 'refused' },
        ] };
      }
      if (call.method === RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE) {
        remaining.delete('second');
        activity.push({ v: 1, id: 'second-trash_moved', kind: 'trash_moved', at: 1, undoneAt: 5,
          rule: 'approved_proposal', outcome: 'done', attribution: { kind: 'unknown' } });
        return { outcomes: [{ entryId: 'second', status: 'restored' }, { entryId: 'third', status: 'failed' }] };
      }
      return original(call);
    });
    const reads = (method: string, machineId: string) => calls(method).filter(call => call.machineId === machineId).length;
    const a = await render(first);
    const a2 = await render(second, true, 'approval-2');
    const b = await render(third, true, 'approval-b');
    await vi.waitFor(() => {
      expect(a.getTextContent()).toContain('machineStorage.pile.inTrash(count=3)');
      expect(a2.getTextContent()).toContain('machineStorage.pile.inTrash(count=1)');
      expect(b.getTextContent()).toContain('machineStorage.pile.inTrash(count=1)');
    });
    for (const method of [RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST]) {
      expect(reads(method, MACHINE)).toBe(1);
      expect(reads(method, otherMachine)).toBe(1);
    }
    const otherReads = [reads(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, otherMachine), reads(RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST, otherMachine)];
    await a.pressByTestIdAsync('machine-storage-pile-empty');
    await vi.waitFor(() => expect(a.getTextContent()).toContain('machineStorage.pile.inTrash(count=2)'));
    await a.pressByTestIdAsync('machine-storage-pile-undo');
    await vi.waitFor(() => expect(a.getTextContent()).toContain('machineStorage.pile.inTrash(count=1)'));
    expect([reads(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, otherMachine), reads(RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST, otherMachine)]).toEqual(otherReads);
    await a.unmount();
    await a2.unmount();
    await b.unmount();
    const before = [reads(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, MACHINE), reads(RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST, MACHINE)];
    const reopened = await render(first, false);
    const reopened2 = await render(second, false, 'approval-2');
    const reopenedB = await render(third, false, 'approval-b');
    await vi.waitFor(() => {
      expect(reopened.getTextContent()).toContain('machineStorage.pile.inTrash(count=1)');
      expect(reopened.getTextContent()).toContain('resourceProposal.receiptRestored(count=1)');
      expect(reopened.getTextContent()).toContain('resourceProposal.receiptFreed(count=1,amount=500 MB)');
      expect(reopened2.getTextContent()).toContain('machineStorage.pile.inTrash(count=1)');
      expect(reopenedB.getTextContent()).toContain('machineStorage.pile.inTrash(count=1)');
    });
    expect(reads(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, MACHINE) - before[0]!).toBe(1);
    expect(reads(RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST, MACHINE) - before[1]!).toBe(1);
    await reopened.unmount();
    await reopened2.unmount();
    await reopenedB.unmount();
  });

  it('keeps a declined proposal as one line; Reopen runs the same Action from the UI and the request stays rejected', async () => {
    const screen = await render(proposal({
      status: 'rejected', updatedAtMs: 2, decision: { kind: 'reject', decidedAtMs: 2 },
    }));
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-declined')).toBeTruthy());
    await screen.pressByTestIdAsync('resource-proposal-reopen');
    await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK)).toHaveLength(1));
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-run')).toBeTruthy());
    await screen.pressByTestIdAsync('resource-proposal-item-old-wt');
    await screen.pressByTestIdAsync('resource-proposal-run');
    await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE)).toHaveLength(1));
    const moved = (calls(RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE)[0]!.payload as { items: Array<{ ref: { itemId: string } }> }).items;
    expect(moved.map((item) => item.ref.itemId)).toEqual(ids.slice(0, 5));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('machineStorage.pile.inTrash'));
    expect(readApproval().status).toBe('rejected');
    expect(calls(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)).toHaveLength(0);
  });

  it('tries a skipped item again as a new invocation for that item only', async () => {
    const result: PileApplyResultV1 = {
      batchId: 'batch-1', mode: 'trash', inTrashBytes: 5 * GB, freedBytes: 0,
      outcomes: [...ids.slice(0, 5).map((itemId) => ({ itemId, status: 'moved' as const })),
        { itemId: 'old-wt', status: 'skipped' as const, reason: { code: 'in_use' as const } }],
    };
    const screen = await render(proposal({
      status: 'executed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user', narrowedInput: StrictJsonValueSchema.parse(proposalArgs) },
      execution: { executedAtMs: 3, ok: true, result },
    }));
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-retry-old-wt')).toBeTruthy());
    await screen.pressByTestIdAsync('resource-proposal-retry-old-wt');
    await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE)).toHaveLength(1));
    const moved = (calls(RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE)[0]!.payload as { items: Array<{ ref: { itemId: string } }> }).items;
    expect(moved.map((item) => item.ref.itemId)).toEqual(['old-wt']);
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-retry-old-wt')).toBeNull());
    // The retry has its own receipt, from its own settled result and batch.
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-retry-receipt-batch-ui')).toBeTruthy());
    await vi.waitFor(() => expect(findAllHostTestInstances(
      screen.findByTestId('resource-proposal-retry-receipt-batch-ui')!,
      node => node.props.testID === 'machine-storage-pile-undo',
    )).toHaveLength(1));
    const retryReceipt = screen.findByTestId('resource-proposal-retry-receipt-batch-ui')!;
    const undoButton = findAllHostTestInstances(retryReceipt, node => node.props.testID === 'machine-storage-pile-undo')[0];
    await pressTestInstanceAsync(undoButton, 'retry batch Undo');
    await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE)).toHaveLength(1));
    expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE)[0]!.payload).toMatchObject({ entryIds: ['entry-ui-old-wt'] });
  });

  it.each(['delete', 'trash'] as const)('retries only the selected skipped operand with current facts after a partial %s receipt is freed and remounted', async mode => {
    const actionId = mode === 'delete' ? 'machines.storage.deleteNow' : 'machines.storage.trash.move';
    home.answer(homeId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1: setActionApprovalOverride({ settings: normalizeActionsSettingsV1(null), actionId,
        surface: 'ui', approvalRequired: true }),
    } }, version: 1 } });
    const method = mode === 'delete' ? RPC_METHODS.DAEMON_STORAGE_DELETE_NOW : RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE;
    const args = mode === 'delete'
      ? MachineStorageDeleteNowInputV1Schema.parse({ machineId: MACHINE,
        items: proposalArgs.items.map(({ ref, expect }) => ({ ref, expect })) }) : proposalArgs;
    const result = PileApplyResultV1Schema.parse({ batchId: 'batch-1', mode,
      inTrashBytes: mode === 'trash' ? 4 * GB : 0, freedBytes: mode === 'delete' ? 4 * GB : 0,
      ...(mode === 'trash' ? { trashEntryIds: ids.slice(0, 4).map(id => `entry-${id}`) } : {}),
      outcomes: [...ids.slice(0, 4).map(itemId => ({ itemId, status: mode === 'delete' ? 'deleted' : 'moved' })),
        ...ids.slice(4).map(itemId => ({ itemId, status: 'skipped', reason: { code: 'changed_since_review' } }))] });
    const base = proposal();
    const request = ApprovalRequestV2Schema.parse({ ...base, actionId, actionArgs: args,
      executionOriginV1: { ...base.executionOriginV1, actionId }, status: 'executed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user', narrowedInput: StrictJsonValueSchema.parse(args) },
      execution: { executedAtMs: 3, ok: true, result } });
    let emptied = false;
    const incumbent = daemonRpc.getMockImplementation()!;
    daemonRpc.mockImplementation(async call => {
      if (call.method === RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY) {
        emptied = true;
        return { outcomes: ids.slice(0, 4).map(id => ({ entryId: `entry-${id}`, status: 'deleted' })), freedBytes: 4 * GB };
      }
      if (emptied && call.method === RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST) {
        return MachineStorageCategoryListResultV1Schema.parse({ revision: 2, sizedAt: 4, categoryId: 'trash', items: [], trashEntries: [] });
      }
      if (emptied && call.method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST) {
        return MachineGuardActivityListV1Schema.parse({ entries: ids.slice(0, 4).map(id => ({ v: 1,
          id: `entry-${id}-trash_emptied`, kind: 'trash_emptied', at: 4, rule: 'approved_proposal',
          outcome: 'done', attribution: { kind: 'unknown' }, freedBytes: GB })),
          counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 4 });
      }
      if (call.method === RPC_METHODS.DAEMON_STORAGE_DELETE_NOW) {
        const input = MachineStorageDeleteNowInputV1Schema.parse(call.payload);
        return PileApplyResultV1Schema.parse({ batchId: 'retry-delete', mode: 'delete', inTrashBytes: 0,
          freedBytes: input.items.length * GB, outcomes: input.items.map(item => ({ itemId: item.ref.itemId, status: 'deleted' })) });
      }
      return incumbent(call);
    });
    const first = await render(request);
    if (mode === 'trash') {
      await vi.waitFor(() => expect(first.findByTestId('machine-storage-pile-empty')).toBeTruthy());
      await first.pressByTestIdAsync('machine-storage-pile-empty');
    }
    await vi.waitFor(() => expect(first.getTextContent()).toContain('machineStorage.pile.freed(amount=4 GB)'));
    expect(first.findByTestId('resource-proposal-retry-old-wt')).not.toBeNull();
    await first.unmount();
    const screen = await render(request, false);
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('machineStorage.pile.freed(amount=4 GB)'));
    checkExpect = itemId => `current-${itemId}`;
    await screen.pressByTestIdAsync('resource-proposal-retry-old-wt');
    // Explicit Ask first creates a fresh approval Artifact through the Action owner.
    await vi.waitFor(() => expect(home.artifacts(homeId).list().filter(row => row.id !== 'approval-1')).toHaveLength(1));
    const retryApprovalId = home.artifacts(homeId).list().find(row => row.id !== 'approval-1')!.id;
    expect(ApprovalRequestSchema.parse(JSON.parse(home.artifacts(homeId).readPlainBody(retryApprovalId)!))).toMatchObject({
      status: 'open', actionId, actionArgs: { items: [{ ref: { itemId: 'old-wt' }, expect: 'current-old-wt' }] },
    });
    expect(calls(method)).toHaveLength(0);
    // A subsequent UI invocation obeys the newly selected Allowed preference as well.
    home.answer(homeId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1: setActionApprovalOverride({ settings: normalizeActionsSettingsV1(null), actionId,
        surface: 'ui', approvalRequired: false }),
    } }, version: 2 } });
    await screen.pressByTestIdAsync('resource-proposal-retry-old-wt');
    await vi.waitFor(() => expect(calls(method)).toHaveLength(1));
    expect(calls(RPC_METHODS.DAEMON_STORAGE_ITEMS_CHECK).at(-1)?.payload).toMatchObject({ refs: [{ itemId: 'old-wt', path: ref('old-wt').path }] });
    const input = calls(method)[0]!.payload as { items: Array<{ ref: { itemId: string }; expect: string }> };
    expect(input.items.map(item => ({ itemId: item.ref.itemId, expect: item.expect }))).toEqual([{ itemId: 'old-wt', expect: 'current-old-wt' }]);
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-retry-old-wt')).toBeNull());
    expect(screen.findByTestId('resource-proposal-retry-playwright')).not.toBeNull();
    expect(calls(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)).toHaveLength(0);
    await screen.unmount();
  });

  it('retains the successful retry batch after Undo and a cold reopened failed-first proposal', async () => {
    const args = { ...proposalArgs, items: [proposalArgs.items[5]!] };
    const first = PileApplyResultV1Schema.parse({ batchId: 'batch-failed', mode: 'trash',
      outcomes: [{ itemId: 'old-wt', status: 'failed', reason: { code: 'operation_failed' } }],
      inTrashBytes: 0, freedBytes: 0, trashEntryIds: [] });
    const retry = PileApplyResultV1Schema.parse({ batchId: 'batch-retry', mode: 'trash',
      outcomes: [{ itemId: 'old-wt', status: 'moved' }], inTrashBytes: GB, freedBytes: 0,
      trashEntryIds: ['entry-retry'] });
    let moved = false;
    let restored = false;
    const incumbent = daemonRpc.getMockImplementation()!;
    daemonRpc.mockImplementation(async call => {
      if (call.method === RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE) {
        moved = true;
        return retry;
      }
      if (call.method === RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST) {
        return MachineStorageCategoryListResultV1Schema.parse({ revision: 1, sizedAt: 1,
          categoryId: 'trash', items: [], trashEntries: moved && !restored ? [{ entryId: 'entry-retry',
            batchId: retry.batchId, volumeId: 'disk', originalPath: ref('old-wt').path,
            title: 'Old worktree', size: size(GB), movedAt: 4,
            movedBy: { accountId: 'account-1', kind: 'person' }, emptiesAt: null, restorable: true }] : [] });
      }
      if (call.method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST) {
        return MachineGuardActivityListV1Schema.parse({ entries: moved ? [{ v: 1,
          id: 'entry-retry-trash_moved', kind: 'trash_moved', at: 4, rule: 'approved_proposal',
          outcome: 'done', inTrashBytes: GB, freedBytes: 0, attribution: { kind: 'unknown' },
          ...(restored ? { undoneAt: 5 } : {}) }] : [],
          counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 5 });
      }
      if (call.method === RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE) {
        restored = true;
        return { outcomes: [{ entryId: 'entry-retry', status: 'restored' }] };
      }
      return incumbent(call);
    });
    const request = proposal({ actionArgs: args, status: 'executed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user', narrowedInput: StrictJsonValueSchema.parse(args) },
      execution: { executedAtMs: 3, ok: true, result: first } });
    const screen = await render(request);
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-retry-old-wt')).toBeTruthy());
    await screen.pressByTestIdAsync('resource-proposal-retry-old-wt');
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-retry-receipt-batch-retry')).toBeTruthy());
    await vi.waitFor(() => expect(screen.findByTestId('machine-storage-pile-undo')).toBeTruthy());
    await screen.pressByTestIdAsync('machine-storage-pile-undo');
    await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE)[0]?.payload).toMatchObject({ entryIds: ['entry-retry'] }));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('resourceProposal.restored'));
    await act(async () => screen.unmount());
    const stored = ApprovalRequestV2Schema.parse(readApproval());
    expect(stored.execution?.result).toEqual(first);
    expect(stored.storageRetryResults).toEqual([retry]);
    const reopened = await render(stored, false);
    await vi.waitFor(() => expect(reopened.getTextContent()).toContain('resourceProposal.restored'));
    expect(reopened.findByTestId('resource-proposal-retry-old-wt')).toBeNull();
    expect(reopened.findByTestId('machine-storage-pile-undo')).toBeNull();
    expect(reopened.findByTestId('resource-proposal-retry-receipt-batch-retry')).toBeTruthy();
  });

  it('keeps the retry receipt and the unresolved rows when Undo puts the original batch back (RV-A2-F2)', async () => {
    const result = PileApplyResultV1Schema.parse({ batchId: 'batch-1', mode: 'trash', inTrashBytes: GB, freedBytes: 0,
      trashEntryIds: ['entry-wt-merged'],
      outcomes: [{ itemId: 'wt-merged', status: 'moved' },
        { itemId: 'playwright', status: 'skipped', reason: { code: 'in_use' } },
        { itemId: 'old-wt', status: 'skipped', reason: { code: 'in_use' } }] });
    const request = proposal({ status: 'executed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user', narrowedInput: StrictJsonValueSchema.parse(proposalArgs) },
      execution: { executedAtMs: 3, ok: true, result } });
    const restored = new Set<string>();
    const boundary = daemonRpc.getMockImplementation()!;
    daemonRpc.mockImplementation(async call => {
      if (call.method === RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE) {
        for (const entryId of (call.payload as { entryIds: string[] }).entryIds) restored.add(entryId);
      }
      if (call.method === RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST) {
        const held = [{ entryId: 'entry-wt-merged', batchId: 'batch-1', itemId: 'wt-merged' },
          ...uiMovedItems.map(itemId => ({ entryId: `entry-ui-${itemId}`, batchId: 'batch-ui', itemId }))]
          .filter(entry => !restored.has(entry.entryId));
        return MachineStorageCategoryListResultV1Schema.parse({ revision: 1, sizedAt: 1, categoryId: 'trash', items: [],
          trashEntries: held.map(entry => ({ entryId: entry.entryId, batchId: entry.batchId, volumeId: 'disk',
            originalPath: ref(entry.itemId).path, title: entry.itemId, size: size(GB), movedAt: 1,
            movedBy: { accountId: 'account-1', kind: 'person' }, emptiesAt: null, restorable: true })) });
      }
      if (call.method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST) {
        return MachineGuardActivityListV1Schema.parse({ entries: [...restored].map(entryId => ({ v: 1,
          id: `${entryId}-trash_moved`, kind: 'trash_moved', at: 1, rule: 'approved_proposal', outcome: 'done',
          inTrashBytes: GB, freedBytes: 0, attribution: { kind: 'unknown' }, undoneAt: 5 })),
          counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 5 });
      }
      return boundary(call);
    });
    const screen = await render(request);
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-retry-old-wt')).toBeTruthy());
    await screen.pressByTestIdAsync('resource-proposal-retry-old-wt');
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-retry-receipt-batch-ui')).toBeTruthy());
    // Undo the original batch: the card's own receipt, not the retry's.
    const original = () => screen.findByTestId('resource-proposal-pile')!;
    await vi.waitFor(() => expect(findAllHostTestInstances(original(), node => node.props.testID === 'machine-storage-pile-undo')).toHaveLength(1));
    await pressTestInstanceAsync(findAllHostTestInstances(original(), node => node.props.testID === 'machine-storage-pile-undo')[0], 'original Undo');
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-restored')).toBeTruthy());
    // The retry batch is still in the Trash and still actionable, and the operand nobody retried is still there to try again.
    const retryReceipt = screen.findByTestId('resource-proposal-retry-receipt-batch-ui');
    expect(retryReceipt).toBeTruthy();
    expect(findAllHostTestInstances(retryReceipt!, node => node.props.testID === 'machine-storage-pile-undo')).toHaveLength(1);
    expect(screen.findByTestId('resource-proposal-retry-playwright')).toBeTruthy();
    // What Undo put back is not listed as work again.
    expect(screen.findByTestId('resource-proposal-retry-wt-merged')).toBeNull();
    await screen.unmount();
  });

  it('keeps the real retry receipt and Undo when the history compare-and-set is refused', async () => {
    const args = { ...proposalArgs, items: [proposalArgs.items[5]!] };
    const request = proposal({ actionArgs: args, status: 'executed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true,
        result: PileApplyResultV1Schema.parse({ batchId: 'first-failed', mode: 'trash', inTrashBytes: 0,
          freedBytes: 0, trashEntryIds: [], outcomes: [{ itemId: 'old-wt', status: 'failed' }] }) } });
    const screen = await render(request);
    home.answer(homeId, 'POST /v1/artifacts/approval-1', { body: { success: false, error: 'version-mismatch' } });
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.alert).mockClear();
    await screen.pressByTestIdAsync('resource-proposal-retry-old-wt');
    await vi.waitFor(() => expect(screen.findByTestId('machine-storage-pile-undo')).toBeTruthy());
    expect(Modal.alert).toHaveBeenCalled();
    expect(readApproval()).toEqual(request);
    await screen.pressByTestIdAsync('machine-storage-pile-undo');
    await vi.waitFor(() => expect(calls(RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE)[0]?.payload).toMatchObject({ entryIds: ['entry-ui-old-wt'] }));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('resourceProposal.restored'));
  });

  it('starts a stopped process again through the process owner’s Start again', async () => {
    const stopArgs = { machineId: MACHINE, targets: [{ ref: 'cHJvYzox', expect: { level: 'proven' as const, owner: { kind: 'browser_sidecar' as const } } }] };
    const base = proposal();
    const request = ApprovalRequestV2Schema.parse({
      ...base, actionId: 'machines.processes.stop', actionArgs: stopArgs,
      executionOriginV1: { ...base.executionOriginV1, actionId: 'machines.processes.stop' },
      status: 'executed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user', narrowedInput: StrictJsonValueSchema.parse(stopArgs) },
      execution: { executedAtMs: 3, ok: true, result: { status: 'ended', outcomes: [{ ref: 'cHJvYzox', outcome: 'ended', freedBytes: GB }] } },
    });
    const screen = await render(request);
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-start-again-cHJvYzox')).toBeTruthy());
    expect(screen.getTextContent()).toContain('resourceProposal.stoppedFreed');
    await screen.pressByTestIdAsync('resource-proposal-start-again-cHJvYzox');
    await vi.waitFor(() => expect(calls(RPC_METHODS.MACHINES_PROCESSES_START_AGAIN)).toHaveLength(1));
    expect(calls(RPC_METHODS.MACHINES_PROCESSES_START_AGAIN)[0]!.payload).toMatchObject({ machineId: MACHINE, ref: 'cHJvYzox' });
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('resourceProposal.startedAgain'));
  });

  it.each(['machines.processes.stop', 'machines.processes.kill', 'machines.processes.leftBehind.cleanUp'] as const)('checks and approves only the selected %s references', async (actionId) => {
    const refs = ['cHJvYzox', 'cHJvYzoy'];
    const level = actionId === 'machines.processes.leftBehind.cleanUp' ? 'left_behind' : 'proven';
    const actionArgs = actionId === 'machines.processes.leftBehind.cleanUp'
      ? { machineId: MACHINE, refs }
      : { machineId: MACHINE, ...(actionId === 'machines.processes.kill' ? { tree: true } : {}), targets: refs.map(ref => ({ ref, expect: { level } })) };
    const boundary = daemonRpc.getMockImplementation()!;
    daemonRpc.mockImplementation(async (call) => call.method === RPC_METHODS.MACHINES_PROCESSES_CHECK
      ? { checks: refs.map(ref => ({ ref, present: true, identityEqual: true, level, memoryBytes: GB })) }
      : boundary(call));
    const base = proposal();
    const request = signed(ApprovalRequestV2Schema.parse({ ...base, actionId, actionArgs,
      executionOriginV1: { ...base.executionOriginV1, actionId } }));
    const screen = await render(request);
    await vi.waitFor(() => expect(calls(RPC_METHODS.MACHINES_PROCESSES_CHECK)).toHaveLength(1));
    await vi.waitFor(() => expect(screen.findByTestId('resource-proposal-item-cHJvYzoy')).toBeTruthy());
    await vi.waitFor(() => expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync('resource-proposal-item-cHJvYzoy');
    await screen.pressByTestIdAsync('approval-prompt-approve');
    await vi.waitFor(() => expect(readApproval()).toMatchObject({ status: 'approved' }));
    expect((readApproval() as ApprovalRequestV2).decision?.narrowedInput).toEqual(actionId === 'machines.processes.leftBehind.cleanUp'
      ? { machineId: MACHINE, refs: [refs[0]] }
      : { machineId: MACHINE, ...(actionId === 'machines.processes.kill' ? { tree: true } : {}), targets: [{ ref: refs[0], expect: { level } }] });
  });

  it.each([
    ['machines.processes.stop', 'working'],
    ['machines.processes.kill', 'waiting_for_you'],
  ] as const)('leaves %s %s work unticked until its named-loss confirmation, then admits exactly that consent', async (actionId, reason) => {
    const ref = 'cHJvYzox';
    const owner = { kind: 'session' as const, sessionId: 'session-1' };
    const args = { machineId: MACHINE, ...(actionId === 'machines.processes.kill' ? { tree: true } : {}),
      targets: [{ ref, expect: { level: 'likely', owner } }] };
    const guard = createMachineGuardViewFixture();
    guard.ladder.excluded.push({ ref: 'session:session-1', processRef: ref, kind: 'session',
      label: 'Upgrade the editor', reason, footprintBytes: GB });
    const boundary = daemonRpc.getMockImplementation()!;
    daemonRpc.mockImplementation(async call => call.method === RPC_METHODS.MACHINES_PROCESSES_CHECK
      ? { checks: [{ ref, present: true, identityEqual: true, level: 'proven', owner, memoryBytes: GB }] }
      : call.method === RPC_METHODS.MACHINES_GUARD_GET ? guard : boundary(call));
    const base = proposal();
    const request = signed(ApprovalRequestV2Schema.parse({ ...base, actionId, actionArgs: args,
      executionOriginV1: { ...base.executionOriginV1, actionId } }));
    const screen = await render(request);
    await vi.waitFor(() => expect(calls(RPC_METHODS.MACHINES_PROCESSES_CHECK)).toHaveLength(1));
    await vi.waitFor(() => expect(screen.findByTestId(`resource-proposal-item-${ref}`)).toBeTruthy());
    await vi.waitFor(() => expect(screen.getTextContent()).toContain(`machineGuard.reasons.${reason}`));
    // Current facts and the asynchronous approval admission must both reach the actionable row.
    await vi.waitFor(() => expect(screen.findHostByTestId(`resource-proposal-item-${ref}`)?.props.role).toBe('checkbox'));
    await vi.waitFor(() => expect(screen.findByTestId(`resource-proposal-item-${ref}`)?.props.accessibilityState?.checked).toBe(false));
    expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(true);
    await screen.pressByTestIdAsync(`resource-proposal-item-${ref}`);
    expect(screen.getTextContent()).toContain('Upgrade the editor');
    expect(screen.getTextContent()).toContain(`machineGuard.reasons.${reason}`);
    expect(screen.getTextContent()).toContain(actionId === 'machines.processes.kill'
      ? 'resourceProposal.processKillLoss' : 'resourceProposal.processStopLoss');
    await screen.pressByTestIdAsync(`resource-proposal-include-${ref}`);
    expect(screen.findByTestId(`resource-proposal-item-${ref}`)?.props.accessibilityState?.checked).toBe(true);
    // Consent to the old loss must not carry into a different current work state.
    const nextReason = reason === 'working' ? 'waiting_for_you' : 'working';
    guard.ladder.excluded[0]!.reason = nextReason;
    await screen.pressByTestIdAsync('resource-proposal-check-again');
    await vi.waitFor(() => expect(screen.getTextContent()).toContain(`machineGuard.reasons.${nextReason}`));
    expect(screen.findByTestId(`resource-proposal-item-${ref}`)?.props.accessibilityState?.checked).toBe(false);
    await screen.pressByTestIdAsync(`resource-proposal-include-${ref}`);
    await screen.pressByTestIdAsync('approval-prompt-approve');
    await vi.waitFor(() => expect(readApproval()).toMatchObject({ status: 'approved' }));
    expect((readApproval() as ApprovalRequestV2).decision?.narrowedInput).toEqual({ ...args,
      targets: [{ ref, expect: { level: 'proven', owner } }] });
    expect(readApproval().actionArgs).toEqual(args);
  });

  it('withholds a process approval when the canonical current-work facts cannot be checked', async () => {
    const actionId = 'machines.processes.stop';
    const args = { machineId: MACHINE, targets: [{ ref: 'cHJvYzox', expect: { level: 'proven' } }] };
    const boundary = daemonRpc.getMockImplementation()!;
    let unavailable = true;
    daemonRpc.mockImplementation(async call => call.method === RPC_METHODS.MACHINES_PROCESSES_CHECK
      ? { checks: [{ ref: 'cHJvYzox', present: true, identityEqual: true, level: 'proven', memoryBytes: GB }] }
      : call.method === RPC_METHODS.MACHINES_GUARD_GET && unavailable ? undefined : boundary(call));
    const base = proposal();
    const screen = await render(signed(ApprovalRequestV2Schema.parse({ ...base, actionId, actionArgs: args,
      executionOriginV1: { ...base.executionOriginV1, actionId } })));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('resourceProposal.checkUnavailable'));
    expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(true);
    expect(readApproval().status).toBe('open');
    unavailable = false;
    await screen.pressByTestIdAsync('resource-proposal-check-again');
    await vi.waitFor(() => expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(false));
  });

  describe('process rows name the work, never its opaque reference', () => {
    const REF = 'MzY1ODQyMToyMDc1OTQxMg';
    const owner = { kind: 'terminal' as const, terminalId: 'terminal-1' };
    const row = (extra: Record<string, unknown> = {}) => ({
      rowId: 'row-1', ref: REF, name: 'node', displayName: 'Vite', command: 'node vite --port 5173',
      pid: 4321, startedAtMs: 1, memoryBytes: GB, memoryKind: 'rss', level: 'left_behind', ...extra,
    });
    async function renderCleanup(check: Record<string, unknown>) {
      const actionId = 'machines.processes.leftBehind.cleanUp';
      const boundary = daemonRpc.getMockImplementation()!;
      daemonRpc.mockImplementation(async (call) => call.method === RPC_METHODS.MACHINES_PROCESSES_CHECK
        ? { checks: [{ ref: REF, present: true, identityEqual: true, level: 'left_behind', memoryBytes: GB, ...check }] }
        : boundary(call));
      const base = proposal();
      const request = signed(ApprovalRequestV2Schema.parse({ ...base, actionId, actionArgs: { machineId: MACHINE, refs: [REF] },
        executionOriginV1: { ...base.executionOriginV1, actionId } }));
      const screen = await render(request);
      await vi.waitFor(() => expect(calls(RPC_METHODS.MACHINES_PROCESSES_CHECK)).toHaveLength(1));
      await vi.waitFor(() => expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(false));
      return screen;
    }

    it('titles the row by the checked process and says what it was left behind by, with its command beneath', async () => {
      const screen = await renderCleanup({ row: row(), owner });
      const text = screen.getTextContent();
      expect(text).toContain('Vite');
      expect(text).toContain('machineProcesses.endedOwner.terminal');
      expect(text).toContain('node vite --port 5173');
      expect(text).not.toContain(REF);
      await screen.pressByTestIdAsync('approval-prompt-approve');
      await vi.waitFor(() => expect(readApproval()).toMatchObject({ status: 'approved' }));
      expect((readApproval() as ApprovalRequestV2).decision?.narrowedInput).toEqual({ machineId: MACHINE, refs: [REF] });
    });

    it('shows the same binary memory amount on the Left behind row, summary and approval button', async () => {
      const bytes = 1024 ** 2;
      const screen = await renderCleanup({ row: row({ memoryBytes: bytes }), owner, memoryBytes: bytes });
      const amount = formatMachineBytes(bytes, 'memory');
      expect(screen.findByTestId('resource-proposal-pile')?.props.accessibilityLabel).toContain(
        t('machineStorage.pile.frees', { amount }),
      );
      expect(screen.getTextContent()).toContain(t('machineProcesses.cleanUp', { count: 1, amount }));
      expect(screen.getTextContent()).not.toContain(formatMachineBytes(bytes, 'storage'));
    });

    it('keeps the generic title and shows no reference when an older daemon sends no row', async () => {
      const screen = await renderCleanup({});
      expect(screen.findByTestId(`resource-proposal-item-${REF}`)).toBeTruthy();
      expect(screen.getTextContent()).not.toContain(REF);
    });
  });

  it('renders cleanup ended/skipped receipts without offering Start again for left-behind work', async () => {
    const actionId = 'machines.processes.leftBehind.cleanUp';
    const base = proposal();
    const request = ApprovalRequestV2Schema.parse({ ...base, actionId, actionArgs: { machineId: MACHINE, refs: ['cHJvYzox', 'cHJvYzoy'] },
      executionOriginV1: { ...base.executionOriginV1, actionId }, status: 'executed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' },
      execution: { executedAtMs: 3, ok: true, result: { ended: [{ ref: 'cHJvYzox', freedBytes: GB }], skipped: [{ ref: 'cHJvYzoy', reason: 'owner_returned' }] } } });
    const screen = await render(request);
    expect(screen.getTextContent()).toContain('resourceProposal.stoppedFreed');
    expect(screen.findByTestId('resource-proposal-retry-cHJvYzoy')).toBeTruthy();
    expect(screen.findByTestId('resource-proposal-start-again-cHJvYzox')).toBeNull();
  });
});
