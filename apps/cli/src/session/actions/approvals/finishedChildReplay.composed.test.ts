import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  AccountSettingsSchema, ApprovalRequestV2Schema, FeaturesResponseSchema, createActionExecutor,
  type ApprovalRequest,
} from '@happier-dev/protocol';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ReviewCommentV1Schema } from '@happier-dev/protocol/reviews/comments/v1';
import { REVIEW_COMMENT_PRINCIPAL_HEADER_V1, ReviewCommentActionInputSchemasV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createCliActionExecutorFromCredentials } from '../createCliActionExecutorFromCredentials';

// Only authenticated HTTP and RPC boundaries are substituted. The CLI executor, its
// executionRunGet adapter/service, strict codecs and approval replay stay real.
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc: rpc }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rpc.mockReset();
  resetActiveAccountSettingsSnapshotForTests();
});

describe('finished child approval through the credentialed CLI replay owner', () => {
  // A later Run occurrence does not withdraw an exact reviewed approval.
  it.each(['unchanged', 'replaced'] as const)(
    'executes the approved finished-child effect once when the Run occurrence is %s', async scenario => {
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_TOKEN',
        'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE', 'HAPPIER_ACCOUNT_SETTINGS_MODE', 'HAPPIER_ACTIONS_SETTINGS_V1']);
      try {
        await withTempDir('happier-finished-child-replay-', async homeDir => {
          const endpoint = 'https://finished-child.example.test';
          env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: endpoint, HAPPIER_WEBAPP_URL: endpoint,
            HAPPIER_TOKEN: undefined, HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined,
            HAPPIER_ACCOUNT_SETTINGS_MODE: 'auto', HAPPIER_ACTIONS_SETTINGS_V1: undefined });
          reloadConfiguration();
          const serverId = configuration.activeServerId;
          const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', provenance: {
            v: 1, kind: 'terminal', authority: 'account_automation',
          } })).toString('base64url')}.signature`;
          const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
          const settings = AccountSettingsSchema.parse({});
          setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKeyForToken(token)!,
            loadedAtMs: 1, settingsVersion: 1, settingsSecretsReadKeys: [], settings });
          const features = FeaturesResponseSchema.parse({ features: {},
            capabilities: { serverIdentity: { serverIdentityId: 'srv_finished_child' } } });
          const sessionId = 'c123456789012345678901234';
          const workspace = { machineId: 'machine', path: '/workspace' };
          let comment = ReviewCommentV1Schema.parse({ v: 1, id: 'comment', accountId: 'account', workspace, sessionId,
            anchor: { kind: 'file', filePath: 'a.ts' }, snapshot: { kind: 'none', capturedAt: 1 }, body: 'Original finding',
            bodyVersion: 1, edits: [], author: { kind: 'plugin', pluginId: 'acme.external-review' }, state: 'open', flags: {},
            dispositions: {}, threadId: 'comment', transitions: [], createdAt: 1, updatedAt: 1, serverRevision: 1 });
          let created: ApprovalRequest | null = null;
          // Produce the exact deferred child proposal through the canonical owner.
          await expect(createActionExecutor({ ...createUnavailableActionTransportDeps(), approvalsCreate: async ({ request }) => {
            created = request; return { artifactId: 'approval' };
          } }).execute('reviews.comments.edit', { workspace, commentId: 'comment', expectedServerRevision: 1,
            expectedBodyVersion: 1, nextBody: 'Approved edit', clientMutationId: 'edit' }, {
            surface: 'agent', authority: 'account_automation', serverId, serverIdentityId: 'srv_finished_child',
            defaultSessionId: sessionId, defaultSessionMachineId: 'machine', runtimeAccountId: 'account',
            runtimeRunId: 'run-child', runtimeRunOccurrenceId: 'original-occurrence', actionRequestId: 'proposal',
            actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
          })).resolves.toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
          const approval = ApprovalRequestV2Schema.parse(created);
          let artifact = { id: 'approval', ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
          const session = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain', machineId: 'machine',
            metadata: JSON.stringify(await createTestMetadata({ machineId: 'machine', path: '/workspace' })) });
          const run = ExecutionRunGetResponseSchema.parse({ run: { runId: 'run-child', callId: 'call', sidechainId: 'side',
            intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
            retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', startedAtMs: 1, finishedAtMs: 2,
            status: 'succeeded', inputTurns: { occurrenceId: scenario === 'replaced' ? 'replacement-occurrence' : 'original-occurrence' } } });
          rpc.mockImplementation(async (request: { method: string; sessionId: string }) => {
            expect(request.sessionId).toBe(sessionId);
            expect(request.method).toBe(`${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}`);
            return run;
          });
          const currentness = createAccountEncryptionCurrentnessFixture({ mode: 'plain' });
          vi.stubGlobal('fetch', async (input: string | URL | Request) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            if (path === '/v1/account/encryption/currentness') return Response.json(currentness);
            throw new Error(`Unexpected fetch: ${path}`);
          });
          vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'account' } };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
            if (path === '/v1/account/settings' || path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: settings } } };
            if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session } };
            if (path === '/v1/artifacts/approval') return { status: 200, data: { ...artifact } };
            throw new Error(`Unexpected HTTP read: ${path}`);
          });
          let effects = 0;
          vi.spyOn(axios, 'post').mockImplementation(async (url, input) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/artifacts/approval') {
              expect(input.expectedHeaderVersion).toBe(artifact.headerVersion);
              expect(input.expectedBodyVersion).toBe(artifact.bodyVersion);
              artifact = { ...artifact, header: input.header, body: input.body,
                headerVersion: artifact.headerVersion + 1, bodyVersion: artifact.bodyVersion + 1 };
              return { status: 200, data: { success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
            }
            throw new Error(`Unexpected HTTP mutation: ${path}`);
          });
          vi.spyOn(axios, 'patch').mockImplementation(async (url, input, options) => {
            expect(new URL(String(url)).pathname).toBe('/v1/reviews/comments/comment');
            expect(options?.headers).not.toHaveProperty(REVIEW_COMMENT_PRINCIPAL_HEADER_V1);
            const body = ReviewCommentActionInputSchemasV1['reviews.comments.edit'].parse({ commentId: 'comment', ...input });
            comment = ReviewCommentV1Schema.parse({ ...comment, body: body.nextBody, bodyVersion: 2, serverRevision: 2 });
            effects += 1;
            return { status: 200, data: { comment } };
          });
          const executor = createCliActionExecutorFromCredentials({ credentials, serverId, serverApiUrl: endpoint,
            serverIdentityId: 'srv_finished_child' });
          const decide = () => executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
            surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
          });
          // The same adapter already works through the public Action normalizer.
          await expect(executor.execute('execution.run.get', { sessionId, runId: 'run-child' }, { surface: 'cli' }))
            .resolves.toMatchObject({ ok: true, result: run });
          const runReadsBeforeDecision = rpc.mock.calls.length;
          const decision = await decide();
          expect(decision, JSON.stringify(decision)).toMatchObject(
            { ok: true, result: { status: 'executed', execution: { ok: true } } });
          // The approval owner no longer reads the Run to decide currentness.
          expect(rpc.mock.calls.length).toBe(runReadsBeforeDecision);
          expect(comment.body).toBe('Approved edit');
          expect(comment.author).toEqual({ kind: 'plugin', pluginId: 'acme.external-review' });
          expect(effects).toBe(1);
          await decide();
          expect(effects).toBe(1);
        });
      } finally {
        env.restore();
        reloadConfiguration();
      }
    },
  );
});
