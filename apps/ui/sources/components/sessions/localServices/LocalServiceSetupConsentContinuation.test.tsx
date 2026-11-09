import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock().module;
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// Genuine platform/text boundaries; credential scope, operation store, the Scripts controller and the
// Trust client stay real.
installSessionSubagentCommonModuleMocks({
  storage: () =>
    vi.importActual<typeof import('@/sync/domains/state/storage')>(
      '@/sync/domains/state/storage',
    ),
});
installDisconnectedServerSocketBoundary();
// The daemon RPC is the boundary: operation reads and Stop. The Trust owner stays real over HTTP.
const machineTransport = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: (...args: unknown[]) =>
      machineTransport.read(...args),
  }),
);
const { storage } = await import('@/sync/domains/state/storage');
const { publishActionOperationObservation } = await import(
  '@/sync/domains/actionOperations/actionOperationRuntime'
);
const { Text } = await import('react-native');
const { useServerCredentialAccountScopeBindings } =
  await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { resolveServerProfileScopeIdForIdentifier } =
  await import('@/sync/domains/server/serverProfiles');
const { LocalServiceSetupConsentContinuation } =
  await import('./LocalServiceSetupConsentContinuation');

afterEach(() => {
  standardCleanup();
  actionOperationStore.reset();
  machineTransport.read.mockReset();
});

const DIGEST = 'effect-digest-1';
const TEST_ID = 'services';
const REVIEW = `${TEST_ID}-setup-review`;

function setupOperation(
  serverId: string,
  workspace: {
    serverId: string;
    machineId: string;
    workspaceId: string;
    rootPath: string;
  },
  patch: Partial<ActionOperationSnapshotV1> &
    Pick<ActionOperationSnapshotV1, 'operationId' | 'state'>,
): ActionOperationSnapshotV1 {
  return {
    version: 1,
    revision: 1,
    actionId: 'projects.prepare',
    scope: { accountId: 'account', machineId: 'devbox' },
    title: 'Set up a project',
    createdAt: 100,
    cancellation: 'supported',
    domainRef: {
      kind: 'projectCommand',
      purpose: 'setup',
      serverId,
      machineId: 'devbox',
      workspaceRefId: workspace.workspaceId,
      cwd: workspace.rootPath,
      sourceWorkspace: workspace,
    },
    ...patch,
  } as ActionOperationSnapshotV1;
}

async function mountContinuation() {
  const trustMutations: unknown[] = [];
  const serverIdentityId = 'srv_service_setup_consent';
  const workspaceRef = {
    id: 'checkout',
    serverId: serverIdentityId,
    machineId: 'devbox',
    rootPath: '/src/lumen',
    createdAtMs: 1,
    projectKey: 'project-lumen',
  };
  const connection = await restoreServerAccountForTest({
    serverUrl: 'https://service-setup-consent.test',
    serverIdentityId,
    accountId: 'account',
    request: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/project-rows/list')
        return Response.json(
          createPlainProjectAccountRowListFixture({ workspaceRefs: [workspaceRef] }),
        );
      if (path === '/v1/account/encryption')
        return Response.json({ mode: 'plain', updatedAt: 1 });
      if (path === '/v1/account/encryption/currentness')
        return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v2/account/settings')
        return Response.json({
          content: {
            t: 'plain',
            v: {
              actionsSettingsV1: {
                v: 1,
                approvalWaivedSurfaces: { 'action.operations.cancel': ['ui'] },
              },
            },
          },
          version: 1,
        });
      if (path === '/v1/account/project-trust/read')
        return Response.json({ status: 'absent' });
      if (path === '/v1/account/project-trust/mutate') {
        trustMutations.push(JSON.parse(String(init?.body)));
        return Response.json({ status: 'updated', revision: 1, cursor: 1 });
      }
      return Response.json({}, { status: 404 });
    },
  });
  const serverId = resolveServerProfileScopeIdForIdentifier(connection.home.id);
  const workspace = {
    serverId,
    machineId: 'devbox',
    workspaceId: 'checkout',
    rootPath: '/src/lumen',
  };
  // Restore admits the Account census through its real HTTP/cipher/store owners.
  // Seeding rows directly would race (and bypass) the authorized refresh.
  await vi.waitFor(() =>
    expect(storage.getState().projectAccountRows).toMatchObject({
      scope: { serverId, accountId: 'account' },
      status: 'ready',
      coverage: 'complete',
      workspaceRefs: [workspaceRef],
    }),
  );
  const held = setupOperation(serverId, workspace, {
    operationId: 'held-setup',
    state: 'accepted',
    setupReview: {
      kind: 'pendingApproval',
      code: 'project_setup_consent_required',
      reviewedEffectDigest: DIGEST,
      reviewedEffect: {
        v: 1,
        purpose: 'setup',
        commands: [
          {
            source: { kind: 'command', command: 'npm ci' },
            executable: 'npm',
            args: ['ci'],
          },
        ],
      },
    },
  } as never);
  // The Action front door is the boundary: the first Start asks for setup, a decided retry runs it.
  const prepares: unknown[] = [];
  const runtimeActionExecute = vi.fn(
    async (request: { actionId: string; input: unknown }) => {
      expect(request.actionId).toBe('projects.prepare');
      prepares.push(request.input);
      return {
        operation:
          prepares.length === 1
            ? held
            : setupOperation(serverId, workspace, {
                operationId: 'held-setup',
                revision: 2,
                state: 'running',
                startedAt: 101,
              }),
      };
    },
  );
  const settled: boolean[] = [];
  function Harness() {
    const binding = useServerCredentialAccountScopeBindings([serverId]).get(
      serverId,
    );
    if (!binding?.isCurrent()) return <Text testID="resolving">resolving</Text>;
    return (
      <LocalServiceSetupConsentContinuation
        review={{
          actionId: 'localServices.actions.startLauncherTarget' as never,
          target: { id: 'web', title: 'web', workspace } as never,
          consent: {
            kind: 'pendingApproval',
            code: 'project_setup_consent_required',
            reviewedEffectDigest: DIGEST,
          } as never,
        }}
        binding={binding}
        runtimeActionExecute={runtimeActionExecute as never}
        onComplete={(accepted) => settled.push(accepted)}
        testID={TEST_ID}
      />
    );
  }
  const screen = await renderScreen(<Harness />);
  await vi.waitFor(() => expect(screen.findByTestId(REVIEW)).not.toBeNull());
  return {
    screen,
    serverId,
    workspace,
    prepares,
    trustMutations,
    settled,
    connection,
  };
}

