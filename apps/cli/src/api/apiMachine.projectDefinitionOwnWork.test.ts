import axios from 'axios';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { PROJECT_DEFINITION_ACTION_IDS } from '@happier-dev/protocol/actions/projectDefinitionActionIdsV1';
import { WorkspaceExecutionConfigReadResponseV1Schema, WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { HostAgentIsolationLaunchSnapshot } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createInstalledProjectFiniteRuntime } from '@/daemon/startup/createInstalledProjectFiniteRuntime';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { materializeWorkspaceRefForMachineRoot } from '@/workspaces/workspaceRefsV1';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { writeStoredCredentialsForServerId } from '@/persistence';

// Owner ruling 2026-11-23 ~15:10Z: on a Machine whose owner turned isolation off, a Use guest's
// own Project work (including declaring scripts) runs on the daemon; with isolation on it stays
// inside isolation; another person's Project is never reached. Home admits the grantee only as
// the signed Action (`originalExecution.machineAdmission: 'requester_own_work'`), so the daemon
// builds the Project runtime from the requester custody that Action carries, never from the
// custodian's stored credentials. Real: the installed Machine receiver, the Project runtime
// builder, the signed requester Account admission and projection, placement, accepted-workspace
// resolution and the definition owner reading and writing `.happier/project.json`. Substituted:
// Home HTTP only (admission verify, the guest's Account rows, absent trust and execution config).
type DefinitionActionId = typeof PROJECT_DEFINITION_ACTION_IDS[number];
const off = { enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] } as unknown as HostAgentIsolationLaunchSnapshot;
const on = { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' },
  workspaceRoots: [] } as unknown as HostAgentIsolationLaunchSnapshot;
