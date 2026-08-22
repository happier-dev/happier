import {
    PluginContributionIdentityV1Schema,
    RETIRED_ACCOUNT_SETTINGS_SESSION_ORGANIZATION_KEYS,
    readProviderSettingsFromAccountSettingsV1,
    SavedSecretSchema,
    SecretStringV1Schema,
    VoiceCredentialBindingV1Schema,
    VoiceSpeechDiagnosticsSettingsV1Schema,
    resolvePredecessorVoiceProviderContributionIdentityV1,
    type AccountSettings,
    type AccountSettingsDefaults,
    type SecretStringV1,
    type VoiceCredentialBindingV1,
    type VoiceProviderSettingsEnvelopeV1,
    type VoiceSpeechDiagnosticsSettingsV1,
} from '@happier-dev/protocol';
import { z } from 'zod';

import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';

import { stripMigratedSessionOrganizationSettings } from './parse/accountSettingsLegacyCleanup';
import {
    projectCurrentSecretBindingsByProfileId,
    type CurrentSecretBindingsByProfileId,
} from './secretBindings';
import {
    getCanonicalVoiceProviderSettingsOwner,
    isReservedVoiceSettingsRootKey,
    voiceSettingsDefaults,
    voiceSettingsParse,
    VoiceLocalConversationSchema,
    type VoiceSettings,
} from './voiceSettings';
import { migrateLegacySpeechProviderConfig } from './migrations/speechProviders';
import type { LocalAccountSettings } from './registry/local/localAccountSettingDefinitions';
import {
    PredecessorVoiceCredentialBindingV1Schema,
    parsePredecessorVoiceCredentialBindings,
    type PredecessorVoiceCredentialBindingV1,
} from './voiceCredentialBindingCompatibility';

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
const QUALIFIED_ELEVENLABS_PROVIDER_ID = 'happier.voice.elevenlabs/realtime-elevenlabs';
const QUALIFIED_OPENAI_COMPAT_STT_PROVIDER_ID = 'happier.voice.openai-compat/stt';
const QUALIFIED_OPENAI_COMPAT_TTS_PROVIDER_ID = 'happier.voice.openai-compat/tts';

type PredecessorInlineCredentialProviderId =
    | typeof PREDECESSOR_OWNED_CREDENTIAL_PROVIDER_ID
    | typeof QUALIFIED_OPENAI_COMPAT_STT_PROVIDER_ID
    | typeof QUALIFIED_OPENAI_COMPAT_TTS_PROVIDER_ID;

export type VoiceSettingsPersistenceV1 = Omit<
    VoiceSettings,
    'diagnostics' | 'credentialBindings'
> & Readonly<{
    credentialBindings: readonly VoiceCredentialBindingV1[];
}>;

type VoiceDiagnosticsAccountProjection = Readonly<{
    voiceDiagnosticsV1: VoiceSpeechDiagnosticsSettingsV1;
}>;

type VoiceSettingsAccountProjection = Readonly<{
    voiceSettingsV1: VoiceSettingsPersistenceV1;
}>;

/**
 * The UI-only view materialized from the bounded persisted Voice roots.
 *
 * Protocol owns the storage schema and deliberately treats retained legacy
 * roots as bounded JSON. This projection is the one canonical consumer-facing
 * interpretation after Account Settings have been opened and migrated.
 */
export type VoiceSettingsRuntimeProjection = Readonly<{
    voice: VoiceSettings;
}> & VoiceDiagnosticsAccountProjection & VoiceSettingsAccountProjection;

/**
 * Retained Account JSON stays on its Protocol-owned root for writeback. UI
 * consumers receive only this positively recognized current-map projection.
 */
type SecretBindingsRuntimeProjection = Readonly<{
    currentSecretBindingsByProfileId: CurrentSecretBindingsByProfileId;
}>;

type RetiredAccountSettingsRuntimeKey =
    (typeof RETIRED_ACCOUNT_SETTINGS_SESSION_ORGANIZATION_KEYS)[number];

/**
 * Protocol's parser is deliberately a passthrough type, so omitting keys
 * directly from it would erase every known property through its string index.
 * Rebuild only the known catalog shape here while replacing the three
 * materialized Voice roots. Runtime values preserve forward Account roots,
 * but consumer types deliberately do not grant indexed access to them.
 */
export type ProtocolAccountSettingsRuntimeProjection = Omit<
    AccountSettingsDefaults,
    | keyof VoiceSettingsRuntimeProjection
    | RetiredAccountSettingsRuntimeKey
    // The Protocol-owned bounded JSON carrier remains on the runtime object
    // solely for persistence/writeback. Consumers receive the current-map
    // projection above rather than the raw carrier.
    | 'secretBindingsByProfileId'
> & VoiceSettingsRuntimeProjection & SecretBindingsRuntimeProjection;

type ProtocolAndLocalAccountSettingsRuntimeProjection =
    ProtocolAccountSettingsRuntimeProjection & LocalAccountSettings;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: object, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function projectPredecessorVoicePrivacy(
    privacy: VoiceSettings['privacy'],
): Omit<VoiceSettings['privacy'], 'currentUiContextMode'> {
    const { currentUiContextMode: _currentUiContextMode, ...predecessorPrivacy } = privacy;
    return predecessorPrivacy;
}

