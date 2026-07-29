import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
  PluginPermissionGrantDismissRequestActionOutputV1Schema,
  PluginPermissionGrantGrantActionOutputV1Schema,
  PluginPermissionGrantListActionOutputV1Schema,
  PluginPermissionGrantRequestActionInputV1Schema,
  PluginPermissionGrantRequestActionOutputV1Schema,
  PluginPermissionGrantRevokeActionOutputV1Schema,
  ReviewCommentListResponseV1Schema,
  type ExecutionRunHostActionApprovalRequestV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
  createReviewCommentHostActionMaterializer,
  type ReviewCommentHostActionCandidate,
  type ReviewCommentHostPluginAuthority,
} from '../../../../../apps/cli/src/agent/executionRuns/profiles/review/hostActionMaterializer';
import { createCliReviewCommentActionExecutorFromCredentials } from '../../../../../apps/cli/src/agent/reviews/comments/executor';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '../../../../../apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import { signPluginInstallationPublisherHeader } from '../../../../../apps/cli/src/plugins/installations/publisherProof';
import { readCurrentCommittedPluginGenerations } from '../../../../../apps/cli/src/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '../../../../../apps/cli/src/plugins/store/paths';
import { getSharedBlockingApprovalCoordinator } from '../../../../../apps/cli/src/session/actions/approvals/blockingApprovalCoordinator';
import { createExecutionRunHostActionCurrentIntentAdapter } from '../../../../../apps/cli/src/session/actions/approvals/executionRunHostActionCurrentIntent';
import { createTestAuth } from '../auth';
import { fetchJson } from '../http';
import {
  createMachineInstallationIdentityFixture,
  registerMachineIdentity,
  type MachineInstallationIdentityFixture,
} from '../machineIdentity';
import { startServerLight } from '../process/serverLight';

const PLUGIN_ID = 'happier.review.coderabbit';
const DIRECT_WRITE_CAPABILITY = 'reviews.comments.write.direct';

type AuthenticatedAccount = Readonly<{
  token: string;
  accountId: string;
  machineId: string;
  installation: MachineInstallationIdentityFixture;
}>;

function authorizationHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function createAccountWithMachine(baseUrl: string): Promise<AuthenticatedAccount> {
  const auth = await createTestAuth(baseUrl);
  const installation = createMachineInstallationIdentityFixture();
  const registered = await registerMachineIdentity({
    baseUrl,
    token: auth.token,
    installation,
  });
  expect(registered.status).toBe(200);
  const [, encodedClaims] = auth.token.split('.');
  const claims = encodedClaims
    ? JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8')) as Readonly<{ sub?: unknown }>
    : {};
  if (typeof claims.sub !== 'string' || !claims.sub.trim()) {
    throw new Error('Test auth token did not contain an account subject');
  }
  return {
    token: auth.token,
    accountId: claims.sub,
    machineId: registered.machineId,
    installation,
  };
}

