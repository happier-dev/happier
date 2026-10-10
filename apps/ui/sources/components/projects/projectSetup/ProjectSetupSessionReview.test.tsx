import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import {
  createTestSessionTranscriptSource,
  renderWithSessionTranscriptSource,
  standardCleanup,
} from '@/dev/testkit';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock().module;
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// Genuine platform/text boundaries; credential scope, operation store, selectors and the Trust client stay real.
installSessionSubagentCommonModuleMocks({
  storage: () =>
    vi.importActual<typeof import('@/sync/domains/state/storage')>(
      '@/sync/domains/state/storage',
    ),
});
installDisconnectedServerSocketBoundary();
// Current review and continuation are daemon RPC boundaries; the operation reader and Trust owner
// remain real, including the producer digest check and observation publication.
const machineTransport = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: (...args: unknown[]) => machineTransport.read(...args),
}));
const { storage } = await import('@/sync/domains/state/storage');
const { Text } = await import('react-native');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { resolveServerProfileScopeIdForIdentifier } =
  await import('@/sync/domains/server/serverProfiles');
const { ProjectSetupSessionReviews } =
  await import('./ProjectSetupSessionReview');

afterEach(() => {
  standardCleanup();
  actionOperationStore.reset();
  machineTransport.read.mockReset();
});

const DIGEST = 'effect-digest-1';

function AccountProbe({ serverId }: { serverId: string }) {
  const binding = useServerCredentialAccountScopeBindings([serverId]).get(serverId);
  return <Text testID="review-account">{binding?.isCurrent() ? binding.accountId : 'resolving'}</Text>;
}

function heldScript(
  serverId: string,
  sessionId: string,
  workspace: {
    serverId: string;
    machineId: string;
    workspaceId: string;
    rootPath: string;
  },
): ActionOperationSnapshotV1 {
  return {
    version: 1,
    operationId: 'held-test',
    revision: 1,
    actionId: 'projects.script.run',
    state: 'accepted',
    scope: { accountId: 'account', machineId: 'devbox', sessionId },
    title: 'test',
    createdAt: 100,
    cancellation: 'supported',
    domainRef: {
      kind: 'projectCommand',
      purpose: 'script',
      serverId,
      machineId: 'devbox',
      workspaceRefId: workspace.workspaceId,
      cwd: workspace.rootPath,
      sourceWorkspace: workspace,
      script: {
        name: 'test',
        source: { kind: 'command', command: 'yarn test' },
      },
    },
    setupReview: {
      kind: 'pendingApproval',
      code: 'project_setup_consent_required',
      reviewedEffectDigest: DIGEST,
      reviewedEffect: {
        v: 1,
        purpose: 'setup',
        commands: [
          {
            source: { kind: 'command', command: 'mise install' },
            executable: 'mise',
            args: ['install'],
          },
          {
            source: { kind: 'command', command: 'yarn install' },
            executable: 'yarn',
            args: ['install', '--immutable'],
          },
        ],
      },
    },
  } as ActionOperationSnapshotV1;
}

