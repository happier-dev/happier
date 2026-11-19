import { mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, type MachineServiceObservationV1 } from '@happier-dev/protocol/plugins/events/machineServiceObservationV1';
import { configuration } from '@/configuration';
import { createProjectSessionRuntimeFixture } from '@/daemon/testkit/projectSessionRuntimeFixture';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { prepareProjectCheckoutRemoval } from '@/workspaces/projectSetup/projectCheckoutRemoval';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createInstalledProjectFiniteRuntime } from './createInstalledProjectFiniteRuntime';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('publishes settled removal with the portable Home identity through a local profile', async () => {
  const profileId = 'removal-local-profile';
  const homeId = 'srv_removal_home';
  const f = await createProjectSessionRuntimeFixture({ serverId: profileId, homeServerIdentityId: homeId,
    accountId: 'owner' });
  const plugin = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
  onTestFinished(() => plugin.dispose());
  const broker = plugin.registry.stableEventsBroker;
  if (!broker) throw new Error('Missing installed host Event broker');
  const facts: MachineServiceObservationV1[] = [];
  const subscription = broker.subscribeHost({
    target: { eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' } },
    isCurrent: () => true, listener(event) { facts.push(event.payload); },
  });
  onTestFinished(() => subscription.dispose());
  const operationRuntime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'owner',
    custodyBinding: { serverId: profileId, installationId: f.installation.installationId } });
  const terminalSessions = createTerminalPtySessionManager({
    // Process launch is the OS boundary; removal with no Project never spawns.
    ptyProvider: { spawn() { throw new Error('No process expected'); } },
    config: readDaemonTerminalPtyConfig({}).sessionManager, env: {}, platform: 'linux',
  });
  onTestFinished(() => terminalSessions.dispose());
  const factory = createInstalledProjectFiniteRuntime({ api: { getMachine: async () => null },
    credentials: f.bootstrap.credentials, externalActionAccountId: 'owner',
    finiteServerId: profileId, finiteServerHttpBaseUrl: 'https://session-home.test', registeredMachineId: 'machine',
    admission: createProjectWorkerAdmission({ machineId: 'machine', admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'default', metadataVersion: 1 }) }),
    nativeIo: createProjectNativeIo(), successHomeDir: configuration.happyHomeDir, isCurrent: async () => true,
    prepareBetween: async () => { throw new Error('No worker preparation expected'); },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }) });
  const ingress = { signal: f.signal, requesterSessionBootstrap: f.bootstrap };
  const runtime = await factory({ operationRuntime, terminalSessions }, ingress);
  if (!runtime) throw new Error('Installed Project runtime refused');
  const worktreePath = join(f.directory, 'removed-worktree');
  await mkdir(worktreePath);
  const physicalRoot = await realpath(worktreePath);
  const result = await operationRuntime.observeExecution({ actionId: 'scm.worktree.remove', input: {}, rpcContext: ingress,
    execute: async operation => {
      const removal = await prepareProjectCheckoutRemoval({ runtime, ingress, context: {}, operation,
        worktreePath, association: null, skipCleanup: true });
      await rm(worktreePath, { recursive: true });
      removal.settle('deleted');
      return { ok: true, result: null };
    } });
  expect(result).toMatchObject({ ok: true });
  await expect.poll(() => facts).toMatchObject([{ kind: 'worktreeRemoved', serverId: homeId,
    removal: { workspace: null, machineId: 'machine', worktreePath: physicalRoot, outcome: 'removed', removalKind: 'deleted' } }]);
});
