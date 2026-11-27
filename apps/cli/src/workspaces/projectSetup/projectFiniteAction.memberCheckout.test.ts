import axios from 'axios';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { prepareRequesterNativeOperation } from '@/daemon/agentIsolation/prepareNativeOperation';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { withTempDir } from '@/testkit/fs/tempDir';
import { workspaceCheckoutNativeBoundary as boundary } from '@/workspaces/activation/workspaceCheckoutNative.testkit';
import { runWorkspaceEffectWorker } from '@/workspaces/activation/workspaceEffectWorker';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import {
  createProjectAccountRowsHttpBoundary,
  createPlainProjectAccountRefRow,
} from '@/workspaces/projectAccountRows.testkit';
import {
  createProjectFiniteAction,
  type ProjectFiniteActionRuntime,
} from './projectFiniteAction';

// Only OS permissions and process launch are replaced, as in the member inspection owner test.
// The framed member worker, read port, Project review and finite Action owner stay real.
const owner = vi.hoisted(() => ({
  roots: [] as string[],
  daemonReads: [] as string[],
}));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const {
    workspaceCheckoutFilesystemBoundary,
    workspaceCheckoutNativeBoundary,
  } = await import('@/workspaces/activation/workspaceCheckoutNative.testkit');
  const filesystem = workspaceCheckoutFilesystemBoundary(actual);
  // Every daemon-identity filesystem call under another person's checkout is recorded.
  return Object.fromEntries(
    Object.entries(filesystem).map(([name, value]) => [
      name,
      typeof value !== 'function'
        ? value
        : (...args: unknown[]) => {
            const path = String(args[0]);
            if (
              workspaceCheckoutNativeBoundary.identity.getStore() !==
                'member' &&
              owner.roots.some(
                (root) => path === root || path.startsWith(`${root}/`),
              )
            )
              owner.daemonReads.push(`${name}:${path}`);
            // A 0700 member checkout: only the member identity reads it.
            const memberPrivate = name !== 'realpath'
              && workspaceCheckoutNativeBoundary.privateRoots.some(
                (root) => path === root || path.startsWith(`${root}/`),
              );
            if (memberPrivate && workspaceCheckoutNativeBoundary.identity.getStore() === 'member') {
              workspaceCheckoutNativeBoundary.phases.push('member_definition_read');
            } else if (memberPrivate) {
              workspaceCheckoutNativeBoundary.phases.push(
                'daemon_definition_read',
              );
              throw Object.assign(new Error('Private read denied'), {
                code: 'EACCES',
              });
            }
            return Reflect.apply(value, filesystem, args);
          },
    ]),
  );
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { spawnWorkspaceCheckoutNativeBoundary } =
    await import('@/workspaces/activation/workspaceCheckoutNative.testkit');
  return {
    ...actual,
    spawn: (
      command: string,
      args: readonly string[],
      options: import('node:child_process').SpawnOptions,
    ) =>
      args.at(-1) === 'agent-launch' && [command, ...args].includes('sudo')
        ? spawnWorkspaceCheckoutNativeBoundary(actual.spawn, options)
        : actual.spawn(command, args, options),
  };
});
vi.mock('@happier-dev/cli-common/process', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@happier-dev/cli-common/process')>();
  return {
    ...actual,
    execFileWithDeadline: async (
      ...input: Parameters<typeof actual.execFileWithDeadline>
    ) => {
      if (!input[2]?.inputBytes || input[1]?.at(-1) !== 'agent-launch')
        return actual.execFileWithDeadline(...input);
      const { runWorkspaceCheckoutCwdBoundary } = await import('@/workspaces/activation/workspaceCheckoutNative.testkit');
      const cwd = await runWorkspaceCheckoutCwdBoundary(input[2].inputBytes, input[2].signal);
      if (cwd) return cwd;
      const frame = await readAgentLaunchFrame(
        Readable.from([input[2]!.inputBytes], { objectMode: false }),
        undefined,
        true,
      );
      expect(frame).toMatchObject({ action: 'retire_operation' });
      boundary.phases.push('native_retired');
      return { stdout: '', stderr: '' };
    },
  };
});
afterEach(() => {
  boundary.reset();
  owner.roots.length = 0;
  owner.daemonReads.length = 0;
  vi.restoreAllMocks();
});

const requesterIdentity = {
  kind: 'isolated' as const,
  separationRequired: true,
  requester: {
    serverId: 'home',
    accountId: 'member',
    machineId: 'machine',
    installationId: 'installation',
  },
};
const memberIdentity = {
  ...deriveAgentIsolationMemberIdentity({
    ...requesterIdentity,
    homeServerIdentityId: 'home',
  }),
  agentUid: 2401,
  agentGid: 2401,
};
const memberSnapshot = {
  enabled: true,
  memberProvisioning: 'linuxUsersV1' as const,
  status: { kind: 'effective' as const, platform: 'linux' as const },
  workspaceRoots: [],
};

