import type { SessionUsageLimitRecoveryResumePromptModeV1 } from '@happier-dev/protocol';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | null {
  return value === 'standard' || value === 'off' || value === 'custom' ? value : null;
}

export async function resolveRoutedUsageLimitRecoveryResumePromptMode(input: Readonly<{
  explicit?: unknown;
  existingIntent?: unknown;
  accountSettings?: unknown;
  loadGroupPolicy?: () => Promise<unknown> | unknown;
}>): Promise<SessionUsageLimitRecoveryResumePromptModeV1> {
  const existing = readRecord(input.existingIntent);
  const higher = readMode(input.explicit) ?? readMode(existing?.resumePromptMode);
  if (higher) return higher;
  let groupPolicy: unknown = null;
  try {
    groupPolicy = await input.loadGroupPolicy?.() ?? null;
  } catch {
    groupPolicy = null;
  }
  const group = readRecord(groupPolicy);
  const account = readRecord(input.accountSettings);
  const nestedAccount = readRecord(account?.usageLimitRecoverySettingsV1);
  return readMode(group?.resumePromptMode)
    ?? readMode(nestedAccount?.resumePromptMode)
    ?? readMode(account?.resumePromptMode)
    ?? 'standard';
}