describe('Project setup review inside a Session', () => {
  it('asks for the held invocation with its exact effect and remembers the reviewed effect for this Project only', async () => {
    const mutations: unknown[] = [];
    const connection = await restoreServerAccountForTest({
      serverUrl: 'https://setup-session-review.test',
      serverIdentityId: 'srv_setup_session_review',
      accountId: 'account',
      request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption')
          return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness')
          return Response.json(
            createPlainAccountEncryptionCurrentnessFixture(),
          );
        if (path === '/v2/account/settings')
          return Response.json({ content: { t: 'plain', v: { actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'action.operations.cancel': ['ui'] } } } }, version: 1 });
        if (path === '/v1/account/project-trust/read')
          return Response.json({ status: 'absent' });
        if (path === '/v1/account/project-trust/mutate') {
          mutations.push(JSON.parse(String(init?.body)));
          return Response.json({ status: 'updated', revision: 1, cursor: 1 });
        }
        return Response.json({}, { status: 404 });
      },
    });
    try {
      const serverId = resolveServerProfileScopeIdForIdentifier(
        connection.home.id,
      );
      const workspace = {
        serverId,
        machineId: 'devbox',
        workspaceId: 'checkout',
        rootPath: '/src/happier',
      };
      const scope = { serverId, accountId: 'account' };
      const machine = createMachineFixture({ id: 'devbox', isShared: true });
      storage.setState({
        machineListByServerId: { [serverId]: [{ ...machine, metadata: { ...machine.metadata!, username: 'shared-user' } }] },
        profileScope: scope,
        projectAccountRows: {
          scope,
          status: 'ready',
          coverage: 'complete',
          relationships: [],
          organizations: [],
          revisionsByPhysicalKey: {},
          workspaceRefs: [
            {
              id: 'checkout',
              serverId,
              machineId: 'devbox',
              rootPath: '/src/happier',
              createdAtMs: 1,
              projectKey: 'project-happier',
            },
          ],
        },
      } as never);
      const held = heldScript(serverId, 'session-1', workspace);
      machineTransport.read.mockResolvedValueOnce({ kind: 'found', operation: held })
        .mockResolvedValueOnce({ kind: 'found', operation: { ...held, revision: 2, setupReview: undefined } });
      actionOperationStore.mergeSnapshots({
        serverId,
        snapshots: [
          held,
          // Another Session's held run is not asked here.
          {
            ...heldScript(serverId, 'session-2', workspace),
            operationId: 'other-session',
          },
        ],
      });
      const source = createTestSessionTranscriptSource({
        sessionId: 'session-1',
        serverId,
        interaction: { canApprovePermissions: true } as never,
      });
      const screen = await renderWithSessionTranscriptSource(
        <>
          <ProjectSetupSessionReviews sessionId="session-1" serverId={serverId} />
          <AccountProbe serverId={serverId} />
        </>,
        source,
      );
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('project-setup-session-review:held-test'),
        ).not.toBeNull(),
      );
      expect(
        screen.findByTestId('project-setup-session-review:other-session'),
      ).toBeNull();
      expect(screen.getTextContent()).toContain('mise install');
      expect(screen.getTextContent()).toContain('yarn install --immutable');

      await act(async () => {
        screen.pressByTestId('project-setup-session-review:held-test-approve');
      });
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('project-setup-session-review:held-test.settled'),
        ).not.toBeNull(),
      );
      expect(mutations).toEqual([
        {
          project: { serverId, projectId: 'project-happier' },
          expectedRevision: 'absent',
          content: {
            t: 'plain',
            v: {
              project: { serverId, projectId: 'project-happier' },
              reviewedEffectDigest: DIGEST,
              approvedAtMs: expect.any(Number),
            },
          },
        },
      ]);
      // Later filesystem changes can rehold the very same reservation after Remember returned.
      const later = { ...held, revision: 3, setupReview: {
        ...held.setupReview!, code: 'project_setup_effect_changed' as const,
        reviewedEffectDigest: 'effect-B', reviewedEffect: { commands: [{ executable: 'make', args: ['bootstrap'] }],
          presentation: { bindings: [{ name: 'TOKEN', ref: 'saved-secret:deploy', revision: 7,
            source: 'shared_resource', displayName: 'Deployment', value: 'NEVER-DISCLOSE' }],
            provenance: { file: '.happier/project.json', kind: 'repository', headCommit: 'abcdef123456',
              branch: 'feature', fileState: 'modified', bytes: 'NEVER-DISCLOSE' } } },
      } };
      await act(async () => { actionOperationStore.mergeSnapshots({ serverId, snapshots: [later] }); });
      expect(screen.findByTestId('project-setup-session-review:held-test.settled')).toBeNull();
      expect(screen.getTextContent()).toContain('make bootstrap');
      expect(screen.findByTestId('project-setup-session-review:held-test-reject')).not.toBeNull();
      machineTransport.read.mockResolvedValue({ kind: 'requested' });
      await act(async () => { screen.pressByTestId('project-setup-session-review:held-test-reject'); });
      await vi.waitFor(() => expect(machineTransport.read).toHaveBeenCalledWith(expect.objectContaining({
        serverId, machineId: 'devbox', method: 'actionOperation.cancel.v1', payload: { operationId: 'held-test' },
      })));
      expect(screen.getTextContent()).toContain('saved-secret:deploy');
      expect(screen.getTextContent()).toContain('r7');
      expect(screen.getTextContent()).toContain('secretsSettings.keepShared');
      expect(screen.getTextContent()).toContain('projects.scripts.setup.provenanceModified');
      expect(screen.getTextContent()).toContain('machines.terminals.sharedOsDetail');
      expect(screen.getTextContent()).not.toContain('NEVER-DISCLOSE');

      // Retire the Account binding, then return to the same Account: old settled lines stay gone.
      await act(async () => { actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ ...held, revision: 4, setupReview: undefined }] }); });
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
      const bob = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature` };
      credentialRead.mockResolvedValue(bob);
      await act(async () => { await TokenStorage.setCredentialsForServerUrl(connection.home.serverUrl, { serverId }, bob); });
      await vi.waitFor(() => expect(screen.findByTestId('review-account')?.children).toEqual(['bob']));
      await vi.waitFor(() => expect(screen.findByTestId('project-setup-session-review:held-test')).toBeNull());
      credentialRead.mockResolvedValue(connection.credentials);
      await act(async () => { await TokenStorage.setCredentialsForServerUrl(connection.home.serverUrl, { serverId }, connection.credentials); });
      await vi.waitFor(() => expect(screen.findByTestId('review-account')?.children).toEqual(['account']));
      expect(screen.findByTestId('project-setup-session-review:held-test.settled')).toBeNull();
      await screen.unmount();
    } finally {
      await connection.dispose();
    }
  });

  it('draws nothing for a Session whose live operations carry no setup review', async () => {
    const connection = await restoreServerAccountForTest({
      serverUrl: 'https://setup-session-none.test',
      serverIdentityId: 'srv_setup_session_none',
      accountId: 'account',
      request: async () => Response.json({}, { status: 404 }),
    });
    try {
      const serverId = resolveServerProfileScopeIdForIdentifier(
        connection.home.id,
      );
      const workspace = {
        serverId,
        machineId: 'devbox',
        workspaceId: 'checkout',
        rootPath: '/src/happier',
      };
      const { setupReview: _omit, ...running } = heldScript(
        serverId,
        'session-1',
        workspace,
      );
      actionOperationStore.mergeSnapshots({
        serverId,
        snapshots: [running as ActionOperationSnapshotV1],
      });
      const screen = await renderWithSessionTranscriptSource(
        <ProjectSetupSessionReviews
          sessionId="session-1"
          serverId={serverId}
        />,
        createTestSessionTranscriptSource({ sessionId: 'session-1', serverId }),
      );
      expect(
        screen.findByTestId('project-setup-session-review:held-test'),
      ).toBeNull();
      await screen.unmount();
    } finally {
      await connection.dispose();
    }
  });
});
