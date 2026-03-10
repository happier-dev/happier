import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { ApprovalRequestV1Schema } from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import {
  createArtifactViaApi,
  decodeArtifactJsonBase64,
  fetchArtifactViaApi,
  listArtifactsViaApi,
  updateArtifactViaApi,
} from '../../src/testkit/artifactApi';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: approvals artifact roundtrip', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop().catch(() => {});
    server = null;
  }, 60_000);

  it('roundtrips approval request artifacts and exposes status changes through list headers', async () => {
    const testDir = run.testDir(`approvals-artifact-roundtrip-${randomUUID()}`);
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'approvals-artifact-roundtrip',
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifactId = randomUUID();
    const createdAtMs = Date.now();
    const openHeader = {
      v: 1 as const,
      kind: 'approval_request.v1' as const,
      title: 'Approve prompt export',
      approvalStatus: 'open',
      actionId: 'review.start',
      sessionId: 'session-123',
      sessions: ['session-123'],
    };
    const openBody = {
      v: 1 as const,
      status: 'open' as const,
      createdAtMs,
      updatedAtMs: createdAtMs,
      createdBy: { surface: 'session_agent' as const, sessionId: 'session-123', agentId: 'coding' },
      actionId: 'review.start',
      actionArgs: { instructions: 'Review the latest changes', backendIds: ['codex'] },
      summary: 'Approve starting a review run',
      preview: { type: 'review_plan', files: ['src/review.ts'] },
    };

    const rejectedAtMs = createdAtMs + 10_000;
    const rejectedHeader = {
      ...openHeader,
      approvalStatus: 'rejected',
    };
    const rejectedBody = {
      ...openBody,
      status: 'rejected' as const,
      updatedAtMs: rejectedAtMs,
      decision: { kind: 'reject' as const, decidedAtMs: rejectedAtMs },
    };

    const artifacts = new FailureArtifacts();
    artifacts.json('approval.open.header.json', () => openHeader);
    artifacts.json('approval.open.body.json', () => openBody);
    artifacts.json('approval.rejected.header.json', () => rejectedHeader);
    artifacts.json('approval.rejected.body.json', () => rejectedBody);

    let passed = false;
    try {
      const created = await createArtifactViaApi({
        baseUrl: server.baseUrl,
        token: auth.token,
        artifactId,
        headerJson: openHeader,
        bodyJson: openBody,
      });
      expect(created.headerVersion).toBe(1);
      expect(created.bodyVersion).toBe(1);

      const listBefore = await listArtifactsViaApi({ baseUrl: server.baseUrl, token: auth.token });
      artifacts.json('approval.list.before.json', () => listBefore);
      const before = listBefore.find((item) => item.id === artifactId);
      expect(before).toBeTruthy();
      expect((decodeArtifactJsonBase64<Record<string, unknown>>(before!.header)).approvalStatus).toBe('open');

      const updateResult = await updateArtifactViaApi({
        baseUrl: server.baseUrl,
        token: auth.token,
        artifactId,
        headerJson: rejectedHeader,
        expectedHeaderVersion: created.headerVersion,
        bodyJson: rejectedBody,
        expectedBodyVersion: created.bodyVersion,
      });
      artifacts.json('approval.update.result.json', () => updateResult);
      expect(updateResult.success).toBe(true);
      if (updateResult.success) {
        expect(updateResult.headerVersion).toBe(2);
        expect(updateResult.bodyVersion).toBe(2);
      }

      const fetched = await fetchArtifactViaApi({ baseUrl: server.baseUrl, token: auth.token, artifactId });
      artifacts.json('approval.fetched.after.json', () => fetched);
      const parsed = ApprovalRequestV1Schema.parse(decodeArtifactJsonBase64<unknown>(fetched.body));
      expect(parsed.status).toBe('rejected');
      expect(parsed.decision?.kind).toBe('reject');

      const listAfter = await listArtifactsViaApi({ baseUrl: server.baseUrl, token: auth.token });
      artifacts.json('approval.list.after.json', () => listAfter);
      const after = listAfter.find((item) => item.id === artifactId);
      expect(after).toBeTruthy();
      expect((decodeArtifactJsonBase64<Record<string, unknown>>(after!.header)).approvalStatus).toBe('rejected');

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
    }
  }, 240_000);
});
