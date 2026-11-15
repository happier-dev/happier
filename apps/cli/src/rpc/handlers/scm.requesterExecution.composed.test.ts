import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { createHostScmCommandRunner } from '@/scm/runtime';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { removeTempDir } from '@/testkit/fs/tempDir';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { configuration } from '@/configuration';
import type { HostAgentIsolationLaunchSnapshot } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';

// Observe the genuine OS boundary while the real Git processes and canonical
// Exec supervision run. No SCM, admission or identity owner is substituted.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(() => vi.restoreAllMocks());

// R126S3 / ISOLATION-REPAIR-1114: a separate-users Machine whose Project folder
// changes are applied (status effective) still refused the Session-less Project
// SCM read with `launch_probe_failed`, because the daemon-level isolation port
// (startDaemon) carries no launch material for anonymous workspace exec.
it.skipIf(process.platform !== 'linux')(
  'runs Session-less Project SCM as the admitted viewer on a separate-users Machine',
  async () => {
    const repository = createLocalScmRepositoryFixture({
      executable: 'git',
      repoMode: '.git',
      prefix: 'happier-scm-viewer-',
    });
    const machineId = 'separate-users-machine';
    const installationId = 'separate-users-installation';
    const home = configuration.activeServerId;
    const daemonIsolation: HostAgentIsolationLaunchSnapshot = {
      enabled: true,
      memberProvisioning: 'linuxUsersV1',
      status: {
        kind: 'effective',
        platform: 'linux',
        agentUser: 'happier-agent',
      },
      workspaceRoots: [repository.rootPath],
    };
    const registration = createGitScmBackendRuntimeRegistration();
    // The installed daemon's policy port, exactly as startDaemon composes it.
    const runner = createHostScmCommandRunner({
      isCurrent: () => true,
      agentIsolation: { read: () => daemonIsolation },
    });
    const backend = createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' },
      qualifiedId: 'happier.scm.git/git',
      executableDefinition: registration.runtime!,
      registration,
      scmCommandRunner: runner,
    });
    const manager = createRpcHandlerManager({
      scopePrefix: machineId,
      scopeKind: 'machine',
      localMachineId: machineId,
      encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'legacy',
      encryptionMode: 'plain',
      authorizeRequest: (request) =>
        authorizeMachineRpcRequest(request, {
          machineId,
          resolveCustodianAccountId: async () => 'owner-account',
          resolveInstallationId: () => installationId,
          resolveHomeServerIdentityId: async () => home,
          // Authentication/currentness are the Home network boundary.
          verifyMachineAdmission: async () => true,
        }),
    });
    const effectAdmission = createFilesystemEffectAdmission({
      readAgentIsolation: () => daemonIsolation,
      resolveHomeServerIdentityId: async () => home,
      resolveHostIdentity: async () => ({
        custodianAccountId: 'owner-account',
        machineId,
        installationId,
      }),
    });
    registerScmHandlers(manager, repository.rootPath, {
      machineId,
      registry: createScmBackendRegistry([backend]),
      accessPolicy: { kind: 'restrictedRoots', roots: [repository.rootPath] },
      resolveRequester: effectAdmission.resolveRpcRequester,
    });
    const read = (accountId: string, role: 'manage' | 'use') =>
      manager.invokeLocal(
        RPC_METHODS.SCM_STATUS_SNAPSHOT,
        { cwd: repository.rootPath },
        {
          rpcContext: {
            callerAuthority: 'present_user',
            verifyMachineAdmissionCurrent: async () => true,
            machineAdmission: {
              actorAccountId: accountId,
              custodianAccountId: 'owner-account',
              machineId,
              installationId,
              role,
              encryptionMode: 'plain',
            },
          },
        },
      );
    const launches = () =>
      vi.mocked(spawn).mock.calls.map(([, , options]) => ({
        uid: options?.uid ?? process.getuid?.(),
        gid: options?.gid ?? process.getgid?.(),
      }));
    try {
      // First (before any cached snapshot): a closed host call keeps the daemon's isolation port; its refusal stays typed
      // instead of collapsing into a Git probe message.
      const hostCall = await manager.invokeLocal(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: repository.rootPath });
      expect(hostCall).toMatchObject({ success: false, errorCode: 'BACKEND_UNAVAILABLE',
        actionErrorCode: 'workspace_exec_isolation_unavailable' });
      // A Manage grantee (the custodian takes the same owner_person branch); one read, before any cached snapshot.
      for (const accountId of ['manager-account']) {
        vi.mocked(spawn).mockClear();
        const response = await read(accountId, 'manage');
        expect(response, JSON.stringify(response)).toMatchObject({
          success: true,
          snapshot: { repo: { isRepo: true } },
        });
        // Manage is full control of the Machine (owner ruling 2026-10-31): unisolated, as the daemon user.
        expect(launches().length).toBeGreaterThan(0);
        expect(
          launches().every(
            (launch) =>
              launch.uid === process.getuid?.() &&
              launch.gid === process.getgid?.(),
          ),
        ).toBe(true);
      }
      // A Can use requester is refused, typed, before any Git process.
      vi.mocked(spawn).mockClear();
      const member = await read('member-account', 'use');
      expect(member).toMatchObject({
        errorCode: 'agent_isolation_unavailable',
      });
      expect(launches()).toEqual([]);
    } finally {
      await removeTempDir(repository.rootPath);
    }
  },
);
