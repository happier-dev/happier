import type { UsageLimitRecoverySettingsV1 } from '@happier-dev/protocol';

export function normalizeUsageLimitRecoverySettings(
    settings: Partial<UsageLimitRecoverySettingsV1> | null | undefined,
): UsageLimitRecoverySettingsV1 {
    const resumePromptMode = settings?.resumePromptMode === 'off' || settings?.resumePromptMode === 'custom'
        ? settings.resumePromptMode
        : 'standard';
    const customResumePrompt = typeof settings?.customResumePrompt === 'string'
        ? settings.customResumePrompt.trim()
        : '';
    const next: UsageLimitRecoverySettingsV1 = {
        v: 1,
        mode: settings?.mode === 'auto_wait' ? 'auto_wait' : 'ask',
        promptMode: 'standard',
        resumePromptMode,
    };
    if (customResumePrompt.length > 0) {
        next.customResumePrompt = customResumePrompt;
    }
    return next;
}

export function updateUsageLimitRecoveryRememberedMode(
    settings: Partial<UsageLimitRecoverySettingsV1> | null | undefined,
    mode: UsageLimitRecoverySettingsV1['mode'],
): UsageLimitRecoverySettingsV1 {
    return normalizeUsageLimitRecoverySettings({
        ...settings,
        mode,
    });
}
