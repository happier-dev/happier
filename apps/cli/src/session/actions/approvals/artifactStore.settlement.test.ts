import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

import {
  API_TOKEN_FULL_GRANT_V1,
  ApprovalRequestV1Schema,
  ApprovalRequestV2Schema,
  ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES,
  createActionExecutor,
  createBlockingApprovalCoordinator,
  decodePlainArtifactStoredContent,
  encodePlainArtifactStoredContent,
  type ActionExecutorDeps,
  type ActionExecutorContext,
  type ApprovalRequest,
} from '@happier-dev/protocol';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';

import { createCliApprovalsArtifactStore } from './artifactStore';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createLocalServiceActionConfirmationNonceV1, LocalServiceActionResultV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createLocalServiceActionRoutes } from '@/daemon/local/services/actions/routes';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import { createLocalServicesDaemonFeatureGate } from '@/daemon/local/services/featureGate';
import { createLocalServicesDaemonRuntimeActionExecutor } from '@/daemon/local/services/actions/runtimeActionExecutor';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { authorizeResolvedProjectExecLaunchForHost, createProjectNativeEnvironmentIoForHost } from '@/plugins/runtime/invocation/services/exec';

// Only the Account server's HTTP boundary is replaced. The real Action executor,
// the real approval Artifact store and its codecs, and the server's versioned
// Artifact CAS contract (expected header/body versions) run over in-memory rows.
const http = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  request: vi.fn(),
  beforeUpdate: null as null | ((id: string) => void),
  failNextUpdateWith: null as null | Error,
  failNextUpdateStatus: null as null | number,
  loseNextUpdateResponse: false as boolean | ((id: string) => void),
}));
vi.mock('axios', async importOriginal => ({ default: {
  ...(await importOriginal<typeof import('axios')>()).default,
  get: http.get, post: http.post, request: http.request,
} }));
vi.mock('@/configuration', () => ({ configuration: {
  apiServerUrl: 'http://approval-settlement.invalid',
  activeServerId: 'home-1',
  activeServerDir: '/tmp/happier-cli-approval-settlement-test',
  happyHomeDir: '/tmp/happier-cli-approval-settlement-test',
} }));

const rows = new Map<string, Record<string, unknown>>();

beforeEach(() => {
  rows.clear();
  http.beforeUpdate = null;
  http.failNextUpdateWith = null;
  http.failNextUpdateStatus = null;
  http.loseNextUpdateResponse = false;
  http.get.mockReset();
  http.post.mockReset();
  http.request.mockReset();
  http.get.mockImplementation(async (url: string) => {
    const id = url.split('/').at(-1)!;
    return { status: rows.has(id) ? 200 : 404, data: rows.get(id) };
  });
  http.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
    if (url.endsWith('/v1/artifacts')) {
      rows.set(String(body.id), { ...body, ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    }
    const id = url.split('/').at(-1)!;
    http.beforeUpdate?.(id);
    if (http.failNextUpdateWith) {
      const error = http.failNextUpdateWith;
      http.failNextUpdateWith = null;
      throw error;
    }
    if (http.failNextUpdateStatus !== null) {
      const status = http.failNextUpdateStatus;
      http.failNextUpdateStatus = null;
      return { status, data: { error: 'upstream_error' } };
    }
    const existing = rows.get(id)!;
    const headerMatches = body.expectedHeaderVersion === undefined || body.expectedHeaderVersion === existing.headerVersion;
    const bodyMatches = body.expectedBodyVersion === undefined || body.expectedBodyVersion === existing.bodyVersion;
    if (!headerMatches || !bodyMatches) {
      return { status: 200, data: { success: false, error: 'version-mismatch' } };
    }
    const headerVersion = Number(existing.headerVersion) + (body.header === undefined ? 0 : 1);
    const bodyVersion = Number(existing.bodyVersion) + (body.body === undefined ? 0 : 1);
    rows.set(id, {
      ...existing,
      ...(body.header === undefined ? {} : { header: body.header }),
      ...(body.body === undefined ? {} : { body: body.body }),
      headerVersion,
      bodyVersion,
    });
    if (http.loseNextUpdateResponse) {
      const alterReceipt = http.loseNextUpdateResponse;
      http.loseNextUpdateResponse = false;
      if (typeof alterReceipt === 'function') alterReceipt(id);
      throw Object.assign(new Error('Committed update response was lost'), { code: 'ECONNRESET' });
    }
    return { status: 200, data: { success: true, headerVersion, bodyVersion } };
  });
});

function createStore() {
  return createCliApprovalsArtifactStore({
    credentials: { token: 'synthetic-token', encryption: null } as never,
    getAccountEncryptionMode: async () => 'plain',
  });
}

const PROVIDER_SECRET = 'synthetic-provider-client-secret';
const providerSecretInput = {
  owner: { kind: 'home' as const },
  id: 'provider-1',
  expectedRevision: 3,
  clientSecret: PROVIDER_SECRET,
};

const SAVED_SECRET_CIPHERTEXT = Buffer.alloc(40, 7).toString('base64');
const savedSecretInput = {
  resourceId: 'secret-1',
  displayName: 'Synthetic token',
  kind: 'token',
  encryptionMode: 'e2ee',
  storedContent: { t: 'encrypted', c: SAVED_SECRET_CIPHERTEXT },
  accountGrants: ['account-2'],
  teamGrants: [],
  groupGrants: [],
  keyEnvelopes: [{
    recipientAccountId: 'account-2',
    encryptedDataKey: Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, 3).toString('base64'),
    recipientContentPublicKeyFingerprint: 'content-key:v1:account-2',
  }],
};