function attachCurrentSecretBindingsRuntimeProjection<T extends object>(
    value: T,
): T & SecretBindingsRuntimeProjection {
    Object.defineProperty(value, 'currentSecretBindingsByProfileId', {
        configurable: false,
        enumerable: false,
        value: projectCurrentSecretBindingsByProfileId(value),
        writable: false,
    });
    return value as T & SecretBindingsRuntimeProjection;
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

function resolveVoiceContributionIdentity(providerId: string) {
    const predecessor = resolvePredecessorVoiceProviderContributionIdentityV1(providerId);
    if (predecessor) return predecessor;
    const separator = providerId.indexOf('/');
    if (separator <= 0 || separator === providerId.length - 1) return null;
    const parsed = PluginContributionIdentityV1Schema.safeParse({
        pluginId: providerId.slice(0, separator),
        localId: providerId.slice(separator + 1),
    });
    return parsed.success ? parsed.data : null;
}

function normalizeVoiceProviderSettingsId(providerId: string): string {
    const contribution = resolveVoiceContributionIdentity(providerId);
    return contribution
        ? `${contribution.pluginId}/${contribution.localId}`
        : providerId;
}

function projectPredecessorVoiceProviderId(providerId: string): string | null {
    if (PREDECESSOR_VOICE_PROVIDER_IDS.has(providerId)) return providerId;
    return providerId === QUALIFIED_ELEVENLABS_PROVIDER_ID
        ? PREDECESSOR_OWNED_CREDENTIAL_PROVIDER_ID
        : null;
}

function resolvePredecessorCredentialTarget(
    providerId: string,
    credentialSlotId: string,
): Readonly<{
    contribution: VoiceCredentialBindingV1['contribution'];
    credentialSlotId: string;
}> | null {
    const contribution = resolveVoiceContributionIdentity(providerId);
    return contribution ? { contribution, credentialSlotId } : null;
}

const MAX_VOICE_CREDENTIAL_BINDINGS = 64;

function normalizeQualifiedCredentialBindings(value: unknown): readonly VoiceCredentialBindingV1[] {
    if (!isRecord(value) || !Array.isArray(value.credentialBindings)) return [];
    // A legacy carrier entry fans out to one binding per credential slot, so the
    // normalized result can exceed its input length and can collide with an
    // already-canonical entry for the same identity. `VoiceCredentialBindingsSchema`
    // rejects duplicates and anything past the ceiling for the WHOLE array, and
    // `voiceSettingsParse` then falls back to `[]` — which is how a single
    // duplicate would silently retract every stored Voice credential binding at
    // the next settings write. Emit a set the canonical schema always accepts.
    return dedupeCredentialBindings(value.credentialBindings.slice(0, 64).flatMap((candidate) => {
        const canonical = VoiceCredentialBindingV1Schema.safeParse(candidate);
        if (canonical.success) return [canonical.data];
        const legacy = PredecessorVoiceCredentialBindingV1Schema.safeParse(candidate);
        if (!legacy.success) return [];
        const binding = legacy.data;
        const slotIds = new Set<string>([
            ...Object.keys(binding.credentialBindings.account ?? {}),
            ...Object.values(binding.credentialBindings.byMachineId ?? {})
                .flatMap((machine) => Object.keys(machine)),
        ]);
        return [...slotIds].flatMap((legacyCredentialSlotId) => {
            const target = resolvePredecessorCredentialTarget(
                binding.providerId,
                legacyCredentialSlotId,
            );
            if (!target) return [];
            const parsed = VoiceCredentialBindingV1Schema.safeParse({
                contribution: target.contribution,
                credentialSlotId: target.credentialSlotId,
                credentialSource: { kind: 'savedSecret' },
                credentialBindings: {
                    ...(binding.credentialBindings.account?.[legacyCredentialSlotId]
                        ? {
                            account: {
                                [target.credentialSlotId]:
                                    binding.credentialBindings.account[legacyCredentialSlotId],
                            },
                        }
                        : {}),
                    ...(Object.keys(binding.credentialBindings.byMachineId ?? {}).length > 0
                        ? {
                            byMachineId: Object.fromEntries(Object.entries(
                                binding.credentialBindings.byMachineId ?? {},
                            ).flatMap(([machineId, machine]) => machine[legacyCredentialSlotId]
                                ? [[machineId, {
                                    [target.credentialSlotId]: machine[legacyCredentialSlotId],
                                }]]
                                : [])),
                        }
                        : {}),
                },
                ...(binding.approvedRecipientContractDigest
                    ? { approvedRecipientContractDigest: binding.approvedRecipientContractDigest }
                    : {}),
            });
            return parsed.success ? [parsed.data] : [];
        });
    }));
}

function dedupeCredentialBindings(
    bindings: readonly VoiceCredentialBindingV1[],
): readonly VoiceCredentialBindingV1[] {
    const byIdentity = new Map<string, VoiceCredentialBindingV1>();
    for (const binding of bindings) {
        const identity = credentialBindingIdentity(binding);
        if (byIdentity.has(identity)) continue;
        byIdentity.set(identity, binding);
        if (byIdentity.size === MAX_VOICE_CREDENTIAL_BINDINGS) break;
    }
    return [...byIdentity.values()];
}

function omitPersistenceOnlyVoiceFields(value: VoiceSettings, raw: unknown): VoiceSettingsPersistenceV1 {
    const result = { ...value } as Record<string, unknown>;
    delete result.diagnostics;
    delete result[VOICE_SETTINGS_CURRENT_WRITER_MARKER];
    result.credentialBindings = normalizeQualifiedCredentialBindings(raw);
    return result as VoiceSettingsPersistenceV1;
}

export function parseVoiceSettingsPersistenceV1(value: unknown): VoiceSettingsPersistenceV1 {
    return omitPersistenceOnlyVoiceFields(voiceSettingsParse(value, {
        allowLegacyCredentialRecoveryCarrier: true,
    }), value);
}

export const VoiceSettingsPersistenceV1Schema = z.unknown().transform(parseVoiceSettingsPersistenceV1);
export const voiceSettingsPersistenceV1Defaults = parseVoiceSettingsPersistenceV1(voiceSettingsDefaults);

function withDiagnostics(
    value: VoiceSettingsPersistenceV1,
    diagnostics: VoiceSpeechDiagnosticsSettingsV1,
): VoiceSettings {
    return {
        ...value,
        // Credential authority is canonical-only. The ordinary runtime Voice
        // projection remains writable by settings surfaces and must never
        // carry a stale copy back into `voiceSettingsV1`.
        credentialBindings: [],
        diagnostics,
    };
}

function hasCurrentWriterMarker(rawVoice: unknown): boolean {
    return isRecord(rawVoice) && rawVoice[VOICE_SETTINGS_CURRENT_WRITER_MARKER] === true;
}

/**
 * A marked projection was emitted by the current canonical Voice writer, not
 * by the released predecessor writer. Keep this identity decision with the
 * marker owner so compatibility ingress cannot reinterpret our own sidecar.
 */
export function isCurrentWriterPredecessorVoiceProjection(value: unknown): boolean {
    if (!hasCurrentWriterMarker(value) || !isRecord(value)) return false;
    const providerId = value.providerId;
    return providerId === 'off' || PREDECESSOR_VOICE_PROVIDER_IDS.has(String(providerId));
}

export function parseCurrentWriterPredecessorVoiceProjection(
    value: unknown,
): Record<string, unknown> | null {
    if (!isCurrentWriterPredecessorVoiceProjection(value) || !isRecord(value)) return null;
    const providerId = value.providerId;
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
        privacy: projectPredecessorVoicePrivacy(parsed.privacy),
        adapters,
        [VOICE_SETTINGS_CURRENT_WRITER_MARKER]: true,
    };
}

