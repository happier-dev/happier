import {
    SavedSecretSchema,
    VoiceSpeechDiagnosticsSettingsV1Schema,
    type SecretStringV1,
    type VoiceCredentialBindingV1,
    type VoiceProviderSettingsEnvelopeV1,
    type VoiceSpeechDiagnosticsSettingsV1,
} from '@happier-dev/protocol';
import { z } from 'zod';

import {
    getCanonicalVoiceProviderSettingsOwner,
    isReservedVoiceSettingsRootKey,
    voiceSettingsDefaults,
    voiceSettingsParse,
    type VoiceSettings,
} from './voiceSettings';

export const VOICE_DIAGNOSTICS_ACCOUNT_SETTING_KEY = 'voiceDiagnosticsV1' as const;
export const VOICE_SETTINGS_ACCOUNT_SETTING_KEY = 'voiceSettingsV1' as const;
export const VOICE_SETTINGS_CURRENT_WRITER_MARKER = 'happierVoiceSettingsV1' as const;

const DEFAULT_DIAGNOSTICS = VoiceSpeechDiagnosticsSettingsV1Schema.parse({});
const PREDECESSOR_VOICE_PROVIDER_IDS = new Set([
    'realtime_elevenlabs',
    'local_direct',
    'local_conversation',
]);
const PREDECESSOR_OWNED_CREDENTIAL_PROVIDER_ID = 'realtime_elevenlabs';

export type VoiceSettingsPersistenceV1 = Omit<VoiceSettings, 'diagnostics'>;

type VoiceDiagnosticsAccountProjection = Readonly<{
    voiceDiagnosticsV1: VoiceSpeechDiagnosticsSettingsV1;
}>;

