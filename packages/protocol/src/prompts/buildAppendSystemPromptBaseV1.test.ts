import { describe, expect, it } from 'vitest';

import { buildAppendSystemPromptBaseV1 } from './buildAppendSystemPromptBaseV1.js';

describe('buildAppendSystemPromptBaseV1', () => {
  it('places fresh-Bot first-message guidance in the canonical coding base', () => {
    const text = buildAppendSystemPromptBaseV1({ settings: {}, executionRunsFeatureEnabled: false, createdAsBot: true });
    expect(text).toMatch(/task or remit[\s\S]*proceed[\s\S]*without asking/i);
    expect(text).toMatch(/one concise focus question/i);
    expect(text).toMatch(/persona name/i);
    expect(text).not.toContain('task changes significantly');
  });
  it('returns the base prompt when execution runs guidance is disabled', () => {
    expect(buildAppendSystemPromptBaseV1({
      settings: {},
      base: 'BASE',
      executionRunsFeatureEnabled: false,
    })).toBe('BASE');
  });

  it('keeps role guidance out of the frozen fresh-session base when execution runs are enabled', () => {
    const out = buildAppendSystemPromptBaseV1({
      settings: {},
      base: 'BASE',
      executionRunsFeatureEnabled: true,
    });

    expect(out).toBe('BASE');
  });

  it('honors an explicit guidance opt-out', () => {
    expect(buildAppendSystemPromptBaseV1({
      settings: {
        executionRunsGuidanceEnabled: false,
        executionRunsGuidanceEntries: [{ id: 'rule', description: 'Use a Happier review run' }],
      },
      base: 'BASE',
      executionRunsFeatureEnabled: true,
    })).toBe('BASE');
  });

  it('does not mention custom rules when no valid enabled rules exist', () => {
    const out = buildAppendSystemPromptBaseV1({
      settings: {
        executionRunsGuidanceEntries: [
          { id: 'disabled', description: 'Disabled custom rule', enabled: false },
          { id: 'invalid', description: '   ', enabled: true },
        ],
      },
      base: 'BASE',
      executionRunsFeatureEnabled: true,
    });

    expect(out).toBe('BASE');
    expect(out.toLowerCase()).not.toContain('custom rule');
    expect(out).not.toContain('Disabled custom rule');
  });

  it('does not freeze legacy routing entries into the fresh-session base', () => {
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

    expect(out).toBe('BASE');
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

  it('omits session title instructions when the delivery has no title tool', () => {
    const out = buildAppendSystemPromptBaseV1({
      settings: {},
      executionRunsFeatureEnabled: false,
      memoryRecallGuidanceEnabled: false,
      sessionTitleToolAvailable: false,
    });

    expect(out).not.toContain('# Session title');
    expect(out).not.toContain('change_title');
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
