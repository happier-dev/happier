export * from '@happier-dev/protocol/voice/settings/voiceSettingsPersistence';
import type { AccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import { createVoiceSettingsPersistenceOwner, type ProtocolAccountSettingsRuntimeProjection } from '@happier-dev/protocol/voice/settings/voiceSettingsPersistence';
import { voiceSettingsOwner } from './voiceSettings';
import type { LocalAccountSettings } from './registry/local/localAccountSettingDefinitions';

export const voiceSettingsPersistenceOwner = createVoiceSettingsPersistenceOwner({
    voiceOwner: voiceSettingsOwner,
});

export const { parseVoiceSettingsPersistenceV1, VoiceSettingsPersistenceV1Schema, voiceSettingsPersistenceV1Defaults, isCurrentWriterPredecessorVoiceProjection, parseCurrentWriterPredecessorVoiceProjection, projectVoiceDiagnosticsIntoRuntimeSettings, normalizeVoiceDiagnosticsLocalDelta, normalizeVoiceDiagnosticsServerDelta, normalizeVoiceSettingsLocalDelta, normalizeVoiceSettingsServerDelta } = voiceSettingsPersistenceOwner;

export function projectVoiceSettingsIntoRuntimeSettings(params: {
    parsed: AccountSettings & LocalAccountSettings;
    raw: Readonly<object>;
}): ProtocolAccountSettingsRuntimeProjection & LocalAccountSettings;
export function projectVoiceSettingsIntoRuntimeSettings(params: {
    parsed: AccountSettings;
    raw: Readonly<object>;
}): ProtocolAccountSettingsRuntimeProjection;
export function projectVoiceSettingsIntoRuntimeSettings(params: {
    parsed: AccountSettings;
    raw: Readonly<object>;
}): ProtocolAccountSettingsRuntimeProjection {
    return voiceSettingsPersistenceOwner.projectVoiceSettingsIntoRuntimeSettings(params);
}