const uiContext = {
  surface: 'ui' as const,
  authority: 'present_user' as const,
  serverId: 'home-1',
  runtimeAccountId: 'account-1',
  actionRequestId: 'settlement-1',
  actionCaller: { kind: 'host' as const },
};

function createExecutor(
  store: ReturnType<typeof createStore>,
  overrides: Partial<ActionExecutorDeps> = {},
) {
  return createActionExecutor({
    ...store,
    isApprovalExecutionOriginCurrent: async () => true,
    isActionApprovalRequired: (id) => id === 'identity.providers.secret.replace' || id === 'secrets.shared.create',
    ...overrides,
  } as ActionExecutorDeps);
}

async function createDeferred(
  executor: ReturnType<typeof createExecutor>,
  actionId: 'identity.providers.secret.replace' | 'secrets.shared.create',
  input: unknown,
): Promise<string> {
  const created = await executor.execute(actionId, input, uiContext);
  expect(created).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  const artifactId = String((created as { result: { artifactId: string } }).result.artifactId);
  // Deferred replay still needs the admitted operands while the request is pending.
  expect(storedBody(artifactId)).toContain(
    actionId === 'secrets.shared.create' ? SAVED_SECRET_CIPHERTEXT : PROVIDER_SECRET,
  );
  return artifactId;
}

/** Everything the Account server durably holds for this Artifact, decoded. */
function storedBody(artifactId: string): string {
  const row = rows.get(artifactId);
  if (!row) throw new Error(`missing artifact row ${artifactId}`);
  const decode = (value: unknown) => typeof value === 'string' ? decodePlainArtifactStoredContent(value) : null;
  const decoded = { header: decode(row.header), body: decode(row.body) };
  if (decoded.header === null || decoded.body === null) throw new Error('undecodable plain artifact row');
  return JSON.stringify(decoded);
}

