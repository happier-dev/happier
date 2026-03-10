import { describe, expect, it } from 'vitest';

import { buildAppendSystemPromptBaseV1 } from './buildAppendSystemPromptBaseV1.js';

describe('buildAppendSystemPromptBaseV1', () => {
  it('returns the base prompt when execution runs guidance is disabled', () => {
    expect(buildAppendSystemPromptBaseV1({
      settings: { executionRunsGuidanceEnabled: true },
      base: 'BASE',
      executionRunsFeatureEnabled: false,
    })).toBe('BASE');
  });

  it('appends execution runs guidance when enabled', () => {
    const out = buildAppendSystemPromptBaseV1({
      settings: {
        executionRunsGuidanceEnabled: true,
        executionRunsGuidanceEntries: [
          {
            id: 'g1',
            description: 'Always use execution runs for code reviews.',
            enabled: true,
            suggestedBackendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          },
        ],
      },
      base: 'BASE',
      executionRunsFeatureEnabled: true,
    });

    expect(out).toContain('BASE');
    expect(out).toContain('Execution Runs Guidance');
    expect(out).toContain('Always use execution runs for code reviews.');
    expect(out).toContain('backend=agent:claude');
  });

  it('appends memory recall guidance only when explicitly enabled', () => {
    const withMemory = buildAppendSystemPromptBaseV1({
      settings: {},
      base: 'BASE',
      executionRunsFeatureEnabled: false,
      memoryRecallGuidanceEnabled: true,
    });
    const withoutMemory = buildAppendSystemPromptBaseV1({
      settings: {},
      base: 'BASE',
      executionRunsFeatureEnabled: false,
      memoryRecallGuidanceEnabled: false,
    });

    expect(withMemory).toContain('If the user asks you to remember or find something from past conversations');
    expect(withMemory).toContain('use `memory_search` first');
    expect(withMemory).toContain('use `memory_get_window`');
    expect(withoutMemory).toBe('BASE');
  });
});
