import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
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
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
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
  it('reaches the real server effect with current authority and writes without a plugin grant and preserves the encryption boundary', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-review-host-action-'));
    const cwd = join(testDir, 'workspace');
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
      const sourceCustody = {
        kind: 'bundled_first_party' as const,
        packagedRuntime: {
          kind: 'cli_version_root' as const,
          versionRootId: 'test-cli-version-root',
        },
      };
      const readCurrentPluginAuthority = async (): Promise<ReviewCommentHostPluginAuthority | null> => {
        return { sourceCustody };
      };
      expect(await readCurrentPluginAuthority()).toEqual({
        sourceCustody,
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

      const encryptedAccount = await createAccountWithMachine(server.baseUrl);
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
