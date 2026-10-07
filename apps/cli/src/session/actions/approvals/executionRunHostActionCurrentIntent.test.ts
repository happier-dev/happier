import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import type { ExecutionRunHostActionApprovalRequestV1 } from '@happier-dev/protocol';

import { createExecutionRunHostActionCurrentIntentAdapter } from './executionRunHostActionCurrentIntent';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';

const subject = {
  actionId: 'reviews.comments.create' as const,
  sessionId: 'session-1',
  runId: 'run-1',
  callId: 'call-1',
  profileId: 'acme.review/review',
  pluginId: 'acme.review',
  agentId: 'claude',
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  serverId: 'server-1',
  proposals: [{ body: 'Fix this.', anchor: { kind: 'line' as const, filePath: 'src/a.ts', line: 3 } }],
  subjectFingerprint: 'a'.repeat(64),
};

describe('createExecutionRunHostActionCurrentIntentAdapter', () => {
  it('accepts the matching approved subject after a durable artifact invalidation', async () => {
    const stored: { request: ExecutionRunHostActionApprovalRequestV1 | null } = { request: null };
    let onChange = () => {};
    let subscribedArtifactId = '';
    const dispose = vi.fn();
    const requestIntent = createExecutionRunHostActionCurrentIntentAdapter({
      now: () => 10,
      create: async (request) => { stored.request = request; return { artifactId: 'artifact-other-device' }; },
      read: async () => stored.request,
      subscribeChanges: (artifactId, change) => {
        subscribedArtifactId = artifactId;
        onChange = change;
        return { dispose };
      },
    });
    const pending = requestIntent(subject);
    await Promise.resolve();
    expect(subscribedArtifactId).toBe('artifact-other-device');
    if (!stored.request) throw new Error('approval_not_created');
    stored.request = { ...stored.request, status: 'approved', updatedAtMs: 11, decision: { kind: 'approve', decidedAtMs: 11 } };
    onChange();
    await expect(pending).resolves.toEqual({ status: 'approved', fingerprint: subject.subjectFingerprint });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('creates a typed durable subject and accepts only its matching approval', async () => {
    let stored: ExecutionRunHostActionApprovalRequestV1 | null = null;
    const requestIntent = createExecutionRunHostActionCurrentIntentAdapter({
      now: () => 10,
      create: async (request) => {
        stored = request;
        queueMicrotask(() => {
          const approved: ExecutionRunHostActionApprovalRequestV1 = {
            ...request,
            status: 'approved',
            updatedAtMs: 11,
            decision: { kind: 'approve', decidedAtMs: 11 },
          };
          stored = approved;
          getSharedBlockingApprovalCoordinator().notifyApprovalUpdated({ artifactId: 'artifact-1', request: approved });
        });
        return { artifactId: 'artifact-1' };
      },
      read: async () => stored,
    });

    await expect(requestIntent(subject)).resolves.toEqual({ status: 'approved', fingerprint: subject.subjectFingerprint });
    expect(stored).toMatchObject({
      kind: 'execution_run_host_action', runId: 'run-1', proposalCount: 1,
      proposalPreview: [expect.objectContaining({
        pathLabel: 'src/a.ts', bodyPreview: 'Fix this.', bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })],
    });
  });

  it('fails closed when the decided artifact mutates the approved subject', async () => {
    let stored: ExecutionRunHostActionApprovalRequestV1 | null = null;
    const requestIntent = createExecutionRunHostActionCurrentIntentAdapter({
      now: () => 10,
      create: async (request) => {
        queueMicrotask(() => {
          stored = {
            ...request,
            runId: 'other-run',
            status: 'approved',
            updatedAtMs: 11,
            decision: { kind: 'approve', decidedAtMs: 11 },
          };
          getSharedBlockingApprovalCoordinator().notifyApprovalUpdated({
            artifactId: 'artifact-2',
            request: stored,
          });
        });
        return { artifactId: 'artifact-2' };
      },
      read: async () => stored,
    });

    await expect(requestIntent(subject)).resolves.toEqual({
      status: 'unavailable',
      code: 'execution_run_host_action_current_intent_mismatch',
    });
  });

  it('redacts approval previews while binding hashes to the original proposal', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const createdRequests: ExecutionRunHostActionApprovalRequestV1[] = [];
    const requestIntent = createExecutionRunHostActionCurrentIntentAdapter({
      now: () => 10,
      create: async (request) => {
        createdRequests[0] = request;
        queueMicrotask(() => {
          const approved: ExecutionRunHostActionApprovalRequestV1 = {
            ...request,
            status: 'approved',
            updatedAtMs: 11,
            decision: { kind: 'approve', decidedAtMs: 11 },
          };
          createdRequests[0] = approved;
          getSharedBlockingApprovalCoordinator().notifyApprovalUpdated({ artifactId: 'artifact-secret', request: approved });
        });
        return { artifactId: 'artifact-secret' };
      },
      read: async () => createdRequests[0] ?? null,
    });
    const body = `Please remove leaked token ${secret}`;
    const filePath = `fixtures/${secret}.txt`;

    await expect(requestIntent({
      ...subject,
      proposals: [{ body, anchor: { kind: 'file', filePath } }],
    })).resolves.toEqual({ status: 'approved', fingerprint: subject.subjectFingerprint });

    expect(createdRequests[0]?.proposalPreview[0]).toMatchObject({
      pathLabel: 'fixtures/[REDACTED].txt',
      pathSha256: createHash('sha256').update(filePath).digest('hex'),
      bodyPreview: 'Please remove leaked token [REDACTED]',
      bodySha256: createHash('sha256').update(body).digest('hex'),
    });
  });
});
