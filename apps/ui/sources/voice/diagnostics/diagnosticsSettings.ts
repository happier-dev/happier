import type { VoiceSpeechDiagnosticsSettingsV1 } from '@happier-dev/protocol';

import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { readVoiceDiagnosticsSettings, writeVoiceDiagnosticsSettings } from '@/sync/domains/settings/voiceSettings';

type CaptureDirection = 'captureSttInput' | 'captureTtsOutput';

/** Removing the final direction revokes recording consent; selecting one never grants it. */
export function applyVoiceDiagnosticsCaptureDirection(
    diagnostics: VoiceSpeechDiagnosticsSettingsV1,
    direction: CaptureDirection,
    enabled: boolean,
): VoiceSpeechDiagnosticsSettingsV1 {
    const next = { ...diagnostics, [direction]: enabled };
    return next.captureSttInput || next.captureTtsOutput
        ? next : { ...next, enabled: false, consentVersion: null };
}

export function voiceDiagnosticsCaptureBinding(direction: CaptureDirection): SettingStorageBinding {
    return {
        scope: 'account', kind: 'owner', access: 'read_write',
        read: (settings) => readVoiceDiagnosticsSettings(settings.voice)[direction],
        parse: (value) => typeof value === 'boolean' ? { success: true, value } : { success: false },
        mutate: (settings, value) => typeof value === 'boolean' ? { voice: writeVoiceDiagnosticsSettings(
            settings.voice,
            applyVoiceDiagnosticsCaptureDirection(readVoiceDiagnosticsSettings(settings.voice), direction, value),
        ) } : null,
    };
}
