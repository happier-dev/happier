import { normalizeTurnAssistantText } from '@/api/session/turnAssistantTextSnapshot';
import type { TurnAssistantTextSnapshot } from '@/api/session/turnAssistantTextSnapshot';
import { configuration } from '@/configuration';
import type { ProviderTurnCompletionResult } from './providerPromptSubmission';

export type ReadyNotificationAssistantTextSession = Readonly<{
  getTurnAssistantTextSnapshot?: (params: {
    turnToken?: string | null;
    startSeqExclusive?: number | null;
  }) => TurnAssistantTextSnapshot | null;
}>;

export function resolveReadyNotificationAssistantText(params: Readonly<{
  includeMessageText?: boolean;
  explicitAssistantText?: string | null;
  turnResult?: ProviderTurnCompletionResult;
  session?: ReadyNotificationAssistantTextSession | null;
  turnToken?: string | null;
  startSeqExclusive?: number | null;
  maxTextChars?: number;
}>): string | null {
  if (params.includeMessageText === false) return null;
  const maxTextChars = params.maxTextChars ?? configuration.readyNotificationAssistantTextMaxChars;
  if (params.turnResult) {
    return normalizeTurnAssistantText(params.turnResult.assistantText, { maxTextChars });
  }
  const explicit = normalizeTurnAssistantText(params.explicitAssistantText, { maxTextChars });
  if (explicit) return explicit;
  const snapshot = params.session?.getTurnAssistantTextSnapshot?.({
    turnToken: params.turnToken ?? null,
    startSeqExclusive: params.startSeqExclusive ?? null,
  }) ?? null;
  return snapshot?.text ?? null;
}
