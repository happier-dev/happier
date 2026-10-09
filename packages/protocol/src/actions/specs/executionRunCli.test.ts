import { describe, expect, it } from 'vitest';
import { ExecutionRunStartCliInputSchema, bindExecutionRunStartCliInput } from './executionRunCli.js';
import { readActionCliDerivedDefault } from '../actionCliProjection.js';

describe('friendly execution Run target', () => {
  it('binds an authored cwd without a Session as explicitly detached and preserves Session selection', () => {
    const detached = ExecutionRunStartCliInputSchema.parse({ cwd: '/repo', intent: 'scm_commit_message', agent: 'codex' });
    const detachedInput = bindExecutionRunStartCliInput(detached);
    expect(detachedInput).toMatchObject({ cwd: '/repo', intent: 'scm_commit_message' });
    expect(readActionCliDerivedDefault(detachedInput.sessionId)).toEqual({ value: null });
    const attached = ExecutionRunStartCliInputSchema.parse({ sessionId: 'session-tag', intent: 'delegate', agent: 'codex' });
    expect(bindExecutionRunStartCliInput(attached)).toMatchObject({ sessionId: 'session-tag', intent: 'delegate' });
    const explicit = ExecutionRunStartCliInputSchema.parse({ sessionId: null, cwd: '/repo', intent: 'delegate', agent: 'codex' });
    expect(bindExecutionRunStartCliInput(explicit)).toMatchObject({ sessionId: null, cwd: '/repo' });
    expect(bindExecutionRunStartCliInput({})).toEqual({});
  });

  it('rejects invalid cwd and unknown friendly fields', () => {
    for (const input of [
      { cwd: ' ', intent: 'delegate', agent: 'codex' },
      { cwd: 1, intent: 'delegate', agent: 'codex' },
      { cwd: '/repo', intent: 'delegate', agent: 'codex', unknown: true },
    ]) expect(ExecutionRunStartCliInputSchema.safeParse(input).success).toBe(false);
  });
});