const token = (accountId: string) => `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
const signedRoot = (actionId: DefinitionActionId) => `guest-definition-root:${actionId}`;

afterEach(() => { vi.restoreAllMocks(); });

async function guestOnInstalledMachine(policy: HostAgentIsolationLaunchSnapshot | undefined) {
  let finite: ReturnType<typeof createInstalledProjectFiniteRuntime> | undefined;
  const agentIsolation = { read: () => policy } as unknown as NonNullable<Parameters<typeof createInstalledFilesystemMachineFixture>[0]>['agentIsolation'];
  const f = await createInstalledFilesystemMachineFixture({ agentIsolation,
    createProjectFiniteRuntime: (...args) => { if (!finite) throw new Error('Installed finite producer not ready'); return finite(...args); } });
  await seedTestServerProfile({ id: f.serverId, homeId: f.homeServerIdentityId, serverUrl: f.serverHttpBaseUrl });
  // The custodian's stored daemon sign-in: the continuation a non-custodian must never reach.
  await writeStoredCredentialsForServerId(f.serverId, f.bootstrap.credentials);
  const roots = { own: join(f.directory, 'guest-project'), owner: join(f.directory, 'owner-project') };
  for (const root of Object.values(roots)) {
    await mkdir(join(root, '.happier'), { recursive: true });
    await writeFile(join(root, '.happier/project.json'), '{"version":1}');
  }
  const accepted = (rootPath: string, id: string) => materializeWorkspaceRefForMachineRoot([], { serverId: f.homeServerIdentityId,
    machineId: f.machineId, rootPath, nowMs: 1, createId: () => id }).workspaceRef;
  const guestRef = accepted(roots.own, 'guest-accepted');
  const ownerRef = accepted(roots.owner, 'owner-accepted');
  // Each Account sees only its own accepted WorkspaceRef.
  const rowsByAccount: Record<string, unknown[]> = { guest: [createPlainProjectAccountRefRow(guestRef)],
    requester: [createPlainProjectAccountRefRow(ownerRef)] };
  const rowReaders: string[] = [];
  const originalGet = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation(async (url, options) => {
    if (String(url).endsWith('/v1/account/profile')) {
      const authorization = options?.headers?.Authorization;
      return { status: 200, data: { id: typeof authorization === 'string' ? readAccountIdFromToken(authorization.slice(7)) : 'requester' } };
    }
    return originalGet(url, options);
  });
  const originalPost = vi.mocked(axios.post).getMockImplementation()!;
  vi.mocked(axios.post).mockImplementation(async (url, body, options) => {
    if (String(url).endsWith('/admission/verify')) return originalPost(url, body, options);
    if (String(url).endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: f.isHomeCurrent() } };
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/project-rows/read' || path === '/v1/account/project-rows/list') {
      const authorization = options?.headers?.Authorization;
      const reader = typeof authorization === 'string' ? readAccountIdFromToken(authorization.slice(7)) ?? 'unknown' : 'unknown';
      rowReaders.push(reader);
      return projectAccountRowsReadHttpResponse(rowsByAccount[reader] ?? [], String(url), body);
    }
    if (!String(options?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] ?? '').startsWith('guest-definition-root:')) {
      throw new Error(`Requester effect read must use the guest's signed root: ${path}`);
    }
    if (path.endsWith('/project-trust/read')) return { status: 200, data: { status: 'absent' } };
    if (path.endsWith(`${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`)) return { status: 200,
      data: WorkspaceExecutionConfigReadResponseV1Schema.parse({ status: 'absent' }) };
    throw new Error(`Unexpected Home request: ${path}`);
  });
  finite = createInstalledProjectFiniteRuntime({ api: { getMachine: async () => { throw new Error('No worker placement expected'); } },
    credentials: f.bootstrap.credentials, externalActionAccountId: 'requester', finiteServerId: f.serverId,
    finiteServerHttpBaseUrl: f.serverHttpBaseUrl, registeredMachineId: f.machineId,
    admission: createProjectWorkerAdmission({ machineId: f.machineId, admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'stored', metadataVersion: 1 }) }),
    nativeIo: createProjectNativeIo({ agentIsolation }), agentIsolation, successHomeDir: f.directory,
    isCurrent: async () => f.isHomeCurrent(), prepareBetween: async () => { throw new Error('No Workspace Sync expected'); },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: f.homeServerIdentityId, machineId: f.machineId }) });
  const admission = { actorAccountId: 'guest', custodianAccountId: 'requester', machineId: f.machineId,
    installationId: f.installation.installationId, role: 'use' as const, encryptionMode: 'plain' as const };
  /** The guest's Home-signed Action as the receiving daemon's ingress carries it. */
  const signedIngress = async (actionId: DefinitionActionId): Promise<RpcHandlerContext> => {
    const wire = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: signedRoot(actionId), binding: {
      accountId: 'guest', custodianAccountId: 'requester', serverIdentityId: f.homeServerIdentityId, machineId: f.machineId,
      installationId: f.installation.installationId, actionId, accountEncryptionMode: 'plain',
      authentication: { kind: 'account', tokenEpoch: 0 }, requestId: `guest-definition-${actionId}`,
      requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: f.machineId } } });
    const account = await admitRequesterAccountActionContext({ authorization: wire,
      invocation: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' } },
      credentials: { token: token('guest'), encryption: null },
      serverId: f.serverId, serverIdentityId: f.homeServerIdentityId, serverHttpBaseUrl: f.serverHttpBaseUrl,
      isCurrent: async () => f.isHomeCurrent() });
    if (!account) throw new Error('Genuine requester Account admission failed');
    onTestFinished(() => account.dispose());
    const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: account.authorization,
      serverId: f.serverId, serverIdentityId: f.homeServerIdentityId, serverHttpBaseUrl: f.serverHttpBaseUrl,
      target: wire.binding.target, installationId: f.installation.installationId, privateKey: f.installation.privateKey,
      isCurrent: async () => f.isHomeCurrent() });
    if (!authorization) throw new Error('Genuine signed requester projection failed');
    return { signal: new AbortController().signal, callerAuthority: 'present_user', transportRequestId: `guest-definition-${actionId}`,
      callerInputAuthorization: authorization, machineAdmission: admission, verifyMachineAdmissionCurrent: async () => f.isHomeCurrent() };
  };
  const call = async (actionId: DefinitionActionId, project: 'own' | 'owner', basis?: 'present', raw?: 'raw') => {
    const ref = project === 'own' ? guestRef : ownerRef;
    const workspace = { serverId: ref.serverId, machineId: ref.machineId, rootPath: ref.rootPath, workspaceId: ref.id };
    const current = await readFile(join(roots[project], '.happier/project.json'), 'utf8');
    const input = actionId === 'projects.inspect' ? { workspace, read: { kind: 'editor', target: 'repository' } }
      : actionId === 'projects.manifest.update' ? { workspace, bytes: '{"version":1,"scripts":{}}',
        expectedBasis: basis ? { kind: 'present', hash: createHash('sha256').update(current).digest('hex') } : { kind: 'absent' } }
      : { workspace };
    // A raw call carries only Home's admission context, no signed requester custody.
    const action = f.machine.createProjectDefinitionAction(f.serverId, raw
      ? { signal: new AbortController().signal, callerAuthority: 'present_user', machineAdmission: admission,
        verifyMachineAdmissionCurrent: async () => f.isHomeCurrent() }
      : await signedIngress(actionId));
    return await action({ actionId, input, context: {} } as never).catch((error: unknown) => ({ thrown: error }));
  };
  const manifest = (project: 'own' | 'owner') => readFile(join(roots[project], '.happier/project.json'), 'utf8');
  return { call, manifest, rowReaders };
}

