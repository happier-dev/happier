import { Buffer } from 'node:buffer';

import axios from 'axios';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
  API_TOKEN_FULL_GRANT_V1,
  CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  type AccountApiTokenSummaryV1,
  type ApprovalRequest,
  type WorkflowAcceptedAuthorizationV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { configuration, reloadConfiguration } from '@/configuration';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';

// Only true system boundaries are replaced: the daemon's credential/settings
// files, the Account server's HTTP routes (Axios and `fetch`), and nothing else.
// The production approval RPC composition, the credential-backed executor, the
// real CLI approval Artifact store and codecs, the daemon currentness owner and
// the daemon's own Workflow accepted-authorization owner all run for real.
const files = vi.hoisted(() => ({
  readStoredCredentials: vi.fn(),
  readSettings: vi.fn(),
}));
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: files.readStoredCredentials,
  readSettings: files.readSettings,
}));

import { registerApprovalRpcHandlers } from './approvals';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { buildWorkflowActionContext, createProductionDaemonWorkflowRuntime } from '@/daemon/workflows/daemonRuntime';

const HOME_URL = 'https://workflow-replay-home.example.test';
const ACCOUNT_ID = 'account-workflow-replay';
const MACHINE_ID = 'machine-workflow-replay';
const WORKFLOW_CREDENTIAL_ID = '22222222-2222-4222-8222-222222222222';
const POOL_ID = '33333333-3333-4333-8333-333333333333';