function credentialBindingIdentity(binding: VoiceCredentialBindingV1): string {
    return `${binding.contribution.pluginId}\u0000${binding.contribution.localId}\u0000${binding.credentialSlotId}`;
}

function isPredecessorInlineCredentialProviderId(
    providerId: string,
): providerId is PredecessorInlineCredentialProviderId {
    return providerId === PREDECESSOR_OWNED_CREDENTIAL_PROVIDER_ID
        || providerId === QUALIFIED_OPENAI_COMPAT_STT_PROVIDER_ID
        || providerId === QUALIFIED_OPENAI_COMPAT_TTS_PROVIDER_ID;
}

function isOpenAiCompatSpeechCredentialBinding(binding: VoiceCredentialBindingV1): boolean {
    return binding.contribution.pluginId === 'happier.voice.openai-compat'
        && (binding.contribution.localId === 'stt' || binding.contribution.localId === 'tts')
        && binding.credentialSlotId === 'api_key';
}

/**
 * Merges the credential a predecessor Voice write actually carries into the
 * canonical bindings.
 *
 * A predecessor write is a degraded read of the canonical store: `remote-dev`
 * rewrites the whole `voice` object from its own closed schema and knows
 * nothing about `voiceSettingsV1`. It may therefore SUPPLY a credential it
 * carries, but it must never RETRACT a canonical binding it does not carry —
 * an absent, null, or unparseable inline credential means "this writer knows
 * nothing about that slot", not "the user removed it". Retracting there
 * deleted stored Voice credential bindings and left
 * `connectedAccountPurposeBindingsV1` pointing at a credential source that no
 * longer existed, which is the cross-store inconsistency
 * `resolveAccountSettingsVoiceCredentialSource` fails closed on.
 *
 * A canonical Connected-Account selection is likewise never demoted: the
 * predecessor schema cannot express one, so its SavedSecret-shaped projection
 * of that slot is not evidence about it, and replacing it would orphan the
 * matching purpose binding.
 */
function mergePredecessorOwnedBindings(
    canonical: readonly VoiceCredentialBindingV1[],
    predecessor: readonly PredecessorVoiceCredentialBindingV1[],
): VoiceCredentialBindingV1[] {
    const supplied = new Map(normalizeQualifiedCredentialBindings({
        credentialBindings: predecessor.filter(
            (binding) => isPredecessorInlineCredentialProviderId(binding.providerId),
        ),
    }).map((binding) => [credentialBindingIdentity(binding), binding] as const));
    if (supplied.size === 0) return [...canonical];
    const merged = canonical.map((binding) => {
        if (binding.credentialSource.kind === 'connectedAccount') return binding;
        const replacement = supplied.get(credentialBindingIdentity(binding));
        if (!replacement) return binding;
        // The released sidecar represents only an account-level inline key.
        // Preserve current machine-specific authority when that same role is
        // re-authored by the predecessor's whole-object writer.
        if (!isOpenAiCompatSpeechCredentialBinding(binding)) return replacement;
        const parsed = VoiceCredentialBindingV1Schema.safeParse({
            ...replacement,
            credentialBindings: {
                ...replacement.credentialBindings,
                ...(binding.credentialBindings.byMachineId
                    ? { byMachineId: binding.credentialBindings.byMachineId }
                    : {}),
            },
        });
        return parsed.success ? parsed.data : binding;
    });
    const canonicalIdentities = new Set(canonical.map(credentialBindingIdentity));
    return [
        ...merged,
        ...[...supplied.values()].filter(
            (binding) => !canonicalIdentities.has(credentialBindingIdentity(binding)),
        ),
    ];
}

function predecessorSpeechAdapterIds(
    rawPredecessor: Readonly<Record<string, unknown>>,
): readonly ('local_direct' | 'local_conversation')[] {
    if (rawPredecessor.providerId === 'local_direct') {
        return ['local_direct', 'local_conversation'];
    }
    if (rawPredecessor.providerId === 'local_conversation') {
        return ['local_conversation', 'local_direct'];
    }
    return ['local_direct', 'local_conversation'];
}

function readPredecessorOpenAiCompatSpeechConfig(
    rawPredecessor: Readonly<Record<string, unknown>>,
    role: 'stt' | 'tts',
): Readonly<Record<string, unknown>> | null {
    const adapters = isRecord(rawPredecessor.adapters) ? rawPredecessor.adapters : null;
    if (!adapters) return null;
    for (const adapterId of predecessorSpeechAdapterIds(rawPredecessor)) {
        const adapter = isRecord(adapters[adapterId]) ? adapters[adapterId] : null;
        const roleSettings = adapter && isRecord(adapter[role]) ? adapter[role] : null;
        const openAiCompat = roleSettings && isRecord(roleSettings.openaiCompat)
            ? roleSettings.openaiCompat
            : null;
        if (openAiCompat) return openAiCompat;
    }
    return null;
}

function readPredecessorInlineCredential(
    rawPredecessor: Readonly<Record<string, unknown>>,
    providerId: PredecessorInlineCredentialProviderId,
): unknown {
    const adapters = isRecord(rawPredecessor.adapters) ? rawPredecessor.adapters : null;
    if (!adapters) return undefined;
    if (providerId === PREDECESSOR_OWNED_CREDENTIAL_PROVIDER_ID) {
        const elevenLabs = isRecord(adapters.realtime_elevenlabs)
            ? adapters.realtime_elevenlabs
            : null;
        const byo = elevenLabs && isRecord(elevenLabs.byo) ? elevenLabs.byo : null;
        return byo?.apiKey;
    }
    const role = providerId === QUALIFIED_OPENAI_COMPAT_STT_PROVIDER_ID ? 'stt' : 'tts';
    for (const adapterId of predecessorSpeechAdapterIds(rawPredecessor)) {
        const adapter = isRecord(adapters[adapterId]) ? adapters[adapterId] : null;
        const roleSettings = adapter && isRecord(adapter[role]) ? adapter[role] : null;
        const openAiCompat = roleSettings && isRecord(roleSettings.openaiCompat)
            ? roleSettings.openaiCompat
            : null;
        if (openAiCompat?.apiKey != null) return openAiCompat.apiKey;
    }
    return undefined;
}

