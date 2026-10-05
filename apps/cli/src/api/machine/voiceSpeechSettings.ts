import { isDeepStrictEqual } from 'node:util';
import { normalizeVoiceDictationLanguage, VoiceProviderSettingsEnvelopeV1Schema, type VoiceProviderContribution } from '@happier-dev/protocol';
import { getActiveAccountSettingsSnapshotLifetimeToken, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The admitted Account envelope and its existing currentness predicate for one speech invocation. */
export function readVoiceSpeechSettingsSnapshot(input: Readonly<{
  providerId: string;
  contribution: Extract<VoiceProviderContribution, { kind: 'speech' }>;
  readSnapshot(): ActiveAccountSettingsSnapshot | null;
  isRuntimeCurrent(): boolean;
  capturePurpose?: 'dictation' | 'conversation';
}>) {
  const snapshot = input.readSnapshot();
  const root = snapshot?.settings.voiceSettingsV1;
  const providers = isRecord(root) ? root.providers : null;
  const candidate = isRecord(providers) ? providers[input.providerId] : null;
  const envelope = VoiceProviderSettingsEnvelopeV1Schema.safeParse(candidate);
  if (!snapshot || !envelope.success || envelope.data.schemaVersion !== input.contribution.settings.schemaVersion) {
    throw Object.assign(new Error('provider_settings_invalid'), { code: 'provider_settings_invalid' });
  }
  const snapshotLifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const usesDictationLanguage = input.capturePurpose === 'dictation'
    && input.contribution.roles.some((role) => role === 'dictation_stt' || role === 'conversation_stt')
    && input.contribution.settings.fields.some((field) => field.id === 'language');
  const readDictationLanguage = (settingsRoot: unknown) => {
    const dictation = isRecord(settingsRoot) ? settingsRoot.dictation : null;
    return normalizeVoiceDictationLanguage(isRecord(dictation) ? dictation.language : null);
  };
  const recognitionLanguage = usesDictationLanguage ? readDictationLanguage(root) : undefined;
  const isCurrent = () => {
    const current = input.readSnapshot();
    if (!input.isRuntimeCurrent() || !current || getActiveAccountSettingsSnapshotLifetimeToken() !== snapshotLifetimeToken) return false;
    if (snapshot.scopeKey === undefined || current.scopeKey === undefined) return current === snapshot;
    if (current.scopeKey !== snapshot.scopeKey) return false;
    const currentRoot = current.settings.voiceSettingsV1;
    if (usesDictationLanguage && readDictationLanguage(currentRoot) !== recognitionLanguage) return false;
    const currentProviders = isRecord(currentRoot) ? currentRoot.providers : null;
    const currentEnvelope = VoiceProviderSettingsEnvelopeV1Schema.safeParse(isRecord(currentProviders) ? currentProviders[input.providerId] : null);
    return currentEnvelope.success && currentEnvelope.data.schemaVersion === envelope.data.schemaVersion
      && isDeepStrictEqual(currentEnvelope.data.config, envelope.data.config);
  };
  return Object.freeze({ snapshot, settings: envelope.data.config, settingsVersion: snapshot.settingsVersion,
    ...(usesDictationLanguage ? { recognitionLanguage } : {}), isCurrent });
}
