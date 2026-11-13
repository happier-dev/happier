import { describe, expect, it } from 'vitest';

import { buildAppendSystemPromptBaseV1 } from './buildAppendSystemPromptBaseV1.js';

describe('buildAppendSystemPromptBaseV1', () => {
  it('includes the retained role assignment even with execution runs disabled, and omits no role or malformed data', () => {
    const roleMetadata = (sessionRoleV1: unknown) => ({ sessionRoleV1 });
    const assigned = buildAppendSystemPromptBaseV1({
      // A later account-default edit must not replace the snapshot used by this assignment.
      settings: { executionRunsGuidanceEnabled: false, sessionRoleProfilesV1: { v: 1, instructionsByRole: { reviewer: 'NEWER DEFAULT' } } },
      base: 'BASE',
      executionRunsFeatureEnabled: false,
      sessionMetadata: roleMetadata({ v: 1, role: 'reviewer', instructions: 'SNAPSHOT RULES', assignmentId: 'a-1', assignedAt: 1 }),
    });
    expect(assigned.startsWith('BASE')).toBe(true);
    expect(assigned).toContain('Reviewer');
    expect(assigned).toContain('SNAPSHOT RULES');
    expect(assigned).not.toContain('NEWER DEFAULT');
    for (const sessionMetadata of [{}, roleMetadata({ v: 1, role: 'reviewer' }), roleMetadata({ v: 9, role: 'reviewer', instructions: 'X' }), roleMetadata('reviewer')]) {
      expect(buildAppendSystemPromptBaseV1({ settings: {}, base: 'BASE', executionRunsFeatureEnabled: false, sessionMetadata })).toBe('BASE');
    }
  });

  it('keeps the role block when the shared base is empty and omits it only on explicit opt-out', () => {
    const sessionMetadata = { sessionRoleV1: { v: 1, role: 'planner', instructions: 'PLAN RULES', assignmentId: 'a-1', assignedAt: 1 } };
    const emptyBase = buildAppendSystemPromptBaseV1({ settings: {}, base: '', executionRunsFeatureEnabled: false, sessionMetadata });
    expect(emptyBase).toContain('Current role assignment: Planner');
    expect(emptyBase).toContain('PLAN RULES');
    expect(buildAppendSystemPromptBaseV1({
      settings: {}, base: 'BASE', executionRunsFeatureEnabled: false, sessionMetadata, includeSessionRole: false,
    })).toBe('BASE');
  });

  it('returns the base prompt when execution runs guidance is disabled', () => {
    expect(buildAppendSystemPromptBaseV1({
      settings: {},
      base: 'BASE',
      executionRunsFeatureEnabled: false,
    })).toBe('BASE');
  });

  it('uses the enabled default when the guidance setting is absent', () => {
    const out = buildAppendSystemPromptBaseV1({
      settings: {},
      base: 'BASE',
      executionRunsFeatureEnabled: true,
    });

    expect(out).toContain('current backend\'s native subagent facility by default');
    expect(out).toContain('Happier subagent');
    expect(out).toContain('Happier delegation run');
  });

  it('honors an explicit guidance opt-out', () => {
    expect(buildAppendSystemPromptBaseV1({
      settings: { executionRunsGuidanceEnabled: false },
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

    expect(out).toContain('current backend\'s native subagent facility by default');
    expect(out.toLowerCase()).not.toContain('custom rule');
    expect(out).not.toContain('Disabled custom rule');
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
    expect(out).toContain('Happier-Managed Runs');
    expect(out).toContain('Always use execution runs for code reviews.');
    expect(out).toContain('backend=agent:claude');
    expect(out.indexOf('Happier-Managed Runs')).toBeLessThan(out.indexOf('Custom Execution-Run Rules'));
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

  it.each([undefined, 'initial'] as const)('uses start-only session title instructions for %s title updates', (sessionTitleUpdates) => {
    const out = buildAppendSystemPromptBaseV1({
      settings: {
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates,
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