async function finiteHarness(
  directory: string,
  ref: WorkspaceRefV1,
  isolation: 'member' | 'off',
) {
  const rows = [createPlainProjectAccountRefRow(ref)];
  const accountRows = createProjectAccountRowsHttpBoundary(rows);
  vi.spyOn(axios, 'get').mockResolvedValue({
    status: 200,
    data: { mode: 'plain', updatedAt: 0 },
  });
  const post = vi
    .spyOn(axios, 'post')
    .mockImplementation(async (url, body) =>
      String(url).endsWith('/project-trust/read')
        ? { status: 200, data: { status: 'absent' } }
        : accountRows(String(url), body),
    );
  const spawned: string[] = [];
  const terminalSessions = createTerminalPtySessionManager({
    config: readDaemonTerminalPtyConfig({}).sessionManager,
    platform: 'linux',
    env: {},
    ptyProvider: {
      spawn: (params) => {
        spawned.push(params.file);
        return {
          pid: 0,
          write() {},
          resize() {},
          kill() {},
          onData: () => ({ dispose() {} }),
          onExit: () => ({ dispose() {} }),
        };
      },
    },
  });
  onTestFinished(() => terminalSessions.dispose());
  const operationRuntime = createHostActionOperationRuntime({
    machineId: 'machine',
    custodyBinding: { serverId: 'home', installationId: 'installation' },
    resolveAccountId: async () => 'member',
    generateOperationId: () => 'operation',
  });
  const snapshot =
    isolation === 'member'
      ? memberSnapshot
      : {
          enabled: false,
          status: { kind: 'disabled' as const },
          workspaceRoots: [],
        };
  const runtime: ProjectFiniteActionRuntime = {
    accountId: 'member',
    serverId: 'home',
    machineId: 'machine',
    serverHttpBaseUrl: 'https://home.example',
    credentials: {
      token: `e30.${Buffer.from(JSON.stringify({ sub: 'member' })).toString('base64url')}.signature`,
      encryption: null,
    },
    resolveHostHomeServerIdentityId: async () => 'home',
    isCurrent: async () => true,
    requesterIdentity,
    agentIsolation: { read: () => snapshot },
    terminalSessions,
    operationRuntime,
    workerAdmission: createProjectWorkerAdmission({
      machineId: 'machine',
      admissionDrain: createDaemonAdmissionDrain(),
      readMemory: () => null,
      readPolicy: async () => ({
        status: 'ready',
        policy: { accepting: true, runAtMost: null },
        source: 'stored',
        metadataVersion: 1,
      }),
    }),
    resolveWorkspaceExecutionConfig: async () => null,
    nativeIo: { resolveTool: async () => null },
    environmentIo: createProjectNativeToolchainIoForHost({
      resolveTool: async () => null,
    }),
    platform: 'linux',
    arch: 'x64',
    hostEnvironment: {},
    successHomeDir: join(directory, 'success'),
    nativeOperationRuntime: {
      prepareNativeOperation: (input) =>
        prepareRequesterNativeOperation(input, {
          homeServerIdentityId: 'home',
          machineId: 'machine',
          installationId: 'installation',
          machine: {
            read: () => snapshot,
            managedHappierBinaryPath: '/opt/happier/cli/current/happier',
            readMember: async () => ({
              identity: memberIdentity,
              daemonObservation: {
                daemonIdentity: 'nonRoot',
                daemonUid: 2400,
                daemonUsername: 'daemon',
                daemonPrimaryGroup: 'daemon',
              },
            }),
          },
        }),
      prepareConnectedAccountProcessEnvironment: async () => {
        throw new Error('Unexpected process credential preparation');
      },
    },
  };
  const ingress: RpcHandlerContext = {
    signal: new AbortController().signal,
    transportRequestId: 'transport',
    machineAdmission: {
      actorAccountId: 'member',
      custodianAccountId: 'member',
      machineId: 'machine',
      installationId: 'installation',
      role: 'use',
      encryptionMode: 'plain',
    },
    verifyMachineAdmissionCurrent: async () => true,
  };
  const address = {
    serverId: 'home',
    machineId: 'machine',
    workspaceId: ref.id,
    rootPath: ref.rootPath,
  };
  const invoke = (
    actionId: 'projects.prepare' | 'projects.script.run',
    input: unknown,
  ) =>
    createProjectFiniteAction(
      runtime,
      ingress,
    )({
      actionId,
      input,
      context: {
        authority: 'account_automation',
        surface: 'agent',
        actionRequestId: 'request',
        serverId: 'home',
      },
    });
  const terminal = () =>
    operationRuntime.runner.waitForTerminal(
      { accountId: 'member', machineId: 'machine' },
      'operation',
    );
  return { address, invoke, terminal, operationRuntime, post, spawned };
}

