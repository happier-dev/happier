import { describe, expect, it } from 'vitest';

import { diffProviderBaseline, type ProviderBaselineV1 } from '../../src/testkit/providers/baselines';

describe('providers: baseline diff', () => {
  it('does not fail missing baseline keys when an allowed any-of alternative is observed', () => {
    const baseline: ProviderBaselineV1 = {
      v: 1,
      providerId: 'opencode',
      scenarioId: 'edit_write_file_and_cat',
      createdAt: '2026-02-04T00:00:00.000Z',
      fixtureKeys: ['acp/opencode/tool-call/Edit', 'acp/opencode/tool-result/Edit'],
      shapesByKey: {},
    };

    const scenario = {
      requiredAnyFixtureKeys: [
        ['acp/opencode/tool-call/Patch', 'acp/opencode/tool-call/Edit', 'acp/opencode/tool-call/Write'],
        ['acp/opencode/tool-result/Patch', 'acp/opencode/tool-result/Edit', 'acp/opencode/tool-result/Write'],
      ],
    };

    const res = diffProviderBaseline({
      baseline,
      observedFixtureKeys: ['acp/opencode/tool-call/Write', 'acp/opencode/tool-result/Write'],
      observedExamples: {},
      allowExtraKeys: true,
      scenario,
    });

    expect(res.ok).toBe(true);
  });
});
