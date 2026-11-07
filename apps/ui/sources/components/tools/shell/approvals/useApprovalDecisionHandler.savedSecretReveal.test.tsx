import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalRequestSchema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import {
  type SavedSecretCatalogEntryV1,
} from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import type { SavedSecretResourceMaterialV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import {
  configureConnectedServerSocketBoundary,
  installDisconnectedServerSocketBoundary,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const modal = vi.hoisted(() => ({
  boundary: null as ReturnType<
    typeof import('@/dev/testkit/mocks/modal').createModalModuleMock
  > | null,
}));
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  modal.boundary = createModalModuleMock({ renderCustomModals: true });
  return modal.boundary.module;
});
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key) => key,
  }),
);

// Only the Home network, device credential store, Socket.IO transport and modal presentation are replaced.
// The Action executor, approval policy/replay, decision hook, catalog and reveal custody run for real.
const home = createHomeGovernanceHarness();
let restoreNativeFetch: (() => void) | undefined;
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary((socket) => {
  configureConnectedServerSocketBoundary(socket);
});
const [{ createDefaultActionExecutor }, { useApprovalDecisionHandler }] =
  await Promise.all([
    import('@/sync/ops/actions/defaultActionExecutor'),
    import('./useApprovalDecisionHandler'),
  ]);

const SECRET_VALUE = 'reveal-ui-sentinel-value';
const ref = 'happier:shared-secret:v1:resource-reveal';
const entry: SavedSecretCatalogEntryV1 = {
  ref,
  source: 'shared_resource',
  relationship: 'recipient',
  name: 'Stripe live key',
  kind: 'apiKey',
  encryptionMode: 'plain',
  owner: null,
  accessSources: [],
  audience: { accounts: [], teams: [], groups: [] },
  ownerAccountId: 'secret-owner',
  revision: 3,
  materialStatus: 'ready',
  capabilities: {
    use: true,
    reveal: true,
    rename: false,
    rotate: false,
    manageAccess: false,
    delete: false,
  },
};
const material: SavedSecretResourceMaterialV1 = {
  resourceId: 'resource-reveal',
  encryptionMode: 'plain',
  entry,
  storedContent: {
    t: 'plain',
    v: { v: 1, name: 'Stripe live key', kind: 'apiKey', value: SECRET_VALUE },
  },
  recipientEnvelope: null,
};

async function addConnectedHome() {
  const serverId = await home.addHome({
    name: 'Home A',
    serverUrl: 'https://home-a.example',
    serverIdentityId: 'srv_stable-home-a',
    accountId: 'account-a',
  });
  home.answer(serverId, '/v1/auth/ping', { body: {} });
  home.answer(serverId, '/v2/cursor', { body: { cursor: '0' } });
  const bearer = home.findByServerUrl('https://home-a.example')?.token;
  if (!bearer) throw new Error('expected_account_credentials');
  const { restoreConnectionToActiveServer } =
    await import('@/sync/runtime/orchestration/connectionManager');
  await restoreConnectionToActiveServer({ token: bearer });
  let exactReads = 0;
  home.answer(serverId, '/v1/account/saved-secrets/resources/materials', {
    select: (_input, request) => {
      const query = new URL(request.url).searchParams;
      if (query.get('requireManage') === 'true') return { status: 403, body: { error: 'forbidden' } };
      if (query.get('expectedRevision') === '3') exactReads++;
      return { body: { resources: [material] } };
    },
  });
  home.answer(serverId, 'GET /v1/account/saved-secrets/resources', { body: { resources: [entry] } });
  home.answer(serverId, '/v1/account/saved-secrets/resources/activity', {
    body: { historyEntryId: 'history-reveal' },
  });
  return { serverId, exactReads: () => exactReads };
}

/** An Agent asks for the value; the default policy turns it into a value-free request. */
async function requestRevealAsAgent(serverId: string, requestId: string) {
  const requested = await createDefaultActionExecutor().execute(
    'secrets.shared.reveal',
    { ref, expectedRevision: 3 },
    {
      surface: 'agent',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
      serverId,
      actionRequestId: requestId,
    },
  );
  expect(requested).toMatchObject({
    ok: true,
    result: { kind: 'approval_request_created' },
  });
  expect(JSON.stringify(requested)).not.toContain(SECRET_VALUE);
  const artifactId = (requested as { result: { artifactId: string } }).result
    .artifactId;
  return {
    artifactId,
    approval: ApprovalRequestSchema.parse(
      JSON.parse(home.artifacts(serverId).readPlainBody(artifactId)!),
    ),
  };
}

