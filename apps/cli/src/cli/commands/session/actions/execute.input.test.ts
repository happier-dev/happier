import { describe, expect, it } from 'vitest';
import { createActionExecutor, getActionSpec, type ActionExecutorDeps } from '@happier-dev/protocol';

import { withResolvedSessionInput } from './withResolvedSessionInput';

describe('Session-bound CLI Action input', () => {
  it('keeps strict presentation intent separate from the resolved Session context', async () => {
    const input = withResolvedSessionInput('session.presentation.apply', { intent: { kind: 'companion.show' } }, 'session-a');
    const delivered: unknown[] = [];
    // Mounted presentation is an external client response, not a headless writer.
    const ports = { currentSessionPresentationApply: async ({ input: selected }) => {
      delivered.push(selected);
      return { status: 'applied', revision: 'client-a:2' };
    } } satisfies Partial<ActionExecutorDeps>;
    const executor = createActionExecutor(ports as ActionExecutorDeps);
    await expect(executor.execute('session.presentation.apply', input, {
      surface: 'cli', defaultSessionId: 'session-a', actionRequestId: 'presentation-a', bypassApprovals: true,
    })).resolves.toEqual({ ok: true, result: { status: 'applied', revision: 'client-a:2' } });
    expect(delivered).toEqual([{ intent: { kind: 'companion.show' } }]);
  });

  it('retains resolved Session input for an Action that admits that field', () => {
    const input = withResolvedSessionInput('session.status.get', {}, 'session-a');
    expect(getActionSpec('session.status.get').inputSchema.parse(input)).toEqual({ sessionId: 'session-a' });
  });

  it('does not mask malformed presentation input', () => {
    const input = withResolvedSessionInput('session.presentation.apply', { intent: { kind: 'not-an-intent' } }, 'session-a');
    expect(getActionSpec('session.presentation.apply').inputSchema.safeParse(input).success).toBe(false);
  });
});
