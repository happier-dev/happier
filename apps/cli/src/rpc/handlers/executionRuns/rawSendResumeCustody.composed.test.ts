import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { ActionId } from '@happier-dev/protocol/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import { createExecutionRunAccountSettingsSnapshotResolver } from '@/api/machine/resolveExecutionRunAccountSettingsSnapshot';
import { reloadConfiguration } from '@/configuration';
import { createProjectSessionRuntimeFixture } from '@/daemon/testkit/projectSessionRuntimeFixture';
import { prepareRequesterAccountActionContext, readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import type { ExecutionRunProjectLaunchContext } from '@/agent/runtime/registry/engineRegistryTypes';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { buildActionExecutorContextForRpc } from '../_actionDispatchAdapter';
import { createExecutionRunRpcActionExecutor } from './dispatchExecutionRunRpcAction';

// COORD-PROVE-RAW-SEND-RESUME-CUSTODY-2-1125 (SEC-COORD-OPUS-1125D P1-1).
// Real: the Machine-scope execution-run executor, requester scoping, retained Run storage
// and recovery, the bridge's send/ensure/resume owners, and the production Account
// snapshot resolver apiMachine.ts installs (createExecutionRunAccountSettingsSnapshotResolver).
// Boundary: the Machine's stored-credential port (readCredentials) is a recording fake
// holding the custodian's sign-in, and runtime creation is observed then stopped (no
// provider process is spawned) so the test asserts on the objects handed to the launch.
describe('raw execution.run.send resume custody (guest on owner Machine, isolation off)', () => {
  let directory: string;
  let manager: ExecutionRunHostBridge;
  const custodianCredentials = { token: 'custodian-stored-token', encryption: null };
  let credentialReads = 0;
  let baseResolver: ReturnType<typeof createExecutionRunAccountSettingsSnapshotResolver>;
  let launches: Array<{ runId?: string; resolver: unknown; projectLaunchContext?: ExecutionRunProjectLaunchContext }>;
  const attribution = (accountId: string) => ({ serverId: 'home', accountId, machineId: 'machine', installationId: 'installation' });

  const retained = (runId: string, accountId: string, runClass: 'bounded' | 'long_lived'): ExecutionRunState => ({
    runId, callId: `${runId}-call`, sidechainId: `${runId}-sidechain`, sessionId: null,
    depth: 0, intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
    instructions: `Private ${accountId} instructions`, permissionMode: 'read_only', retentionPolicy: 'resumable',
    runClass, ioMode: runClass === 'bounded' ? 'request_response' : 'streaming', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
    resumeHandle: { kind: 'provider_session.v1', backendTarget: readBackendTargetRefV2({ kind: 'builtInAgent', agentId: 'codex' }),
      providerSessionId: `${runId}-provider-session` },
    requesterWorkAttributionV1: attribution(accountId),
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'happier-raw-send-resume-'));
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    reloadConfiguration();
    credentialReads = 0;
    launches = [];
    // The resolver apiMachine.ts:2396 installs; readCredentials is the Machine's stored sign-in (the custodian 'alice').
    baseResolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'machine', serverHttpBaseUrl: 'https://home.test',
      readCredentials: async () => { credentialReads++; return custodianCredentials; }, isOwnerCurrent: () => true,
      readHostAgentExecutionContext: async () => null, onSettings: () => {} });
    for (const runClass of ['bounded', 'long_lived'] as const) {
      await retainExecutionRunState(retained(`alice-${runClass}`, 'alice', runClass));
      // Not creatable today (Start is custodian_only at Home); the row the pending guest Start would retain.
      await retainExecutionRunState(retained(`bob-${runClass}`, 'bob', runClass));
    }
    manager = new ExecutionRunHostBridge({ parentProvider: 'daemon.executionRuns', cwd: directory, sendAcp: async () => {},
      runtimeAccountId: 'alice', machineId: 'machine', resolveAccountSettingsSnapshot: baseResolver });
    const bridge = manager as unknown as { createExecutionRunRuntime(opts: Record<string, unknown>): unknown };
    vi.spyOn(bridge, 'createExecutionRunRuntime').mockImplementation(opts => {
      launches.push({ runId: opts.runId as string | undefined, resolver: opts.resolveAccountSettingsSnapshot,
        projectLaunchContext: opts.projectLaunchContext as ExecutionRunProjectLaunchContext | undefined });
      throw new Error('launch boundary observed');
    });
  });

  afterEach(async () => {
    await manager?.dispose();
    await baseResolver?.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    reloadConfiguration();
    await rm(directory, { recursive: true, force: true });
  });

  // Exactly what Home forwards for a raw call it admitted: admission context only,
  // no callerInputAuthorization, no requesterSessionBootstrap.
  const raw = (actorAccountId: string, role: 'use' | 'manage') => buildActionExecutorContextForRpc({
    serverId: 'home', callerAuthority: 'present_user', localActionContext: { surface: 'rpc' },
    machineAdmission: { actorAccountId, custodianAccountId: 'alice', machineId: 'machine',
      installationId: 'installation', role, encryptionMode: 'plain' },
  } as Parameters<typeof buildActionExecutorContextForRpc>[0]);

  const executor = (projectLaunchContext?: ExecutionRunProjectLaunchContext) => createExecutionRunRpcActionExecutor({
    manager, context: { sessionId: null, cwd: directory, serverId: 'home', projectLaunchContext },
    policy: resolveExecutionRunPolicy({ defaults: { boundedTimeoutMs: null, reviewBoundedTimeoutMs: null, maxTurns: null } }),
    isExecutionRunsEnabled: () => true });

  const call = async (actionId: ActionId, input: Record<string, unknown>, ctx: ReturnType<typeof raw>) => {
    const request = { sessionId: null, ...input };
    getActionSpec(actionId).inputSchema.parse(request);
    return await executor().execute(actionId, request, ctx);
  };

  it.each(['bounded', 'long_lived'] as const)('(1) owner control: the custodian cold-resumes their own %s Run under the base resolver', async runClass => {
    const result = await call('execution.run.send', { runId: `alice-${runClass}`, message: 'Owner resume', localInputId: `owner-${runClass}`, resume: true }, raw('alice', 'manage'));
    expect(launches, JSON.stringify(result)).toHaveLength(1);
    expect(launches[0]).toMatchObject({ runId: `alice-${runClass}`, projectLaunchContext: undefined });
    expect(launches[0]!.resolver).toBe(baseResolver);
  });

  it.each(['bounded', 'long_lived'] as const)('(2) a Use guest\'s raw resume of their own %s Run never launches under the custodian\'s Account', async runClass => {
    const result = await call('execution.run.send', { runId: `bob-${runClass}`, message: 'Guest resume', localInputId: `guest-${runClass}`, resume: true }, raw('bob', 'use'));
    const observed = { result, launches: launches.map(l => ({ runId: l.runId, baseResolver: l.resolver === baseResolver,
      projectLaunchContext: l.projectLaunchContext === undefined ? 'absent' : 'present' })) };
    // Evidence of what the base resolver hands the launch: it reads the Machine's stored sign-in.
    if (launches[0]?.resolver === baseResolver) {
      await (launches[0].resolver as typeof baseResolver)().catch(() => {});
      Object.assign(observed, { custodianCredentialReads: credentialReads });
    }
    // Contract: without retained requester custody a non-custodian cold resume is refused
    // with a typed cause and nothing is handed to a native launch.
    expect(observed.launches, JSON.stringify(observed)).toEqual([]);
    expect(result, JSON.stringify(observed)).toMatchObject({ ok: false,
      errorCode: 'provider_authorization_changed', error: 'requester_not_current' });
    expect(credentialReads).toBe(0);
  });

  it.each(['bounded', 'long_lived'] as const)('(3) a guest raw resume of the owner %s Run is execution_run_not_found', async runClass => {
    const result = await call('execution.run.send', { runId: `alice-${runClass}`, message: 'Foreign', localInputId: `foreign-${runClass}`, resume: true }, raw('bob', 'use'));
    expect(result).toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
    expect(launches).toEqual([]);
  });

  it.each(['bounded', 'long_lived'] as const)('(5) after the installed Account changes, the new custodian cannot reach the previous Account\'s %s Run', async runClass => {
    // Restart under a different sign-in: Run records stay on the Machine home, scoped by their recorded requester.
    await manager.dispose();
    manager = new ExecutionRunHostBridge({ parentProvider: 'daemon.executionRuns', cwd: directory, sendAcp: async () => {},
      runtimeAccountId: 'bob', machineId: 'machine', resolveAccountSettingsSnapshot: baseResolver });
    vi.spyOn(manager as unknown as { createExecutionRunRuntime(opts: Record<string, unknown>): unknown }, 'createExecutionRunRuntime')
      .mockImplementation(opts => { launches.push({ runId: opts.runId as string | undefined, resolver: opts.resolveAccountSettingsSnapshot });
        throw new Error('launch boundary observed'); });
    const newCustodian = buildActionExecutorContextForRpc({
      serverId: 'home', callerAuthority: 'present_user', localActionContext: { surface: 'rpc' },
      machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'bob', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
    } as Parameters<typeof buildActionExecutorContextForRpc>[0]);
    for (const actionId of ['execution.run.send', 'execution.run.ensure'] as const) {
      const result = await call(actionId, { runId: `alice-${runClass}`, resume: true,
        ...(actionId === 'execution.run.send' ? { message: 'After switch', localInputId: `switch-${runClass}` } : {}) }, newCustodian);
      expect(result, actionId).toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
    }
    expect(launches).toEqual([]);
    expect(credentialReads).toBe(0);
  });

  it('(4a) a guest raw send without resume to their cold Run launches nothing', async () => {
    const result = await call('execution.run.send', { runId: 'bob-bounded', message: 'No resume', localInputId: 'guest-plain' }, raw('bob', 'use'));
    expect(result).toMatchObject({ ok: false });
    expect(launches).toEqual([]);
  });

  it.each([
    { actionId: 'execution.run.ensure', input: { resume: true } },
    { actionId: 'execution.run.ensure_or_start', input: { resume: true } },
  ] satisfies ReadonlyArray<{ actionId: ActionId; input: Record<string, unknown> }>)('(4b) daemon-side $actionId for a guest long-lived Run (Home refuses it custodian_only)', async ({ actionId, input }) => {
    const result = await call(actionId, { runId: 'bob-long_lived', ...input }, raw('bob', 'use'));
    const observed = { result, launches: launches.map(l => ({ runId: l.runId, baseResolver: l.resolver === baseResolver })) };
    expect(observed.launches, JSON.stringify(observed)).toEqual([]);
    expect(result).toMatchObject({ ok: false, errorCode: 'provider_authorization_changed', error: 'requester_not_current' });
    expect(credentialReads).toBe(0);
  });
  it('retains the signed guest requester for the cold launch and releases it on a launch refusal', async () => {
    const home = await createProjectSessionRuntimeFixture({ accountId: 'bob', serverId: 'home',
      homeServerIdentityId: 'srv_resume_home', serverUrl: 'https://home.test',
      machineAccess: { custodianAccountId: 'alice', role: 'use' } });
    await retainExecutionRunState({ ...retained('bob-long_lived', 'bob', 'long_lived'),
      requesterWorkAttributionV1: { ...attribution('bob'), installationId: home.installation.installationId } });
    const binding = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'resume-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'srv_resume_home', machineId: 'machine',
      installationId: home.installation.installationId, actionId: 'execution.run.send', requestId: randomUUID(),
      requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
    } });
    const purpose = { kind: 'external_action' } as const;
    const credentials = home.bootstrap.credentials;
    const authorization = sealExternalActionRequesterAccountContextV1({ authorization: binding, purpose,
      credentials: { token: credentials.token, encryption: null },
      installationPublicKey: Buffer.from(home.installation.publicKey, 'base64url'), randomBytes: nacl.randomBytes });
    const ingress = new AbortController();
    const current = async () => home.isHomeCurrent();
    const requester = await prepareRequesterAccountActionContext({ authorization, purpose,
      machineId: 'machine', installationId: home.installation.installationId,
      installationPrivateKey: Buffer.from(home.installation.privateKey, 'base64url'),
      serverId: 'home', serverIdentityId: 'srv_resume_home', serverHttpBaseUrl: 'https://home.test',
      signal: ingress.signal, isCurrent: current, isCustodyCurrent: current, isRetainedCustodyCurrent: current,
      createExecutor: () => ({ execute: async () => { throw new Error('No requester Action expected'); } }) });
    if (!requester) throw new Error('Missing signed requester fixture');
    const rpcContext = { signal: ingress.signal, callerInputAuthorization: requester.authorization,
      machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
        installationId: home.installation.installationId, role: 'use', encryptionMode: 'plain' } as const };
    try {
      const result = await executor({ ingress: rpcContext, isCurrent: current,
        resolveRuntime: async () => { throw new Error('Launch intercepted before Project open'); } }).execute('execution.run.send',
        { sessionId: null, runId: 'bob-long_lived', message: 'Signed resume', localInputId: 'signed-resume', resume: true },
        buildActionExecutorContextForRpc({ ...rpcContext, serverId: 'home', callerAuthority: 'present_user' }));
      expect(result).toMatchObject({ ok: false, error: 'launch boundary observed' });
      expect(launches).toHaveLength(1);
      expect(launches[0]?.resolver).not.toBe(baseResolver);
      const lifetime = launches[0]?.projectLaunchContext?.forRunLifetime?.(new AbortController().signal);
      const account = readRequesterAccountActionContext(lifetime?.ingress?.callerInputAuthorization);
      expect(account?.authorization.binding.accountId).toBe('bob');
      expect(await account?.isCurrent()).toBe(false);
      expect(credentialReads).toBe(0);
    } finally {
      await requester.dispose();
    }
  });

});