function readSavedSecretEnvelope(
    account: Readonly<Record<string, unknown>>,
    secretId: string,
): unknown {
    if (!Array.isArray(account.secrets)) return undefined;
    for (const candidate of account.secrets) {
        const parsed = SavedSecretSchema.safeParse(candidate);
        if (parsed.success && parsed.data.id === secretId) {
            return parsed.data.encryptedValue;
        }
    }
    return undefined;
}

function readValidPredecessorInlineCredential(params: Readonly<{
    rawPredecessor: Readonly<Record<string, unknown>>;
    providerId: PredecessorInlineCredentialProviderId;
}>): SecretStringV1 | null {
    const parsed = SecretStringV1Schema.safeParse(readPredecessorInlineCredential(
        params.rawPredecessor,
        params.providerId,
    ));
    return parsed.success ? parsed.data : null;
}

function predecessorInlineCredentialMatchesCanonical(params: Readonly<{
    account: Readonly<Record<string, unknown>>;
    canonical: VoiceSettingsPersistenceV1;
    rawPredecessor: Readonly<Record<string, unknown>>;
    providerId: PredecessorInlineCredentialProviderId;
}>): boolean {
    const rawCredential = readValidPredecessorInlineCredential(params);
    if (!rawCredential) return false;
    const contribution = resolveVoiceContributionIdentity(params.providerId);
    if (!contribution) return false;
    const binding = params.canonical.credentialBindings.find((candidate) => (
        candidate.contribution.pluginId === contribution.pluginId
        && candidate.contribution.localId === contribution.localId
        && candidate.credentialSlotId === 'api_key'
    ));
    const savedSecretId = binding?.credentialBindings.account?.api_key;
    if (!savedSecretId) return false;
    const canonicalCredential = readSavedSecretEnvelope(params.account, savedSecretId);
    return canonicalCredential !== undefined
        && JSON.stringify(canonicalCredential) === JSON.stringify(rawCredential);
}

/**
 * A predecessor rewrite can update only the released role settings it carried.
 * The canonical provider envelope continues to own every newer field, so this
 * merges the bounded old shape into that envelope rather than replacing it.
 */
function mergePredecessorOpenAiCompatSpeechConfigs(
    providers: Record<string, VoiceProviderSettingsEnvelopeV1>,
    rawPredecessor: Readonly<Record<string, unknown>>,
): Record<string, VoiceProviderSettingsEnvelopeV1> {
    const mergedProviders = { ...providers };
    const roles = [
        ['stt', QUALIFIED_OPENAI_COMPAT_STT_PROVIDER_ID],
        ['tts', QUALIFIED_OPENAI_COMPAT_TTS_PROVIDER_ID],
    ] as const;
    for (const [role, providerId] of roles) {
        const rawConfig = readPredecessorOpenAiCompatSpeechConfig(rawPredecessor, role);
        if (!rawConfig) continue;
        const releasedConfig = migrateLegacySpeechProviderConfig(providerId, rawConfig);
        if (!releasedConfig) continue;
        const owner = getCanonicalVoiceProviderSettingsOwner(providerId);
        const currentEnvelope = mergedProviders[providerId];
        const currentConfig = owner
            && currentEnvelope?.schemaVersion === owner.currentSchemaVersion
            ? owner.parseConfig(currentEnvelope.config)
            : owner?.defaultConfig;
        if (!owner || !isRecord(currentConfig)) continue;
        const nextConfig = owner.parseConfig({ ...currentConfig, ...releasedConfig });
        if (!nextConfig) continue;
        mergedProviders[providerId] = {
            schemaVersion: owner.currentSchemaVersion,
            config: nextConfig as VoiceProviderSettingsEnvelopeV1['config'],
        };
    }
    return mergedProviders;
}

