import { buildCodingSessionPromptPlanBaseV1, renderPromptPlanV1 } from '@happier-dev/protocol';

import { recordResolvedCodingPrompt } from '@/agent/prompting/coding/resolvedCodingPromptRecord';

/**
 * Claude's append system prompt for a base the runtime chose without the shared composition: none
 * on provider resume, a message reset (`null`), or a message's custom append text. The canonical
 * builder adds the retained session role block to that base, so the role survives resume and
 * resets exactly as on other providers, while the ordinary default base stays omitted.
 */
export function resolveClaudeRetainedAppendSystemPromptText(args: Readonly<{
  base: string | null | undefined;
  sessionMetadata: unknown;
}>): string | undefined {
  const plan = buildCodingSessionPromptPlanBaseV1({
    settings: null,
    base: typeof args.base === 'string' ? args.base : '',
    executionRunsFeatureEnabled: false,
    memoryRecallGuidanceEnabled: false,
    sessionMetadata: args.sessionMetadata,
  });
  const text = renderPromptPlanV1(plan).trim();
  // The runtime prompt preview reports this retained launch form (plan 2J).
  recordResolvedCodingPrompt({ plan, text, launchForm: 'retained', providerId: 'claude' });
  return text || undefined;
}

export function resolveInitialClaudeSystemPromptText(args: Readonly<{
  existingSessionId: string | null | undefined;
  defaultSystemPromptText?: string | null;
  sessionMetadata?: unknown;
}>): string | undefined {
  const existingSessionId = typeof args.existingSessionId === 'string' ? args.existingSessionId.trim() : '';
  // A resumed provider session keeps its original default base; only the retained role is re-established.
  if (existingSessionId) return resolveClaudeRetainedAppendSystemPromptText({ base: null, sessionMetadata: args.sessionMetadata });

  const defaultSystemPromptText = typeof args.defaultSystemPromptText === 'string'
    ? args.defaultSystemPromptText.trim()
    : '';

  return defaultSystemPromptText || undefined;
}
