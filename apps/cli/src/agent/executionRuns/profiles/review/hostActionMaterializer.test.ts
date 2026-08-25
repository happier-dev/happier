import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { ActionExecutorContext, ReviewCommentCreateRequestV1 } from '@happier-dev/protocol';

import {
  createReviewCommentHostActionMaterializer,
  resolveReviewCommentHostPluginAuthority,
  type ReviewCommentHostActionCandidate,
  type ReviewCommentHostPluginAuthority,
} from './hostActionMaterializer';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'happier-review-host-action-'));
  roots.push(cwd);
  await writeFile(join(cwd, 'a.ts'), 'one\ntwo\nthree\n', 'utf8');
  return cwd;
}

function candidate(): ReviewCommentHostActionCandidate {
  return {
    actionId: 'reviews.comments.create',
    sessionId: 'session-1',
    runId: 'run-1',
    callId: 'call-1',
    profileId: 'acme.review/review',
    pluginId: 'acme.review',
    agentId: 'claude',
    proposals: [{
      findingId: 'finding-1',
      body: 'Use the canonical owner.',
      anchor: { kind: 'line', filePath: 'a.ts', line: 2 },
      severity: 'warning',
    }],
  };
}

function twoProposalCandidate(): ReviewCommentHostActionCandidate {
  return {
    ...candidate(),
    proposals: [
      candidate().proposals[0]!,
      {
        findingId: 'finding-2',
        body: 'Keep the dispatch bounded.',
        anchor: { kind: 'line', filePath: 'a.ts', line: 3 },
      },
    ],
  };
}

const currentPluginAuthority: ReviewCommentHostPluginAuthority = Object.freeze({
  immutableGenerationId: 'generation-1',
});

