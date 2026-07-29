export type LocalVoiceAgentToolResultEntry = Readonly<{
  t: string;
  args: unknown;
  result: unknown;
}>;

export type RetainedLocalVoiceEffectOutcome = Readonly<{
  fingerprint: string;
  outcome: Promise<LocalVoiceAgentToolResultEntry>;
}>;

const retainedOutcomesBySessionId = new Map<
  string,
  Map<string, RetainedLocalVoiceEffectOutcome>
>();

export function getRetainedLocalVoiceEffectOutcomes(
  sessionId: string,
): Map<string, RetainedLocalVoiceEffectOutcome> {
  let outcomes = retainedOutcomesBySessionId.get(sessionId);
  if (!outcomes) {
    outcomes = new Map();
    retainedOutcomesBySessionId.set(sessionId, outcomes);
  }
  return outcomes;
}

export function clearRetainedLocalVoiceEffectOutcomes(sessionId: string): void {
  retainedOutcomesBySessionId.delete(sessionId);
}