type VoiceSettingsAccountProjection = Readonly<{
    voiceSettingsV1: VoiceSettingsPersistenceV1;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: object, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function parseCanonicalDiagnostics(value: unknown): VoiceSpeechDiagnosticsSettingsV1 {
    const parsed = VoiceSpeechDiagnosticsSettingsV1Schema.safeParse(value);
    return parsed.success ? parsed.data : DEFAULT_DIAGNOSTICS;
}

function readLegacyNestedDiagnostics(rawVoice: unknown): VoiceSpeechDiagnosticsSettingsV1 {
    if (!isRecord(rawVoice) || !hasOwn(rawVoice, 'diagnostics')) return DEFAULT_DIAGNOSTICS;
    return parseCanonicalDiagnostics(rawVoice.diagnostics);
}

function readDiagnosticsFromAccountSettings(raw: Readonly<Record<string, unknown>>): VoiceSpeechDiagnosticsSettingsV1 {
    if (hasOwn(raw, VOICE_DIAGNOSTICS_ACCOUNT_SETTING_KEY)) {
        return parseCanonicalDiagnostics(raw[VOICE_DIAGNOSTICS_ACCOUNT_SETTING_KEY]);
    }
    return readLegacyNestedDiagnostics(raw.voice);
}

function omitPersistenceOnlyVoiceFields(value: VoiceSettings): VoiceSettingsPersistenceV1 {
    const result = { ...value } as Record<string, unknown>;
    delete result.diagnostics;
    delete result[VOICE_SETTINGS_CURRENT_WRITER_MARKER];
    return result as VoiceSettingsPersistenceV1;
}

export function parseVoiceSettingsPersistenceV1(value: unknown): VoiceSettingsPersistenceV1 {
    return omitPersistenceOnlyVoiceFields(voiceSettingsParse(value, {
        allowLegacyCredentialRecoveryCarrier: true,
    }));
}

export const VoiceSettingsPersistenceV1Schema = z.unknown().transform(parseVoiceSettingsPersistenceV1);
export const voiceSettingsPersistenceV1Defaults = parseVoiceSettingsPersistenceV1(voiceSettingsDefaults);

function withDiagnostics(
    value: VoiceSettingsPersistenceV1,
    diagnostics: VoiceSpeechDiagnosticsSettingsV1,
): VoiceSettings {
    return { ...value, diagnostics } as VoiceSettings;
}

function hasCurrentWriterMarker(rawVoice: unknown): boolean {
    return isRecord(rawVoice) && rawVoice[VOICE_SETTINGS_CURRENT_WRITER_MARKER] === true;
}

export function parseCurrentWriterPredecessorVoiceProjection(
    value: unknown,
): Record<string, unknown> | null {
    if (!hasCurrentWriterMarker(value) || !isRecord(value)) return null;
    const providerId = value.providerId;
    if (providerId !== 'off' && !PREDECESSOR_VOICE_PROVIDER_IDS.has(String(providerId))) return null;
    const parsed = voiceSettingsParse(value);
    const rawAdapters = isRecord(value.adapters) ? value.adapters : {};
    const adapters: Record<string, unknown> = {};
    for (const providerIdCandidate of PREDECESSOR_VOICE_PROVIDER_IDS) {
        const owner = getCanonicalVoiceProviderSettingsOwner(providerIdCandidate);
        const adapter = rawAdapters[providerIdCandidate];
        if (!owner || adapter === undefined || owner.migrateLegacy(adapter) === null) continue;
        adapters[providerIdCandidate] = JSON.parse(JSON.stringify(adapter)) as unknown;
    }
    return {
        providerId,
        assistantLanguage: parsed.assistantLanguage,
        ui: parsed.ui,
        privacy: parsed.privacy,
        adapters,
        [VOICE_SETTINGS_CURRENT_WRITER_MARKER]: true,
    };
}

function replacePredecessorOwnedBindings(
    canonical: readonly VoiceCredentialBindingV1[],
    predecessor: readonly VoiceCredentialBindingV1[],
): VoiceCredentialBindingV1[] {
    return [
        ...canonical.filter((binding) => binding.providerId !== PREDECESSOR_OWNED_CREDENTIAL_PROVIDER_ID),
        ...predecessor.filter((binding) => binding.providerId === PREDECESSOR_OWNED_CREDENTIAL_PROVIDER_ID),
    ];
}

function mergePredecessorVoiceWrite(
    canonical: VoiceSettingsPersistenceV1,
    predecessor: VoiceSettings,
    rawPredecessor: Readonly<Record<string, unknown>>,
): VoiceSettingsPersistenceV1 {
    const providers = { ...canonical.providers };
    const rawAdapters = isRecord(rawPredecessor.adapters) ? rawPredecessor.adapters : {};
    for (const providerId of PREDECESSOR_VOICE_PROVIDER_IDS) {
        if (!hasOwn(rawAdapters, providerId)) continue;
        const currentEnvelope = canonical.providers[providerId];
        const predecessorEnvelope = predecessor.providers[providerId];
        const owner = getCanonicalVoiceProviderSettingsOwner(providerId);
        if (!owner || !currentEnvelope || !predecessorEnvelope) continue;
        if (currentEnvelope.schemaVersion !== owner.currentSchemaVersion
            || predecessorEnvelope.schemaVersion !== owner.currentSchemaVersion) continue;
        const mergedConfig = owner.mergeLegacy(currentEnvelope.config, predecessorEnvelope.config);
        if (mergedConfig === null) continue;
        providers[providerId] = {
            schemaVersion: owner.currentSchemaVersion,
            config: mergedConfig as VoiceProviderSettingsEnvelopeV1['config'],
        };
    }
    const providerId = hasOwn(rawPredecessor, 'providerId')
        ? predecessor.providerId
        : canonical.providerId;
    const selectedProviderOwnsWelcome = providerId !== null
        && hasOwn(rawAdapters, providerId)
        && (providerId === 'realtime_elevenlabs' || providerId === 'local_conversation');
    const selectedProviderOwnsExecutionMachine = providerId === 'local_conversation'
        && hasOwn(rawAdapters, providerId);
    const predecessorOwnsElevenLabsCredential = hasOwn(
        rawAdapters,
        PREDECESSOR_OWNED_CREDENTIAL_PROVIDER_ID,
    );
    return parseVoiceSettingsPersistenceV1({
        ...canonical,
        providerId,
        assistantLanguage: hasOwn(rawPredecessor, 'assistantLanguage')
            ? predecessor.assistantLanguage
            : canonical.assistantLanguage,
        welcome: selectedProviderOwnsWelcome ? predecessor.welcome : canonical.welcome,
        executionMachine: selectedProviderOwnsExecutionMachine
            ? predecessor.executionMachine
            : canonical.executionMachine,
        ui: hasOwn(rawPredecessor, 'ui') ? predecessor.ui : canonical.ui,
        privacy: hasOwn(rawPredecessor, 'privacy') ? predecessor.privacy : canonical.privacy,
        providers,
        credentialBindings: predecessorOwnsElevenLabsCredential
            ? replacePredecessorOwnedBindings(
                canonical.credentialBindings,
                predecessor.credentialBindings,
            )
            : canonical.credentialBindings,
    });
}

function readCanonicalVoiceFromProjection(params: Readonly<{
    parsed: Readonly<Record<string, unknown>>;
    raw: Readonly<Record<string, unknown>>;
}>): VoiceSettingsPersistenceV1 {
    const rootPresent = hasOwn(params.raw, VOICE_SETTINGS_ACCOUNT_SETTING_KEY);
    const canonical = rootPresent
        ? parseVoiceSettingsPersistenceV1(params.raw[VOICE_SETTINGS_ACCOUNT_SETTING_KEY])
        : parseVoiceSettingsPersistenceV1(params.parsed.voice);
    const runtimeProjectionPresent = hasOwn(params.raw, 'voice');
    if (!rootPresent
        || !runtimeProjectionPresent
        || !isRecord(params.raw.voice)
        || hasCurrentWriterMarker(params.raw.voice)) return canonical;

    // A predecessor whole-object Voice write strips the marker. Only the
    // predecessor-owned families are merged; current-only providers and
    // bounded future root namespaces remain owned by voiceSettingsV1.
    const rawPredecessor = params.raw.voice;
    return mergePredecessorVoiceWrite(
        canonical,
        voiceSettingsParse(rawPredecessor),
        rawPredecessor,
    );
}

function readEncryptedSavedSecretCredential(
    account: Readonly<Record<string, unknown>>,
    voice: VoiceSettingsPersistenceV1,
    providerId: string,
    slotId: string,
): SecretStringV1 | null {
    const binding = voice.credentialBindings.find((candidate) => candidate.providerId === providerId);
    const savedSecretId = binding?.credentialBindings.account?.[slotId] ?? null;
    if (!savedSecretId || !Array.isArray(account.secrets)) return null;
    for (const candidate of account.secrets) {
        const parsed = SavedSecretSchema.safeParse(candidate);
        if (!parsed.success || parsed.data.id !== savedSecretId) continue;
        const encryptedValue = parsed.data.encryptedValue.encryptedValue;
        return encryptedValue
            ? { _isSecretValue: true, encryptedValue }
            : null;
    }
    return null;
}

function readProviderEnvelope(
    voice: VoiceSettingsPersistenceV1,
    providerId: string,
): VoiceProviderSettingsEnvelopeV1 | null {
    return voice.providers[providerId] ?? null;
}

function createPredecessorVoiceProjection(
    voice: VoiceSettingsPersistenceV1,
    account: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
    const resolveCredential = (providerId: string, slotId: string): SecretStringV1 | null =>
        providerId === PREDECESSOR_OWNED_CREDENTIAL_PROVIDER_ID
            ? readEncryptedSavedSecretCredential(account, voice, providerId, slotId)
            : null;
    const root = {
        assistantLanguage: voice.assistantLanguage,
        welcome: voice.welcome,
        executionMachine: voice.executionMachine,
    } as const;
    const adapters: Record<string, unknown> = {};
    for (const providerId of PREDECESSOR_VOICE_PROVIDER_IDS) {
        const owner = getCanonicalVoiceProviderSettingsOwner(providerId);
        const envelope = readProviderEnvelope(voice, providerId);
        if (!owner || !envelope || envelope.schemaVersion !== owner.currentSchemaVersion) continue;
        const projected = owner.projectLegacy(envelope.config, { root, resolveCredential });
        if (projected !== null) adapters[providerId] = projected;
    }
    const selectedProviderId = voice.providerId;
    const predecessorProviderId = selectedProviderId !== null
        && PREDECESSOR_VOICE_PROVIDER_IDS.has(selectedProviderId)
        && hasOwn(adapters, selectedProviderId)
        ? selectedProviderId
        : 'off';
    return {
        providerId: predecessorProviderId,
        assistantLanguage: voice.assistantLanguage,
        ui: voice.ui,
        privacy: voice.privacy,
        adapters,
        [VOICE_SETTINGS_CURRENT_WRITER_MARKER]: true,
    };
}

function omitLegacyNestedDiagnostics(rawVoice: unknown): Record<string, unknown> {
    if (!isRecord(rawVoice)) return {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawVoice)) {
        if (key === 'diagnostics') continue;
        if (isReservedVoiceSettingsRootKey(key) && key !== 'adapters') continue;
        out[key] = value;
    }
    return out;
}

