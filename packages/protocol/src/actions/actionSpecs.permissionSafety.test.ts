import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';

describe('permission decision read-back safety', () => {
  it.each([
    ['allow', 'danger'], ['approved', 'danger'], ['approved_for_session', 'danger'],
    ['approved_execpolicy_amendment', 'danger'], ['deny', 'safe'], ['denied', 'safe'], ['abort', 'safe'],
  ] as const)('classifies permission %s as %s', (decision, safety) => {
    const spec = getActionSpec('session.permission.respond');
    const input = spec.inputSchema.parse({ sessionId: 'session', requestId: 'request', decision });
    expect(spec.safetyForInput?.(input) ?? spec.safety).toBe(safety);
  });

  it('requires read-back for opaque native choices whose grant is resolved by the Session', () => {
    const spec = getActionSpec('session.permission.respond');
    const input = spec.inputSchema.parse({ nativeChoice: { requirementId: 'request', choiceId: 'choice' } });
    expect(spec.safetyForInput?.(input) ?? spec.safety).toBe('danger');
  });

  it.each([['approve', 'danger'], ['reject', 'safe'], ['request_changes', 'safe']] as const)(
    'classifies user-action %s as %s', (decision, safety) => {
      const spec = getActionSpec('session.user_action.answer');
      expect(spec.safetyForInput?.({ decision }) ?? spec.safety).toBe(safety);
    });
});
