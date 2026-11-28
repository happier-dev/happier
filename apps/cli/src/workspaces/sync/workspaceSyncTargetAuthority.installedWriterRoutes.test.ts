import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createWorkspaceSyncTargetAuthority } from './workspaceSyncTargetAuthority';

// A Sync link from the installed owner's Machine A to a copy on another Account's
// Machine B (W40/W43, MS-R5). Home refuses the raw Account RPC to B (custodian_only);
// the installed SOURCE writer reaches B's retained endpoint only through writer-target routing.
const relationshipId = 'cross-account-link';
const snapshot = {
  source: 'network',
  workspaceRefs: [
    {
      id: 'workspace-alpha',
      serverId: 'server-1',
      machineId: 'machine-a',
      rootPath: '/work/alpha',
      createdAtMs: 1,
    },
    {
      id: 'workspace-beta',
      serverId: 'server-1',
      machineId: 'machine-b',
      rootPath: '/work/beta',
      createdAtMs: 1,
    },
  ],
  relationships: [
    {
      v: 1,
      relationshipId,
      controllerMachineId: 'machine-a',
      alphaWorkspaceRefId: 'workspace-alpha',
      betaWorkspaceRefId: 'workspace-beta',
      mode: 'keep_synced',
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      contentPolicy: { v: 1, policyDigest: 'p'.repeat(64) },
    },
  ],
} as unknown as ActiveProjectAccountRowsSnapshot;

const installedIngress = (
  overrides: Partial<NonNullable<RpcHandlerContext['machineAdmission']>> = {},
): RpcHandlerContext => ({
  signal: new AbortController().signal,
  callerAuthority: 'present_user',
  machineAdmission: {
    actorAccountId: 'owner',
    custodianAccountId: 'owner',
    machineId: 'machine-a',
    installationId: 'installation-a',
    role: 'manage',
    encryptionMode: 'plain',
    ...overrides,
  },
});

function createController() {
  const raw: string[] = [];
  const routed: Array<
    Readonly<{ method: string; routing: unknown; context: RpcHandlerContext }>
  > = [];
  const authority = createWorkspaceSyncTargetAuthority({
    localServerId: 'server-1',
    localMachineId: 'machine-a',
    localAccountId: 'owner',
    getProjectSnapshot: () => snapshot,
    // Home's answer to a non-custodian raw call on a custodian_only method.
    callMachineRpc: async ({ machineId, method }) => {
      raw.push(`${machineId}:${method}`);
      throw Object.assign(new Error('Forbidden'), { code: 'RPC_FORBIDDEN' });
    },
    callWorkspaceTargetPhase: async (descriptor, context) => {
      routed.push({
        method: descriptor.method,
        routing: descriptor.routing,
        context,
      });
      if (descriptor.method === RPC_METHODS.DAEMON_PROJECT_WORKER_DEPENDENCIES)
        return [];
      if (
        descriptor.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ
      ) {
        return { ok: true, kind: 'missing' };
      }
      return { kind: 'missing' };
    },
  } as Parameters<typeof createWorkspaceSyncTargetAuthority>[0]);
  return { authority, raw, routed };
}

const expectInstalledWriterRoute = (
  call: Readonly<{ routing: unknown; context: RpcHandlerContext }>,
  phase: string,
) => {
  expect(call.routing).toEqual({
    v: 1,
    phase,
    operationId: relationshipId,
    accountServerId: 'server-1',
    targetMachineId: 'machine-b',
    targetRootPath: '/work/beta',
  });
  expect(call.context.callerInputAuthorization).toBeUndefined();
  expect(call.context.machineAdmission).toMatchObject({
    actorAccountId: 'owner',
    custodianAccountId: 'owner',
    machineId: 'machine-a',
    installationId: 'installation-a',
    role: 'manage',
  });
  expect(call.context.workspaceSyncSourceWriterTargetRouting).toMatchObject({
    v: 1,
    sourceWriter: { machineId: 'machine-a', installationId: 'installation-a' },
    source: {
      sourceMachineId: 'machine-a',
      sourceRootPath: '/work/alpha',
      accountServerId: 'server-1',
    },
    target: call.routing,
  });
};