export function projectVoiceDiagnosticsIntoRuntimeSettings<T extends object>(params: {
    parsed: T;
    raw: Readonly<object>;
}): T {
    const parsedRecord = params.parsed as Record<string, unknown>;
    const rawRecord = params.raw as Readonly<Record<string, unknown>>;
    const diagnostics = readDiagnosticsFromAccountSettings(rawRecord);
    const voice = voiceSettingsParse(parsedRecord.voice, {
        allowLegacyCredentialRecoveryCarrier: true,
    });
    return {
        ...parsedRecord,
        [VOICE_DIAGNOSTICS_ACCOUNT_SETTING_KEY]: diagnostics,
        voice: {
            ...voice,
            diagnostics,
        } satisfies VoiceSettings,
    } as T;
}

/**
 * Projects the account-root persistence owner into the sole runtime Voice view.
 *
 * `remote-dev` 1b32cdc6f3f978c06484be49e52c9e4039e0fd71 preserves
 * unknown account-root fields but strips unknown nested Voice fields. Its
 * whole-object Voice writer also strips the current-writer marker, which is
 * the bounded evidence used to merge predecessor-owned edits exactly once.
 * Remove this projection only after the provenance-pinned deployed readers,
 * rollback path, and predecessor producer are all unreachable and persisted
 * carriers have been migrated.
 */
