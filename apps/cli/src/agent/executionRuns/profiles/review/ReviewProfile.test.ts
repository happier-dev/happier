import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecutionRunStartRequest } from '@happier-dev/protocol';
import { resolveScmPullRequestReviewScope } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ReviewProfile } from './ReviewProfile';

/**
 * The daemon-applied plugin runtime registry is a different process, and this
 * is a unit process: `runWithScmBackendRegistryLease` therefore refuses with
 * `PLUGIN_DAEMON_RUNTIME_UNAVAILABLE` and every `prepareStartParams` case in
 * this file throws before reaching the behavior under test. Mock exactly that
 * boundary — the same one the scope resolver's own test mocks — and leave
 * `resolveReviewScmScope` and the profile itself real beneath it. With no
 * backend selectable the resolver reaches its genuine `not_repository` arm.
 */
const scmCatalogMock = vi.hoisted(() => ({
  runWithScmBackendRegistryLease: vi.fn(async <T>(
    registry: unknown,
    run: (resolvedRegistry: unknown) => Promise<T>,
  ): Promise<T> => await run(registry ?? { selectBackend: async () => null })),
}));

vi.mock('@/scm/scmBackendCatalog', () => ({
  runWithScmBackendRegistryLease: scmCatalogMock.runWithScmBackendRegistryLease,
}));

