import { describe, expect, it } from 'vitest';

import { normalizeActionInput, normalizeActionInputPatch } from './normalizeActionInputPatch';

describe('normalizeActionInputPatch', () => {
  it('normalizes a full execution-run action input before submission', () => {
    expect(normalizeActionInput({
      actionId: 'subagents.plan.start' as any,
      input: {
        sessionId: 'session-1',
        backendTargetKeys: ['agent:claude', 'agent:opencode'],
        instructions: 'Plan this.',
      },
    })).toEqual({
      sessionId: 'session-1',
      backendTargetKeys: ['agent:opencode'],
      instructions: 'Plan this.',
    });
  });

  it('keeps the latest selected backend target for execution-run action drafts', () => {
    expect(normalizeActionInputPatch({
      actionId: 'subagents.plan.start' as any,
      patch: { backendTargetKeys: ['agent:claude', 'agent:opencode'] },
    })).toEqual({ backendTargetKeys: ['agent:opencode'] });

    expect(normalizeActionInputPatch({
      actionId: 'subagents.delegate.start' as any,
      patch: { backendTargetKeys: ['agent:claude', 'agent:codex'] },
    })).toEqual({ backendTargetKeys: ['agent:codex'] });

    expect(normalizeActionInputPatch({
      actionId: 'voice_agent.start' as any,
      patch: { backendTargetKeys: ['agent:claude', 'agent:pi'] },
    })).toEqual({ backendTargetKeys: ['agent:pi'] });
  });

  it('leaves review and unrelated action patches unchanged', () => {
    const reviewPatch = { engineIds: ['claude', 'coderabbit'] };
    expect(normalizeActionInputPatch({ actionId: 'review.start' as any, patch: reviewPatch })).toBe(reviewPatch);

    const sessionPatch = { title: 'Renamed' };
    expect(normalizeActionInputPatch({ actionId: 'session.rename' as any, patch: sessionPatch })).toBe(sessionPatch);
  });

  it('leaves single or non-array backend target patches unchanged', () => {
    const singlePatch = { backendTargetKeys: ['agent:claude'] };
    expect(normalizeActionInputPatch({ actionId: 'subagents.plan.start' as any, patch: singlePatch })).toBe(singlePatch);

    const malformedPatch = { backendTargetKeys: 'agent:claude' };
    expect(normalizeActionInputPatch({ actionId: 'subagents.plan.start' as any, patch: malformedPatch })).toBe(malformedPatch);
  });
});