export function projectVoiceSettingsIntoRuntimeSettings<T extends object>(params: {
    parsed: T;
    raw: Readonly<object>;
}): T {
    const projectedDiagnostics = projectVoiceDiagnosticsIntoRuntimeSettings(params);
    const parsedRecord = projectedDiagnostics as Record<string, unknown>;
    const rawRecord = params.raw as Readonly<Record<string, unknown>>;
    const diagnostics = parseCanonicalDiagnostics(parsedRecord[VOICE_DIAGNOSTICS_ACCOUNT_SETTING_KEY]);
    const canonical = readCanonicalVoiceFromProjection({ parsed: parsedRecord, raw: rawRecord });
    return {
        ...parsedRecord,
        [VOICE_SETTINGS_ACCOUNT_SETTING_KEY]: canonical,
        voice: withDiagnostics(canonical, diagnostics),
    } as T;
}

export function normalizeVoiceDiagnosticsLocalDelta<T extends object>(
    delta: T,
    current?: Readonly<object>,
): T | (T & VoiceDiagnosticsAccountProjection) {
    const deltaRecord = delta as Record<string, unknown>;
    const currentRecord = current as Readonly<Record<string, unknown>> | undefined;
    const hasVoice = hasOwn(deltaRecord, 'voice');
    const hasCanonical = hasOwn(deltaRecord, VOICE_DIAGNOSTICS_ACCOUNT_SETTING_KEY);
    if (!hasVoice && !hasCanonical) return delta;

    const voiceCarriesLegacyDiagnostics = isRecord(deltaRecord.voice) && hasOwn(deltaRecord.voice, 'diagnostics');
    const diagnostics = hasCanonical
        ? parseCanonicalDiagnostics(deltaRecord[VOICE_DIAGNOSTICS_ACCOUNT_SETTING_KEY])
        : voiceCarriesLegacyDiagnostics
            ? readLegacyNestedDiagnostics(deltaRecord.voice)
            : currentRecord
                ? readDiagnosticsFromAccountSettings(currentRecord)
                : DEFAULT_DIAGNOSTICS;
    const next = {
        ...deltaRecord,
        [VOICE_DIAGNOSTICS_ACCOUNT_SETTING_KEY]: diagnostics,
    } as Record<string, unknown>;
    if (hasVoice) {
        next.voice = {
            ...voiceSettingsParse(deltaRecord.voice, {
                allowLegacyCredentialRecoveryCarrier: true,
            }),
            diagnostics,
        } satisfies VoiceSettings;
    }
    return next as T & VoiceDiagnosticsAccountProjection;
}

export function normalizeVoiceDiagnosticsServerDelta<T extends object>(
    delta: T,
): T | (T & VoiceDiagnosticsAccountProjection) {
    const deltaRecord = delta as Record<string, unknown>;
    const hasCanonical = hasOwn(deltaRecord, VOICE_DIAGNOSTICS_ACCOUNT_SETTING_KEY);
    const voiceCarriesLegacyDiagnostics = isRecord(deltaRecord.voice)
        && hasOwn(deltaRecord.voice, 'diagnostics');
    const normalized = hasCanonical || voiceCarriesLegacyDiagnostics
        ? Object.assign({}, deltaRecord, {
            [VOICE_DIAGNOSTICS_ACCOUNT_SETTING_KEY]: hasCanonical
                ? parseCanonicalDiagnostics(deltaRecord[VOICE_DIAGNOSTICS_ACCOUNT_SETTING_KEY])
                : readLegacyNestedDiagnostics(deltaRecord.voice),
        })
        : deltaRecord;
    if (!hasOwn(normalized, 'voice')) return normalized as T | (T & VoiceDiagnosticsAccountProjection);
    return Object.assign({}, normalized, {
        voice: omitLegacyNestedDiagnostics(normalized.voice),
    }) as T | (T & VoiceDiagnosticsAccountProjection);
}