const refusalCode = (result: unknown) => {
  const thrown: unknown = result && typeof result === 'object' ? Reflect.get(result, 'thrown') : undefined;
  return thrown && typeof thrown === 'object' ? Reflect.get(thrown, 'code') : undefined;
};

describe("a Use guest's signed Project definition Action on an installed Machine", () => {
  it("reads, saves and re-ports the guest's own Project on the daemon when the owner turned isolation off", async () => {
    const g = await guestOnInstalledMachine(off);
    expect(await g.call('projects.inspect', 'own')).toMatchObject({ definition: { document: { bytes: '{"version":1}' } } });
    expect(await g.call('projects.manifest.update', 'own', 'present')).toMatchObject({ status: 'saved' });
    expect(await g.manifest('own')).toBe('{"version":1,"scripts":{}}');
    expect(await g.call('projects.worktree.ports.reassign', 'own')).toMatchObject({ kind: expect.any(String) });
    expect(await g.manifest('owner')).toBe('{"version":1}');
    // Every Account row the runtime read was the guest's, through the guest's own custody.
    expect(new Set(g.rowReaders)).toEqual(new Set(['guest']));
  }, 60_000);

  it.each([
    ['isolation off', off],
    ['isolation on', on],
    ['an unread isolation policy', undefined],
  ] as const)("refuses the owner's Project before any read or write with %s", async (_label, policy) => {
    const g = await guestOnInstalledMachine(policy);
    const refused: Record<string, unknown> = {};
    for (const actionId of PROJECT_DEFINITION_ACTION_IDS) {
      refused[actionId] = refusalCode(await g.call(actionId, 'owner', actionId === 'projects.manifest.update' ? 'present' : undefined));
    }
    const writeRefusal = policy === off ? 'project_workspace_unavailable' : 'agent_isolation_unavailable';
    expect(refused).toEqual({ 'projects.inspect': 'project_workspace_unavailable',
      'projects.manifest.update': writeRefusal, 'projects.worktree.ports.reassign': 'project_workspace_unavailable' });
    expect(await g.manifest('owner')).toBe('{"version":1}');
    // The custodian's Account rows are never read on the guest's behalf.
    expect(g.rowReaders).not.toContain('requester');
  }, 60_000);

  it('refuses the same guest without the signed Action before any Account row is read', async () => {
    const g = await guestOnInstalledMachine(off);
    for (const project of ['own', 'owner'] as const) {
      for (const actionId of PROJECT_DEFINITION_ACTION_IDS) {
        expect(refusalCode(await g.call(actionId, project, actionId === 'projects.manifest.update' ? 'present' : undefined, 'raw')))
          .toBe('project_requester_credentials_unavailable');
      }
    }
    expect(g.rowReaders).toEqual([]);
    expect([await g.manifest('own'), await g.manifest('owner')]).toEqual(['{"version":1}', '{"version":1}']);
  }, 60_000);
});
