import { describe, expect, expectTypeOf, it } from 'vitest';

import { getActionSpec } from './actionSpecs.js';
import type { ActionSpec } from './actionSpecs.js';
import { ActionInputOptionSchema } from './actionInputHints.js';
import { normalizeActionInputByFieldHints, resolveEffectiveActionInputFields } from './actionInputHintsRuntime.js';

describe('resolveEffectiveActionInputFields', () => {
  it('accepts the exact input-hints owner rather than requiring a fabricated ActionSpec', () => {
    expectTypeOf<Parameters<typeof resolveEffectiveActionInputFields>[0]>()
      .toEqualTypeOf<Pick<ActionSpec, 'inputHints'>>();
    expectTypeOf<Parameters<typeof normalizeActionInputByFieldHints>[0]>()
      .toEqualTypeOf<Pick<ActionSpec, 'inputHints'>>();

    const hintsOnly = {
      inputHints: {
        fields: [{ path: 'kind', title: 'Kind', widget: 'text' }],
      },
    } satisfies Pick<ActionSpec, 'inputHints'>;

    expect(resolveEffectiveActionInputFields(hintsOnly, {}).map((field) => field.path)).toEqual(['kind']);
    expect(normalizeActionInputByFieldHints(hintsOnly, { kind: 'review' })).toEqual({ kind: 'review' });
  });

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

  it('retains schema-admitted inactive draft values without converting omission and null', () => {
    const spec = getActionSpec('review.start');
    const input = {
      engineIds: ['codex'],
      instructions: 'x',
      changeType: 'committed',
      base: {
        kind: 'none',
        baseBranch: 'main',
        baseCommit: null,
      },
    };

    expect(resolveEffectiveActionInputFields(spec, input).map((field) => field.path)).not.toContain('base.baseBranch');
    expect(resolveEffectiveActionInputFields(spec, input).map((field) => field.path)).not.toContain('base.baseCommit');
    expect(normalizeActionInputByFieldHints(spec, input)).toEqual(input);
  });

  it('normalizes multiselect fields using protocol-owned field limits', () => {
    const spec = getActionSpec('subagents.plan.start');

    expect(normalizeActionInputByFieldHints(spec, {
      sessionId: 'session-1',
      backendTargetKeys: ['agent:claude', 'agent:opencode'],
      instructions: 'Plan this.',
    })).toEqual({
      sessionId: 'session-1',
      backendTargetKeys: ['agent:opencode'],
      instructions: 'Plan this.',
    });
  });

  it('accepts exact qualified Connected Account refs in host-resolved options', () => {
    const account = {
      service: { pluginId: 'com.acme.accounts', localId: 'service' },
      accountId: 'account-1',
    };

    expect(ActionInputOptionSchema.parse({
      value: account,
      label: 'Work account',
    }).value).toEqual(account);
  });
});
