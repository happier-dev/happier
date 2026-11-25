import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { PROJECT_DEFINITION_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectDefinitionActionIdsV1';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { registerProjectDefinitionHandlers } from '@/rpc/handlers/projectDefinitions';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

const boundary = vi.hoisted(() => ({
  control: null as Parameters<typeof startDaemonControlServer>[0] | null,
}));
// The private HTTP listener is the transport boundary; its production dispatcher stays real.
vi.mock('@/daemon/controlServer', () => ({
  startDaemonControlServer: async (
    input: Parameters<typeof startDaemonControlServer>[0],
  ) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
  },
}));
// Genuine HTTP boundary: control requests use Undici's fetch; share the fixture's Fetch responder.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: ((...args: Parameters<typeof fetch>) =>
      globalThis.fetch(...args)) as unknown as typeof actual.fetch,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  boundary.control = null;
});
afterAll(() => pluginReloadController.shutdown());

const terminalSignIn = (accountId: string) => ({
  token: `e30.${Buffer.from(
    JSON.stringify({
      sub: accountId,
      tokenEpoch: 0,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
    }),
  ).toString('base64url')}.signature`,
  encryption: null,
});

// Found by BL40-GUEST-NEGATIVE-PROOFS-1125 (2026-11-25): with Home's raw-call context for a
// Use grantee and no Home-signed Action, the installed daemon built the Project runtime on its
// stored (custodian) credentials, so the guest read, rewrote and re-ported the owner's Project.
// Contract: a caller who is not the Machine custodian runs only on the requester custody a
// signed Action carries; without it the runtime builder refuses before any read or write.
// Real: the installed daemon's ingress executor, its Project definition handlers, the runtime
// builder, requester placement and the definition owner. Substituted: the Socket transport
// (handlers are invoked with Home's admission context) and Home HTTP.
it("refuses a Use grantee's raw Project definition call without a Home-signed Action, on their own Project and on another person's", async () => {
  const credentials = terminalSignIn('requester');
  const h = await createInstalledProjectAgentDaemonFixture(
    () => boundary.control,
    undefined,
    false,
    undefined,
    undefined,
    {
      processEnv: process.env,
      externalActionAccountId: 'requester',
      credentials,
      accountActionCredentials: credentials,
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      resolveCurrentMachineExecutionOriginContext: async () => ({
        serverIdentityId: 'srv_raw_project',
        machineId: 'machine',
      }),
      // The owner turned isolation off: the placement in which a guest's own work runs on the daemon.
      agentIsolation: {
        read: () => ({
          enabled: false,
          status: { kind: 'disabled' },
          workspaceRoots: [],
        }),
      },
    },
  );
  const ownerManifest = JSON.stringify({ version: 1 });
  await writeFile(join(h.cwd, '.happier/project.json'), ownerManifest);
  const guestRoot = join(h.f.directory, 'guest-project');
  await mkdir(join(guestRoot, '.happier'), { recursive: true });
  await writeFile(join(guestRoot, '.happier/project.json'), ownerManifest);
  const handlers = new Map<
    string,
    (input: unknown, context?: RpcHandlerContext) => Promise<unknown>
  >();
  registerProjectDefinitionHandlers({
    machineId: 'machine',
    rpcHandlerManager: {
      registerHandler: (method, handler) => {
        handlers.set(method, handler);
      },
    },
    actionExecutor: h.daemon.externalActionIngressOwner!.executor,
  });
  // Exactly what Home forwards for a raw call: its admission context and nothing else
  // (no callerInputAuthorization, no Session origin).
  const rawIngress = (
    actor: Readonly<{ accountId: string; role: 'use' | 'manage' }>,
  ): RpcHandlerContext => ({
    signal: h.signal,
    callerAuthority: 'present_user',
    machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({
      actorAccountId: actor.accountId,
      custodianAccountId: 'requester',
      machineId: 'machine',
      installationId: h.f.installation.installationId,
      role: actor.role,
      encryptionMode: h.machine.getMachineEncryptionMode(),
    }),
    verifyMachineAdmissionCurrent: h.requester.isCurrent,
  });
  const call = async (
    actionId: keyof typeof PROJECT_DEFINITION_ACTION_RPC_METHODS_V1,
    target: Readonly<{ workspaceId: string; rootPath: string }>,
    actor: Readonly<{ accountId: string; role: 'use' | 'manage' }>,
  ) => {
    const handler = handlers.get(
      PROJECT_DEFINITION_ACTION_RPC_METHODS_V1[actionId],
    );
    if (!handler) throw new Error(`Missing installed ${actionId} RPC`);
    const workspace = {
      serverId: 'session-home',
      machineId: 'machine',
      ...target,
    };
    const input =
      actionId === 'projects.inspect'
        ? { workspace, read: { kind: 'editor', target: 'repository' } }
        : actionId === 'projects.manifest.update'
          ? {
              workspace,
              expectedBasis: { kind: 'absent' },
              bytes: '{"version":1,"scripts":{}}',
            }
          : { workspace };
    try {
      return await handler(input, rawIngress(actor));
    } catch (error) {
      return {
        thrown:
          error instanceof Error && 'code' in error
            ? error.code
            : String(error),
      };
    }
  };
  const ownerProject = { workspaceId: 'workspace', rootPath: h.cwd };
  const guestProject = { workspaceId: 'guest-workspace', rootPath: guestRoot };
  // Control: the custodian's raw inspection reaches the definition owner through the same handler.
  expect(
    await call('projects.inspect', ownerProject, {
      accountId: 'requester',
      role: 'manage',
    }),
  ).toMatchObject({ definition: { document: { bytes: ownerManifest } } });
  const observed: Record<string, unknown> = {};
  for (const [label, target] of [
    ['owner', ownerProject],
    ['own', guestProject],
  ] as const) {
    for (const actionId of Object.keys(
      PROJECT_DEFINITION_ACTION_RPC_METHODS_V1,
    ) as (keyof typeof PROJECT_DEFINITION_ACTION_RPC_METHODS_V1)[]) {
      for (const role of ['use', 'manage'] as const) {
        const result = await call(actionId, target, {
          accountId: 'guest',
          role,
        });
        observed[`${label}:${actionId}:${role}`] =
          result && typeof result === 'object'
            ? Reflect.get(result, 'errorCode')
            : result;
      }
    }
  }
  // Without the Home-signed Action no grantee call reaches the runtime: one typed refusal,
  // decided before any Account row, manifest or port is read. Observed on HEAD 9463e87e588
  // (BL40): every owner:* entry executed and the own:* entries refused project_workspace_unavailable.
  expect(observed).toEqual(
    Object.fromEntries(
      Object.keys(observed).map((key) => [
        key,
        'project_requester_credentials_unavailable',
      ]),
    ),
  );
  // Write probe: the guest echoes the basis a raw inspection would disclose. Observed: "saved".
  const handler = handlers.get(
    PROJECT_DEFINITION_ACTION_RPC_METHODS_V1['projects.manifest.update'],
  )!;
  const write = await handler(
    {
      workspace: {
        serverId: 'session-home',
        machineId: 'machine',
        ...ownerProject,
      },
      expectedBasis: {
        kind: 'present',
        hash: createHash('sha256').update(ownerManifest).digest('hex'),
      },
      bytes: '{"version":1,"scripts":{}}',
    },
    rawIngress({ accountId: 'guest', role: 'use' }),
  ).catch((error: unknown) => ({ thrown: String(error) }));
  expect(write).toMatchObject({
    ok: false,
    errorCode: 'project_requester_credentials_unavailable',
  });
  expect(await readFile(join(h.cwd, '.happier/project.json'), 'utf8')).toBe(
    ownerManifest,
  );
  expect(await readFile(join(guestRoot, '.happier/project.json'), 'utf8')).toBe(
    ownerManifest,
  );
}, 120_000);
