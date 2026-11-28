import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionExecutorContext, ReviewCommentCreateRequestV1 } from '@happier-dev/protocol';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { registerTranscriptSecret, TRANSCRIPT_SECRET_REDACTED } from '@/api/session/client/transport/transcriptSecretRedaction';

import {
  createReviewCommentHostActionMaterializer,
  resolveReviewCommentHostPluginAuthority,
  type ReviewCommentHostActionCandidate,
  type ReviewCommentHostPluginAuthority,
} from './hostActionMaterializer';

// Snapshot policy and proposal preparation remain real; only filesystem reads are counted.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const roots: string[] = [];
const releaseSecrets: Array<() => void> = [];
afterEach(async () => {
  for (const release of releaseSecrets.splice(0)) release();
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
      extensions: { 'acme.review': { source: 'slice-1', evidence: ['native'] } },
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
  sourceCustody: {
    kind: 'managed',
    immutableGenerationId: 'generation-1',
    installSource: 'archive',
  },
});

describe('createReviewCommentHostActionMaterializer', () => {
  it('reads a shared file once for independent proposals and retains their ordered snapshots', async () => {
    const cwd = await fixture();
    const snapshots: unknown[] = [];
    const materialize = createReviewCommentHostActionMaterializer({
      cwd, isRunActive: () => true, readCurrentCandidate: twoProposalCandidate,
      readCurrentPluginAuthority: async () => currentPluginAuthority,
      resolveWorkspace: async () => ({ projectId: 'project-1', workspaceId: 'workspace-1', serverId: 'server-1' }),
      requestCurrentIntent: async subject => ({ status: 'approved', fingerprint: subject.subjectFingerprint }),
      executeHostAction: async (_actionId, input) => {
        snapshots.push(input.snapshot);
        return { ok: true, result: { comment: { id: `comment-${snapshots.length}` }, replayed: false } };
      },
    });
    vi.mocked(readFile).mockClear();
    expect(await materialize()).toMatchObject({ ok: true, result: { status: 'created', comments: [
      { findingId: 'finding-1', commentId: 'comment-1' }, { findingId: 'finding-2', commentId: 'comment-2' },
    ] } });
    expect(vi.mocked(readFile).mock.calls.filter(([path]) => String(path) === join(cwd, 'a.ts'))).toHaveLength(1);
    expect(snapshots).toMatchObject([{ selectedLines: ['two'] }, { selectedLines: ['three'] }]);
  });
  it('admits review-comment host effects only through an applied final-policy generation', () => {
    const occurrenceId = createPluginRuntimeOccurrenceId('acme.review-current');
    const current = {
      occurrenceId,
      sourceCustody: currentPluginAuthority.sourceCustody,
      desiredOccurrenceId: occurrenceId,
      appliedOccurrenceId: occurrenceId,
      applied: true,
      selectedAccess: [],
    } as const;

    expect(resolveReviewCommentHostPluginAuthority({
      pluginId: 'acme.review',
      current,
      sourceCustody: currentPluginAuthority.sourceCustody,
    })).toEqual(currentPluginAuthority);
    expect(resolveReviewCommentHostPluginAuthority({
      pluginId: 'acme.review',
      current: {
        ...current,
        applied: false,
        appliedOccurrenceId: null,
      },
      sourceCustody: currentPluginAuthority.sourceCustody,
    })).toBeNull();
    expect(resolveReviewCommentHostPluginAuthority({
      pluginId: 'acme.review',
      current: null,
      sourceCustody: null,
    })).toBeNull();
  });

  it('binds approved intent once and dispatches deterministic canonical host actions', async () => {
    const cwd = await fixture();
    let current: ReviewCommentHostActionCandidate | null = candidate();
    let candidateReads = 0;
    const dispatches: Array<Readonly<{ input: ReviewCommentCreateRequestV1; context: ActionExecutorContext }>> = [];
    const materialize = createReviewCommentHostActionMaterializer({
      cwd,
      isRunActive: () => true,
      readCurrentCandidate: () => { candidateReads += 1; return current; },
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
    expect(candidateReads).toBe(2);
    expect(dispatches[0]?.input).toMatchObject({
      projectId: 'project-1', workspaceId: 'workspace-1', sessionId: 'session-1', runId: 'run-1',
      engineId: 'acme.review', findingId: 'finding-1', authorIntent: 'propose',
      anchor: { kind: 'line', filePath: 'a.ts', line: 2 },
      snapshot: { kind: 'text', selectedLines: ['two'] },
      metadata: { severity: 'warning' },
      extensions: { 'acme.review': { source: 'slice-1', evidence: ['native'] } },
      fingerprint: expect.objectContaining({ engineId: 'acme.review' }),
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
      sourceCustody: currentPluginAuthority.sourceCustody,
    });
    current = null;
  });

  it('creates no comments when intent is denied, its fingerprint differs, or a snapshot is unavailable', async () => {
    const cwd = await fixture();
    let current: ReviewCommentHostActionCandidate | null = candidate();
    let mode: 'denied' | 'fingerprint' | 'missing' = 'denied';
    let dispatchCount = 0;
    const materialize = createReviewCommentHostActionMaterializer({
      cwd,
      isRunActive: () => true,
      readCurrentCandidate: () => mode === 'missing'
        ? {
          ...twoProposalCandidate(),
          proposals: [
            twoProposalCandidate().proposals[0]!,
            { body: 'Missing.', anchor: { kind: 'line', filePath: 'missing.ts', line: 1 } },
          ],
        }
        : current,
      readCurrentPluginAuthority: async () => currentPluginAuthority,
      resolveWorkspace: async () => ({ projectId: 'project-1', workspaceId: 'workspace-1', serverId: 'server-1' }),
      requestCurrentIntent: async (subject) => {
        if (mode === 'denied') return { status: 'rejected', code: 'execution_run_host_action_current_intent_rejected' };
        return { status: 'approved', fingerprint: mode === 'fingerprint' ? 'different-fingerprint' : subject.subjectFingerprint };
      },
      executeHostAction: async () => {
        dispatchCount += 1;
        return { ok: true, result: {} };
      },
    });

    await expect(materialize()).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_host_action_current_intent_rejected' });
    mode = 'fingerprint';
    await expect(materialize()).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_host_action_current_intent_mismatch' });
    mode = 'missing';
    current = candidate();
    await expect(materialize()).resolves.toMatchObject({ ok: false, errorCode: 'review_comment_snapshot_unavailable' });
    expect(dispatchCount).toBe(0);
  });

  it.each(['source', 'policy', 'candidate'] as const)('writes the exact prepared operands once after an approved %s changes', async (change) => {
    const cwd = await fixture();
    let current = candidate();
    let authority: ReviewCommentHostPluginAuthority | null = currentPluginAuthority;
    const dispatched: ReviewCommentCreateRequestV1[] = [];
    const materialize = createReviewCommentHostActionMaterializer({
      cwd,
      isRunActive: () => true,
      readCurrentCandidate: () => current,
      readCurrentPluginAuthority: async () => authority,
      resolveWorkspace: async () => ({ projectId: 'project-1', workspaceId: 'workspace-1', serverId: 'server-1' }),
      requestCurrentIntent: async (subject) => {
        if (change === 'source') authority = { sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-2', installSource: 'archive' } };
        if (change === 'policy') authority = null;
        if (change === 'candidate') current = { ...candidate(), callId: 'call-2', proposals: [{ ...candidate().proposals[0]!, body: 'A later proposal.' }] };
        await writeFile(join(cwd, 'a.ts'), 'Changed after approval.\n', 'utf8');
        return { status: 'approved', fingerprint: subject.subjectFingerprint };
      },
      executeHostAction: async (_actionId, input) => {
        dispatched.push(input);
        return { ok: true, result: { comment: { id: 'comment-1' }, replayed: false } };
      },
    });

    await expect(materialize()).resolves.toMatchObject({ ok: true, result: { status: 'created', comments: [{ commentId: 'comment-1' }] } });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ body: 'Use the canonical owner.', runId: 'run-1', snapshot: { selectedLines: ['two'] } });
  });

  it.each(['returned', 'thrown'] as const)('retains a %s typed refusal while continuing later proposals', async (mode) => {
    const cwd = await fixture();
    const secret = 'synthetic-review-publish-secret';
    releaseSecrets.push(registerTranscriptSecret(secret));
    const failure = { ok: false as const, errorCode: 'review_comment_permission_denied', error: `The reviewer cannot publish with ${secret}.`,
      requestId: 'review-create-request', effectAttempted: false,
      failureCause: { phase: 'review.comments.create', errorClass: 'HttpStatusError' as const,
        errorCode: 'review_comment_permission_denied', httpStatus: 403 } };
    const dispatchedMutationIds: string[] = [];
    const materialize = createReviewCommentHostActionMaterializer({
      cwd,
      isRunActive: () => true,
      readCurrentCandidate: twoProposalCandidate,
      readCurrentPluginAuthority: async () => currentPluginAuthority,
      resolveWorkspace: async () => ({ projectId: 'project-1', workspaceId: 'workspace-1', serverId: 'server-1' }),
      requestCurrentIntent: async (subject) => ({ status: 'approved', fingerprint: subject.subjectFingerprint }),
      executeHostAction: async (_actionId, input) => {
        dispatchedMutationIds.push(input.clientMutationId);
        if (input.findingId === 'finding-1') {
          if (mode === 'thrown') throw createActionExecuteFailureError(failure);
          return failure;
        }
        return { ok: true, result: { comment: { id: 'comment-2' }, replayed: false } };
      },
    });

    const { ok: _ok, ...diagnostic } = failure;
    await expect(materialize()).resolves.toMatchObject({
      ok: true,
      result: {
        status: 'partial',
        comments: [{ findingId: 'finding-2', commentId: 'comment-2', replayed: false }],
        failures: [{ findingId: 'finding-1', ...diagnostic, error: `The reviewer cannot publish with ${TRANSCRIPT_SECRET_REDACTED}.` }],
      },
    });
    expect(dispatchedMutationIds).toHaveLength(2);
    expect(dispatchedMutationIds.every((id) => id.length <= 191)).toBe(true);
  });

  it('stops remaining proposal effects when the approved run is cancelled after a partial prefix', async () => {
    const cwd = await fixture();
    let current: ReviewCommentHostActionCandidate | null = twoProposalCandidate();
    let dispatchCount = 0;
    const materialize = createReviewCommentHostActionMaterializer({
      cwd,
      isRunActive: () => current !== null,
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
