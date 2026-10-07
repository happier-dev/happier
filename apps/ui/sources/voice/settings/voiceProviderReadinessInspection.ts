import type { ConnectedServiceBindingsV1, PluginContributionIdentityV1, VoiceRawCredentialGrantDeclaration } from '@happier-dev/protocol';
import type { Settings } from '@/sync/domains/settings/settings';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { resolveAccountVoiceCredentialSourceSelection, resolveSelectedVoiceCredentialRawGrants } from '@/voice/credentials/accountVoiceCredential';
import { inspectRawCredentialAuthorizationReadiness } from '@/voice/credentials/rawCredentialAuthorizationClient';
import { parseLocalVoiceSttSettings, parseLocalVoiceTtsSettings, resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { readVoiceProviderPassiveRealtimeSetupResult, type VoiceProviderAgentRealtimePassiveSetup } from './passiveSetup';
import { createVoiceDictationRuntimeSettingsSnapshot } from '@/voice/dictation/voiceDictationRuntimeSettings';
import { readVoiceDictationNativeModelReadiness } from '@/voice/dictation/voiceDictationNativeModelReadiness';

export type VoiceRawSpeechReadinessTarget = Readonly<{
    providerId: string;
    contribution: PluginContributionIdentityV1;
    rawGrants: readonly VoiceRawCredentialGrantDeclaration[];
}>;

/** Canonical selected speech credential targets, shared by page checks and Actions. */
export function projectVoiceRawSpeechReadinessTargets(settings: Pick<Settings, 'voice' | 'voiceSettingsV1' | 'secrets' | 'connectedAccountPurposeBindingsV1'>, registry: VoiceProviderRegistry, machineId: string | null, purpose: 'conversation' | 'dictation' = 'conversation'): readonly VoiceRawSpeechReadinessTarget[] {
    const runtime = purpose === 'dictation' ? createVoiceDictationRuntimeSettingsSnapshot(settings) : settings;
    const config = resolveLocalVoiceAdapterSettings(runtime).config;
    const providerIds = purpose === 'dictation' ? [parseLocalVoiceSttSettings(config.stt).provider]
        : [parseLocalVoiceSttSettings(config.stt).provider, parseLocalVoiceTtsSettings(config.tts).provider];
    return [...new Set(providerIds)].flatMap(providerId => {
        const entry = registry.get(providerId);
        if (entry?.kind !== 'voice.speech-engine.v1' || entry.declaration?.kind !== 'speech' || !entry.declaration.credentials) return [];
        const contribution = { pluginId: entry.pluginId, localId: entry.declaration.id };
        try {
            const source = resolveAccountVoiceCredentialSourceSelection({ settings, contribution,
                credentialSlotId: entry.declaration.credentials.slot.id,
                purpose: { consumer: contribution, purpose: entry.declaration.credentials.slot.purpose }, machineId });
            const rawGrants = resolveSelectedVoiceCredentialRawGrants({ declaration: entry.declaration, contribution,
                selection: source.selection, access: { realm: 'daemon', phase: 'speech' } });
            return rawGrants.length ? [{ providerId, contribution, rawGrants }] : [];
        } catch { return []; }
    });
}

export async function inspectVoiceDictationSettingsReadiness(input: Readonly<{
    packId: string | null;
    rawTarget: Pick<VoiceRawSpeechReadinessTarget, 'contribution' | 'rawGrants'> | null;
    signal?: AbortSignal;
}>) {
    const rawTarget = input.rawTarget;
    const [nativeLocalNeuralModel, rawCredentialAuthorization] = await Promise.all([
        input.packId ? readVoiceDictationNativeModelReadiness(input.packId) : Promise.resolve(null),
        rawTarget ? Promise.all(rawTarget.rawGrants.map(grant => inspectRawCredentialAuthorizationReadiness(rawTarget.contribution, grant, input.signal)))
            .then(values => values.some(value => value === 'unknown') ? 'unknown' as const : values.some(value => value === 'approval_required') ? 'approval_required' as const : 'ready' as const)
            : Promise.resolve(null),
    ]);
    return { nativeLocalNeuralModel, rawCredentialAuthorization };
}

/** Passive probes never open a provider or microphone and never grant credential access. */
export async function inspectVoiceProviderReadiness(input: Readonly<{
    machineId: string;
    passiveSetup: VoiceProviderAgentRealtimePassiveSetup | null;
    connectedServices: ConnectedServiceBindingsV1 | null;
    rawTargets: readonly VoiceRawSpeechReadinessTarget[];
    signal?: AbortSignal;
    isCurrent(): boolean;
}>) {
    const passiveResult = input.passiveSetup && input.connectedServices && input.isCurrent()
        ? machineCapabilitiesInvoke(input.machineId, { id: input.passiveSetup.capabilityId, method: 'probePassiveRealtimeSetup',
            params: { connectedServices: input.connectedServices } }, { timeoutMs: 30_000 }).then(outcome =>
                outcome.supported && outcome.response.ok ? readVoiceProviderPassiveRealtimeSetupResult(outcome.response.result) : null, () => null)
        : Promise.resolve(null);
    const rawResult = Promise.all(input.rawTargets.map(async target => {
        const statuses = await Promise.all(target.rawGrants.map(grant => input.isCurrent()
            ? inspectRawCredentialAuthorizationReadiness(target.contribution, grant, input.signal)
            : Promise.resolve('unknown' as const)));
        const status = statuses.some(value => value === 'unknown') ? 'unknown' as const
            : statuses.some(value => value === 'approval_required') ? 'approval_required' as const : 'ready' as const;
        return { providerId: target.providerId, contribution: target.contribution, status };
    }));
    const [passive, raw] = await Promise.all([passiveResult, rawResult]);
    return { passive, raw };
}
