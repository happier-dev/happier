import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import { onTestFinished, vi } from 'vitest';
import { ProjectTrustMutationRequestV1Schema, ProjectTrustReadRequestV1Schema, type ProjectTrustContentV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { ApiMachineClient } from '@/api/apiMachine';
import { ApiClient } from '@/api/api';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectSessionRuntimeFixture } from '@/daemon/testkit/projectSessionRuntimeFixture';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { projectRuntimeAccountRowsInput } from '@/workspaces/projectAccountRows';
import { prepareProjectAgentLaunch } from '@/workspaces/projectSetup/projectAgentLaunch';
import { createProjectSetupTrustClient } from '@/workspaces/projectSetup/projectSetupTrust';
import type { ProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { createInstalledProjectFiniteRuntime } from '@/daemon/startup/createInstalledProjectFiniteRuntime';
import { readStoredCredentialsForServerId, sameStoredCredentials, writeCredentialsTokenOnly, writeStoredCredentialsForServerId, type StoredCredentials } from '@/persistence';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { verifyMachineInstallationProof, MachineInstallationProofV1Schema, RequesterSessionCurrentnessPurposeV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { ProjectAccountRowReadRequestV1Schema, ProjectAccountRowReadResponseV1Schema, ProjectAccountRowListRequestV1Schema,
  ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { readBundledPluginAvailabilityHttpFixture } from '@/plugins/testkit/bundledPluginAvailabilityHttpFixture';

/** Installed Project/Account/Trust and native IO composition for cold launch seam tests. */
export async function createInstalledProjectAgentLaunchFixture(options: Readonly<{
  accountActionCredentials?: StoredCredentials;
  requesterCredentials?: StoredCredentials;
  serverId?: string;
  accountSettings?: Readonly<Record<string, unknown>>;
  homeServerIdentityId?: string;
  boundSessionId?: string;
  prepareProject?: boolean;
  machineAccess?: NonNullable<Parameters<typeof createProjectSessionRuntimeFixture>[0]>['machineAccess'];
  machineRpcMethods?: readonly string[];
  resolveCurrentMachineExecutionOriginContext?: Parameters<typeof createInstalledProjectFiniteRuntime>[0]['resolveCurrentMachineExecutionOriginContext'];
}> = {}) {
  const serverId = options.serverId ?? 'session-home';
  const f = await createProjectSessionRuntimeFixture(options.accountActionCredentials
    ? { serverId, homeServerIdentityId: options.homeServerIdentityId, boundSessionId: options.boundSessionId,
      serverUrl: 'https://session-home.test', machineAccess: options.machineAccess,
      // Account decision ingress may proceed directly over RPC. Original
      // CLI Run ingress remains unwaived and must retain setup review.
      accountSettings: { ...options.accountSettings, actionsSettingsV1: setActionApprovalOverride({ settings: normalizeActionsSettingsV1(options.accountSettings?.actionsSettingsV1),
        actionId: 'projects.prepare', surface: 'rpc', approvalRequired: false }) } }
    : { serverId, homeServerIdentityId: options.homeServerIdentityId, boundSessionId: options.boundSessionId,
      serverUrl: 'https://session-home.test', credentials: options.requesterCredentials, machineAccess: options.machineAccess,
      accountSettings: options.accountSettings });
  let accountActionCredentials: StoredCredentials | undefined;
  let accountActionSettings: Awaited<ReturnType<typeof bootstrapAccountSettingsContext>> | undefined;
  if (options.accountActionCredentials) {
    await writeCredentialsTokenOnly(options.accountActionCredentials);
    await writeStoredCredentialsForServerId(serverId, options.accountActionCredentials);
    accountActionCredentials = await readStoredCredentialsForServerId(serverId) ?? undefined;
    if (!accountActionCredentials) throw new Error('Missing canonical Account Action credentials');
    // Account decisions have their own admitted policy lifetime; retiring a
    // Session requester must not withdraw this separately authenticated ingress.
    accountActionSettings = await bootstrapAccountSettingsContext({ credentials: accountActionCredentials,
      mode: 'blocking', refresh: 'force', publication: 'invocation', expectedAccountEncryptionMode: 'plain' });
  }
  const cwd = join(f.directory, 'accepted-project');
  await mkdir(join(cwd, '.happier'), { recursive: true });
  await writeFile(join(cwd, '.happier/project.json'), JSON.stringify({ version: 1,
    toolchain: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' } }));
  await writeFile(join(cwd, 'mise.toml'), '[env]\nNATIVE = "active"\n');
  let trust: ProjectTrustContentV1 | null = null;
  let trustWrites = 0;
  const accountReads: unknown[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, requestOptions) => {
    const promptRow = new URL(String(url)).pathname.match(/^\/v1\/account\/entity-rows\/prompt-library\/([^/]+)$/u);
    if (promptRow) return { status: 200, data: f.mutatePromptLibraryRow(decodeURIComponent(promptRow[1]), body) };
    const availability = readBundledPluginAvailabilityHttpFixture(new URL(String(url)).pathname, body);
    if (availability) return { status: 200, data: availability };
    if (String(url).endsWith('/v1/machines/machine/admission/verify')) {
      if (!body || typeof body !== 'object' || !('context' in body) || !('proof' in body)) throw new Error('Missing requester admission proof');
      // Home HTTP is the boundary; custody uses the real signer and proof verifier.
      const context = SocketRpcMachineAdmissionContextV1Schema.parse(body.context);
      const proof = MachineInstallationProofV1Schema.parse(body.proof);
      const purpose = 'purpose' in body ? { purpose: RequesterSessionCurrentnessPurposeV1Schema.parse(body.purpose) }
        : 'method' in body && typeof body.method === 'string'
          && (body.method === `machine:${RPC_METHODS.DAEMON_PROJECTS_PREPARE}`
            || options.machineRpcMethods?.some(method => body.method === `machine:${method}`))
          ? { method: body.method } : null;
      const custodianAccountId = options.machineAccess?.custodianAccountId ?? 'requester';
      const valid = purpose !== null && context.actorAccountId === 'requester'
        && context.custodianAccountId === custodianAccountId
        && context.role === (options.machineAccess?.role ?? 'manage')
        && verifyMachineInstallationProof({ publicKey: f.installation.publicKey,
        proof, payload: {
          version: 1, accountId: custodianAccountId, machineId: 'machine', installationId: f.installation.installationId,
          rpcAdmission: { context, ...purpose } } });
      return { status: valid && f.isHomeCurrent() ? 200 : 403, data: valid && f.isHomeCurrent() ? { v: 1, ok: true } : { error: 'access_denied' } };
    }
    accountReads.push(requestOptions?.headers?.Authorization);
    if (String(url).endsWith('/project-trust/read')) {
      if (String(requestOptions?.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER] ?? '').startsWith('execution.run.')) {
        return { status: 403, data: { error: 'forbidden' } };
      }
      const project = ProjectTrustReadRequestV1Schema.parse(body).project;
      return { status: 200, data: trust?.t === 'plain' && trust.v.project.projectId === project.projectId
        ? { status: 'present', revision: 1, content: trust } : { status: 'absent' } };
    }
    if (String(url).endsWith('/project-trust/mutate')) {
      trustWrites++;
      trust = ProjectTrustMutationRequestV1Schema.parse(body).content;
      return { status: 200, data: { status: 'updated', revision: 1, cursor: 1 } };
    }
    if (String(url).endsWith('/project-rows/list') || String(url).endsWith('/project-rows/read')) {
      // Account topology is read with the admitted requester's bearer. A signed
      // execution root alone does not authorize this Account-private endpoint.
      if (requestOptions?.headers?.Authorization !== `Bearer ${f.bootstrap.credentials.token}`
        && (!accountActionCredentials || requestOptions?.headers?.Authorization !== `Bearer ${accountActionCredentials.token}`)) {
        return { status: 403, data: { error: 'forbidden' } };
      }
      const key = { kind: 'workspace-ref', serverId, id: 'workspace' } as const;
      const row = { key, revision: 1,
        content: { t: 'plain', v: { key, value: { id: 'workspace', serverId, machineId: 'machine',
          rootPath: cwd, projectKey: 'project', createdAtMs: 1 } } } };
      if (String(url).endsWith('/project-rows/read')) {
        const request = ProjectAccountRowReadRequestV1Schema.parse(body);
        return { status: 200, data: ProjectAccountRowReadResponseV1Schema.parse(
          request.key.kind === key.kind && request.key.serverId === key.serverId && request.key.id === key.id
            ? { status: 'present', row } : { status: 'absent' }) };
      }
      const request = ProjectAccountRowListRequestV1Schema.parse(body);
      const selected = (!request.serverId || request.serverId === key.serverId)
        && (!request.kinds || request.kinds.includes(key.kind));
      return { status: 200, data: ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: selected ? [row] : [] }) };
    }
    throw new Error(`Unexpected Home write: ${new URL(String(url)).pathname}`);
  });
  let nativeEffects = 0;
  // Installed-tool discovery and evaluation are OS boundaries; this fixture
  // does not characterize a real Mise distribution. Account and launch owners stay real.
  const resolveTool = async () => ({ executablePath: '/tools/mise', version: '2026.10.4' });
  const environmentIo: ProjectNativeToolchainIoForHost = {
    resolveTool,
    async run() { nativeEffects++; return { exitCode: 0, stdout: 'PATH=/native/bin\0NATIVE=active\0' }; },
    createInvocation: () => environmentIo,
  };
  const admission = createProjectWorkerAdmission({ machineId: 'machine', admissionDrain: createDaemonAdmissionDrain(),
    readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: 1 }, source: 'default', metadataVersion: 1 }) });
  const finite = createInstalledProjectFiniteRuntime({ api: await ApiClient.create(accountActionCredentials ?? f.bootstrap.credentials),
    credentials: accountActionCredentials ?? { token: 'custodian-token', encryption: null },
    externalActionAccountId: options.accountActionCredentials ? 'requester' : 'custodian',
    finiteServerId: serverId, finiteServerHttpBaseUrl: 'https://session-home.test', registeredMachineId: 'machine',
    admission,
    nativeIo: { commandIo: { resolveTool }, environmentIo },
    successHomeDir: join(f.directory, 'success'), isCurrent: async () => !accountActionCredentials
      || sameStoredCredentials(accountActionCredentials, await readStoredCredentialsForServerId(serverId)),
    prepareBetween: async () => { throw new Error('No worker routing expected'); },
    resolveCurrentMachineExecutionOriginContext: options.resolveCurrentMachineExecutionOriginContext ?? (async () => null) });
  const machine = new ApiMachineClient(accountActionCredentials?.token ?? 'custodian-token', { id: 'machine', encryptionMode: 'plain',
    dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 },
    undefined, { createProjectFiniteRuntime: finite,
      resolveCurrentServerIdentityId: () => options.homeServerIdentityId ?? null });
  machine.setRPCHandlers({ spawnSession: async () => { throw new Error('No replacement Session expected'); },
    stopSession: async () => true, requestShutdown() {} }, options.accountActionCredentials ? {
      actionsSettingsProvider: createActionSettingsProvider({ allowEnvironmentOverride: false,
        scopeKey: accountActionSettings?.scopeKey,
        getAccountSettings: () => accountActionSettings?.settings ?? null }),
    } : undefined);
  onTestFinished(() => machine.shutdown());
  const signal: AbortSignal = new AbortController().signal;
  if (options.prepareProject !== false) {
    const runtime = await machine.resolveProjectFiniteRuntime({ signal, requesterSessionBootstrap: f.bootstrap });
    if (!runtime) throw new Error('Missing installed requester Project runtime');
    const reviewed = await prepareProjectAgentLaunch({ cwd, machineId: 'machine', serverId, serverHttpBaseUrl: 'https://session-home.test',
      account: projectRuntimeAccountRowsInput(runtime), nativeIo: runtime.nativeIo, successHomeDir: runtime.successHomeDir,
      platform: { os: 'linux', arch: 'x64' }, signal });
    if (reviewed.kind !== 'prepared') throw new Error(`Project review failed: ${JSON.stringify(reviewed)}`);
    await createProjectSetupTrustClient({ credentials: f.bootstrap.credentials, serverHttpBaseUrl: 'https://session-home.test' })
      .approveReviewedEffect({ project: reviewed.outcome.plan.project, expectedRevision: 'absent', authority: 'present_user',
        reviewedEffectDigest: reviewed.outcome.plan.reviewedEffectDigest, currentEffectDigest: reviewed.outcome.plan.reviewedEffectDigest, approvedAtMs: 1 });
  }
  return { f, cwd, machine, finite, signal, admission, installedCredentials: accountActionCredentials,
    nativeEffects: () => nativeEffects, accountReads: () => [...accountReads],
    trustWrites: () => trustWrites,
    async requireSetup(command = 'printf setup') {
      trust = null;
      await writeFile(join(cwd, '.happier/project.json'), JSON.stringify({ version: 1,
        toolchain: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' },
        workspace: { setup: [{ kind: 'command', command }] } }));
    },
  };
}

