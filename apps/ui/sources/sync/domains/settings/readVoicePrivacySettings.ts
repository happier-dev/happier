import { readVoiceContentDisclosureV1 } from '@happier-dev/protocol/voice/sourceDisclosureV1';

import { voiceSettingsParse, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';

export function readVoicePrivacySettings(settings: unknown): VoiceSettings['privacy'] {
    const rawVoice = (settings as { voice?: unknown } | null | undefined)?.voice ?? null;
    const voiceSettings = voiceSettingsParse(rawVoice);
    const rawPrivacy = rawVoice && typeof rawVoice === 'object' && !Array.isArray(rawVoice)
        ? (rawVoice as { privacy?: unknown }).privacy
        : null;
    const privacyRecord = rawPrivacy && typeof rawPrivacy === 'object' && !Array.isArray(rawPrivacy)
        ? rawPrivacy as Record<string, unknown>
        : null;
    const explicitlyShares = (key: string): boolean => privacyRecord?.[key] === true;
    const hasCurrentUiContextMode = privacyRecord !== null
        && Object.prototype.hasOwnProperty.call(privacyRecord, 'currentUiContextMode');
    const rawCurrentUiContextMode = privacyRecord?.currentUiContextMode;
    const currentUiContextMode = hasCurrentUiContextMode
        && rawCurrentUiContextMode !== voiceSettings.privacy.currentUiContextMode
        ? 'off'
        : voiceSettings.privacy.currentUiContextMode;

    return {
        ...voiceSettings.privacy,
        // The settings parser recovers malformed input for UI editing, but a
        // present value that did not survive parsing must not authorize
        // provider disclosure. Missing predecessor data retains on-demand.
        currentUiContextMode,
        // These values are consumed at provider boundaries. A malformed or
        // partial payload must never inherit the account schema's UI defaults.
        // Summary and transcript disclosure are decided by the Protocol owner
        // the daemon Voice path also asks, so one Account switch bounds both.
        ...readVoiceContentDisclosureV1(settings),
        shareToolNames: explicitlyShares('shareToolNames'),
        sharePermissionRequests: explicitlyShares('sharePermissionRequests'),
        shareDeviceInventory: explicitlyShares('shareDeviceInventory'),
        // These remain hard-disabled unless the canonical parser and raw value
        // both explicitly admit sharing.
        shareFilePaths: voiceSettings.privacy.shareFilePaths && explicitlyShares('shareFilePaths'),
        shareToolArgs: voiceSettings.privacy.shareToolArgs && explicitlyShares('shareToolArgs'),
    };
}