describe('Service Start setup consent', () => {
  it.each(['thisTime', 'skip'] as const)('consumes the Service setup %s decision on its held operation without remembering trust', async choice => {
    const {
      screen,
      serverId,
      workspace,
      prepares,
      trustMutations,
      settled,
      connection,
    } = await mountContinuation();
    try {
      expect(screen.getTextContent()).toContain('npm ci');
      expect(screen.findByTestId(`${REVIEW}.scope:thisTime`)).not.toBeNull();
      expect(
        screen.findByTestId(`${REVIEW}.scope:untilChanged`),
      ).not.toBeNull();
      if (choice === 'skip') await act(async () => { await screen.pressByTestIdAsync(`${REVIEW}.scope:skip`); });
      await act(async () => {
        await screen.pressByTestIdAsync(`${REVIEW}-approve`);
      });
      await vi.waitFor(() => expect(prepares).toHaveLength(2));
      expect(prepares[1]).toEqual({
        workspace,
        phase: 'setup',
        expectedEffectDigest: DIGEST,
        ...(choice === 'skip' ? { skipForInvocation: true } : { consentScope: 'thisTime' }),
        heldOperationId: 'held-setup',
      });
      expect(trustMutations).toEqual([]);
      expect(settled).toEqual([]);
      await act(async () => {
        // The daemon's push of the settled setup is an observation of that operation.
        publishActionOperationObservation({
          serverId,
          machineId: 'devbox',
          observation: 'available',
          snapshots: [
            setupOperation(serverId, workspace, {
              operationId: 'held-setup',
              state: 'succeeded',
              revision: 3,
              startedAt: 101,
              settledAt: 102,
              result: { kind: choice === 'skip' ? 'skippedForInvocation' : 'success', reviewedEffectDigest: DIGEST },
            } as never),
          ],
        });
      });
      await vi.waitFor(() => expect(settled).toEqual([choice !== 'skip']));
      expect(trustMutations).toEqual([]);
      await screen.unmount();
    } finally {
      await connection.dispose();
    }
  });

  it('remembers the reviewed effect only when Until it changes is chosen, and resumes the held setup instead of launching another', async () => {
    const {
      screen,
      serverId,
      workspace,
      prepares,
      trustMutations,
      settled,
      connection,
    } = await mountContinuation();
    try {
      machineTransport.read
        .mockResolvedValueOnce({
          kind: 'found',
          operation: setupOperation(serverId, workspace, {
            operationId: 'held-setup',
            state: 'accepted',
            revision: 1,
            setupReview: {
              kind: 'pendingApproval',
              code: 'project_setup_consent_required',
              reviewedEffectDigest: DIGEST,
              reviewedEffect: { v: 1, purpose: 'setup' },
            },
          } as never),
        })
        .mockResolvedValueOnce({
          kind: 'found',
          operation: setupOperation(serverId, workspace, {
            operationId: 'held-setup',
            state: 'running',
            startedAt: 101,
            revision: 2,
          }),
        });
      await act(async () => {
        await screen.pressByTestIdAsync(`${REVIEW}.scope:untilChanged`);
      });
      await act(async () => {
        await screen.pressByTestIdAsync(`${REVIEW}-approve`);
      });
      await vi.waitFor(() => expect(trustMutations).toHaveLength(1));
      expect(trustMutations[0]).toMatchObject({
        project: { serverId, projectId: 'project-lumen' },
        expectedRevision: 'absent',
        content: { t: 'plain', v: { reviewedEffectDigest: DIGEST } },
      });
      expect(prepares).toHaveLength(1);
      await act(async () => {
        actionOperationStore.mergeSnapshots({
          serverId,
          snapshots: [
            setupOperation(serverId, workspace, {
              operationId: 'held-setup',
              state: 'succeeded',
              revision: 3,
              startedAt: 101,
              settledAt: 102,
              result: { kind: 'success', reviewedEffectDigest: DIGEST },
            } as never),
          ],
        });
      });
      await vi.waitFor(() => expect(settled).toEqual([true]));
      await screen.unmount();
    } finally {
      await connection.dispose();
    }
  });

  it('declines the Start and stops its own held setup on Not now, without remembering anything', async () => {
    const { screen, serverId, trustMutations, settled, connection } =
      await mountContinuation();
    try {
      machineTransport.read.mockResolvedValue({ kind: 'requested' });
      await act(async () => {
        await screen.pressByTestIdAsync(`${REVIEW}-reject`);
      });
      await vi.waitFor(() =>
        expect(machineTransport.read).toHaveBeenCalledWith(
          expect.objectContaining({
            serverId,
            machineId: 'devbox',
            method: 'actionOperation.cancel.v1',
            payload: { operationId: 'held-setup' },
          }),
        ),
      );
      await vi.waitFor(() => expect(settled).toEqual([false]));
      expect(trustMutations).toEqual([]);
      await screen.unmount();
    } finally {
      await connection.dispose();
    }
  });
});
