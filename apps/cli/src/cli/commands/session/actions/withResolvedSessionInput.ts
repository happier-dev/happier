import { getActionContextualDefaults } from '@happier-dev/protocol/actions/actionSpecs';

/** The Session command supplies context separately from schema-admitted input. */
export function withResolvedSessionInput(actionId: string, input: unknown, sessionId: string): unknown {
  if (
    getActionContextualDefaults(actionId, input)?.sessionId !== 'current_session'
    || !input
    || typeof input !== 'object'
    || Array.isArray(input)
  ) {
    return input;
  }
  return { ...input, sessionId };
}
