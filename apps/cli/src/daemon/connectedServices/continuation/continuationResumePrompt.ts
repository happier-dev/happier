import type { SessionContinuationResumePromptModeV1 } from '@happier-dev/protocol';
import type { ConnectedServiceRuntimeAuthFailureKind } from '../runtimeAuth/types';
import type { ConnectedServiceRecoveryScope } from '../runtimeRegistry/target';

export type ConnectedServiceContinuationInterruption = 'none' | 'clean_boundary' | 'forced_turn_cancelled' | 'provider_failed_turn';

/** One continuation admission pipeline; each scope supplies only its native delivery. */
export async function continueConnectedServiceRecoveryForScope<T>(input: Readonly<{
  scope: ConnectedServiceRecoveryScope;
  interruption: ConnectedServiceContinuationInterruption;
  resumePromptMode: SessionContinuationResumePromptModeV1;
  customResumePrompt?: string | null;
  recoveryKind?: ConnectedServiceRuntimeAuthFailureKind | null;
  afterUsageLimitReset?: boolean;
  prepare?: (input: Readonly<{ continuationEnabled: boolean }>) => Promise<boolean>;
  deliver: (input: Readonly<{ scope: ConnectedServiceRecoveryScope; prompt: string }>) => Promise<T>;
}>): Promise<Readonly<{ status: 'not_interrupted' | 'disabled' | 'unavailable' }> | Readonly<{ status: 'delivered'; value: T }>> {
  const continuationEnabled = input.interruption !== 'none' && input.interruption !== 'clean_boundary' && input.resumePromptMode !== 'off';
  if (input.prepare && !await input.prepare({ continuationEnabled })) return { status: 'unavailable' };
  if (input.interruption === 'none' || input.interruption === 'clean_boundary') return { status: 'not_interrupted' };
  if (!continuationEnabled) return { status: 'disabled' };
  return { status: 'delivered', value: await input.deliver({ scope: input.scope, prompt: buildContinuationResumePrompt(input) }) };
}

export const USAGE_LIMIT_CONTINUATION_RESUME_PROMPT =
  'Usage limits are lifted. Continue where you left off.';
export const GENERIC_CONTINUATION_RESUME_PROMPT = 'Continue where you left off';

/**
 * Resolves the prompt text for a continuation attempt. `custom` uses the
 * account-level custom text; empty/missing custom text fails safe to the
 * standard prompt (never silently off).
 */
export function buildContinuationResumePrompt(input: Readonly<{
  resumePromptMode: SessionContinuationResumePromptModeV1;
  customResumePrompt?: string | null;
  recoveryKind?: ConnectedServiceRuntimeAuthFailureKind | null;
  afterUsageLimitReset?: boolean;
}>): string {
  if (input.resumePromptMode === 'custom') {
    const custom = input.customResumePrompt?.trim() ?? '';
    if (custom.length > 0) return custom;
  }
  return input.afterUsageLimitReset === true
    && (input.recoveryKind === 'usage_limit' || input.recoveryKind === 'rate_limit')
    ? USAGE_LIMIT_CONTINUATION_RESUME_PROMPT
    : GENERIC_CONTINUATION_RESUME_PROMPT;
}
