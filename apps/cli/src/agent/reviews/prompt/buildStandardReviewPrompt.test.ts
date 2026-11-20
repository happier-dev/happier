import { describe, expect, it } from 'vitest';

import { buildStandardReviewPrompt } from './buildStandardReviewPrompt';

describe('buildStandardReviewPrompt', () => {
  it('keeps an ordinary file selection and its admitted base in the generic reviewer input', () => {
    const prompt = buildStandardReviewPrompt({ instructions: 'Review the selection.', intentInput: {
      reviewers: [{ kind: 'engine', engineId: 'claude' }], instructions: 'Review the selection.',
      changeType: 'uncommitted', base: { kind: 'branch', baseBranch: 'unselected-ambient-base' },
      selectedPaths: ['unselected-raw-path.ts'],
      scmReviewScope: { kind: 'review_scm_scope.v1', status: 'supported', scope: 'changes',
        scmBackendId: 'git', scmMode: '.git', repositoryRoot: '/repo', worktreeRoot: '/repo',
        baseRef: { source: 'explicit', ref: 'admitted-base' }, selectedPaths: ['selected.ts'],
        committedPaths: [], uncommittedPaths: [], changedPaths: [],
        diff: { committedAvailable: false, uncommittedAvailable: true }, diagnostics: [] },
    } });
    expect(prompt).toContain('selected.ts');
    expect(prompt).toContain('admitted-base');
    expect(prompt).not.toContain('unselected-ambient-base');
    expect(prompt).not.toContain('unselected-raw-path.ts');
  });
  it.each([true, false])('uses resolved captured scope instead of instructing the reviewer to infer ambient changes (picker fields: %s)', (hasPickerFields) => {
    const prompt = buildStandardReviewPrompt({ instructions: 'Review the selected turn.', intentInput: {
      ...(hasPickerFields ? { reviewers: [{ kind: 'engine', engineId: 'claude' }] } : {}), instructions: 'Review the selected turn.', changeType: 'uncommitted', base: { kind: 'none' },
      scmReviewScope: { kind: 'review_scm_scope.v1', status: 'supported', scmBackendId: 'git', scmMode: '.git',
        repositoryRoot: '/repo', worktreeRoot: '/repo', baseRef: { source: 'explicit', ref: 'captured-base' },
        selectedPaths: ['selected.ts'], committedPaths: [], uncommittedPaths: [], changedPaths: [],
        diff: { committedAvailable: true, uncommittedAvailable: false }, diagnostics: [],
        comparison: { id: 'selected-turn', source: { kind: 'turnCheckpoint', sessionId: 'session', turnId: 'turn' },
          endpoints: { before: 'captured-base', after: 'captured-head' } } },
    } });
    expect(prompt).toContain('captured-head');
    expect(prompt).toContain('selected.ts');
    expect(prompt).not.toContain('infer the repository');
    expect(prompt).not.toContain('current uncommitted');
  });
  it('uses the observed PR range without requiring review picker fields', () => {
    const baseOid = '1'.repeat(40);
    const headOid = '2'.repeat(40);
    const prompt = buildStandardReviewPrompt({ instructions: 'Review the selected PR.', intentInput: {
      scmReviewScope: { kind: 'review_scm_scope.v1', status: 'supported', scmBackendId: 'git', scmMode: '.git',
        repositoryRoot: '/repo', worktreeRoot: '/repo', baseRef: { source: 'explicit', ref: baseOid },
        selectedPaths: [], committedPaths: [], uncommittedPaths: [], changedPaths: [],
        diff: { committedAvailable: true, uncommittedAvailable: false }, diagnostics: [],
        revisionRange: { kind: 'revisionRange', baseOid, headOid } },
    } });
    expect(prompt).toContain(baseOid);
    expect(prompt).toContain(headOid);
    expect(prompt).not.toContain('infer the repository');
    expect(prompt).not.toContain('current uncommitted');
  });
  it('lets a Hunt inspect unchanged files instead of restricting it to a comparison', () => {
    const prompt = buildStandardReviewPrompt({ instructions: 'Find security issues.', intentInput: {
      reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Find security issues.', scope: 'repository',
    } });
    expect(prompt).toContain('entire repository');
    expect(prompt).not.toContain('Change type:');
    expect(prompt).not.toContain('Do not broaden');
  });
  it('requires initial reviews to inspect accessible workspace context before finalizing', () => {
    const prompt = buildStandardReviewPrompt({
      instructions: 'Review the current workspace thoroughly.',
    });

    expect(prompt).toContain('Inspect the accessible workspace');
    expect(prompt).toContain('Do not stop at a plan');
    expect(prompt).toContain('add a question instead of guessing');
  });

  it('requires a new round to report unresolved findings again in its complete current findings set', () => {
    const prompt = buildStandardReviewPrompt({
      instructions: 'Review total.ts, where the reducer still uses sum - value.',
      intentInput: {
        previousRoundContext: {
          reviewRound: { roundOrdinal: 1 },
          reviewFindings: {
            summary: 'Reducer subtracts instead of adding.',
            findings: [{ id: 'F1', title: 'Reducer subtracts instead of adding', severity: 'blocker', filePath: 'total.ts' }],
          },
        },
      },
    });

    expect(prompt).toContain('"id":"F1"');
    expect(prompt).toContain('complete current findings set');
    expect(prompt).toContain('including unresolved findings reported in previous rounds that still apply');
    expect(prompt).toContain('Do not omit a current finding merely because it was reported before');
    expect(prompt).not.toContain('Only update findings when your conclusion changed');
  });

  it('keeps ordinary follow-up finding updates limited to changed conclusions or clarification', () => {
    const prompt = buildStandardReviewPrompt({
      instructions: 'Explain the existing finding.',
      intentInput: {
        kind: 'review_follow_up.v1',
        parentRunRef: { runId: 'run_1', callId: 'call_1', backendId: 'codex' },
        threadId: 'thread_1',
        messageMarkdown: 'Why is the reducer incorrect?',
        summary: 'Reducer subtracts instead of adding.',
        overviewMarkdown: 'The reducer still subtracts each value.',
      },
    });

    expect(prompt).toContain('Only update findings when your conclusion changed or needs clarification');
    expect(prompt).toContain('updatedFindings');
    expect(prompt).not.toContain('complete current findings set');
    expect(prompt).not.toContain('Do not omit a current finding');
  });

  it('includes explicit review scope guidance for normal review launches', () => {
    const prompt = buildStandardReviewPrompt({
      instructions: 'Review the current session changes.',
      intentInput: {
        reviewers: [{ kind: 'engine', engineId: 'claude' }],
        instructions: 'Review the current session changes.',
        changeType: 'committed',
        base: { kind: 'none' },
      },
    });

    expect(prompt).toContain('Review scope:');
    expect(prompt).toContain('Change type: committed');
    expect(prompt).toContain('Base: infer the repository');
    expect(prompt).toContain('Do not broaden the review to unrelated repository areas');
  });
});