describe('installed SOURCE writer reads of another Account’s TARGET endpoint', () => {
  it('observes a conflict entry through writer-target inspect routing, never the custodian_only raw RPC (MS-R5)', async () => {
    const { authority, raw, routed } = createController();
    await expect(
      authority.observeEntryAtTarget({
        relationshipId,
        targetMachineId: 'machine-b',
        targetWorkspaceRefId: 'workspace-beta',
        path: 'conflict.txt',
        context: installedIngress(),
      }),
    ).resolves.toEqual({ kind: 'missing' });
    expect(raw).toEqual([]);
    expect(routed.map((call) => call.method)).toEqual([
      RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_ENTRY_OBSERVE,
    ]);
    expectInstalledWriterRoute(routed[0]!, 'inspect');
  });

  it('reads a bounded file preview through the same route', async () => {
    const { authority, raw, routed } = createController();
    await authority
      .readFileAtTarget({
        relationshipId,
        targetMachineId: 'machine-b',
        targetWorkspaceRefId: 'workspace-beta',
        path: 'conflict.txt',
        maxBytes: 1024,
        context: installedIngress(),
      })
      .catch(() => undefined);
    expect(raw).toEqual([]);
    expect(routed.map((call) => call.method)).toEqual([
      RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ,
    ]);
    expectInstalledWriterRoute(routed[0]!, 'inspect');
  });

  it('reads retirement dependencies through writer-target dependencies routing (W43)', async () => {
    const { authority, raw, routed } = createController();
    const request = {
      serverId: 'server-1',
      machineId: 'machine-b',
      workspaceRefId: 'workspace-beta',
      relationshipId,
    };
    await expect(
      authority.readDependenciesAsInstalledWriter(request, installedIngress()),
    ).resolves.toEqual([]);
    expect(raw).toEqual([]);
    expect(routed.map((call) => call.method)).toEqual([
      RPC_METHODS.DAEMON_PROJECT_WORKER_DEPENDENCIES,
    ]);
    expectInstalledWriterRoute(routed[0]!, 'dependencies');
  });

  it('has no installed-writer route without the installed custodian’s ingress, another link, or a non-endpoint Machine', async () => {
    const { authority, routed } = createController();
    const request = {
      serverId: 'server-1',
      machineId: 'machine-b',
      workspaceRefId: 'workspace-beta',
      relationshipId,
    };
    expect(authority.readDependenciesAsInstalledWriter(request)).toBeNull();
    expect(
      authority.readDependenciesAsInstalledWriter(
        request,
        installedIngress({
          actorAccountId: 'guest',
        }),
      ),
    ).toBeNull();
    expect(
      authority.readDependenciesAsInstalledWriter(
        request,
        installedIngress({
          custodianAccountId: 'another-person',
          actorAccountId: 'another-person',
        }),
      ),
    ).toBeNull();
    expect(
      authority.readDependenciesAsInstalledWriter(
        { ...request, relationshipId: 'another-persons-link' },
        installedIngress(),
      ),
    ).toBeNull();
    expect(
      authority.readDependenciesAsInstalledWriter(
        { ...request, machineId: 'machine-c' },
        installedIngress(),
      ),
    ).toBeNull();
    // Background reads with no ingress keep today's raw transport and its refusal.
    await expect(
      authority.observeEntryAtTarget({
        relationshipId,
        targetMachineId: 'machine-b',
        targetWorkspaceRefId: 'workspace-beta',
        path: 'conflict.txt',
      }),
    ).rejects.toMatchObject({ code: 'RPC_FORBIDDEN' });
    expect(routed).toEqual([]);
  });
});

describe('TARGET admission of a routed installed-writer read', () => {
  it('refuses another person’s relationship on the same TARGET before reading anything', async () => {
    const target = createWorkspaceSyncTargetAuthority({
      localServerId: 'server-1',
      localMachineId: 'machine-b',
      localAccountId: 'target-owner',
      getProjectSnapshot: () => null,
      callMachineRpc: async () => {
        throw new Error('The TARGET makes no further calls');
      },
    } as Parameters<typeof createWorkspaceSyncTargetAuthority>[0]);
    const writer = {
      actorAccountId: 'owner',
      custodianAccountId: 'owner',
      machineId: 'machine-a',
      installationId: 'installation-a',
      role: 'manage' as const,
      encryptionMode: 'plain' as const,
    };
    const routing = (phase: 'inspect' | 'dependencies') => ({
      v: 1,
      sourceWriter: {
        machineId: 'machine-a',
        installationId: 'installation-a',
      },
      source: {
        v: 1,
        phase: 'prepare',
        operationId: 'another-persons-link',
        accountServerId: 'server-1',
        sourceMachineId: 'machine-a',
        sourceRootPath: '/work/alpha',
        sourceContext: {
          machineAdmission: writer,
          callerAuthority: 'present_user',
          workspaceWrites: 'allow',
        },
      },
      target: {
        v: 1,
        phase,
        operationId: 'another-persons-link',
        accountServerId: 'server-1',
        targetMachineId: 'machine-b',
        targetRootPath: '/work/beta',
      },
    });
    const context = (phase: 'inspect' | 'dependencies') =>
      ({
        signal: new AbortController().signal,
        callerAuthority: 'present_user',
        machineAdmission: writer,
        verifyMachineAdmissionCurrent: async () => true,
        workspaceSyncSourceWriterTargetRouting: routing(phase),
      }) as unknown as RpcHandlerContext;
    await expect(
      target.assertRetainedCopyDependencyAdmission(
        {
          serverId: 'server-1',
          machineId: 'machine-b',
          workspaceRefId: 'workspace-beta',
          relationshipId: 'another-persons-link',
        },
        context('dependencies'),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      target.observeEntryHere(
        {
          relationshipId: 'another-persons-link',
          workspaceRefId: 'workspace-beta',
          path: 'secret.txt',
        },
        undefined,
        context('inspect'),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