async function requestSignedDirectWrite(params: Readonly<{
  baseUrl: string;
  account: AuthenticatedAccount;
  input: unknown;
}>): Promise<ReturnType<typeof PluginPermissionGrantRequestActionOutputV1Schema.parse>> {
  const path = '/v1/plugins/permissions/grants/request';
  const input = PluginPermissionGrantRequestActionInputV1Schema.parse(params.input);
  const publisherHeader = signPluginInstallationPublisherHeader({
    identity: {
      version: 1,
      installationId: params.account.installation.installationId,
      createdAt: 0,
      publicKey: params.account.installation.publicKeyBase64,
      privateKey: params.account.installation.privateKeyBase64,
    },
    machineId: params.account.machineId,
    path,
    body: input,
  });
  const requestedResponse = await fetchJson(`${params.baseUrl}/v1/plugins/permissions/grants/request`, {
    method: 'POST',
    headers: {
      ...authorizationHeaders(params.account.token),
      [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader,
    },
    body: JSON.stringify(input),
  });
  expect(requestedResponse.status).toBe(200);
  return PluginPermissionGrantRequestActionOutputV1Schema.parse(requestedResponse.data);
}

async function requestProjectDirectWrite(params: Readonly<{
  baseUrl: string;
  account: AuthenticatedAccount;
  projectId: string;
  sessionId: string;
  requestId?: string;
}>): Promise<string> {
  const requested = await requestSignedDirectWrite({
    baseUrl: params.baseUrl,
    account: params.account,
    input: {
      pluginId: PLUGIN_ID,
      capability: DIRECT_WRITE_CAPABILITY,
      targetScope: { kind: 'project', projectId: params.projectId },
      requester: {
        kind: 'plugin',
        pluginId: PLUGIN_ID,
        sessionId: params.sessionId,
        ...(params.requestId ? { requestId: params.requestId } : {}),
      },
      reason: 'Materialize an approved execution-run review proposal.',
    },
  });
  expect(requested.pendingRequest.authoritySource).toEqual({
    kind: 'machine_installation',
    machineId: params.account.machineId,
    installationId: params.account.installation.installationId,
  });
  return requested.pendingRequest.id;
}

async function grantDirectWriteRequest(params: Readonly<{
  baseUrl: string;
  token: string;
  requestId: string;
}>): Promise<string> {
  const grantedResponse = await fetchJson(`${params.baseUrl}/v1/plugins/permissions/grants/grant`, {
    method: 'POST',
    headers: authorizationHeaders(params.token),
    body: JSON.stringify({ requestId: params.requestId }),
  });
  expect(grantedResponse.status).toBe(200);
  const granted = PluginPermissionGrantGrantActionOutputV1Schema.parse(grantedResponse.data);
  return granted.grant.id;
}

async function grantProjectDirectWrite(params: Readonly<{
  baseUrl: string;
  account: AuthenticatedAccount;
  projectId: string;
  sessionId: string;
}>): Promise<Readonly<{ requestId: string; grantId: string }>> {
  const requestId = await requestProjectDirectWrite(params);
  const grantId = await grantDirectWriteRequest({
    baseUrl: params.baseUrl,
    token: params.account.token,
    requestId,
  });
  return { requestId, grantId };
}

async function revokeDirectWrite(params: Readonly<{
  baseUrl: string;
  token: string;
  grantId: string;
}>): Promise<void> {
  const response = await fetchJson(`${params.baseUrl}/v1/plugins/permissions/grants/revoke`, {
    method: 'POST',
    headers: authorizationHeaders(params.token),
    body: JSON.stringify({ grantId: params.grantId, reason: 'Exercise revocation before host dispatch.' }),
  });
  expect(response.status).toBe(200);
  expect(PluginPermissionGrantRevokeActionOutputV1Schema.parse(response.data).grant.status).toBe('revoked');
}

function createAutoApprovedCurrentIntent(): ReturnType<typeof createExecutionRunHostActionCurrentIntentAdapter> {
  const stored = new Map<string, ExecutionRunHostActionApprovalRequestV1>();
  return createExecutionRunHostActionCurrentIntentAdapter({
    create: async (request) => {
      const artifactId = `execution-run-host-action-${randomUUID()}`;
      stored.set(artifactId, request);
      queueMicrotask(() => {
        const approved: ExecutionRunHostActionApprovalRequestV1 = {
          ...request,
          status: 'approved',
          updatedAtMs: request.updatedAtMs + 1,
          decision: { kind: 'approve', decidedAtMs: request.updatedAtMs + 1 },
        };
        stored.set(artifactId, approved);
        getSharedBlockingApprovalCoordinator().notifyApprovalUpdated({ artifactId, request: approved });
      });
      return { artifactId };
    },
    read: async (artifactId) => stored.get(artifactId) ?? null,
  });
}

function readActionErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const code = (error as Readonly<{ code?: unknown }>).code;
    if (typeof code === 'string' && code.trim()) return code.trim();
  }
  return 'review_comment_request_failed';
}

function candidate(params: Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  callId: string;
  body: string;
}>): ReviewCommentHostActionCandidate {
  return {
    actionId: 'reviews.comments.create',
    sessionId: params.sessionId,
    runId: params.runId,
    callId: params.callId,
    profileId: `${PLUGIN_ID}/review`,
    pluginId: PLUGIN_ID,
    agentId: 'claude',
    proposals: [{
      findingId: `${params.runId}-finding`,
      body: params.body,
      severity: 'error',
      anchor: { kind: 'line', filePath: 'src/example.ts', line: 1 },
    }],
  };
}

