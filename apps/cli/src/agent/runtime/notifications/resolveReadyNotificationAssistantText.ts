import {
  normalizeAssistantTextSnapshotText,
  type TurnAssistantTextSnapshotStore,
} from '@/api/session/turns/assistantTextSnapshot';
import { configuration } from '@/configuration';

export function resolveReadyNotificationAssistantText(params: Readonly<{
  includeAssistantPreviewText?: boolean;
  explicitAssistantText?: string | null;
  snapshotStore?: TurnAssistantTextSnapshotStore | null;
  turnToken?: string | null;
  startSeqExclusive?: number | null;
}>): string | null {
  if (params.includeAssistantPreviewText === false) return null;

  const explicit = normalizeAssistantTextSnapshotText(params.explicitAssistantText, {
    maxTextChars: configuration.readyNotificationAssistantTextMaxChars,
  });
  if (explicit) return explicit;

  return params.snapshotStore?.getSnapshotAfter({
    turnToken: params.turnToken ?? null,
    startSeqExclusive: params.startSeqExclusive ?? null,
  })?.normalizedText ?? null;
}