beforeEach(async () => {
  webLocks = installWebLockManagerMock();
  await home.reset();
  const boundary = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => await home.request(input, init));
  restoreNativeFetch = () => boundary.mockRestore();
  const { loadSyncSingletonForTests } =
    await import('@/dev/testkit/harness/syncSingletonLoader');
  await loadSyncSingletonForTests();
  const { resetSavedSecretCatalogEngineForTests } =
    await import('@/sync/engine/settings/savedSecretCatalogEngine');
  const { resetSavedSecretCatalogSnapshotsForTests } =
    await import('@/sync/store/settings/savedSecretCatalogSnapshot');
  resetSavedSecretCatalogEngineForTests();
  resetSavedSecretCatalogSnapshotsForTests();
  modal.boundary?.spies.hideAll();
  modal.boundary?.spies.show.mockClear();
});
afterEach(async () => {
  modal.boundary?.spies.hideAll();
  standardCleanup();
  const { disconnectActiveServerConnection } =
    await import('@/sync/runtime/orchestration/connectionManager');
  await disconnectActiveServerConnection();
  const { serverScopedRpcSocketPool } =
    await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
  const { resetScopedMachineTransportCacheForTests } =
    await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
  serverScopedRpcSocketPool.resetForTests();
  resetScopedMachineTransportCacheForTests();
  restoreNativeFetch?.();
  restoreNativeFetch = undefined;
  webLocks?.restore();
  webLocks = undefined;
});

describe('approved Agent/MCP Saved Secret reveal', () => {
  it('shows the value once, only in the approving app, and never in the request or its Artifact', async () => {
    const { serverId, exactReads } = await addConnectedHome();
    const { artifactId, approval } = await requestRevealAsAgent(
      serverId,
      'agent-reveal-1',
    );
    const { ModalProvider } = await import('@/modal');
    const screen = await renderScreen(<ModalProvider />);
    const hook = await renderHook(() =>
      useApprovalDecisionHandler(
        { id: artifactId, header: null },
        approval,
        '',
        serverId,
      ),
    );

    let decided: boolean | undefined;
    await act(async () => {
      decided = await hook.getCurrent()('approve');
    });
    expect(decided).toBe(true);

    // One app-owned display: one exact grant read, one sheet, the value rendered there.
    expect(exactReads()).toBe(1);
    expect(modal.boundary?.spies.show).toHaveBeenCalledTimes(1);
    expect(screen.getTextContent()).toContain(SECRET_VALUE);
    const stored = home.artifacts(serverId).readPlainBody(artifactId)!;
    expect(ApprovalRequestSchema.parse(JSON.parse(stored))).toMatchObject({
      status: 'executed',
      execution: {
        ok: true,
        result: { status: 'displayed', historyEntryId: 'history-reveal' },
      },
    });
    expect(stored).not.toContain(SECRET_VALUE);

    // A repeated Allow reads the settled receipt: no second read, no second sheet.
    await act(async () => {
      await hook
        .getCurrent()('approve')
        .catch(() => false);
    });
    expect(exactReads()).toBe(1);
    expect(modal.boundary?.spies.show).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when the person denies the request', async () => {
    const { serverId, exactReads } = await addConnectedHome();
    const { artifactId, approval } = await requestRevealAsAgent(
      serverId,
      'agent-reveal-deny',
    );
    const { ModalProvider } = await import('@/modal');
    const screen = await renderScreen(<ModalProvider />);
    const hook = await renderHook(() =>
      useApprovalDecisionHandler(
        { id: artifactId, header: null },
        approval,
        '',
        serverId,
      ),
    );

    await act(async () => {
      await hook.getCurrent()('reject');
    });

    expect(exactReads()).toBe(0);
    expect(modal.boundary?.spies.show).not.toHaveBeenCalled();
    expect(screen.getTextContent()).not.toContain(SECRET_VALUE);
    expect(home.artifacts(serverId).readPlainBody(artifactId)).not.toContain(
      SECRET_VALUE,
    );
  });
});