describe('approval settlement through the real CLI Artifact store', () => {
  it.each([
    { decision: 'approve', rollbackAt: 'decision' },
    { decision: 'reject', rollbackAt: 'decision' },
    { decision: 'cancel', rollbackAt: 'decision' },
    { decision: 'approve', rollbackAt: 'effect' },
  ] as const)('settles $decision when the wall clock moves backwards at $rollbackAt', async ({ decision, rollbackAt }) => {
    // Clock and Home HTTP are the only controlled boundaries. The real
    // executor, transition owner, Artifact codecs and versioned CAS stay live.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(20_000);
    try {
      const store = createStore();
      let deleteCount = 0;
      http.request.mockImplementation(async ({ method, url }: { method: string; url: string }) => {
        expect(method).toBe('DELETE');
        expect(url).toBe('http://approval-settlement.invalid/v1/sessions/clock-session');
        deleteCount += 1;
        if (rollbackAt === 'effect') clock.mockReturnValue(10_000);
        return { status: 200, data: { success: true } };
      });
      const executor = createExecutor(store, {
        isActionApprovalRequired: actionId => actionId === 'session.delete',
        homeDomainAction: createAccountServerActionDeps({ token: 'synthetic-token', serverId: 'home-1',
          serverHttpBaseUrl: 'http://approval-settlement.invalid' }).homeDomainAction,
      });
      const context = { ...uiContext, surface: 'cli' as const, defaultSessionId: 'clock-session' };
      const created = await executor.execute('session.delete', { sessionId: 'clock-session' }, context);
      expect(created).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const { artifactId } = ActionApprovalRequestCreatedResultSchema.parse(created.ok ? created.result : null);
      if (rollbackAt === 'decision') clock.mockReturnValue(10_000);
      const decided = await executor.execute('approval.request.decide', { artifactId, decision }, context);
      const status = decision === 'approve' ? 'executed' : decision === 'reject' ? 'rejected' : 'canceled';
      expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status } });
      expect(await store.approvalsGet({ artifactId, serverId: null })).toMatchObject({ status, updatedAtMs: 20_000 });
      if (decision === 'approve') {
        expect(await executor.execute('approval.request.decide', { artifactId, decision }, context))
          .toMatchObject({ ok: true, result: { status: 'executed' } });
      }
      expect(deleteCount).toBe(decision === 'approve' ? 1 : 0);
    } finally { clock.mockRestore(); }
  });

  it('uses one fresh Artifact read for transition validation and its revision-fenced update', async () => {
    const store = createStore();
    const executor = createExecutor(store, { homeDomainAction: async () => ({}) });
    const artifactId = await createDeferred(executor, 'identity.providers.secret.replace', providerSecretInput);
    const open = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId, serverId: null }));
    http.get.mockClear();
    const result = await store.approvalsUpdate({ artifactId, serverId: null, request: {
      ...open, status: 'approved', updatedAtMs: open.updatedAtMs + 1,
      decision: { kind: 'approve', decidedAtMs: open.updatedAtMs + 1 },
    } });
    expect(result).toEqual({ ok: true });
    expect(storedBody(artifactId)).toContain('approved');
    // This count is the performance contract: validation and sealing must
    // consume the same fresh row, while the write retains its revision CAS.
    expect(http.get.mock.calls.filter(([url]) => String(url).endsWith(`/v1/artifacts/${artifactId}`))).toHaveLength(1);
  });

  it.each(['succeeded', 'failed_after_admission', 'materialization_failed', 'rejected'] as const)(
    'retains the admitted requester and actual personal and Team credential uses when the effect is %s',
    async outcome => {
      const store = createStore();
      const personalService = { pluginId: 'example.credentials', localId: 'personal' };
      const teamService = { pluginId: 'example.credentials', localId: 'team' };
      const consumer = { pluginId: 'example.worker', localId: 'publish' };
      const personalPurpose = { consumer, purpose: 'personal-write' };
      const teamPurpose = { consumer, purpose: 'team-write' };
      const personalAccount = { service: personalService, accountId: 'personal-profile' };
      const teamAccount = { service: teamService, accountId: 'team-source-member' };
      const materialized: string[] = [];
      const owner = createConnectedAccountPurposeBindingOwner({
        credentialOwnerAccountId: 'account-1',
        // The persisted catalog is empty: only this exact operation's admitted
        // bindings may select material. The real binding owner enforces them.
        store: {
          read: async () => ({ v: 1, bindings: [] }),
          update: async () => { throw new Error('An operation cannot change saved credential selection'); },
          subscribe: () => ({ dispose() {} }),
        },
        selectTarget: async () => { throw new Error('An approval cannot prompt for another credential'); },
        resolveTarget: async target => target.kind === 'account'
          ? { account: target.account, displayName: target.account.accountId === personalAccount.accountId
              ? 'Personal release account' : 'Disclosed Team member' }
          : null,
        materializeAccount: async ({ account }) => {
          materialized.push(account.accountId);
          if (outcome === 'materialization_failed') throw new Error('Credential unavailable');
          return { kind: 'environment', env: { PERSONAL_TOKEN: 'private-personal-material' } };
        },
        materializeTeamDirect: async ({ account, captureAdmittedResource }) => {
          materialized.push(account.accountId);
          captureAdmittedResource?.({ teamId: 'release-team', displayName: 'Team release account', resourceRevision: 7 });
          return { kind: 'environment', env: { TEAM_TOKEN: 'private-team-material' } };
        },
        projectTargetAccounts: async () => { throw new Error('No credential listing is requested'); },
        assertTargetAccountMaterializable: async () => { throw new Error('No listed-account selection is requested'); },
      });
      const input = { sessionId: 'release-bot', message: 'Publish the approved release' };
      const attribution = { requestRef: 'original-input', requester: { serverId: 'home-1', accountId: 'account-1' },
        persona: { serverId: 'home-1', sessionId: input.sessionId }, origin: null };
      const context: ActionExecutorContext = { ...uiContext, defaultSessionId: input.sessionId,
        actionRequestAttributionV1: attribution };
      let effects = 0;
      const executor = createExecutor(store, {
        isActionApprovalRequired: id => id === 'session.message.send',
        // Session transport is the external effect boundary. Credential choice,
        // exact lease admission and receipt production all run their real owners.
        sessionSendMessage: async ({ context: admitted }) => {
          const lease = owner.activatePurposeBindings({
            subject: { kind: 'operation', operationId: 'credential-effect-1', consumer,
              sessionId: input.sessionId, isCurrent: () => true },
            purposes: [personalPurpose, teamPurpose],
            bindings: [{ purpose: personalPurpose, target: { kind: 'account', account: personalAccount } },
              { purpose: teamPurpose, target: { kind: 'account', account: teamAccount } }],
            directMaterialOrigins: [{ purpose: teamPurpose, resourceId: 'private-resource-id', disclosedMember: teamAccount }],
            recordOperationCredentialUse: admitted.recordOperationCredentialUse,
          });
          try {
            for (const [purpose, service, key] of [[personalPurpose, personalService, 'PERSONAL_TOKEN'],
              [teamPurpose, teamService, 'TEAM_TOKEN']] as const) {
              await owner.materialize({ purpose, serviceRefs: [service], exactPurposeBindingSubjectId: lease.subjectId,
                signal: new AbortController().signal,
                request: { kind: 'environment', keys: [key] } });
            }
            expect(admitted.runtimeAccountId).toBe('account-1');
            expect(admitted.actionRequestAttributionV1).toEqual(attribution);
            effects += 1;
            if (outcome === 'failed_after_admission') throw Object.assign(new Error('Remote outcome unavailable'), { code: 'ECONNRESET' });
            return { status: 'accepted', localId: 'effect-result' };
          } finally {
            lease.dispose();
          }
        },
      });
      const created = await executor.execute('session.message.send', input, context);
      expect(created, JSON.stringify(created)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const artifactId = String((created as { result: { artifactId: string } }).result.artifactId);
      const decided = await executor.execute('approval.request.decide', {
        artifactId, decision: outcome === 'rejected' ? 'reject' : 'approve',
      }, uiContext);
      const persisted = await store.approvalsGet({ artifactId, serverId: null });
      expect(persisted).toMatchObject({ status: outcome === 'succeeded' ? 'executed' : outcome === 'rejected' ? 'rejected' : 'failed',
        executionOriginV1: { actionRequestAttributionV1: attribution },
      });
      expect(decided).toMatchObject({ ok: true });
      const uses = [
        { v: 1, kind: 'connected_account', label: 'Personal release account', owner: { kind: 'account', accountId: 'account-1' },
          service: personalService, why: { kind: 'purpose_binding', purpose: personalPurpose, target: 'account' },
          currentness: { kind: 'current_at_materialization' } },
        { v: 1, kind: 'team_resource', label: 'Team release account', owner: { kind: 'team', teamId: 'release-team' },
          service: teamService, why: { kind: 'purpose_binding', purpose: teamPurpose, target: 'account' },
          currentness: { kind: 'current_at_materialization', resourceRevision: 7 } },
      ];
      if (outcome === 'succeeded' || outcome === 'failed_after_admission') {
        expect(materialized).toEqual(['personal-profile', 'team-source-member']);
        expect(effects).toBe(1);
        expect(persisted?.execution).toMatchObject({ operationCredentialUses: uses });
        expect(decided).toMatchObject({ result: { execution: { operationCredentialUses: uses } } });
      } else {
        expect(materialized).toEqual(outcome === 'rejected' ? [] : ['personal-profile']);
        expect(effects).toBe(0);
        expect(persisted?.execution && 'operationCredentialUses' in persisted.execution).toBeFalsy();
        expect(JSON.stringify(decided)).not.toContain('operationCredentialUses');
      }
      for (const privateValue of ['private-personal-material', 'private-team-material', 'private-resource-id']) {
        expect(storedBody(artifactId)).not.toContain(privateValue);
        expect(JSON.stringify(decided)).not.toContain(privateValue);
      }
    },
  );

  it.each(['saved', 'unavailable'] as const)('settles an unavailable Home recheck after the execution claim with its receipt %s', async receipt => {
    const store = createStore();
    let artifactId = '';
    let effects = 0;
    const executor = createExecutor(store, {
      isApprovalExecutionOriginCurrent: async () => {
        const current = artifactId ? await store.approvalsGet({ artifactId, serverId: null }) : null;
        // The Home evidence boundary becomes unavailable only after the real
        // Artifact writer has committed its execution claim.
        if (current?.status === 'executing') {
          if (receipt === 'unavailable') http.beforeUpdate = () => { http.failNextUpdateStatus = 503; };
          throw Object.assign(new Error('Home evidence unavailable'), { code: 'project_requester_home_unavailable' });
        }
        return true;
      },
      homeDomainAction: async () => { effects += 1; return { ok: true }; },
    });
    artifactId = await createDeferred(executor, 'identity.providers.secret.replace', providerSecretInput);
    const deciding = executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, uiContext);
    if (receipt === 'unavailable') {
      await expect(deciding).resolves.toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
      expect(await store.approvalsGet({ artifactId, serverId: null })).toMatchObject({ status: 'executing' });
      expect(effects).toBe(0);
      return;
    }
    await expect(deciding)
      .resolves.toMatchObject({ ok: true, result: { status: 'failed', execution: {
        ok: false, effectAttempted: false, errorCode: 'project_requester_home_unavailable',
      } } });
    expect(await store.approvalsGet({ artifactId, serverId: null })).toMatchObject({ status: 'failed', execution: {
      ok: false, effectAttempted: false, errorCode: 'project_requester_home_unavailable',
    } });
    expect(effects).toBe(0);
    expect(storedBody(artifactId)).not.toContain(PROVIDER_SECRET);
  });

  it.each(['committed', 'server_refused'] as const)(
    'settles Session deletion independently of the deleted Session when the terminal write is %s',
    async terminalWrite => {
      const store = createStore();
      const sessionId = 'deleted-session';
      let sessionExists = true;
      let deleteCount = 0;
      http.request.mockImplementation(async ({ method, url }: { method: string; url: string }) => {
        expect(method).toBe('DELETE');
        expect(url).toBe(`http://approval-settlement.invalid/v1/sessions/${sessionId}`);
        deleteCount += 1;
        sessionExists = false;
        if (terminalWrite === 'server_refused') {
          http.post.mockImplementationOnce(async () => ({ status: 403, data: { error: 'permission_denied' } }));
        }
        return { status: 200, data: { success: true } };
      });
      const executor = createExecutor(store, {
        isActionApprovalRequired: actionId => actionId === 'session.delete',
        homeDomainAction: createAccountServerActionDeps({ token: 'synthetic-token', serverId: 'home-1',
          serverHttpBaseUrl: 'http://approval-settlement.invalid' }).homeDomainAction,
      });
      const context = { ...uiContext, surface: 'cli' as const, defaultSessionId: sessionId };
      const created = await executor.execute('session.delete', { sessionId }, context);
      expect(created).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const artifactId = String((created as { result: { artifactId: string } }).result.artifactId);
      const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context);
      expect(sessionExists).toBe(false);
      expect(deleteCount).toBe(1);
      const persisted = await store.approvalsGet({ artifactId, serverId: null });
      if (terminalWrite === 'committed') {
        expect(decided).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
        expect(persisted).toMatchObject({ status: 'executed', execution: { ok: true, effectAttempted: true,
          result: { success: true } }, createdBy: { sessionId } });
      } else {
        expect(decided).toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
        expect(persisted).toMatchObject({ status: 'executing' });
      }
      const repeated = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context);
      expect(repeated).toMatchObject(terminalWrite === 'committed'
        ? { ok: true, result: { status: 'executed' } }
        : { ok: false, errorCode: 'approval_execution_outcome_unknown' });
      expect(deleteCount).toBe(1);
    },
  );

  it.each(['committed', 'transport_failure', 'pool_unavailable', 'transaction_failed', 'terminal_receipt_lost', 'cas_conflict', 'decision_receipt_lost', 'decision_write_refused', 'different_decision_receipt'] as const)(
    'settles a CLI-origin real managed Stop when its persistence outcome is %s',
    async terminalWrite => {
      const owner = createManagedServicesOwner({
        processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
        dependencies() { throw new Error('Project services do not use Plugin dependencies'); },
        resolveScope() { return null; },
      });
      const workspace = { id: 'stop-workspace', serverId: 'home-1', machineId: 'stop-machine',
        rootPath: process.cwd(), createdAtMs: 1 };
      const declaration = { workspaceRefId: workspace.id, selection: { kind: 'manifest' as const, name: 'worker' } };
      let nativeStopped = false;
      let nativeStopCount = 0;
      const store = createStore();
      const terminalWriteErrors: string[] = [];
      const gate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({
        status: 'ready', features: FeaturesResponseSchema.parse({ features: { localServices: {
          enabled: true, inventory: { enabled: true }, actions: { enabled: true }, managed: { enabled: true },
        } }, capabilities: {} }),
      }) });
      await gate.refresh();
      expect(gate.isEnabled('localServices.actions')).toBe(true);
      expect(gate.isEnabled('localServices.managed')).toBe(true);
      try {
        const handle = await owner.superviseProject({
          workspace, declaration, cwd: workspace.rootPath,
          requester: { serverId: workspace.serverId, accountId: 'account-1',
            machineId: workspace.machineId, installationId: 'stop-installation' },
          serviceId: 'project:stop-workspace:manifest:worker', specIdentity: 'reviewed-stop-worker',
          isCurrent: () => true,
          authorizeLaunch: ({ signal }) => authorizeResolvedProjectExecLaunchForHost({
            signal, assertCurrent() {},
            projectLaunch: { status: 'ready', reviewedEffectDigest: 'reviewed-stop-worker',
              environment: { selection: { kind: 'host' }, root: workspace.rootPath, platform: process.platform,
                io: createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null }) } },
            launch: { command: process.execPath, args: [], cwd: workspace.rootPath, env: {} },
          }),
          processSpec: { mode: { kind: 'native',
            instance: { adapter: { pluginId: 'acme.native', localId: 'worker' }, nativeResourceId: 'stop-fixture' },
            // The only service replacement is native OS/tool inspection and Stop.
            lifecycle: {
              inspect: async () => ({ phase: nativeStopped ? 'stopped' : 'running', readiness: 'not_reported', endpoint: null }),
              stop: async () => {
                nativeStopCount += 1;
                nativeStopped = true;
                if (terminalWrite === 'transport_failure') http.failNextUpdateWith = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
                if (terminalWrite === 'pool_unavailable') http.failNextUpdateStatus = 503;
                if (terminalWrite === 'transaction_failed') http.failNextUpdateStatus = 500;
                if (terminalWrite === 'terminal_receipt_lost') http.loseNextUpdateResponse = true;
                if (terminalWrite === 'cas_conflict') http.beforeUpdate = id => {
                  http.beforeUpdate = null;
                  const row = rows.get(id)!;
                  rows.set(id, { ...row, headerVersion: Number(row.headerVersion) + 1 });
                };
                return { status: 'stopped' };
              },
            },
          } },
        });
        const routes = createLocalServiceActionRoutes({ machineId: workspace.machineId,
          inventoryRegistry: createLocalServiceInventoryRegistry(), projectManagedServices: owner,
          verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request),
        });
        const executor = createExecutor(store, {
          isActionApprovalRequired: id => id === 'localServices.actions.stopManaged',
          runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({ featureGate: gate, routes: { actionRoutes: routes } }),
          approvalsUpdate: async args => {
            const result = await store.approvalsUpdate(args);
            if (!result.ok) terminalWriteErrors.push(result.errorCode);
            return result;
          },
        });
        const request = { requestId: 'stop-settlement', action: 'stop_managed' as const, force: false,
          target: { kind: 'managed_service' as const, managedServiceId: handle.instanceId,
            machineId: workspace.machineId, workspaceId: workspace.id, cwd: workspace.rootPath, declaration } };
        const created = await executor.execute('localServices.actions.stopManaged', {
          ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request),
        }, { ...uiContext, surface: 'cli' });
        expect(created).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        const artifactId = String((created as { result: { artifactId: string } }).result.artifactId);
        const pending = await store.approvalsGet({ artifactId, serverId: null });
        expect(pending).toMatchObject({ status: 'open', executionOriginV1: {
          surface: 'cli', authority: 'present_user', caller: { kind: 'host' },
        } });
        expect(pending?.v === 2 && pending.executionOriginV1.originalActionEnvelope).toBeUndefined();

        if (terminalWrite === 'decision_receipt_lost') http.loseNextUpdateResponse = true;
        if (terminalWrite === 'decision_write_refused') http.failNextUpdateWith = new Error('Write unavailable');
        if (terminalWrite === 'different_decision_receipt') http.loseNextUpdateResponse = id => {
          const row = rows.get(id)!;
          const envelope = decodePlainArtifactStoredContent(String(row.body));
          if (!envelope || typeof envelope !== 'object' || !('body' in envelope) || typeof envelope.body !== 'string')
            throw new Error('Fixture approval body unavailable');
          const approved = ApprovalRequestV2Schema.parse(JSON.parse(envelope.body));
          if (approved.decision?.kind !== 'approve') throw new Error('Fixture decision unavailable');
          rows.set(id, { ...row, body: encodePlainArtifactStoredContent({ body: JSON.stringify({ ...approved,
            decision: { ...approved.decision, decidedAtMs: approved.decision.decidedAtMs + 1 },
          }) }) });
        };
        const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, uiContext);
        const persisted = await store.approvalsGet({ artifactId, serverId: null });
        const settlementDiagnostic = JSON.stringify({ ok: decided.ok,
          errorCode: decided.ok ? undefined : decided.errorCode,
          status: persisted?.status,
          executionError: persisted?.execution?.ok === false ? persisted.execution.errorCode : undefined,
          terminalWriteErrors });
        if (terminalWrite === 'decision_write_refused' || terminalWrite === 'different_decision_receipt') {
          // A changed decision remains a revision conflict; neither it nor a
          // refused consent write authorizes an execution claim.
          expect(decided).toMatchObject({ ok: false, errorCode: terminalWrite === 'different_decision_receipt'
            ? 'version_mismatch' : 'approval_context_unavailable' });
          expect(persisted).toMatchObject({ status: terminalWrite === 'decision_write_refused' ? 'open' : 'approved' });
          expect(persisted?.execution).toBeUndefined();
          expect(nativeStopped).toBe(false);
          expect(nativeStopCount).toBe(0);
          return;
        }
        expect(nativeStopped, settlementDiagnostic).toBe(true);
        expect(nativeStopCount).toBe(1);
        if (terminalWrite !== 'cas_conflict') {
          expect(terminalWriteErrors).toEqual(terminalWrite === 'terminal_receipt_lost' || terminalWrite === 'decision_receipt_lost'
            ? ['version_mismatch'] : []);
          expect(decided).toMatchObject({ ok: true, result: { status: 'executed' } });
          expect(persisted).toMatchObject({ status: 'executed', execution: { ok: true } });
          const output = LocalServiceActionResultV1Schema.parse(persisted?.execution?.ok ? persisted.execution.result : null);
          expect(output).toMatchObject({ action: 'stop_managed', status: 'succeeded' });
          await expect(executor.replayApprovedApprovalRequest({ artifactId }))
            .resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
        } else {
          expect(decided).toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
          expect(persisted).toMatchObject({ status: 'executing' });
          if (terminalWrite === 'cas_conflict') expect(terminalWriteErrors).toEqual(['version_mismatch']);
          await expect(executor.replayApprovedApprovalRequest({ artifactId }))
            .resolves.toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
        }
        expect(nativeStopCount).toBe(1);
      } finally {
        http.beforeUpdate = null;
        http.failNextUpdateWith = null;
        await owner.dispose();
      }
    },
  );

  it('keeps retained V1 history readable at its original Home after fail-closed replay', async () => {
    const store = createStore();
    const request = ApprovalRequestV1Schema.parse({
      v: 1, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'system' }, actionId: 'session.model.set', actionArgs: {},
      summary: 'Change model', serverId: 'legacy-home',
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    const { artifactId } = await store.approvalsCreate({ request, serverId: 'legacy-home' });
    const effect = vi.fn(async () => ({}));
    const executor = createExecutor(store, { sessionModelSet: effect });

    await expect(executor.replayApprovedApprovalRequest({ artifactId }))
      .resolves.toMatchObject({ ok: true, result: { status: 'failed' } });

    const persisted = await store.approvalsGet({ artifactId, serverId: 'legacy-home' });
    expect(persisted).toMatchObject({ v: 1, status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } });
    expect(await store.approvalsGet({ artifactId, serverId: 'other-home' })).toBeNull();
    expect(effect).not.toHaveBeenCalled();
  });

  it('durably rejects a deferred approval and keeps only the declared input projection', async () => {
    const store = createStore();
    const effect = vi.fn(async () => ({}));
    const executor = createExecutor(store, { homeDomainAction: effect });
    const artifactId = await createDeferred(executor, 'identity.providers.secret.replace', providerSecretInput);

    const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'reject' }, uiContext);

    expect(decided).toMatchObject({ ok: true, result: { status: 'rejected' } });
    const persisted = await store.approvalsGet({ artifactId, serverId: null });
    expect(persisted).toMatchObject({
      status: 'rejected',
      actionArgs: { owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 3 },
    });
    expect(storedBody(artifactId)).not.toContain(PROVIDER_SECRET);
    expect(effect).not.toHaveBeenCalled();
  });

  it('durably cancels a blocking approval and keeps only the declared input projection', async () => {
    const store = createStore();
    const effect = vi.fn(async () => ({}));
    const lifetime = new AbortController();
    let artifactId = '';
    const executor = createExecutor(store, {
      homeDomainAction: effect,
      // Retain the real host waiter: this Action otherwise defaults to deferred custody.
      hostActionApprovalLifetime: { actionId: 'identity.providers.secret.replace', signal: lifetime.signal },
      approvalsWaitForDecision: async ({ artifactId: waitedArtifactId, request }) => {
        artifactId = waitedArtifactId;
        expect(storedBody(waitedArtifactId)).toContain(PROVIDER_SECRET);
        return { decision: 'canceled' as const, request };
      },
    });

    const result = await executor.execute('identity.providers.secret.replace', providerSecretInput, {
      ...uiContext,
      surface: 'cli',
      signal: lifetime.signal,
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
    expect(await store.approvalsGet({ artifactId, serverId: null })).toMatchObject({ status: 'canceled' });
    expect(storedBody(artifactId)).not.toContain(PROVIDER_SECRET);
    expect(effect).not.toHaveBeenCalled();
  });

  it('settles a successful effect exactly once as executed with the declared input projection', async () => {
    const store = createStore();
    const effect = vi.fn(async () => ({ resourceId: 'secret-1', revision: 1 }));
    const executor = createExecutor(store, { homeDomainAction: effect });
    const artifactId = await createDeferred(executor, 'secrets.shared.create', savedSecretInput);

    const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, uiContext);
    const repeated = await executor.replayApprovedApprovalRequest({ artifactId });

    expect(decided).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(repeated).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(effect).toHaveBeenCalledOnce();
    expect(await store.approvalsGet({ artifactId, serverId: null })).toMatchObject({
      status: 'executed',
      execution: { ok: true },
    });
    expect(storedBody(artifactId)).not.toContain(SAVED_SECRET_CIPHERTEXT);
  });

  it('settles a failed effect as failed with the declared input projection', async () => {
    const store = createStore();
    const effect = vi.fn(async () => ({ ok: false as const, errorCode: 'provider_conflict', error: 'provider_conflict' }));
    const executor = createExecutor(store, { homeDomainAction: effect });
    const artifactId = await createDeferred(executor, 'identity.providers.secret.replace', providerSecretInput);

    await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, uiContext);

    expect(effect).toHaveBeenCalledOnce();
    expect(await store.approvalsGet({ artifactId, serverId: null })).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'provider_conflict' },
    });
    expect(storedBody(artifactId)).not.toContain(PROVIDER_SECRET);
  });

  it('settles a pre-execution currentness failure without an effect and without the secret', async () => {
    const store = createStore();
    const effect = vi.fn(async () => ({}));
    const creator = createExecutor(store, { homeDomainAction: effect });
    const artifactId = await createDeferred(creator, 'identity.providers.secret.replace', providerSecretInput);
    const revokedOrigin = createExecutor(store, {
      homeDomainAction: effect,
      isApprovalExecutionOriginCurrent: async () => false,
    });

    const decided = await revokedOrigin.execute('approval.request.decide', { artifactId, decision: 'approve' }, uiContext);

    expect(decided).toMatchObject({ ok: true, result: { status: 'failed' } });
    expect(effect).not.toHaveBeenCalled();
    expect(await store.approvalsGet({ artifactId, serverId: null })).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'approval_stale' },
    });
    expect(storedBody(artifactId)).not.toContain(PROVIDER_SECRET);
  });

  it('refuses original-subject mutation and caller-authored terminal input at the store', async () => {
    const store = createStore();
    const executor = createExecutor(store, { homeDomainAction: async () => ({}) });
    const artifactId = await createDeferred(executor, 'identity.providers.secret.replace', providerSecretInput);
    const open = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId, serverId: null }));
    const decided = { kind: 'approve' as const, decidedAtMs: open.updatedAtMs + 1 };

    // Approval changes only the decision: the operands stay the admitted ones.
    await expect(store.approvalsUpdate({
      artifactId,
      serverId: null,
      request: { ...open, status: 'approved', updatedAtMs: open.updatedAtMs + 1, decision: decided,
        actionArgs: { ...providerSecretInput, id: 'provider-2' } },
    })).resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
    // A terminal write may replace input only with the Action's declared projection.
    await expect(store.approvalsUpdate({
      artifactId,
      serverId: null,
      request: { ...open, status: 'rejected', updatedAtMs: open.updatedAtMs + 1,
        decision: { kind: 'reject', decidedAtMs: open.updatedAtMs + 1 },
        actionArgs: { owner: { kind: 'home' }, id: 'provider-2', expectedRevision: 3 } },
    })).resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
    // Keeping the raw secret on a terminal write is not the declared projection either.
    await expect(store.approvalsUpdate({
      artifactId,
      serverId: null,
      request: { ...open, status: 'rejected', updatedAtMs: open.updatedAtMs + 1,
        decision: { kind: 'reject', decidedAtMs: open.updatedAtMs + 1 } },
    })).resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
    expect(await store.approvalsGet({ artifactId, serverId: null })).toMatchObject({ status: 'open' });
  });

  it('refuses a transition written against a stale revision', async () => {
    const store = createStore();
    const executor = createExecutor(store, { homeDomainAction: async () => ({}) });
    const artifactId = await createDeferred(executor, 'identity.providers.secret.replace', providerSecretInput);
    const open = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId, serverId: null }));
    const approve: ApprovalRequest = {
      ...open,
      status: 'approved',
      updatedAtMs: open.updatedAtMs + 1,
      decision: { kind: 'approve', decidedAtMs: open.updatedAtMs + 1 },
    };
    // Another device commits a write between this writer's read and its CAS write.
    http.beforeUpdate = (id) => {
      http.beforeUpdate = null;
      const row = rows.get(id)!;
      rows.set(id, { ...row, headerVersion: Number(row.headerVersion) + 1, bodyVersion: Number(row.bodyVersion) + 1 });
    };

    await expect(store.approvalsUpdate({ artifactId, serverId: null, request: approve }))
      .resolves.toMatchObject({ ok: false, errorCode: 'version_mismatch' });
  });

  it('lets exactly one of two executors claim and perform an approved effect', async () => {
    const store = createStore();
    const effect = vi.fn(async () => ({ resourceId: 'secret-1', revision: 1 }));
    const creator = createExecutor(store, { homeDomainAction: effect });
    const artifactId = await createDeferred(creator, 'secrets.shared.create', savedSecretInput);
    const open = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId, serverId: null }));
    await expect(store.approvalsUpdate({ artifactId, serverId: null, request: {
      ...open,
      status: 'approved',
      updatedAtMs: open.updatedAtMs + 1,
      decision: { kind: 'approve', decidedAtMs: open.updatedAtMs + 1 },
    } })).resolves.toEqual({ ok: true });

    const first = createExecutor(createStore(), { homeDomainAction: effect });
    const second = createExecutor(createStore(), { homeDomainAction: effect });
    const results = await Promise.all([
      first.replayApprovedApprovalRequest({ artifactId }),
      second.replayApprovedApprovalRequest({ artifactId }),
    ]);

    expect(effect).toHaveBeenCalledOnce();
    expect(results.filter((result) => result.ok)).not.toHaveLength(0);
    for (const result of results) {
      if (!result.ok) expect(result.errorCode).toBe('approval_execution_outcome_unknown');
    }
    expect(await store.approvalsGet({ artifactId, serverId: null })).toMatchObject({ status: 'executed' });
    expect(storedBody(artifactId)).not.toContain(SAVED_SECRET_CIPHERTEXT);
  });

  it('fresh-reads a committed terminal outcome when its update acknowledgement is lost', async () => {
    const store = createStore();
    let effects = 0;
    const executor = createExecutor(store, {
      homeDomainAction: async () => {
        effects += 1;
        http.loseNextUpdateResponse = true;
        return { resourceId: 'secret-1', revision: 1 };
      },
    });
    const artifactId = await createDeferred(executor, 'secrets.shared.create', savedSecretInput);
    const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, uiContext);

    expect(decided).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    await expect(executor.replayApprovedApprovalRequest({ artifactId }))
      .resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(effects).toBe(1);
    expect(await store.approvalsGet({ artifactId, serverId: null })).toMatchObject({ status: 'executed' });
  });

  it('never repeats an effect whose terminal write remains unavailable', async () => {
    const store = createStore();
    const effect = vi.fn(async () => ({ resourceId: 'secret-1', revision: 1 }));
    const executor = createExecutor(store, {
      homeDomainAction: async () => {
        const result = await effect();
        http.beforeUpdate = () => {
          http.failNextUpdateWith = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        };
        return result;
      },
    });
    const artifactId = await createDeferred(executor, 'secrets.shared.create', savedSecretInput);

    const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, uiContext);
    const repeated = await executor.replayApprovedApprovalRequest({ artifactId });

    expect(decided).toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
    expect(repeated).toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
    expect(effect).toHaveBeenCalledOnce();
    expect(await store.approvalsGet({ artifactId, serverId: null })).toMatchObject({ status: 'executing' });
  });

  it('returns a show-once API token only to its live invocation and never to the Artifact', async () => {
    const store = createStore();
    const tokenId = 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d';
    const bearerSecret = 'S'.repeat(43);
    const created = {
      token: `hap_v1_${tokenId}_${bearerSecret}`,
      apiToken: {
        tokenId,
        label: 'CI deploy',
        displayPrefix: 'hap_v1_dd03e74b',
        createdAt: '2026-08-22T12:00:00.000Z',
        lastUsedAt: null,
        expiresAt: null,
        hasEncryptionAccess: false,
        hasUnattendedTeamAccess: false,
        grant: API_TOKEN_FULL_GRANT_V1,
        parentTokenId: null,
        activeChildCount: 0,
        embedConfig: null,
      },
    };
    const effect = vi.fn(async () => created);
    // The UI host composition: one process-local decision coordinator shared by
    // the waiting invocation and the Approval Detail decision in that process.
    const coordinator = createBlockingApprovalCoordinator();
    let waitingArtifactId: string | null = null;
    const executor = createExecutor(store, {
      accountApiTokensCreateAction: effect,
      isActionApprovalRequired: (id) => id === 'account.apiTokens.create',
      approvalsWaitForDecision: async (args) => {
        waitingArtifactId = args.artifactId;
        return await coordinator.waitForDecision({
          artifactId: args.artifactId,
          request: args.request,
          ...(args.signal ? { signal: args.signal } : {}),
        }) as Awaited<ReturnType<NonNullable<ActionExecutorDeps['approvalsWaitForDecision']>>>;
      },
      approvalsResolveBlockingDecision: async (args) => await coordinator.resolveBlockingDecision(args),
    });

    const invocation = executor.execute('account.apiTokens.create', { tokenId, label: 'CI deploy' }, uiContext);
    await vi.waitFor(() => expect(waitingArtifactId).not.toBeNull());
    const artifactId = waitingArtifactId!;
    const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, uiContext);

    expect(decided).toMatchObject({ ok: true });
    await expect(invocation).resolves.toEqual({ ok: true, result: created });
    expect(effect).toHaveBeenCalledOnce();
    expect(await store.approvalsGet({ artifactId, serverId: null })).toMatchObject({
      status: 'executed',
      execution: { ok: true },
    });
    expect(storedBody(artifactId)).not.toContain(bearerSecret);
  });
});
