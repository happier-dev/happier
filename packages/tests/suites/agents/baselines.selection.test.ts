import { describe, expect, it } from 'vitest';

import { selectBaselineFixtureKeysFromScenario } from '../../src/testkit/providers/baselines';

describe('providers: baseline key selection', () => {
  it('prefers a coherent tool-call/tool-result pair when multiple tool names are observed', () => {
    const scenario = {
      requiredFixtureKeys: [],
      requiredAnyFixtureKeys: [
        ['acp/opencode/tool-call/Patch', 'acp/opencode/tool-call/Edit', 'acp/opencode/tool-call/Write'],
        ['acp/opencode/tool-result/Patch', 'acp/opencode/tool-result/Edit', 'acp/opencode/tool-result/Write'],
      ],
    };

    const observedFixtureKeys = [
      'acp/opencode/tool-call/Edit',
      'acp/opencode/tool-call/Write',
      'acp/opencode/tool-result/Write',
    ];

    const selected = selectBaselineFixtureKeysFromScenario({ scenario, observedFixtureKeys });
    expect(selected).toContain('acp/opencode/tool-call/Write');
    expect(selected).toContain('acp/opencode/tool-result/Write');
    expect(selected).not.toContain('acp/opencode/tool-call/Edit');
  });

  it('deduplicates selected keys when observedFixtureKeys has duplicates', () => {
    const scenario = {
      requiredFixtureKeys: ['acp/opencode/tool-call/Bash'],
      requiredAnyFixtureKeys: [['acp/opencode/tool-result/Bash', 'acp/opencode/tool-result/Execute']],
    };
    const observedFixtureKeys = [
      'acp/opencode/tool-call/Bash',
      'acp/opencode/tool-call/Bash',
      'acp/opencode/tool-result/Bash',
      'acp/opencode/tool-result/Bash',
    ];

    const selected = selectBaselineFixtureKeysFromScenario({ scenario, observedFixtureKeys });
    expect(selected).toEqual(['acp/opencode/tool-call/Bash', 'acp/opencode/tool-result/Bash']);
  });

  it('ignores requiredAny buckets with no observed matches while keeping required keys', () => {
    const scenario = {
      requiredFixtureKeys: ['acp/opencode/tool-call/Bash'],
      requiredAnyFixtureKeys: [
        ['acp/opencode/tool-result/Bash', 'acp/opencode/tool-result/Execute'],
        ['acp/opencode/tool-call/Read', 'acp/opencode/tool-call/Grep'],
      ],
    };
    const observedFixtureKeys = ['acp/opencode/tool-call/Bash', 'acp/opencode/tool-result/Bash'];

    const selected = selectBaselineFixtureKeysFromScenario({ scenario, observedFixtureKeys });
    expect(selected).toEqual(['acp/opencode/tool-call/Bash', 'acp/opencode/tool-result/Bash']);
  });
});
