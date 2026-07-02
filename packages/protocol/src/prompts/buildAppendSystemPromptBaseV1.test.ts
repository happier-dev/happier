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

  it('omits session title instructions when coding prompt title updates are disabled', () => {
    const out = buildAppendSystemPromptBaseV1({
      settings: {
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'disabled',
          responseOptions: 'agent',
        },
      },
      executionRunsFeatureEnabled: false,
      memoryRecallGuidanceEnabled: false,
    });

    expect(out).not.toContain('# Session title');
    expect(out).not.toContain('change_title');
    expect(out).toContain('# Options');
    expect(out).toContain('# Attachments');
  });

  it('uses start-only session title instructions for initial title updates', () => {
    const out = buildAppendSystemPromptBaseV1({
      settings: {
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'initial',
          responseOptions: 'disabled',
        },
      },
      executionRunsFeatureEnabled: false,
      memoryRecallGuidanceEnabled: false,
    });

    expect(out).toContain('# Session title');
    expect(out).toContain('first user message');
    expect(out).toContain('MUST call the change_title tool once');
    expect(out).not.toContain('task changes significantly');
    expect(out).not.toContain('# Options');
  });

  it('uses ongoing session title instructions for ongoing title updates', () => {
    const out = buildAppendSystemPromptBaseV1({
      settings: {
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'ongoing',
          responseOptions: 'disabled',
        },
      },
      executionRunsFeatureEnabled: false,
      memoryRecallGuidanceEnabled: false,
    });

    expect(out).toContain('# Session title');
    expect(out).toContain('first user message');
    expect(out).toContain('task changes significantly');
    expect(out).not.toContain('# Options');
  });

  it('omits options instructions when coding prompt response options are disabled', () => {
    const out = buildAppendSystemPromptBaseV1({
      settings: {
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'ongoing',
          responseOptions: 'disabled',
        },
      },
      executionRunsFeatureEnabled: false,
      memoryRecallGuidanceEnabled: false,
    });

    expect(out).toContain('# Session title');
    expect(out).not.toContain('# Options');
    expect(out).not.toContain('# Plan mode with options');
    expect(out).not.toContain('<options>');
    expect(out).toContain('# Attachments');
  });
});