describe('createReviewCommentHostActionMaterializer', () => {
  it('admits review-comment host effects only through an applied final-policy generation', () => {
    const current = {
      immutableGenerationId: 'generation-1',
      desiredImmutableGenerationId: 'generation-1',
      appliedImmutableGenerationId: 'generation-1',
      applied: true,
      selectedAccess: [],
    } as const;

    expect(resolveReviewCommentHostPluginAuthority({
      pluginId: 'acme.review',
      current,
    })).toEqual(currentPluginAuthority);
    expect(resolveReviewCommentHostPluginAuthority({
      pluginId: 'acme.review',
      current: {
        ...current,
        applied: false,
        appliedImmutableGenerationId: null,
      },
    })).toBeNull();
    expect(resolveReviewCommentHostPluginAuthority({
      pluginId: 'acme.review',
      current: null,
    })).toBeNull();
  });

  it('revalidates current intent and dispatches deterministic canonical host actions', async () => {
    const cwd = await fixture();
    let current: ReviewCommentHostActionCandidate | null = candidate();
    const dispatches: Array<Readonly<{ input: ReviewCommentCreateRequestV1; context: ActionExecutorContext }>> = [];
    const materialize = createReviewCommentHostActionMaterializer({
      cwd,
      readCurrentCandidate: () => current,
      readCurrentPluginAuthority: async () => currentPluginAuthority,
      resolveWorkspace: async () => ({ projectId: 'project-1', workspaceId: 'workspace-1', serverId: 'server-1' }),
      requestCurrentIntent: async (subject) => ({ status: 'approved', fingerprint: subject.subjectFingerprint }),
      executeHostAction: async (_actionId, input, context) => {
        dispatches.push({ input, context });
        return { ok: true, result: { comment: { id: 'comment-1' }, replayed: dispatches.length > 1 } };
      },
    });

    const first = await materialize();
    const second = await materialize();
    expect(first).toEqual({ ok: true, result: { status: 'created', comments: [{ findingId: 'finding-1', commentId: 'comment-1', replayed: false }] } });
    expect(second).toEqual({ ok: true, result: { status: 'created', comments: [{ findingId: 'finding-1', commentId: 'comment-1', replayed: true }] } });
    expect(dispatches).toHaveLength(2);
    expect(dispatches[0]?.input).toMatchObject({
      projectId: 'project-1', workspaceId: 'workspace-1', sessionId: 'session-1', runId: 'run-1',
      engineId: 'acme.review', findingId: 'finding-1', authorIntent: 'propose',
      anchor: { kind: 'line', filePath: 'a.ts', line: 2 },
      snapshot: { kind: 'text', selectedLines: ['two'] },
      metadata: { severity: 'warning' },
      linkedRefs: [{ kind: 'executionRun', id: 'run-1' }, { kind: 'session', id: 'session-1' }],
    });
    expect(dispatches[0]?.input.clientMutationId).toMatch(/^review-run:[a-f0-9]{64}$/);
    expect(dispatches[1]?.input.clientMutationId).toBe(dispatches[0]?.input.clientMutationId);
    expect(dispatches[0]?.context).toMatchObject({
      surface: 'rpc', defaultSessionId: 'session-1', serverId: 'server-1', bypassApprovals: true,
      reviewCommentPrincipal: { actor: { kind: 'agent', agentId: 'claude', sessionId: 'session-1' } },
    });
    expect(dispatches[0]?.context.reviewCommentPrincipal?.currentIntent).toEqual({
      v: 1,
      kind: 'execution_run_host_action',
      actionId: 'reviews.comments.create',
      subjectFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      effectBodySha256Base64Url: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      sessionId: 'session-1',
      runId: 'run-1',
      callId: 'call-1',
      profileId: 'acme.review/review',
      pluginId: 'acme.review',
      agentId: 'claude',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      immutableGenerationId: 'generation-1',
    });
    current = null;
  });

  it('creates no comments when current intent is denied, the run changes, or a snapshot is unavailable', async () => {
    const cwd = await fixture();
    let current: ReviewCommentHostActionCandidate | null = candidate();
    let mode: 'denied' | 'stale' | 'authority' | 'missing' = 'denied';
    let authority = currentPluginAuthority;
    let dispatchCount = 0;
    const materialize = createReviewCommentHostActionMaterializer({
      cwd,
      readCurrentCandidate: () => mode === 'missing'
        ? {
          ...twoProposalCandidate(),
          proposals: [
            twoProposalCandidate().proposals[0]!,
            { body: 'Missing.', anchor: { kind: 'line', filePath: 'missing.ts', line: 1 } },
          ],
        }
        : current,
      readCurrentPluginAuthority: async () => authority,
      resolveWorkspace: async () => ({ projectId: 'project-1', workspaceId: 'workspace-1', serverId: 'server-1' }),
      requestCurrentIntent: async (subject) => {
        if (mode === 'denied') return { status: 'rejected', code: 'execution_run_host_action_current_intent_rejected' };
        if (mode === 'stale') current = { ...candidate(), callId: 'call-2' };
        if (mode === 'authority') authority = { ...currentPluginAuthority, immutableGenerationId: 'generation-2' };
        return { status: 'approved', fingerprint: subject.subjectFingerprint };
      },
      executeHostAction: async () => {
        dispatchCount += 1;
        return { ok: true, result: {} };
      },
    });

    await expect(materialize()).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_host_action_current_intent_rejected' });
    mode = 'stale';
    current = candidate();
    await expect(materialize()).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_host_action_stale' });
    mode = 'authority';
    current = candidate();
    authority = currentPluginAuthority;
    await expect(materialize()).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_host_action_stale' });
    mode = 'missing';
    current = candidate();
    authority = currentPluginAuthority;
    await expect(materialize()).resolves.toMatchObject({ ok: false, errorCode: 'review_comment_snapshot_unavailable' });
    expect(dispatchCount).toBe(0);
  });

  it('bounds thrown action failures and continues later proposals with deterministic partial truth', async () => {
    const cwd = await fixture();
    const dispatchedMutationIds: string[] = [];
    const materialize = createReviewCommentHostActionMaterializer({
      cwd,
      readCurrentCandidate: twoProposalCandidate,
      readCurrentPluginAuthority: async () => currentPluginAuthority,
      resolveWorkspace: async () => ({ projectId: 'project-1', workspaceId: 'workspace-1', serverId: 'server-1' }),
      requestCurrentIntent: async (subject) => ({ status: 'approved', fingerprint: subject.subjectFingerprint }),
      executeHostAction: async (_actionId, input) => {
        dispatchedMutationIds.push(input.clientMutationId);
        if (input.findingId === 'finding-1') throw new Error('transport secret must not escape');
        return { ok: true, result: { comment: { id: 'comment-2' }, replayed: false } };
      },
    });

    await expect(materialize()).resolves.toEqual({
      ok: true,
      result: {
        status: 'partial',
        comments: [{ findingId: 'finding-2', commentId: 'comment-2', replayed: false }],
        failures: [{ findingId: 'finding-1', errorCode: 'review_comment_action_failed' }],
      },
    });
    expect(dispatchedMutationIds).toHaveLength(2);
    expect(dispatchedMutationIds.every((id) => id.length <= 191)).toBe(true);
  });

  it('requests one exact project grant after denial, stops the batch, and requires fresh intent before retry', async () => {
    const cwd = await fixture();
    let granted = false;
    let currentIntentCount = 0;
    const dispatches: string[] = [];
    const grantRequests: unknown[] = [];
    const materialize = createReviewCommentHostActionMaterializer({
      cwd,
      readCurrentCandidate: twoProposalCandidate,
      readCurrentPluginAuthority: async () => currentPluginAuthority,
      resolveWorkspace: async () => ({ projectId: 'project-1', workspaceId: 'workspace-1', serverId: 'server-1' }),
      requestCurrentIntent: async (subject) => {
        currentIntentCount += 1;
        return { status: 'approved', fingerprint: subject.subjectFingerprint };
      },
      requestDirectWriteGrant: async (input) => {
        grantRequests.push(input);
      },
      executeHostAction: async (_actionId, input) => {
        dispatches.push(input.findingId ?? 'missing');
        if (!granted) {
          return {
            ok: false,
            errorCode: 'review_comment_direct_write_permission_required',
            error: 'Direct write grant required',
          };
        }
        return { ok: true, result: { comment: { id: `comment-${input.findingId}` }, replayed: false } };
      },
    });

    await expect(materialize()).resolves.toEqual({
      ok: true,
      result: {
        status: 'failed',
        comments: [],
        failures: [
          { findingId: 'finding-1', errorCode: 'review_comment_direct_write_permission_required' },
          { findingId: 'finding-2', errorCode: 'review_comment_direct_write_permission_required' },
        ],
      },
    });
    expect(dispatches).toEqual(['finding-1']);
    expect(grantRequests).toEqual([{
      pluginId: 'acme.review',
      capability: 'reviews.comments.write.direct',
      targetScope: { kind: 'project', projectId: 'project-1' },
      subject: { kind: 'general' },
      requester: {
        kind: 'plugin',
        pluginId: 'acme.review',
        sessionId: 'session-1',
        requestId: 'call-1',
      },
      reason: 'Write approved review comments directly.',
      serverId: 'server-1',
    }]);

    granted = true;
    await expect(materialize()).resolves.toMatchObject({
      ok: true,
      result: { status: 'created' },
    });
    expect(currentIntentCount).toBe(2);
    expect(dispatches).toEqual(['finding-1', 'finding-1', 'finding-2']);
    expect(grantRequests).toHaveLength(1);
  });

  it('does not request a grant for other action failures', async () => {
    const cwd = await fixture();
    let requestCount = 0;
    const materialize = createReviewCommentHostActionMaterializer({
      cwd,
      readCurrentCandidate: twoProposalCandidate,
      readCurrentPluginAuthority: async () => currentPluginAuthority,
      resolveWorkspace: async () => ({ projectId: 'project-1', workspaceId: 'workspace-1', serverId: 'server-1' }),
      requestCurrentIntent: async (subject) => ({ status: 'approved', fingerprint: subject.subjectFingerprint }),
      requestDirectWriteGrant: async () => {
        requestCount += 1;
      },
      executeHostAction: async () => ({ ok: false, errorCode: 'review_comment_permission_denied', error: 'Denied' }),
    });

    await expect(materialize()).resolves.toMatchObject({
      ok: true,
      result: { status: 'failed' },
    });
    expect(requestCount).toBe(0);
  });

  it('stops remaining proposal effects when the approved run is cancelled after a partial prefix', async () => {
    const cwd = await fixture();
    let current: ReviewCommentHostActionCandidate | null = twoProposalCandidate();
    let dispatchCount = 0;
    const materialize = createReviewCommentHostActionMaterializer({
      cwd,
      readCurrentCandidate: () => current,
      readCurrentPluginAuthority: async () => currentPluginAuthority,
      resolveWorkspace: async () => ({ projectId: 'project-1', workspaceId: 'workspace-1', serverId: 'server-1' }),
      requestCurrentIntent: async (subject) => ({ status: 'approved', fingerprint: subject.subjectFingerprint }),
      executeHostAction: async (_actionId, input) => {
        dispatchCount += 1;
        current = null;
        return { ok: true, result: { comment: { id: `comment-${input.findingId}` }, replayed: false } };
      },
    });

    await expect(materialize()).resolves.toEqual({
      ok: true,
      result: {
        status: 'partial',
        comments: [{ findingId: 'finding-1', commentId: 'comment-finding-1', replayed: false }],
        failures: [{ findingId: 'finding-2', errorCode: 'execution_run_host_action_stale' }],
      },
    });
    expect(dispatchCount).toBe(1);
  });
});
