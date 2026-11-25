import axios from 'axios';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createInstalledProjectFiniteRuntime } from '@/daemon/startup/createInstalledProjectFiniteRuntime';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { createNativeSessionDeleteAction } from '@/daemon/sessions/sessionDeleteAction';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { RpcHandlerContext } from '@/api/rpc/types';

afterEach(() => vi.restoreAllMocks());

it('refuses the legacy raw CLI Delete at the native owner for a guest own managed Session', async () => {
  let finite: ReturnType<typeof createInstalledProjectFiniteRuntime> | undefined;
  const agentIsolation = { read: () => ({ enabled: false as const, status: { kind: 'disabled' as const }, workspaceRoots: [] }) };
  const f = await createInstalledFilesystemMachineFixture({ agentIsolation,
    createProjectFiniteRuntime: (...args) => {
      if (!finite) throw new Error('Finite runtime not installed');
      return finite(...args);
    } });
  finite = createInstalledProjectFiniteRuntime({ api: { getMachine: async () => { throw new Error('Unexpected placement'); } },
    credentials: f.bootstrap.credentials, externalActionAccountId: 'requester', finiteServerId: f.serverId,
    finiteServerHttpBaseUrl: f.serverHttpBaseUrl, registeredMachineId: f.machineId,
    admission: createProjectWorkerAdmission({ machineId: f.machineId, admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'stored', metadataVersion: 1 }) }),
    nativeIo: createProjectNativeIo({ agentIsolation }), agentIsolation, successHomeDir: f.directory,
    isCurrent: async () => f.isHomeCurrent(), prepareBetween: async () => { throw new Error('Unexpected Sync'); },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: f.homeServerIdentityId, machineId: f.machineId }) });
  const directories = createManagedSessionDirectories({});
  const allocation = await directories.materializeForFreshSpawn({ sessionCreationTag: 'guest-own-session' });
  await directories.bind({ allocationId: allocation.allocationId, sessionId: 'guest-own-session' });
  await writeFile(join(allocation.directory, 'guest-work'), 'guest bytes');
  const ingress: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
    machineAdmission: { actorAccountId: 'guest', custodianAccountId: 'requester', machineId: f.machineId,
      installationId: f.installation.installationId, role: 'use', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => true };
  const native = createNativeSessionDeleteAction({ ingress,
    resolveRuntime: async context => await f.machine.resolveProjectFiniteRuntime(context) ?? null,
    isSessionActive: async () => false, retireRequesterCustody: async () => true,
    nativeOperationRuntime: { readMemberFolderOwner: async () => null,
      prepareNativeOperation: async () => { throw new Error('No member process'); } } });
  const operations = createHostActionOperationRuntime({ machineId: f.machineId, resolveAccountId: async () => 'guest' });
  let result: unknown;
  let homeDeleted = false;
  const post = vi.mocked(axios.post); post.mockClear();
  const scope = { accountId: 'guest', machineId: f.machineId };
  const accepted = await operations.observeExecution({ actionId: 'session.delete', input: { sessionId: 'guest-own-session' },
    actionRequestId: 'legacy-delete', response: 'admission', execute: async context => {
      const execution = await native({ input: { sessionId: 'guest-own-session' }, context,
        deleteFromHome: async beforeDelete => {
          await beforeDelete?.();
          homeDeleted = true;
          return { ok: true, result: { success: true } };
        } });
      result = execution;
      return execution;
    } });
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) throw new Error('Operation not admitted');
  const operation = operations.store.list(scope).items[0]!;
  await operations.runner.waitForTerminal(scope, operation.operationId);
  expect(result).toMatchObject({ ok: false, errorCode: 'project_setup_operation_unavailable' });
  expect(homeDeleted).toBe(false);
  expect(await readFile(join(allocation.directory, 'guest-work'), 'utf8')).toBe('guest bytes');
  expect(post.mock.calls.some(([url]) => String(url).includes('/project-rows/'))).toBe(false);
});