function mergePredecessorVoiceWrite(
    canonical: VoiceSettingsPersistenceV1,
    predecessor: VoiceSettings,
    predecessorBindings: readonly PredecessorVoiceCredentialBindingV1[],
    rawPredecessor: Readonly<Record<string, unknown>>,
    account: Readonly<Record<string, unknown>>,
): VoiceSettingsPersistenceV1 {
    const providers = { ...canonical.providers };
    const rawAdapters = isRecord(rawPredecessor.adapters) ? rawPredecessor.adapters : {};
    for (const providerId of PREDECESSOR_VOICE_PROVIDER_IDS) {
        if (!hasOwn(rawAdapters, providerId)) continue;
        const canonicalProviderId = normalizeVoiceProviderSettingsId(providerId);
        const currentEnvelope = canonical.providers[canonicalProviderId];
        const predecessorEnvelope = predecessor.providers[canonicalProviderId];
        const owner = getCanonicalVoiceProviderSettingsOwner(canonicalProviderId);
        if (!owner || !currentEnvelope || !predecessorEnvelope) continue;
        if (currentEnvelope.schemaVersion !== owner.currentSchemaVersion
            || predecessorEnvelope.schemaVersion !== owner.currentSchemaVersion) continue;
        const mergedConfig = owner.mergeLegacy(currentEnvelope.config, predecessorEnvelope.config);
        if (mergedConfig === null) continue;
        providers[canonicalProviderId] = {
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
    const predecessorBindingsToMerge = predecessorBindings.filter((binding) => {
        if (!isPredecessorInlineCredentialProviderId(binding.providerId)) return false;
        if (!readValidPredecessorInlineCredential({
            rawPredecessor,
            providerId: binding.providerId,
        })) return false;
        return !predecessorInlineCredentialMatchesCanonical({
            account,
            canonical,
            rawPredecessor,
            providerId: binding.providerId,
        });
    });
    const providersWithReleasedSpeech = mergePredecessorOpenAiCompatSpeechConfigs(
        providers,
        rawPredecessor,
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
        privacy: hasOwn(rawPredecessor, 'privacy')
            ? {
                ...predecessor.privacy,
                // The released predecessor schema cannot represent this
                // current-only setting, so a whole-object predecessor write
                // must not reset its canonical value to the parser default.
                currentUiContextMode: canonical.privacy.currentUiContextMode,
            }
            : canonical.privacy,
        providers: providersWithReleasedSpeech,
        credentialBindings: predecessorBindingsToMerge.length > 0
            ? mergePredecessorOwnedBindings(
                canonical.credentialBindings,
                predecessorBindingsToMerge,
            )
            : canonical.credentialBindings,
    });
}

/**
 * SavedSecret extraction intentionally removes the raw legacy adapter from the
 * parsed runtime projection. Re-derive only the credential-owning provider's
 * current config through its declared migration callback, so raw credentials
 * and unknown legacy fields never enter the canonical Voice envelope.
 */
function mergePredecessorCredentialOwningProviderConfig(
    canonical: VoiceSettingsPersistenceV1,
    rawPredecessor: Readonly<Record<string, unknown>>,
): VoiceSettingsPersistenceV1 {
    const rawAdapters = isRecord(rawPredecessor.adapters) ? rawPredecessor.adapters : null;
    if (!rawAdapters) return canonical;
    const rawProviders = isRecord(rawPredecessor.providers) ? rawPredecessor.providers : null;
    const providers = { ...canonical.providers };
    for (const predecessorProviderId of PREDECESSOR_VOICE_PROVIDER_IDS) {
        if (!hasOwn(rawAdapters, predecessorProviderId)) continue;
        const providerId = normalizeVoiceProviderSettingsId(predecessorProviderId);
        const owner = getCanonicalVoiceProviderSettingsOwner(providerId);
        // A provider must explicitly declare the retired credential boundary;
        // built-in adapters never receive a raw secret-bearing config here.
        if (!owner?.readLegacySecret) continue;
        const hasExplicitCurrentEnvelope = rawProviders !== null
            && Object.keys(rawProviders).some((rawProviderId) => (
                normalizeVoiceProviderSettingsId(rawProviderId) === providerId
            ));
        if (hasExplicitCurrentEnvelope) continue;
        const migrated = owner.migrateLegacy(rawAdapters[predecessorProviderId]);
        if (!migrated) continue;
        const current = providers[providerId];
        const merged = current?.schemaVersion === owner.currentSchemaVersion
            ? owner.mergeLegacy(current.config, migrated.config)
            : owner.parseConfig(migrated.config);
        if (merged === null) continue;
        providers[providerId] = {
            schemaVersion: owner.currentSchemaVersion,
            config: merged as VoiceProviderSettingsEnvelopeV1['config'],
        };
    }
    return { ...canonical, providers };
}

function readCanonicalVoiceFromProjection(params: Readonly<{
    parsed: Readonly<Record<string, unknown>>;
    raw: Readonly<Record<string, unknown>>;
}>): VoiceSettingsPersistenceV1 {
    const rawRoot = params.raw[VOICE_SETTINGS_ACCOUNT_SETTING_KEY];
    const projectedRoot = params.parsed[VOICE_SETTINGS_ACCOUNT_SETTING_KEY];
    // Protocol's defaults retain an empty root before any current writer has
    // materialized it. That is not a persisted canonical root; fall through
    // to the ordinary Voice input in that case. A concrete projected root,
    // however, is the migration result we must retain during the Chat
    // migration's re-entry through this owner.
    const rawRootPresent = hasOwn(params.raw, VOICE_SETTINGS_ACCOUNT_SETTING_KEY)
        && rawRoot !== undefined;
    const projectedRootPresent = hasOwn(params.parsed, VOICE_SETTINGS_ACCOUNT_SETTING_KEY)
        && isRecord(projectedRoot)
        && Object.keys(projectedRoot).length > 0;
    const rootPresent = rawRootPresent || projectedRootPresent;
    const parsedCanonical = parseVoiceSettingsPersistenceV1(params.parsed.voice);
    const canonical = projectedRootPresent
        ? parseVoiceSettingsPersistenceV1(projectedRoot)
        : rawRootPresent
            ? parseVoiceSettingsPersistenceV1(rawRoot)
        : (() => {
            const rawCanonical = parseVoiceSettingsPersistenceV1(params.raw.voice);
            const explicitBindings = new Map(rawCanonical.credentialBindings.map(
                (binding) => [credentialBindingIdentity(binding), binding] as const,
            ));
            return mergePredecessorCredentialOwningProviderConfig({
                ...parsedCanonical,
                // Raw persisted bindings are explicit user choices. Parsed
                // bindings are compatibility-migration products (for example
                // inline predecessor secrets) and fill only identities that
                // were not already bound by the persisted carrier.
                credentialBindings: [
                    ...explicitBindings.values(),
                    ...parsedCanonical.credentialBindings.filter(
                        (binding) => !explicitBindings.has(credentialBindingIdentity(binding)),
                    ),
                ],
            }, isRecord(params.raw.voice) ? params.raw.voice : {});
        })();
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
        parsePredecessorVoiceCredentialBindings(params.parsed.voice),
        rawPredecessor,
        params.raw,
    );
}

function generatedPredecessorInlineCredentialSecretId(
    providerId: PredecessorInlineCredentialProviderId,
): string {
    return `voice:${providerId}:api_key`;
}

function removeGeneratedMatchingPredecessorInlineCredentialSecrets(params: Readonly<{
    parsedSecrets: unknown;
    raw: Readonly<Record<string, unknown>>;
    canonical: VoiceSettingsPersistenceV1;
}>): unknown {
    if (!Array.isArray(params.parsedSecrets)) return params.parsedSecrets;
    const rawPredecessor = params.raw.voice;
    if (!isRecord(rawPredecessor) || hasCurrentWriterMarker(rawPredecessor)) {
        return params.parsedSecrets;
    }
    const generatedSecretIds = new Set(([
        PREDECESSOR_OWNED_CREDENTIAL_PROVIDER_ID,
        QUALIFIED_OPENAI_COMPAT_STT_PROVIDER_ID,
        QUALIFIED_OPENAI_COMPAT_TTS_PROVIDER_ID,
    ] as const).flatMap((providerId) => {
        if (!predecessorInlineCredentialMatchesCanonical({
            account: params.raw,
            canonical: params.canonical,
            rawPredecessor,
            providerId,
        })) return [];
        const generatedSecretId = generatedPredecessorInlineCredentialSecretId(providerId);
        const generatedSecretWasAlreadyPresent = Array.isArray(params.raw.secrets)
            && params.raw.secrets.some((candidate) => (
                isRecord(candidate)
                && candidate.id === generatedSecretId
            ));
        return generatedSecretWasAlreadyPresent ? [] : [generatedSecretId];
    }));
    if (generatedSecretIds.size === 0) return params.parsedSecrets;
    return params.parsedSecrets.filter((candidate) => (
        !isRecord(candidate)
        || !generatedSecretIds.has(String(candidate.id))
    ));
}