function syntheticAccountToken(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: accountId })}.signature`;
}

const credentials = {
  token: syntheticAccountToken(ACCOUNT_ID),
  encryption: null,
  credentialProvenance: 'stored_session' as const,
};

// The accepted authorization a Workflow Run was admitted with: an API caller's
// exact credential plus the immutable admitted permission ceiling.
const authorization: WorkflowAcceptedAuthorizationV1 = {
  admittedPermissionCeiling: 'safe-yolo',
  principal: {
    kind: 'api',
    accountId: ACCOUNT_ID,
    principalId: ACCOUNT_ID,
    credentialId: WORKFLOW_CREDENTIAL_ID,
  },
};

const rows = new Map<string, Record<string, unknown>>();
let currentTokens: unknown[] = [];
let tokenInventoryReads = 0;
const poolDeletes: unknown[] = [];

function tokenSummary(tokenId: string): AccountApiTokenSummaryV1 {
  return {
    tokenId,
    label: 'Workflow token',
    displayPrefix: 'hap_v1_22222222',
    createdAt: '2026-09-01T00:00:00.000Z',
    lastUsedAt: null,
    expiresAt: null,
    hasEncryptionAccess: false,
    hasUnattendedTeamAccess: false,
    grant: API_TOKEN_FULL_GRANT_V1,
    parentTokenId: null,
    activeChildCount: 0,
    embedConfig: null,
  };
}

function installAccountServer(): void {
  vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
    if (url === `${HOME_URL}/v1/account/profile`) {
      return { status: 200, data: { id: ACCOUNT_ID } };
    }
    if (url === `${HOME_URL}/v2/account/settings`) {
      return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    }
    if (url === `${HOME_URL}/v1/account/encryption`) {
      return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    }
    const artifactPrefix = `${HOME_URL}/v1/artifacts/`;
    if (url.startsWith(artifactPrefix)) {
      const id = decodeURIComponent(url.slice(artifactPrefix.length));
      return { status: rows.has(id) ? 200 : 404, data: rows.get(id) };
    }
    throw Object.assign(new Error(`unexpected GET ${url}`), { code: 'ENOTFOUND' });
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url: string, raw: unknown) => {
    const body = raw as Record<string, unknown>;
    if (url === `${HOME_URL}/v1/artifacts`) {
      rows.set(String(body.id), { ...body, ownerAccountId: ACCOUNT_ID, access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    }
    const artifactPrefix = `${HOME_URL}/v1/artifacts/`;
    if (!url.startsWith(artifactPrefix)) {
      throw Object.assign(new Error(`unexpected POST ${url}`), { code: 'ENOTFOUND' });
    }
    const id = decodeURIComponent(url.slice(artifactPrefix.length));
    const existing = rows.get(id)!;
    // The Account server's versioned Artifact CAS contract.
    if (
      (body.expectedHeaderVersion !== undefined && body.expectedHeaderVersion !== existing.headerVersion)
      || (body.expectedBodyVersion !== undefined && body.expectedBodyVersion !== existing.bodyVersion)
    ) {
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
    return { status: 200, data: { success: true, headerVersion, bodyVersion } };
  });
  vi.spyOn(axios, 'request').mockImplementation(async (config) => {
    const { url, data } = config as { url?: string; data?: unknown };
    if (url === `${HOME_URL}${ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1}`) {
      tokenInventoryReads++;
      return { status: 200, data: { tokens: currentTokens } };
    }
    if (url === `${HOME_URL}/v1/machines/pools/delete`) {
      poolDeletes.push(data);
      return { status: 200, data: { poolId: POOL_ID, deleted: true } };
    }
    throw Object.assign(new Error(`unexpected request ${url}`), { code: 'ENOTFOUND' });
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    features: {},
    capabilities: {
      serverIdentity: { serverIdentityId: 'srv_workflow_replay' },
      accountStoredContentCompatibility: {
        v: 1,
        minimumProtocolVersion: 2,
        currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
        declarationTransport: 'http-header-and-socket-auth-v1',
      },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })));
}

let originalServerUrl: string | undefined;

beforeAll(() => {
  originalServerUrl = process.env.HAPPIER_SERVER_URL;
  process.env.HAPPIER_SERVER_URL = HOME_URL;
  reloadConfiguration();
});

afterAll(() => {
  if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
  else process.env.HAPPIER_SERVER_URL = originalServerUrl;
  reloadConfiguration();
});

beforeEach(async () => {
  rows.clear();
  poolDeletes.length = 0;
  currentTokens = [tokenSummary(WORKFLOW_CREDENTIAL_ID)];
  tokenInventoryReads = 0;
  resetInMemoryAccountSettingsContextForTests();
  resetServerFeaturesClientForTests();
  files.readStoredCredentials.mockResolvedValue(credentials);
  files.readSettings.mockResolvedValue({ machineId: MACHINE_ID });
  installAccountServer();
  await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetInMemoryAccountSettingsContextForTests();
  resetServerFeaturesClientForTests();
});

/**
 * The daemon's Workflow accepted-authorization owner for the Workflow-side
 * executor. The approval RPC production composition reconstructs the same
 * owner from stored credentials and settings when replay begins.
 */
function daemonWorkflowCurrentness() {
  return createProductionDaemonWorkflowRuntime({
    credentials,
    accountId: ACCOUNT_ID,
    serverId: configuration.activeServerId,
  }).isAcceptedAuthorizationCurrent;
}

/**
 * A Workflow Run's leaf asks for a dangerous Action through the same executor
 * composition the Workflow coordinator uses; the Action policy defers it to a
 * durable approval. A present user then approves it through the one approval
 * transition owner, as the UI approval writer does.
 */
async function createApprovedWorkflowApproval(
  workflowAcceptedAuthorizationCurrentness: ReturnType<typeof daemonWorkflowCurrentness>,
): Promise<string> {
  const { artifactId, open } = await createOpenWorkflowApproval(workflowAcceptedAuthorizationCurrentness);
  const store = createCliApprovalsArtifactStore({ credentials });
  const approved = await store.approvalsUpdate({
    artifactId,
    serverId: null,
    request: {
      ...open,
      status: 'approved',
      updatedAtMs: open.updatedAtMs + 1,
      decision: { kind: 'approve', decidedAtMs: open.updatedAtMs + 1 },
    } as ApprovalRequest,
  });
  expect(approved).toEqual({ ok: true });
  return artifactId;
}

async function createOpenWorkflowApproval(
  workflowAcceptedAuthorizationCurrentness: ReturnType<typeof daemonWorkflowCurrentness>,
): Promise<Readonly<{ artifactId: string; open: ApprovalRequest }>> {
  const workflowExecutor = createCliActionExecutorFromCredentials({
    credentials,
    machineId: MACHINE_ID,
    workflowAcceptedAuthorizationCurrentness,
  });
  const workflowContext = buildWorkflowActionContext({
    runId: 'workflow-run-1',
    authorization,
    origin: {
      kind: 'direct',
      originSessionId: 'workflow-origin-session',
      authenticatedStarterV1: {
        requestRef: 'workflow-person-request',
        requester: { serverId: 'srv_workflow_replay', accountId: ACCOUNT_ID },
      },
    },
  });
  const admitted = await workflowExecutor.execute(
    'machines.pools.delete',
    { poolId: POOL_ID, expectedRevision: 3 },
    {
      ...workflowContext,
      // Every Workflow step stamps its own exact request identity
      // (`executionRunStepExecutor.ts`), which the durable origin requires.
      actionRequestId: 'workflow-run-1:step-1',
    },
  );
  expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  expect(poolDeletes).toHaveLength(0);
  const artifactId = String((admitted as { result: { artifactId: string } }).result.artifactId);

  const store = createCliApprovalsArtifactStore({ credentials });
  const open = await store.approvalsGet({ artifactId, serverId: null }) as ApprovalRequest;
  expect(open).toMatchObject({
    v: 2,
    status: 'open',
    executionOriginV1: {
      caller: { kind: 'workflowRun', authorization },
      authority: 'account_automation',
      actionRequestAttributionV1: workflowContext.actionRequestAttributionV1,
    },
  });
  return { artifactId, open };
}

function registerProductionApprovalHandlerMap() {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  registerApprovalRpcHandlers({
    rpcHandlerManager: {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    },
  });
  return handlers;
}

function registerProductionApprovalHandlers() {
  const replay = registerProductionApprovalHandlerMap().get(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED);
  if (!replay) throw new Error('approval replay handler was not registered');
  return replay;
}

describe('machine RPC replay of a deferred Workflow-origin approval', () => {
  it.each([RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, RPC_METHODS.APPROVAL_REQUEST_DECIDE])(
    'refuses %s when the receiving daemon has no credentials for the authenticated original Account', async method => {
      const artifactId = await createApprovedWorkflowApproval(daemonWorkflowCurrentness());
      files.readStoredCredentials.mockResolvedValue({ ...credentials, token: syntheticAccountToken('other-account') });
      const handlers = new Map<string, (input: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
      registerApprovalRpcHandlers({ rpcHandlerManager: { registerHandler: (name, handler) => { handlers.set(name, handler); } } });
      const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: ACCOUNT_ID, custodianAccountId: ACCOUNT_ID, machineId: MACHINE_ID,
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true };
      const result = await handlers.get(method)!({ artifactId, decision: 'approve' }, context);
      expect(result).toMatchObject({ ok: false, errorCode: 'account_mismatch',
        error: expect.stringContaining('original Account') });
      expect(poolDeletes).toEqual([]);
    });

  it.each(['other_account', 'unavailable'] as const)('keeps approved replay with its recorded Account when the profile is %s', async profile => {
    const workflowAcceptedAuthorizationCurrentness = daemonWorkflowCurrentness();
    const artifactId = await createApprovedWorkflowApproval(workflowAcceptedAuthorizationCurrentness);
    const executor = createCliActionExecutorFromCredentials({ credentials, machineId: MACHINE_ID,
      workflowAcceptedAuthorizationCurrentness, readCredentials: files.readStoredCredentials });
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    registerApprovalRpcHandlers({ actionExecutor: executor,
      rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } } });
    const other = { ...credentials, token: syntheticAccountToken('other-account') };
    files.readStoredCredentials.mockResolvedValue(profile === 'unavailable' ? null : other);
    const get = vi.mocked(axios.get).getMockImplementation()!;
    const foreignApprovalReads: string[] = [];
    vi.mocked(axios.get).mockImplementation(async (url, config) => {
      if (String(url).startsWith(`${HOME_URL}/v1/artifacts/`) && config?.headers?.Authorization === `Bearer ${other.token}`) {
        foreignApprovalReads.push(String(url));
        return { status: 404, data: { error: 'not_found' } };
      }
      return get(url, config);
    });
    const request = vi.mocked(axios.request).getMockImplementation()!;
    vi.mocked(axios.request).mockImplementation(async config => {
      if (config.headers?.Authorization === `Bearer ${other.token}`) {
        foreignApprovalReads.push(String(config.url));
        return { status: 403, data: { error: 'account_mismatch' } };
      }
      return request(config);
    });
    const result = await handlers.get(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)!({ artifactId });
    if (profile === 'unavailable') {
      expect(result).toMatchObject({ ok: false, effectAttempted: false, errorCode: 'account_mismatch',
        error: expect.stringContaining('original Account') });
      expect(poolDeletes).toEqual([]);
    } else {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(poolDeletes).toEqual([{ poolId: POOL_ID, expectedRevision: 3 }]);
    }
    expect(foreignApprovalReads).toEqual([]);
  });

  it('performs the approved effect exactly once while the accepted authorization is current', async () => {
    const workflowAcceptedAuthorizationCurrentness = daemonWorkflowCurrentness();
    const artifactId = await createApprovedWorkflowApproval(workflowAcceptedAuthorizationCurrentness);
    const replay = registerProductionApprovalHandlers();

    const firstReplay = await replay({ artifactId });
    expect(firstReplay, JSON.stringify(firstReplay)).toMatchObject({
      ok: true,
      result: { status: 'executed' },
    });
    await expect(replay({ artifactId })).resolves.toMatchObject({
      ok: true,
      result: { status: 'executed' },
    });

    expect(poolDeletes).toEqual([{ poolId: POOL_ID, expectedRevision: 3 }]);
    const store = createCliApprovalsArtifactStore({ credentials });
    await expect(store.approvalsGet({ artifactId, serverId: null })).resolves.toMatchObject({
      status: 'executed',
      execution: { ok: true },
    });
  });

  it('finishes approved admitted work after credential revocation without rereading the token inventory', async () => {
    const workflowAcceptedAuthorizationCurrentness = daemonWorkflowCurrentness();
    const artifactId = await createApprovedWorkflowApproval(workflowAcceptedAuthorizationCurrentness);
    const replay = registerProductionApprovalHandlers();

    // Revoking the Workflow's API credential leaves the daemon Account itself
    // authenticated; only the Run's accepted authorization is no longer current.
    currentTokens = [];
    tokenInventoryReads = 0;

    await expect(replay({ artifactId })).resolves.toMatchObject({
      ok: true,
      result: { status: 'executed' },
    });
    expect(poolDeletes).toEqual([{ poolId: POOL_ID, expectedRevision: 3 }]);
    expect(tokenInventoryReads).toBe(0);
    const store = createCliApprovalsArtifactStore({ credentials });
    await expect(store.approvalsGet({ artifactId, serverId: null })).resolves.toMatchObject({
      status: 'executed',
      execution: { ok: true },
    });
  });

  it('grants the private replay method no decision authority over an open approval', async () => {
    const { artifactId } = await createOpenWorkflowApproval(daemonWorkflowCurrentness());
    const handlers = registerProductionApprovalHandlerMap();

    // The machine RPC decide path is an automation surface; only a present
    // user decides an approval.
    await expect(handlers.get(RPC_METHODS.APPROVAL_REQUEST_DECIDE)?.({
      artifactId,
      decision: 'approve',
    })).resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
    // Replay consumes only an already-approved Artifact.
    await expect(handlers.get(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)?.({
      artifactId,
      decision: 'approve',
      authority: 'present_user',
    })).resolves.not.toMatchObject({ ok: true, result: { status: 'executed' } });

    expect(poolDeletes).toHaveLength(0);
    const store = createCliApprovalsArtifactStore({ credentials });
    await expect(store.approvalsGet({ artifactId, serverId: null })).resolves.toMatchObject({
      status: 'open',
    });
  });
});