describe('authenticated execution-run review host action', () => {
  it('reaches the real server effect with current authority and fails closed across grant, scope, revocation, and encryption boundaries', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-review-host-action-'));
    const cwd = join(testDir, 'workspace');
    const happyHomeDir = join(testDir, 'home');
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src/example.ts'), 'export const value = 1;\n', 'utf8');

    const previousServerUrl = process.env.HAPPIER_SERVER_URL;
    const previousWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const server = await startServerLight({
      testDir: join(testDir, 'server'),
      dbProvider: 'sqlite',
      extraEnv: {
        NODE_ENV: 'test',
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
        HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: 'true',
      },
    });
    process.env.HAPPIER_SERVER_URL = server.baseUrl;
    process.env.HAPPIER_WEBAPP_URL = server.baseUrl;

    try {
      const bundledArtifact = BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS.find(
        (artifact) => artifact.record.pluginId === PLUGIN_ID,
      );
      expect(bundledArtifact).toBeDefined();
      const readCurrentPluginAuthority = async (): Promise<ReviewCommentHostPluginAuthority | null> => {
        const current = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({ happyHomeDir }), {
          bundledArtifacts: bundledArtifact ? [bundledArtifact] : [],
        });
        const generation = current?.generations.get(PLUGIN_ID);
        if (!current || !generation || !(await current.isCurrent())) return null;
        return {
          immutableGenerationId: generation.immutableGenerationId,
          packageDigest: generation.record.packageDigest,
          manifestDigest: generation.record.manifestDigest,
        };
      };
      expect(await readCurrentPluginAuthority()).toEqual({
        immutableGenerationId: bundledArtifact?.record.immutableGenerationId,
        packageDigest: bundledArtifact?.record.packageDigest,
        manifestDigest: bundledArtifact?.record.manifestDigest,
      });

      const createMaterializer = (params: Readonly<{
        account: AuthenticatedAccount;
        projectId: string;
        sessionId: string;
        runId: string;
        callId: string;
        body: string;
      }>) => {
        const currentCandidate = candidate(params);
        const executeReviewComment = createCliReviewCommentActionExecutorFromCredentials({
          credentials: {
            token: params.account.token,
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
          },
          resolvePrincipalSigningContext: async () => ({
            machineId: params.account.machineId,
            installationId: params.account.installation.installationId,
            privateKeyBase64Url: params.account.installation.privateKeyBase64,
          }),
        });
        return createReviewCommentHostActionMaterializer({
          cwd,
          readCurrentCandidate: () => currentCandidate,
          readCurrentPluginAuthority,
          resolveWorkspace: async () => ({
            projectId: params.projectId,
            workspaceId: 'workspace-1',
            serverId: 'server-under-test',
          }),
          requestCurrentIntent: createAutoApprovedCurrentIntent(),
          requestDirectWriteGrant: async ({ serverId: _serverId, ...input }) => {
            return await requestSignedDirectWrite({
              baseUrl: server.baseUrl,
              account: params.account,
              input,
            });
          },
          executeHostAction: async (actionId, input, context) => {
            const principal = context.reviewCommentPrincipal;
            if (!principal) {
              return {
                ok: false,
                errorCode: 'review_comment_principal_missing_from_materializer',
                error: 'review_comment_principal_missing_from_materializer',
              };
            }
            try {
              return {
                ok: true,
                result: await executeReviewComment(actionId, input, {
                  principal,
                }),
              };
            } catch (error) {
              const errorCode = readActionErrorCode(error);
              return { ok: false, errorCode, error: error instanceof Error ? error.message : errorCode };
            }
          },
        });
      };

      const account = await createAccountWithMachine(server.baseUrl);
      const missingGrant = await createMaterializer({
        account,
        projectId: 'project-authorized',
        sessionId: 'session-main',
        runId: 'run-missing-grant',
        callId: 'call-missing-grant',
        body: 'This proposal must not bypass the durable grant.',
      })();
      expect(missingGrant).toMatchObject({
        ok: true,
        result: {
          status: 'failed',
          comments: [],
          failures: [{ errorCode: 'review_comment_direct_write_permission_required' }],
        },
      });

      const pendingResponse = await fetchJson(
        `${server.baseUrl}/v1/plugins/permissions/grants/list`,
        {
          method: 'POST',
          headers: authorizationHeaders(account.token),
          body: JSON.stringify({
            capability: DIRECT_WRITE_CAPABILITY,
            targetScope: { kind: 'project', projectId: 'project-authorized' },
          }),
        },
      );
      expect(pendingResponse.status).toBe(200);
      const pending = PluginPermissionGrantListActionOutputV1Schema.parse(pendingResponse.data);
      expect(pending.grants).toHaveLength(0);
      expect(pending.pendingRequests).toHaveLength(1);
      expect(pending.pendingRequests[0]).toMatchObject({
        pluginId: PLUGIN_ID,
        capability: DIRECT_WRITE_CAPABILITY,
        targetScope: { kind: 'project', projectId: 'project-authorized' },
        requester: {
          kind: 'plugin',
          pluginId: PLUGIN_ID,
          sessionId: 'session-main',
          requestId: 'call-missing-grant',
        },
        authoritySource: {
          kind: 'machine_installation',
          machineId: account.machineId,
          installationId: account.installation.installationId,
        },
      });
      const requestId = pending.pendingRequests[0]!.id;
      const grantId = await grantDirectWriteRequest({ baseUrl: server.baseUrl, token: account.token, requestId });
      const granted = { requestId, grantId };
      const wrongScope = await createMaterializer({
        account,
        projectId: 'project-wrong-scope',
        sessionId: 'session-main',
        runId: 'run-wrong-scope',
        callId: 'call-wrong-scope',
        body: 'A grant for a sibling project must not authorize this proposal.',
      })();
      expect(wrongScope).toMatchObject({
        ok: true,
        result: {
          status: 'failed',
          failures: [{ errorCode: 'review_comment_direct_write_permission_required' }],
        },
      });

      const materializeAuthorized = createMaterializer({
        account,
        projectId: 'project-authorized',
        sessionId: 'session-main',
        runId: 'run-authorized',
        callId: 'call-authorized',
        body: 'Persist this exact approved proposal once.',
      });
      const created = await materializeAuthorized();
      const replayed = await materializeAuthorized();
      expect(created).toMatchObject({
        ok: true,
        result: { status: 'created', comments: [{ replayed: false }] },
      });
      expect(replayed).toMatchObject({
        ok: true,
        result: { status: 'created', comments: [{ replayed: true }] },
      });
      if (!created.ok || !replayed.ok) throw new Error('Expected successful host-action materialization');
      expect(replayed.result.comments[0]?.commentId).toBe(created.result.comments[0]?.commentId);

      const listedResponse = await fetchJson(
        `${server.baseUrl}/v1/reviews/comments?projectId=project-authorized`,
        { headers: { Authorization: `Bearer ${account.token}` } },
      );
      expect(listedResponse.status).toBe(200);
      const listed = ReviewCommentListResponseV1Schema.parse(listedResponse.data);
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]).toMatchObject({
        id: created.result.comments[0]?.commentId,
        projectId: 'project-authorized',
        workspaceId: 'workspace-1',
        sessionId: 'session-main',
        runId: 'run-authorized',
        engineId: PLUGIN_ID,
        body: 'Persist this exact approved proposal once.',
        state: 'proposed',
        author: { kind: 'agent', agentId: 'claude', sessionId: 'session-main' },
      });

      await revokeDirectWrite({ baseUrl: server.baseUrl, token: account.token, grantId: granted.grantId });
      const revoked = await createMaterializer({
        account,
        projectId: 'project-authorized',
        sessionId: 'session-main',
        runId: 'run-revoked',
        callId: 'call-revoked',
        body: 'Revocation must take effect before this dispatch.',
      })();
      expect(revoked).toMatchObject({
        ok: true,
        result: {
          status: 'failed',
          failures: [{ errorCode: 'review_comment_direct_write_permission_required' }],
        },
      });
      const revokedRetry = await createMaterializer({
        account,
        projectId: 'project-authorized',
        sessionId: 'session-main',
        runId: 'run-revoked-retry',
        callId: 'call-revoked-retry',
        body: 'A later explicit retry must reuse the pending request without writing.',
      })();
      expect(revokedRetry).toMatchObject({
        ok: true,
        result: {
          status: 'failed',
          failures: [{ errorCode: 'review_comment_direct_write_permission_required' }],
        },
      });
      const reopenedResponse = await fetchJson(
        `${server.baseUrl}/v1/plugins/permissions/grants/list`,
        {
          method: 'POST',
          headers: authorizationHeaders(account.token),
          body: JSON.stringify({
            capability: DIRECT_WRITE_CAPABILITY,
            targetScope: { kind: 'project', projectId: 'project-authorized' },
          }),
        },
      );
      const reopened = PluginPermissionGrantListActionOutputV1Schema.parse(reopenedResponse.data);
      expect(reopened.pendingRequests).toHaveLength(1);
      const reopenedRequestId = reopened.pendingRequests[0]!.id;
      const dismissedResponse = await fetchJson(
        `${server.baseUrl}/v1/plugins/permissions/grants/dismissRequest`,
        {
          method: 'POST',
          headers: authorizationHeaders(account.token),
          body: JSON.stringify({
            requestId: reopenedRequestId,
            reason: 'User dismissed the renewed request after revocation.',
          }),
        },
      );
      expect(dismissedResponse.status).toBe(200);
      expect(PluginPermissionGrantDismissRequestActionOutputV1Schema.parse(
        dismissedResponse.data,
      ).pendingRequest).toMatchObject({
        id: reopenedRequestId,
        status: 'dismissed',
        authoritySource: {
          kind: 'machine_installation',
          machineId: account.machineId,
          installationId: account.installation.installationId,
        },
      });

      const encryptedAccount = await createAccountWithMachine(server.baseUrl);
      await grantProjectDirectWrite({
        baseUrl: server.baseUrl,
        account: encryptedAccount,
        projectId: 'project-encrypted',
        sessionId: 'session-encrypted',
      });
      const encryptionUpdate = await fetchJson(`${server.baseUrl}/v1/account/encryption`, {
        method: 'PATCH',
        headers: authorizationHeaders(encryptedAccount.token),
        body: JSON.stringify({ mode: 'e2ee' }),
      });
      expect(encryptionUpdate).toMatchObject({ status: 200, data: { mode: 'e2ee' } });
      const encryptedPlaintextAttempt = await createMaterializer({
        account: encryptedAccount,
        projectId: 'project-encrypted',
        sessionId: 'session-encrypted',
        runId: 'run-encrypted',
        callId: 'call-encrypted',
        body: 'Plain host output must not cross an E2EE persistence boundary.',
      })();
      expect(encryptedPlaintextAttempt).toMatchObject({
        ok: true,
        result: {
          status: 'failed',
          failures: [{ errorCode: 'review_comment_encryption_mode_mismatch' }],
        },
      });

      const auditDb = new DatabaseSync(join(server.dataDir, 'happier-server-light.sqlite'), { readOnly: true });
      try {
        const auditRows = auditDb.prepare(`
          SELECT account_id, event_kind, plugin_id, capability, scope_kind, scope_project_id,
                 authority_kind, authority_machine_id, authority_installation_id,
                 actor_json, request_id, grant_id
          FROM plugin_permission_grant_events
          WHERE request_id = ? OR grant_id = ?
          ORDER BY created_at ASC, event_kind ASC
        `).all(granted.requestId, granted.grantId) as Array<Record<string, unknown>>;
        expect(auditRows.map((row) => row.event_kind).sort()).toEqual(['granted', 'requested', 'revoked']);
        for (const row of auditRows) {
          expect(row).toMatchObject({
            account_id: account.accountId,
            plugin_id: PLUGIN_ID,
            capability: DIRECT_WRITE_CAPABILITY,
            scope_kind: 'project',
            scope_project_id: 'project-authorized',
            authority_kind: 'machine_installation',
            authority_machine_id: account.machineId,
            authority_installation_id: account.installation.installationId,
            request_id: granted.requestId,
          });
        }
        expect(JSON.parse(String(auditRows.find((row) => row.event_kind === 'requested')?.actor_json))).toEqual({
          kind: 'plugin',
          pluginId: PLUGIN_ID,
          sessionId: 'session-main',
          requestId: 'call-missing-grant',
        });
        for (const eventKind of ['granted', 'revoked']) {
          const row = auditRows.find((candidate) => candidate.event_kind === eventKind);
          expect(row?.grant_id).toBe(granted.grantId);
          expect(JSON.parse(String(row?.actor_json))).toEqual({
            kind: 'user',
            userId: account.accountId,
          });
        }
        const reopenedAudit = auditDb.prepare(`
          SELECT account_id, event_kind, plugin_id, capability, scope_kind, scope_project_id,
                 authority_kind, authority_machine_id, authority_installation_id, actor_json, request_id
          FROM plugin_permission_grant_events
          WHERE request_id = ?
          ORDER BY created_at ASC, event_kind ASC
        `).all(reopenedRequestId) as Array<Record<string, unknown>>;
        expect(reopenedAudit.map((row) => row.event_kind).sort()).toEqual(['dismissed', 'requested']);
        for (const row of reopenedAudit) {
          expect(row).toMatchObject({
            account_id: account.accountId,
            plugin_id: PLUGIN_ID,
            capability: DIRECT_WRITE_CAPABILITY,
            scope_kind: 'project',
            scope_project_id: 'project-authorized',
            authority_kind: 'machine_installation',
            authority_machine_id: account.machineId,
            authority_installation_id: account.installation.installationId,
            request_id: reopenedRequestId,
          });
        }
        expect(JSON.parse(String(reopenedAudit.find((row) => row.event_kind === 'requested')?.actor_json))).toEqual({
          kind: 'plugin',
          pluginId: PLUGIN_ID,
          sessionId: 'session-main',
          requestId: 'call-revoked',
        });
        expect(JSON.parse(String(reopenedAudit.find((row) => row.event_kind === 'dismissed')?.actor_json))).toEqual({
          kind: 'user',
          userId: account.accountId,
        });
      } finally {
        auditDb.close();
      }
    } finally {
      if (previousServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = previousServerUrl;
      if (previousWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = previousWebappUrl;
      getSharedBlockingApprovalCoordinator().dispose('test_complete');
      await server.stop().catch(() => undefined);
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