function readCanonicalVoiceForDelta(
    delta: Readonly<Record<string, unknown>>,
    current?: Readonly<Record<string, unknown>>,
): VoiceSettingsPersistenceV1 | null {
    if (!hasOwn(delta, 'voice') && !hasOwn(delta, VOICE_SETTINGS_ACCOUNT_SETTING_KEY)) return null;
    const projection = current ? { ...current, ...delta } : delta;
    return readCanonicalVoiceFromProjection({
        parsed: projection,
        raw: projection,
    });
}

export function normalizeVoiceSettingsLocalDelta<T extends object>(
    delta: T,
    current?: Readonly<object>,
): T | (T & VoiceDiagnosticsAccountProjection & VoiceSettingsAccountProjection) {
    const diagnosticsNormalized = normalizeVoiceDiagnosticsLocalDelta(delta, current);
    const deltaRecord = diagnosticsNormalized as Record<string, unknown>;
    const currentRecord = current as Readonly<Record<string, unknown>> | undefined;
    const canonical = hasOwn(deltaRecord, VOICE_SETTINGS_ACCOUNT_SETTING_KEY)
        ? parseVoiceSettingsPersistenceV1(deltaRecord[VOICE_SETTINGS_ACCOUNT_SETTING_KEY])
        : hasOwn(deltaRecord, 'voice')
            ? parseVoiceSettingsPersistenceV1(deltaRecord.voice)
            : readCanonicalVoiceForDelta(deltaRecord, currentRecord);
    if (!canonical || (!hasOwn(deltaRecord, 'voice') && !hasOwn(deltaRecord, VOICE_SETTINGS_ACCOUNT_SETTING_KEY))) {
        return diagnosticsNormalized;
    }
    const diagnostics = hasOwn(deltaRecord, VOICE_DIAGNOSTICS_ACCOUNT_SETTING_KEY)
        ? parseCanonicalDiagnostics(deltaRecord[VOICE_DIAGNOSTICS_ACCOUNT_SETTING_KEY])
        : currentRecord
            ? readDiagnosticsFromAccountSettings(currentRecord)
            : DEFAULT_DIAGNOSTICS;
    return Object.assign({}, diagnosticsNormalized, {
        [VOICE_SETTINGS_ACCOUNT_SETTING_KEY]: canonical,
        voice: withDiagnostics(canonical, diagnostics),
    });
}

export function normalizeVoiceSettingsServerDelta<T extends object>(
    delta: T,
    current?: Readonly<object>,
): T | (T & VoiceDiagnosticsAccountProjection & VoiceSettingsAccountProjection) {
    const diagnosticsNormalized = normalizeVoiceDiagnosticsServerDelta(delta);
    const deltaRecord = diagnosticsNormalized as Record<string, unknown>;
    const currentRecord = current as Readonly<Record<string, unknown>> | undefined;
    const canonical = readCanonicalVoiceForDelta(deltaRecord, currentRecord);
    if (!canonical || (!hasOwn(deltaRecord, 'voice') && !hasOwn(deltaRecord, VOICE_SETTINGS_ACCOUNT_SETTING_KEY))) {
        return diagnosticsNormalized;
    }
    const account = currentRecord
        ? { ...currentRecord, ...deltaRecord }
        : deltaRecord;
    const predecessorProjection = !currentRecord
        && hasOwn(deltaRecord, VOICE_SETTINGS_ACCOUNT_SETTING_KEY)
        && hasCurrentWriterMarker(deltaRecord.voice)
        ? parseCurrentWriterPredecessorVoiceProjection(deltaRecord.voice)
            ?? createPredecessorVoiceProjection(canonical, account)
        : createPredecessorVoiceProjection(canonical, account);
    return Object.assign({}, diagnosticsNormalized, {
        [VOICE_SETTINGS_ACCOUNT_SETTING_KEY]: canonical,
        voice: predecessorProjection,
    });
}
