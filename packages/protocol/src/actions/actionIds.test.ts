import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';

describe('ActionIdSchema', () => {
  it('accepts known action ids', () => {
    expect(ActionIdSchema.parse('review.start')).toBe('review.start');
    expect(ActionIdSchema.parse('subagents.delegate.start')).toBe('subagents.delegate.start');
    expect(ActionIdSchema.parse('session.open')).toBe('session.open');
    expect(ActionIdSchema.parse('execution.run.start')).toBe('execution.run.start');
    expect(ActionIdSchema.parse('execution.run.wait')).toBe('execution.run.wait');
    expect(ActionIdSchema.parse('prompt_asset.export')).toBe('prompt_asset.export');
    expect(ActionIdSchema.parse('prompt_registry.install')).toBe('prompt_registry.install');
  });

  it('does not accept unknown action ids', () => {
    expect(() => ActionIdSchema.parse('execution.run.stream.start' as any)).toThrow();
  });
});
