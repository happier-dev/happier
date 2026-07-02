export type CursorModeId = 'agent' | 'plan' | 'ask';

export function resolveCursorModeValue(mode: CursorModeId): CursorModeId {
  return mode;
}

export function buildCursorPlanModePrompt(prompt: string): string {
  return [
    'Operate in plan mode. Inspect the request, propose the implementation plan, and wait for approval before changing files.',
    '',
    prompt,
  ].join('\n');
}
