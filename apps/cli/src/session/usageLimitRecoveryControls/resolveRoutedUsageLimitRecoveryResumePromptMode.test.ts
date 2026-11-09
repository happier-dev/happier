import { describe, expect, it } from 'vitest';

import { resolveRoutedUsageLimitRecoveryResumePromptMode } from './resolveRoutedUsageLimitRecoveryResumePromptMode';

describe('resolveRoutedUsageLimitRecoveryResumePromptMode', () => {
  it('keeps an unreadable Pool policy unavailable instead of enabling standard continuation', async () => {
    const unavailable = new Error('Home policy read unavailable');
    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'standard' } },
      loadGroupPolicy: async () => { throw unavailable; },
    })).rejects.toBe(unavailable);
  });
});
