import { describe, expect, it } from 'vitest';

import { buildStandardReviewPrompt } from './buildStandardReviewPrompt';

describe('buildStandardReviewPrompt', () => {
  it.each([true, false])('uses resolved captured scope instead of instructing the reviewer to infer ambient changes (picker fields: %s)', (hasPickerFields) => {
    const prompt = buildStandardReviewPrompt({ instructions: 'Review the selected turn.', intentInput: {
      ...(hasPickerFields ? { engineIds: ['claude'] } : {}), instructions: 'Review the selected turn.', changeType: 'uncommitted', base: { kind: 'none' },
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

  it('includes explicit review scope guidance for normal review launches', () => {
    const prompt = buildStandardReviewPrompt({
      instructions: 'Review the current session changes.',
      intentInput: {
        engineIds: ['claude'],
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
