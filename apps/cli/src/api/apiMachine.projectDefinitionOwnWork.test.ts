import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from '@/api/apiMachine';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { HostAgentIsolationLaunchSnapshot } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { withTempDir } from '@/testkit/fs/tempDir';
import {
  createPlainProjectAccountRefRow,
  mockProjectAccountRowsHttpBoundary,
} from '@/workspaces/projectAccountRows.testkit';

// Owner ruling 2026-11-23 ~15:10Z: on a Machine whose owner turned isolation off, a Use
// guest's own Project work (including declaring scripts) runs on the daemon; with isolation
// on, it stays inside isolation; another person's Project is never reached. Real: the
// daemon's Project definition placement, the requester's accepted-workspace resolution and
// the definition owner reading and writing `.happier/project.json`. Replaced: the Home
// Account-rows HTTP boundary (the guest's own rows) and the requester runtime lookup (the
// guest identity Home admitted).
const guest = {
  kind: 'isolated' as const,
  separationRequired: true,
  requester: {
    serverId: 'home',
    accountId: 'guest',
    machineId: 'machine',
    installationId: 'installation',
  },
};
const owner = {
  kind: 'owner_person' as const,
  requester: {
    serverId: 'home',
    accountId: 'owner',
    machineId: 'machine',
    installationId: 'installation',
  },
};
const off = { enabled: false } as HostAgentIsolationLaunchSnapshot;
const on = {
  enabled: true,
  memberProvisioning: 'linuxUsersV1',
  status: { kind: 'effective', platform: 'linux' },
  workspaceRoots: [],
} as unknown as HostAgentIsolationLaunchSnapshot;
type DefinitionActionId =
  | 'projects.inspect'
  | 'projects.manifest.update'
  | 'projects.worktree.ports.reassign';

afterEach(() => {
  vi.restoreAllMocks();
});

async function withDefinitionAction(
  input: Readonly<{
    identity: unknown;
    policy: HostAgentIsolationLaunchSnapshot | undefined;
  }>,
  run: (
    call: (
      actionId: DefinitionActionId,
      project?: 'own' | 'owner',
    ) => Promise<unknown>,
    manifest: (project?: 'own' | 'owner') => Promise<string>,
  ) => Promise<void>,
) {
  await withTempDir('guest-own-definition-', async (directory) => {
    const roots = {
      own: join(directory, 'guest-project'),
      owner: join(directory, 'owner-project'),
    };
    for (const root of Object.values(roots)) {
      await mkdir(join(root, '.happier'), { recursive: true });
      await writeFile(join(root, '.happier/project.json'), '{"version":1}');
    }
    // Only the guest's own accepted WorkspaceRef is in the guest's Account rows.
    mockProjectAccountRowsHttpBoundary([
      createPlainProjectAccountRefRow({
        id: 'guest-accepted',
        serverId: 'home',
        machineId: 'machine',
        rootPath: roots.own,
        createdAtMs: 1,
      }),
    ]);
    const client: ApiMachineClient = Object.assign(
      Object.create(ApiMachineClient.prototype),
      {
        machine: { id: 'machine' },
        machineRpcWorkingDirectory: directory,
        filesystemAccessPolicy: { kind: 'restrictedRoots', roots: [directory] },
        lifecycleDependencies: { agentIsolation: { read: () => input.policy } },
        rpcLifecycleRegistrations: [
          {
            resolveProjectFiniteRuntime: async () => ({
              credentials: {
                token: `e30.${Buffer.from(JSON.stringify({ sub: 'guest' })).toString('base64url')}.signature`,
                encryption: null,
              },
              serverId: 'home',
              serverHttpBaseUrl: 'https://home.test',
              requesterIdentity: input.identity,
            }),
          },
        ],
      },
    );
    const ingress: RpcHandlerContext = {
      signal: new AbortController().signal,
      transportRequestId: 'guest-own-definition',
    };
    await run(
      (actionId, project = 'own') => {
        const workspace = {
          serverId: 'home',
          machineId: 'machine',
          rootPath: roots[project],
          workspaceId: project === 'own' ? 'guest-accepted' : 'owner-accepted',
        };
        return client.createProjectDefinitionAction(
          'home',
          ingress,
        )({
          actionId,
          context: {},
          input:
            actionId === 'projects.inspect'
              ? { workspace, read: { kind: 'editor', target: 'repository' } }
              : actionId === 'projects.manifest.update'
                ? {
                    workspace,
                    expectedBasis: { kind: 'absent' },
                    bytes: '{"version":1,"scripts":{}}',
                  }
                : { workspace },
        } as never);
      },
      (project = 'own') =>
        readFile(join(roots[project], '.happier/project.json'), 'utf8'),
    );
  });
}

describe("Project definition placement for a guest's own Project", () => {
  it("reads and declares in the guest's own Project on the daemon when the owner turned isolation off", async () => {
    await withDefinitionAction(
      { identity: guest, policy: off },
      async (call, manifest) => {
        expect(await call('projects.inspect')).toMatchObject({
          definition: { document: { bytes: '{"version":1}' } },
        });
        // A present manifest with an absent basis is the definition owner's typed conflict, reached past placement.
        expect(await call('projects.manifest.update')).toMatchObject({
          status: 'conflict',
        });
        expect(await call('projects.worktree.ports.reassign')).toMatchObject({
          kind: expect.any(String),
        });
        expect(await manifest()).toBe('{"version":1}');
      },
    );
  });

  it.each([
    'projects.inspect',
    'projects.manifest.update',
    'projects.worktree.ports.reassign',
  ] as const)(
    "refuses %s on another person's Project before effect",
    async (actionId) => {
      await withDefinitionAction(
        { identity: guest, policy: off },
        async (call, manifest) => {
          await expect(call(actionId, 'owner')).rejects.toMatchObject({
            code: 'project_workspace_unavailable',
          });
          expect(await manifest('owner')).toBe('{"version":1}');
        },
      );
    },
  );

  it.each([
    ['isolation on', on],
    ['an unread isolation policy', undefined],
  ] as const)(
    'never writes the manifest as the daemon with %s',
    async (_label, policy) => {
      await withDefinitionAction(
        { identity: guest, policy },
        async (call, manifest) => {
          await expect(call('projects.manifest.update')).rejects.toMatchObject({
            code: 'agent_isolation_unavailable',
          });
          expect(await manifest()).toBe('{"version":1}');
        },
      );
    },
  );

  it('keeps the Machine owner on the daemon whatever the isolation policy', async () => {
    await withDefinitionAction(
      { identity: owner, policy: on },
      async (call) => {
        expect(await call('projects.inspect')).toMatchObject({
          definition: { document: { bytes: '{"version":1}' } },
        });
      },
    );
  });
});