function readEncryptedSavedSecretCredential(
    account: Readonly<Record<string, unknown>>,
    voice: VoiceSettingsPersistenceV1,
    providerId: string,
    slotId: string,
): SecretStringV1 | null {
    const contribution = resolveVoiceContributionIdentity(providerId);
    const binding = contribution
        ? voice.credentialBindings.find((candidate) => (
            candidate.contribution.pluginId === contribution.pluginId
            && candidate.contribution.localId === contribution.localId
            && candidate.credentialSlotId === slotId
        ))
        : null;
    if (binding?.credentialSource.kind !== 'savedSecret') return null;
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

/**
 * The released local-adapter schema carries exactly one account SavedSecret
 * envelope for each OpenAI-compatible speech role. It cannot represent
 * machine overrides or Connected Account selection, so those remain solely
 * in the canonical credential binding and are deliberately not inferred here.
 */
function projectPredecessorOpenAiCompatCredentialSidecar(
    projected: unknown,
    account: Readonly<Record<string, unknown>>,
    voice: VoiceSettingsPersistenceV1,
): unknown {
    const adapter = isRecord(projected) ? projected : null;
    if (!adapter) return projected;
    const projectRole = (
        role: 'stt' | 'tts',
        providerId: string,
    ): Record<string, unknown> | null => {
        const roleConfig = isRecord(adapter[role]) ? adapter[role] : null;
        const openAiCompat = roleConfig && isRecord(roleConfig.openaiCompat)
            ? roleConfig.openaiCompat
            : null;
        if (!roleConfig || !openAiCompat) return null;
        return {
            ...roleConfig,
            openaiCompat: {
                ...openAiCompat,
                apiKey: readEncryptedSavedSecretCredential(account, voice, providerId, 'api_key'),
            },
        };
    };
    const stt = projectRole('stt', QUALIFIED_OPENAI_COMPAT_STT_PROVIDER_ID);
    const tts = projectRole('tts', QUALIFIED_OPENAI_COMPAT_TTS_PROVIDER_ID);
    return stt === null && tts === null
        ? projected
        : {
            ...adapter,
            ...(stt ? { stt } : {}),
            ...(tts ? { tts } : {}),
        };
}

/**
 * A Provider account binding names an existing SavedSecret; the released Chat
 * reader can carry only that same encrypted envelope. It cannot represent an
 * ambiguous, malformed, or plaintext secret, so those cases intentionally
 * leave the Chat sidecar absent.
 */
function readExactEncryptedSavedSecretEnvelope(
    account: Readonly<Record<string, unknown>>,
    savedSecretId: string,
): SecretStringV1 | undefined {
    if (!Array.isArray(account.secrets)) return undefined;
    const candidates = account.secrets.filter((candidate) => (
        isRecord(candidate) && candidate.id === savedSecretId
    ));
    if (candidates.length !== 1) return undefined;
    const parsed = SavedSecretSchema.safeParse(candidates[0]);
    if (!parsed.success) return undefined;
    const encryptedValue = parsed.data.encryptedValue.encryptedValue;
    return encryptedValue
        ? { _isSecretValue: true, encryptedValue }
        : undefined;
}

/**
 * The released Local Conversation reader owns one fixed OpenAI-compatible
 * Chat shape. Project it only when the current Provider-bound selection has
 * the exact same single-connection, single-Agent semantics; otherwise omit it
 * rather than leaving a stale retired Chat path alive.
 */
function projectPredecessorOpenAiCompatChatSidecar(
    projected: unknown,
    account: Readonly<Record<string, unknown>>,
    providerConfig: unknown,
): unknown {
    const adapter = isRecord(projected) ? projected : null;
    const projectedAgent = adapter && isRecord(adapter.agent) ? adapter.agent : null;
    if (!adapter || !projectedAgent) return projected;

    // Provider Chat is current-only authority. Start from the existing
    // released projection without it so unrepresentable current state cannot
    // leak or preserve an old Chat configuration.
    const {
        backend: _backend,
        openaiCompat: _openAiCompat,
        providerChat: _providerChat,
        ...legacyAgent
    } = projectedAgent;
    const withoutChat = {
        ...adapter,
        agent: legacyAgent,
    };

    const parsedConfig = VoiceLocalConversationSchema.safeParse(providerConfig);
    if (!parsedConfig.success) return withoutChat;
    const localConversation = parsedConfig.data;
    const providerChat = localConversation.agent.providerChat;
    if (!providerChat || providerChat.status !== 'configured') return withoutChat;

    const agentId = localConversation.agent.agentId.trim();
    const expectedAgentTargetKey = localConversation.agent.agentSource === 'agent' && agentId.length > 0
        ? buildAgentUniverseBackendTargetKey(agentId)
        : null;
    const chat = providerChat.chat;
    const commit = providerChat.commit;
    if (
        !expectedAgentTargetKey
        || chat.agentTargetKey !== expectedAgentTargetKey
        || commit.agentTargetKey !== expectedAgentTargetKey
        || chat.providerConnectionId === null
        || commit.providerConnectionId !== chat.providerConnectionId
        || chat.modelId.trim().length === 0
        || commit.modelId.trim().length === 0
    ) return withoutChat;

    const providerSettings = readProviderSettingsFromAccountSettingsV1(account);
    if (providerSettings.diagnostics.length > 0) return withoutChat;
    const connection = providerSettings.settings.connections.find(
        (candidate) => candidate.id === chat.providerConnectionId,
    );
    if (
        !connection
        || connection.source.kind !== 'custom'
        || connection.role !== 'named'
        || (connection.endpointOverrides?.length ?? 0) > 0
        || Object.keys(connection.endpointOverridesByMachineId ?? {}).length > 0
        || providerSettings.settings.accountGrants.some((grant) => grant.connectionId === connection.id)
        || providerSettings.settings.machineGrants.some((grant) => grant.connectionId === connection.id)
    ) return withoutChat;

    const endpointTemplates = connection.source.template.endpointTemplates;
    const endpoint = endpointTemplates[0];
    if (
        endpointTemplates.length !== 1
        || !endpoint
        || endpoint.protocol !== 'openai-chat'
        || Object.keys(endpoint.publicHeaders ?? {}).length > 0
    ) return withoutChat;

    const credential = connection.source.template.credential;
    if (credential && (
        credential.slotId !== 'apiKey'
        || credential.transports.length !== 1
        || credential.transports[0]?.protocols.length !== 1
        || credential.transports[0]?.protocols[0] !== 'openai-chat'
        || credential.transports[0]?.uses.length !== 1
        || credential.transports[0]?.uses[0] !== 'runtime'
        || credential.transports[0]?.destination.kind !== 'httpHeader'
        || credential.transports[0]?.destination.name !== 'authorization'
        || credential.transports[0]?.destination.format !== 'bearer'
    )) return withoutChat;

    const secretBinding = providerSettings.settings.secretBindingsByConnectionId[connection.id];
    if (secretBinding && Object.keys(secretBinding.byMachineId ?? {}).length > 0) return withoutChat;
    const accountBinding = secretBinding?.account ?? {};
    const accountBindingKeys = Object.keys(accountBinding);
    if (accountBindingKeys.some((slotId) => slotId !== 'apiKey')) return withoutChat;

    const savedSecretId = accountBinding.apiKey;
    if (savedSecretId && !credential) return withoutChat;
    if (!savedSecretId && credential?.required) return withoutChat;
    const chatApiKey = savedSecretId
        ? readExactEncryptedSavedSecretEnvelope(account, savedSecretId)
        : null;
    if (savedSecretId && !chatApiKey) return withoutChat;

    return {
        ...withoutChat,
        agent: {
            ...legacyAgent,
            backend: 'openai_compat',
            openaiCompat: {
                chatBaseUrl: endpoint.baseUrl,
                chatApiKey,
                chatModel: chat.modelId,
                commitModel: commit.modelId,
                ...(providerChat.configuration.temperature === null
                    ? {}
                    : { temperature: providerChat.configuration.temperature }),
            },
        },
    };
}

function readProviderEnvelope(
    voice: VoiceSettingsPersistenceV1,
    providerId: string,
): VoiceProviderSettingsEnvelopeV1 | null {
    return voice.providers[providerId] ?? null;
}

/**
 * The current-writer marker lets trusted predecessor-compatible adapters pass
 * through a final account write. Provider Chat is not one of those adapters:
 * its released sidecar must always be derived from the canonical Provider
 * binding, otherwise an older marked sidecar can outlive a changed binding.
 */
function reconcileCurrentWriterOpenAiCompatChatSidecar(
    projected: Record<string, unknown>,
    voice: VoiceSettingsPersistenceV1,
    account: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
    const adapters = isRecord(projected.adapters) ? projected.adapters : null;
    if (!adapters) return projected;
    if (hasOwn(adapters, 'local_conversation')) {
        return {
            ...projected,
            adapters: {
                ...adapters,
                local_conversation: projectPredecessorOpenAiCompatChatSidecar(
                    adapters.local_conversation,
                    account,
                    readProviderEnvelope(voice, 'local_conversation')?.config,
                ),
            },
        };
    }

    // Crash-recovered marked writes can retain every trusted predecessor
    // adapter except Local Conversation. Reuse the complete canonical
    // projection, but splice back only a fully representable Chat adapter so
    // this path never reconstructs or takes authority over its siblings.
    const canonicalAdapters = createPredecessorVoiceProjection(voice, account, projected).adapters;
    const canonicalLocalConversation = isRecord(canonicalAdapters)
        ? canonicalAdapters.local_conversation
        : undefined;
    const canonicalAgent = isRecord(canonicalLocalConversation)
        && isRecord(canonicalLocalConversation.agent)
        ? canonicalLocalConversation.agent
        : null;
    if (
        !canonicalAgent
        || canonicalAgent.backend !== 'openai_compat'
        || !isRecord(canonicalAgent.openaiCompat)
    ) return projected;

    return {
        ...projected,
        adapters: {
            ...adapters,
            local_conversation: canonicalLocalConversation,
        },
    };
}

function createPredecessorVoiceProjection(
    voice: VoiceSettingsPersistenceV1,
    account: Readonly<Record<string, unknown>>,
    compatibilityVoice?: unknown,
): Record<string, unknown> {
    const resolveCredential = (providerId: string, slotId: string): SecretStringV1 | null =>
        providerId === PREDECESSOR_OWNED_CREDENTIAL_PROVIDER_ID
            ? readEncryptedSavedSecretCredential(account, voice, providerId, slotId)
            : null;
    const resolveProviderConfig = (providerId: string): Readonly<Record<string, unknown>> | null => {
        const owner = getCanonicalVoiceProviderSettingsOwner(providerId);
        const envelope = readProviderEnvelope(voice, providerId);
        if (!owner || !envelope || envelope.schemaVersion !== owner.currentSchemaVersion) return null;
        const parsed = owner.parseConfig(envelope.config);
        return isRecord(parsed) ? parsed : null;
    };
    const root = {
        assistantLanguage: voice.assistantLanguage,
        welcome: voice.welcome,
        executionMachine: voice.executionMachine,
    } as const;
    const adapters: Record<string, unknown> = {};
    for (const providerId of PREDECESSOR_VOICE_PROVIDER_IDS) {
        const canonicalProviderId = normalizeVoiceProviderSettingsId(providerId);
        const owner = getCanonicalVoiceProviderSettingsOwner(canonicalProviderId);
        const envelope = readProviderEnvelope(voice, canonicalProviderId);
        if (!owner || !envelope || envelope.schemaVersion !== owner.currentSchemaVersion) continue;
        const projected = owner.projectLegacy(envelope.config, {
            root,
            resolveCredential,
            resolveProviderConfig,
        });
        if (projected === null) continue;
        if (providerId !== PREDECESSOR_OWNED_CREDENTIAL_PROVIDER_ID) {
            const withSpeechCredentials = providerId === 'local_direct' || providerId === 'local_conversation'
                ? projectPredecessorOpenAiCompatCredentialSidecar(projected, account, voice)
                : projected;
            adapters[providerId] = providerId === 'local_conversation'
                ? projectPredecessorOpenAiCompatChatSidecar(
                    withSpeechCredentials,
                    account,
                    envelope.config,
                )
                : withSpeechCredentials;
            continue;
        }
        // These retired tuning values belong only to the predecessor sidecar.
        // Preserve them from that compatibility carrier without adding them
        // back to the canonical provider envelope or provisioning input.
        const compatibilityRoot = isRecord(compatibilityVoice)
            && isRecord(compatibilityVoice.adapters)
            && isRecord(compatibilityVoice.adapters.realtime_elevenlabs)
            ? compatibilityVoice.adapters.realtime_elevenlabs
            : null;
        const compatibilityTts = compatibilityRoot && isRecord(compatibilityRoot.tts)
            ? compatibilityRoot.tts
            : null;
        const compatibilityVoiceSettings = compatibilityTts
            && isRecord(compatibilityTts.voiceSettings)
            ? compatibilityTts.voiceSettings
            : null;
        const projectedRecord = isRecord(projected) ? projected : null;
        const projectedTts = projectedRecord && isRecord(projectedRecord.tts)
            ? projectedRecord.tts
            : null;
        const projectedVoiceSettings = projectedTts && isRecord(projectedTts.voiceSettings)
            ? projectedTts.voiceSettings
            : null;
        if (!compatibilityVoiceSettings || !projectedRecord || !projectedTts || !projectedVoiceSettings) {
            adapters[providerId] = projected;
            continue;
        }
        const style = compatibilityVoiceSettings.style;
        const useSpeakerBoost = compatibilityVoiceSettings.useSpeakerBoost;
        adapters[providerId] = {
            ...projectedRecord,
            tts: {
                ...projectedTts,
                voiceSettings: {
                    ...projectedVoiceSettings,
                    ...(typeof style === 'number' && Number.isFinite(style) && style >= 0 && style <= 1
                        ? { style }
                        : {}),
                    ...(typeof useSpeakerBoost === 'boolean' ? { useSpeakerBoost } : {}),
                },
            },
        };
    }
    const selectedProviderId = voice.providerId;
    const selectedPredecessorProviderId = selectedProviderId === null
        ? null
        : projectPredecessorVoiceProviderId(selectedProviderId);
    const predecessorProviderId = selectedPredecessorProviderId !== null
        && hasOwn(adapters, selectedPredecessorProviderId)
        ? selectedPredecessorProviderId
        : 'off';
    return {
        providerId: predecessorProviderId,
        assistantLanguage: voice.assistantLanguage,
        ui: voice.ui,
        privacy: projectPredecessorVoicePrivacy(voice.privacy),
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
export function projectVoiceSettingsIntoRuntimeSettings(params: {
    parsed: AccountSettings & LocalAccountSettings;
    raw: Readonly<object>;
}): ProtocolAndLocalAccountSettingsRuntimeProjection;
export function projectVoiceSettingsIntoRuntimeSettings(params: {
    parsed: AccountSettings;
    raw: Readonly<object>;
}): ProtocolAccountSettingsRuntimeProjection;
export function projectVoiceSettingsIntoRuntimeSettings(params: {
    parsed: object;
    raw: Readonly<object>;
}): object {
    // The account compatibility migration can add predecessor credential
    // bindings to the parsed Voice value before this projection runs. Read the
    // canonical owner from that unmodified migration output: the diagnostics
    // projection intentionally reparses Voice and would otherwise discard the
    // predecessor carrier before it can be context-qualified.
    const parsedInputRecord = stripMigratedSessionOrganizationSettings(
        params.parsed as Record<string, unknown>,
    );
    const projectedDiagnostics = projectVoiceDiagnosticsIntoRuntimeSettings({
        parsed: parsedInputRecord,
        raw: params.raw,
    });
    const parsedRecord = projectedDiagnostics as Record<string, unknown>;
    const rawRecord = params.raw as Readonly<Record<string, unknown>>;
    const diagnostics = parseCanonicalDiagnostics(parsedRecord[VOICE_DIAGNOSTICS_ACCOUNT_SETTING_KEY]);
    const canonical = readCanonicalVoiceFromProjection({ parsed: parsedInputRecord, raw: rawRecord });
    const secrets = removeGeneratedMatchingPredecessorInlineCredentialSecrets({
        parsedSecrets: parsedRecord.secrets,
        raw: rawRecord,
        canonical,
    });
    const projected = {
        ...parsedRecord,
        secrets,
        [VOICE_SETTINGS_ACCOUNT_SETTING_KEY]: canonical,
        voice: withDiagnostics(canonical, diagnostics),
    };
    return attachCurrentSecretBindingsRuntimeProjection(projected);
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
            ? (() => {
                const proposed = parseVoiceSettingsPersistenceV1(deltaRecord.voice);
                const currentCanonical = currentRecord
                    && hasOwn(currentRecord, VOICE_SETTINGS_ACCOUNT_SETTING_KEY)
                    ? parseVoiceSettingsPersistenceV1(
                        currentRecord[VOICE_SETTINGS_ACCOUNT_SETTING_KEY],
                    )
                    : null;
                return currentCanonical
                    ? { ...proposed, credentialBindings: currentCanonical.credentialBindings }
                    : proposed;
            })()
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
        ? (() => {
            const currentWriterProjection = parseCurrentWriterPredecessorVoiceProjection(deltaRecord.voice);
            return currentWriterProjection
                ? reconcileCurrentWriterOpenAiCompatChatSidecar(
                    currentWriterProjection,
                    canonical,
                    account,
                )
                : createPredecessorVoiceProjection(canonical, account, deltaRecord.voice);
        })()
        : createPredecessorVoiceProjection(
            canonical,
            account,
            isRecord(deltaRecord.voice) && isRecord(deltaRecord.voice.adapters)
                ? deltaRecord.voice
                : currentRecord?.voice,
        );
    return Object.assign({}, diagnosticsNormalized, {
        [VOICE_SETTINGS_ACCOUNT_SETTING_KEY]: canonical,
        voice: predecessorProjection,
    });
}
