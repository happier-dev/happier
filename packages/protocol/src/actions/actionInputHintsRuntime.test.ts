import { describe, expect, it } from 'vitest';

import { getActionSpec } from './actionSpecs.js';
import { resolveEffectiveActionInputFields } from './actionInputHintsRuntime.js';

describe('resolveEffectiveActionInputFields', () => {
  it('hides conditional base fields for review.start based on base.kind', () => {
    const spec = getActionSpec('review.start');

    const none = resolveEffectiveActionInputFields(spec, {
      engineIds: ['codex'],
      instructions: 'x',
      changeType: 'committed',
      base: { kind: 'none' },
    });
    expect(none.map((f) => f.path)).not.toContain('base.baseBranch');
    expect(none.map((f) => f.path)).not.toContain('base.baseCommit');

    const branch = resolveEffectiveActionInputFields(spec, {
      engineIds: ['codex'],
      instructions: 'x',
      changeType: 'committed',
      base: { kind: 'branch', baseBranch: 'main' },
    });
    expect(branch.map((f) => f.path)).toContain('base.baseBranch');
    expect(branch.map((f) => f.path)).not.toContain('base.baseCommit');
    expect(branch.find((f) => f.path === 'base.baseBranch')?.required).toBe(true);

    const commit = resolveEffectiveActionInputFields(spec, {
      engineIds: ['codex'],
      instructions: 'x',
      changeType: 'committed',
      base: { kind: 'commit', baseCommit: 'abc123' },
    });
    expect(commit.map((f) => f.path)).not.toContain('base.baseBranch');
    expect(commit.map((f) => f.path)).toContain('base.baseCommit');
    expect(commit.find((f) => f.path === 'base.baseCommit')?.required).toBe(true);
  });
});