it
  .skipIf(process.platform !== 'linux')
  .each(['projects.prepare', 'projects.script.run'] as const)(
  "refuses %s on another person's checkout named by the guest's own WorkspaceRef under member isolation",
  async (actionId) => {
    await withTempDir('member-finite-foreign-', async (directory) => {
      const ownerRoot = join(directory, 'owner-checkout');
      await mkdir(join(ownerRoot, '.happier'), { recursive: true });
      await writeFile(
        join(ownerRoot, '.happier/project.json'),
        JSON.stringify({
          version: 1,
          scripts: {
            check: {
              source: { kind: 'command', command: 'echo owner-private-script' },
            },
          },
          workspace: {
            setup: [{ kind: 'command', command: 'echo owner-private-setup' }],
          },
        }),
      );
      owner.roots.push(ownerRoot);
      boundary.memberUnreadableRoots = [ownerRoot];
      boundary.mounts = [
        {
          path: memberIdentity.workspaceRoot,
          backing: join(directory, 'member'),
          uid: 2401,
          gid: 2400,
          mode: 0o40710,
        },
      ];
      boundary.launch = async (input, output) => {
        await readAgentLaunchFrame(input);
        await runWorkspaceEffectWorker([], {
          input,
          output,
          signal: new AbortController().signal,
          currentDirectory: () => memberIdentity.workspaceRoot,
        });
      };
      // The guest's own Account row names the owner's checkout on the owner's Machine.
      const h = await finiteHarness(
        directory,
        {
          id: 'guest-ref',
          serverId: 'home',
          machineId: 'machine',
          rootPath: ownerRoot,
          createdAtMs: 1,
          projectKey: 'project',
        },
        'member',
      );
      const result = await h.invoke(
        actionId,
        actionId === 'projects.prepare'
          ? { workspace: h.address, phase: 'setup' }
          : {
              workspace: h.address,
              selection: { kind: 'named', name: 'check' },
            },
      );
      expect(result).toMatchObject({
        ok: false,
        errorCode: 'project_workspace_unavailable',
      });
      const operation = h.operationRuntime.store.get(
        { accountId: 'member', machineId: 'machine' },
        'operation',
      );
      expect(operation ?? null).toBeNull();
      expect(JSON.stringify([result, operation ?? null])).not.toContain(
        'owner-private',
      );
      expect(owner.daemonReads).toEqual([]);
      expect(h.spawned).toEqual([]);
      expect(boundary.childFailure).toBeUndefined();
    });
  },
);

it.skipIf(process.platform !== 'linux')(
  'prepares a genuine private member checkout through the member workspace source',
  async () => {
    await withTempDir('member-finite-own-', async (directory) => {
      const root = join(memberIdentity.workspaceRoot, 'accepted');
      const backing = join(directory, 'member');
      await mkdir(join(backing, 'accepted', '.happier'), { recursive: true });
      await writeFile(
        join(backing, 'accepted', '.happier/project.json'),
        JSON.stringify({
          version: 1,
          scripts: {
            check: { source: { kind: 'command', command: 'echo checked' } },
          },
        }),
      );
      boundary.mounts = [
        {
          path: memberIdentity.workspaceRoot,
          backing,
          uid: 2401,
          gid: 2400,
          mode: 0o40710,
        },
      ];
      // The daemon user can neither traverse nor open the 0700 member checkout.
      boundary.privateRoots = [root];
      boundary.launch = async (input, output) => {
        await readAgentLaunchFrame(input);
        await runWorkspaceEffectWorker([], {
          input,
          output,
          signal: new AbortController().signal,
          currentDirectory: () => memberIdentity.workspaceRoot,
        });
      };
      const h = await finiteHarness(
        directory,
        {
          id: 'accepted',
          serverId: 'home',
          machineId: 'machine',
          rootPath: root,
          createdAtMs: 1,
          projectKey: 'project',
        },
        'member',
      );
      expect(
        await h.invoke('projects.prepare', {
          workspace: h.address,
          phase: 'setup',
        }),
      ).toMatchObject({ operation: { operationId: 'operation' } });
      expect(await h.terminal()).toMatchObject({ state: 'succeeded' });
      expect(boundary.phases).toContain('member_definition_read');
      expect(boundary.phases).not.toContain('daemon_definition_read');
      expect(boundary.phases).not.toContain('daemon_private_readback_denied');
      expect(boundary.childFailure).toBeUndefined();
    });
  },
);

it("keeps an isolation-off requester's own checkout on the daemon with no member reader", async () => {
  await withTempDir('member-finite-off-', async (directory) => {
    const root = join(directory, 'checkout');
    await mkdir(join(root, '.happier'), { recursive: true });
    await writeFile(
      join(root, '.happier/project.json'),
      JSON.stringify({ version: 1 }),
    );
    const h = await finiteHarness(
      directory,
      {
        id: 'accepted',
        serverId: 'home',
        machineId: 'machine',
        rootPath: root,
        createdAtMs: 1,
        projectKey: 'project',
      },
      'off',
    );
    expect(
      await h.invoke('projects.prepare', {
        workspace: h.address,
        phase: 'setup',
      }),
    ).toMatchObject({ operation: { operationId: 'operation' } });
    expect(await h.terminal()).toMatchObject({ state: 'succeeded' });
    expect(boundary.phases).not.toContain('native_spawn');
  });
});