describe('ReviewProfile', () => {
  it('adds unsupported host-resolved SCM scope for non-repository review starts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-review-non-repo-'));
    const request = {
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'coderabbit' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      intentInput: {
        engineIds: ['coderabbit'],
        instructions: 'Review.',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      },
    } satisfies ExecutionRunStartRequest;

    try {
      expect(ReviewProfile.prepareStartParams).toEqual(expect.any(Function));
      const patch = await ReviewProfile.prepareStartParams!({ request, cwd });
      expect(patch).toMatchObject({
        intentInput: {
          scmReviewScope: {
            kind: 'review_scm_scope.v1',
            status: 'unsupported',
            diagnostics: [
              expect.objectContaining({
                code: 'not_repository',
              }),
            ],
          },
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY while re-deriving scmReviewScope', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-review-pr-scope-'));
    const scmPullRequestReviewScope = {
      kind: 'scm_pull_request_review_scope.v1',
      account: {
        service: { pluginId: 'happier.scm-github', localId: 'github' },
        accountId: 'account-7',
      },
      pullRequest: { number: 42 },
      observed: {
        baseSha: '1111111111111111111111111111111111111111',
        headSha: '2222222222222222222222222222222222222222',
        nativeRevision: 'PR_kwDOABCD',
        observedAtMs: 1_700_000_000_000,
      },
    } as const;
    const request = {
      intent: 'review',
      backendTarget: { kind: 'backend', backendId: 'coderabbit' },
      instructions: 'Review the selected pull request.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      intentInput: {
        engineIds: ['coderabbit'],
        instructions: 'Review the selected pull request.',
        changeType: 'uncommitted',
        base: { kind: 'none' },
        // The scope a source review was started with, and a stale worktree
        // scope from the caller. Only the second may be replaced.
        scmPullRequestReviewScope,
        scmReviewScope: { kind: 'review_scm_scope.v1', status: 'supported' },
      },
    } satisfies ExecutionRunStartRequest;

    try {
      const patch = await ReviewProfile.prepareStartParams!({ request, cwd });
      // The profile contract lets a profile decline to patch; this one must not,
      // because declining is exactly how the re-derived scope would be lost.
      if (!patch) {
        throw new Error('ReviewProfile.prepareStartParams returned no start-params patch');
      }
      const intentInput = patch.intentInput as Record<string, unknown>;

      // The design depends on exactly this asymmetry: the worktree scope is
      // re-derived from the run's own directory, and every sibling key — the
      // selected pull request among them — survives untouched. A
      // prepareStartParams that builds a fresh object instead of spreading
      // drops the pull request silently and the review simply stops being
      // about it.
      expect(intentInput.scmPullRequestReviewScope).toEqual(scmPullRequestReviewScope);
      expect(intentInput.scmReviewScope).toMatchObject({
        kind: 'review_scm_scope.v1',
        status: 'unsupported',
      });
      expect(intentInput.engineIds).toEqual(['coderabbit']);
      expect(resolveScmPullRequestReviewScope(intentInput)).toEqual({
        status: 'scope_present',
        scope: scmPullRequestReviewScope,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('parses trailing JSON when model output includes preamble text', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'review this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const res = ReviewProfile.onBoundedComplete({
      start,
      rawText: [
        'Sure, here are the findings.',
        '{',
        '  "summary": "Ok",',
        '  "overviewMarkdown": "## Overview\\n\\nLooks good.",',
        '  "findings": [],',
        '  "questions": [],',
        '  "assumptions": []',
        '}',
      ].join('\n'),
      finishedAtMs: 2,
    });

    expect(res.status).toBe('succeeded');
    expect(res.structuredMeta?.kind).toBe('review_findings.v2');
    expect((res.structuredMeta as any).payload?.summary).toBe('Ok');
    expect((res.structuredMeta as any).payload?.overviewMarkdown).toContain('Overview');
  });

  it('validates and retains bounded proposed comments in structured output', () => {
    const start = {
      sessionId: 'sess_1', runId: 'run_1', callId: 'call_1', sidechainId: 'call_1',
      intent: 'review', backendId: 'coderabbit',
      backendTarget: { kind: 'builtInAgent', agentId: 'coderabbit' },
      instructions: 'review this', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
      runClass: 'bounded', ioMode: 'request_response', startedAtMs: 1,
    } as const;
    const res = ReviewProfile.onBoundedComplete({
      start,
      rawText: JSON.stringify({
        summary: 'One finding', overviewMarkdown: 'One finding', findings: [], questions: [], assumptions: [],
        proposedComments: [{
          findingId: 'finding-1', body: 'Validate the redirect.',
          anchor: { kind: 'line', filePath: 'src/auth.ts', line: 12 },
          severity: 'error', taxonomyIds: ['security.redirect'], tags: ['coderabbit'],
        }],
      }),
      finishedAtMs: 2,
    });

    expect(res.status).toBe('succeeded');
    expect((res.structuredMeta?.payload as any).proposedComments).toEqual([
      expect.objectContaining({ findingId: 'finding-1', body: 'Validate the redirect.' }),
    ]);
  });

  it('keeps host comment materialization out of the pure profile action reducer', () => {
    const start = {
      sessionId: 'sess_1', runId: 'run_1', callId: 'call_1', sidechainId: 'call_1',
      intent: 'review', backendId: 'coderabbit',
      backendTarget: { kind: 'builtInAgent', agentId: 'coderabbit' },
      instructions: 'review this', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
      runClass: 'bounded', ioMode: 'request_response', startedAtMs: 1,
    } as const;
    const acted = ReviewProfile.applyAction?.({
      start,
      actionId: 'reviews.comments.create',
      structuredMeta: {
        kind: 'review_findings.v2',
        payload: {
          runRef: { runId: 'run_1', callId: 'call_1', backendId: 'coderabbit' },
          summary: 'One finding', overviewMarkdown: 'One finding', findings: [], questions: [], assumptions: [],
          proposedComments: [{ body: 'Finding', anchor: { kind: 'file', filePath: 'src/auth.ts' } }],
          generatedAtMs: 2,
        },
      },
    });

    expect(acted).toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'execution_run_action_not_supported',
    }));
  });

  it('rejects stale retained proposals at the pure profile boundary', () => {
    const start = {
      sessionId: 'sess_1', runId: 'run_1', callId: 'call_1', sidechainId: 'call_1',
      intent: 'review', backendId: 'coderabbit', backendTarget: { kind: 'builtInAgent', agentId: 'coderabbit' },
      instructions: 'review', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
      runClass: 'bounded', ioMode: 'request_response', startedAtMs: 1,
    } as const;
    expect(ReviewProfile.applyAction?.({
      start, actionId: 'reviews.comments.create', structuredMeta: {
        kind: 'review_findings.v2', payload: {
          runRef: { runId: 'other_run', callId: 'call_1', backendId: 'coderabbit' },
          summary: 'x', overviewMarkdown: 'x', findings: [], questions: [], assumptions: [],
          proposedComments: [{ body: 'x', anchor: { kind: 'file', filePath: 'src/a.ts' } }], generatedAtMs: 2,
        },
      },
    })).toEqual(expect.objectContaining({
      ok: false, errorCode: 'execution_run_action_not_supported',
    }));
  });

  it('fails deterministically when model output is not strict JSON', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'review this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const res = ReviewProfile.onBoundedComplete({
      start,
      rawText: 'not json',
      finishedAtMs: 2,
    });

    expect(res.status).toBe('failed');
    expect((res.toolResultOutput as any)?.error?.code).toBe('invalid_output');
  });

  it('treats provider-specific plain text as invalid generic review output', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendId: ['code', 'rabbit'].join(''),
      backendTarget: { kind: 'builtInAgent', agentId: ['code', 'rabbit'].join('') },
      instructions: 'review this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const rawText = [
      'File: src/foo.ts',
      'Line: 10 to 12',
      'Type: Bug',
      'Comment:',
      'Null deref risk when value is missing.',
      '',
      'Prompt for AI Agent:',
      'Add a guard and unit test.',
      '============================================================================',
    ].join('\n');

    const res = ReviewProfile.onBoundedComplete({
      start,
      rawText,
      finishedAtMs: 2,
    });

    expect(res.status).toBe('failed');
    expect((res.toolResultOutput as any)?.error?.code).toBe('invalid_output');
  });

  it('rejects triage actions when start params are missing required policy fields', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'review this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const completed = ReviewProfile.onBoundedComplete({
      start,
      rawText: '{ "summary": "Ok", "overviewMarkdown": "Ok", "findings": [], "questions": [], "assumptions": [] }',
      finishedAtMs: 2,
    });

    expect(completed.status).toBe('succeeded');
    expect(completed.structuredMeta?.kind).toBe('review_findings.v2');

    const acted = ReviewProfile.applyAction?.({
      actionId: 'review.triage',
      input: { findings: [] },
      structuredMeta: completed.structuredMeta!,
      start: { ...start, permissionMode: '' },
    });

    expect(acted?.ok).toBe(false);
    expect((acted as any)?.errorCode).toBe('execution_run_invalid_action_input');
  });

  it('exposes review.follow_up alongside review.triage for review findings payloads', () => {
    const actionIds = ReviewProfile.listAvailableActionIds?.({
      start: {
        sessionId: 'sess_1',
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        intent: 'review',
        backendId: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'review this',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'bounded',
        ioMode: 'streaming',
        startedAtMs: 1,
      },
      structuredMeta: {
        kind: 'review_findings.v2',
        payload: {
          runRef: {
            runId: 'run_1',
            callId: 'call_1',
            backendId: 'claude',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          },
          summary: 'Ok',
          overviewMarkdown: 'Ok',
          findings: [],
          questions: [],
          assumptions: [],
          generatedAtMs: 1,
        },
      },
    });

    expect(actionIds).toEqual(['review.triage', 'review.follow_up']);
  });

  it('hides review.follow_up for ephemeral review findings payloads', () => {
    const actionIds = ReviewProfile.listAvailableActionIds?.({
      start: {
        sessionId: 'sess_1',
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        intent: 'review',
        backendId: 'review-cli',
        backendTarget: { kind: 'builtInAgent', agentId: 'review-cli' },
        instructions: 'review this',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'streaming',
        startedAtMs: 1,
      },
      structuredMeta: {
        kind: 'review_findings.v2',
        payload: {
          runRef: {
            runId: 'run_1',
            callId: 'call_1',
            backendId: 'review-cli',
            backendTarget: { kind: 'builtInAgent', agentId: 'review-cli' },
          },
          summary: 'Ok',
          overviewMarkdown: 'Ok',
          findings: [],
          questions: [],
          assumptions: [],
          generatedAtMs: 1,
        },
      },
    });

    expect(actionIds).toEqual(['review.triage']);
  });

  it('builds a review-specific repair prompt and normalizes review sidechain text', () => {
    expect(ReviewProfile.emitFinalSidechainMessageWhenStreamed).toBe(true);
    const prompt = ReviewProfile.buildInvalidOutputRepairPrompt?.({
      rawText: 'not json',
      start: {
        sessionId: 'sess_1',
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        intent: 'review',
        backendId: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'review this',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        startedAtMs: 1,
      },
    });

    expect(prompt).toContain('Your previous response did not include the required final JSON object.');
    expect(prompt).toContain('continue the review first using the available read-only tools');
    expect(prompt).toContain('not json');

    expect(
      ReviewProfile.computeSidechainStreamText?.({ fullText: 'Review prose\n{"summary":"Ok","findings":[]}' }),
    ).toBe('Review prose');
  });
});
