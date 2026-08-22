import { VoiceProviderIdSchema, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import type { VoiceSessionSnapshot } from '@/voice/session/types';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import {
    projectVoiceProviderSettings,
    type VoiceProviderRegistry,
} from '@/voice/registry/providerRegistry';
import { projectExternalVoiceProviderSettings } from '@/voice/settings/externalProviderSettings';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

/** @deprecated Use the open conversation-provider id returned by the registry. */
export type KnownVoiceProviderId = string;

let defaultRegistry: VoiceProviderRegistry | null = null;

function getDefaultRegistry(): VoiceProviderRegistry {
    defaultRegistry ??= createDefaultVoiceProviderRegistry();
    return defaultRegistry;
}

function normalizeStoredVoiceProviderId(value: unknown): string | null {
    const normalized = normalizeNonEmptyString(value);
    if (normalized === 'off') return null;
    const parsed = VoiceProviderIdSchema.safeParse(normalized);
    return parsed.success ? parsed.data : null;
}

export function resolveStoredVoiceProviderId(value: unknown): string | null {
    return normalizeStoredVoiceProviderId(value);
}

export function resolveVoiceProviderId(
    value: unknown,
    registry: VoiceProviderRegistry = getDefaultRegistry(),
): KnownVoiceProviderId | null {
    const providerId = resolveStoredVoiceProviderId(value);
    if (!providerId) return null;
    return registry.get(providerId)?.kind === 'voice.conversation-provider.v1' ? providerId : null;
}

export function resolveVoiceProviderIdFromSettings(
    settings: Pick<VoiceSettings, 'providerId' | 'providers'>,
    registry: VoiceProviderRegistry = getDefaultRegistry(),
): KnownVoiceProviderId | null {
    return resolveVoiceProviderIdForBindingScope(settings, 'global', registry);
}

export function resolveVoiceProviderIdForBindingScope(
    settings: Pick<VoiceSettings, 'providerId' | 'providers'>,
    bindingScope: 'global' | 'session',
    registry: VoiceProviderRegistry = getDefaultRegistry(),
): KnownVoiceProviderId | null {
    const providerId = resolveVoiceProviderId(settings.providerId, registry);
    if (!providerId) return null;
    const contribution = registry.get(providerId);
    if (!contribution || contribution.kind !== 'voice.conversation-provider.v1') return null;
    const envelope = settings.providers?.[providerId];
    const settingsProjection = projectVoiceProviderSettings(contribution, envelope ?? null);
    if (settingsProjection?.status === 'ready') return providerId;
    if (
        bindingScope !== 'session'
        || settingsProjection?.status !== 'missing_required_setting'
        || contribution.declaration?.kind !== 'conversation'
        || contribution.declaration.execution?.kind !== 'experimental_agent_session_realtime'
        || !contribution.providerSettings?.connectedServicesBinding
    ) {
        return null;
    }
    const declaredSettingsProjection = projectExternalVoiceProviderSettings(
        envelope ?? null,
        contribution.providerSettings,
    );
    return declaredSettingsProjection.status === 'missing_required_setting'
        ? providerId
        : null;
}

/**
 * Keeps a selected provider with a declarative global binding visible so the
 * surface can present the missing/invalid binding and its remediation. Runtime
 * admission remains exclusively owned by resolveVoiceProviderIdForBindingScope.
 */
export function resolveVoiceProviderIdForSurface(
    settings: Pick<VoiceSettings, 'providerId' | 'providers'>,
    registry: VoiceProviderRegistry = getDefaultRegistry(),
): KnownVoiceProviderId | null {
    const directProviderId = resolveVoiceProviderIdForBindingScope(
        settings,
        'session',
        registry,
    );
    if (directProviderId) return directProviderId;
    const providerId = resolveVoiceProviderId(settings.providerId, registry);
    if (!providerId) return null;
    const contribution = registry.get(providerId);
    return contribution?.kind === 'voice.conversation-provider.v1'
        && contribution.providerSettings?.connectedServicesBinding
        ? providerId
        : null;
}

/**
 * The provider a Voice surface must present.
 *
 * `settings.providerId` names the provider the **next** idle Start would admit; the published
 * snapshot's `adapterId` names the attempt that is running **right now**. The two diverge the
 * moment the user picks a different provider — or Off — while an attempt is still live, and
 * presentation must follow the attempt: hiding the surface would leave an open microphone with
 * no control to stop it, and projecting the newly selected provider's capabilities, recovery and
 * energy onto someone else's attempt states facts that do not belong to it.
 *
 * The lifecycle owner already publishes `adapterId` as that truth (it retains the source adapter
 * until the hand-off observes its disconnect, and clears it to `null` once nothing is running),
 * so this reads that answer rather than deriving a second one.
 */
export function resolveVoicePresentedProviderId(
    snapshot: Pick<VoiceSessionSnapshot, 'adapterId'>,
    settings: Pick<VoiceSettings, 'providerId' | 'providers'>,
    registry: VoiceProviderRegistry = getDefaultRegistry(),
): KnownVoiceProviderId | null {
    const attemptProviderId = normalizeNonEmptyString(snapshot.adapterId);
    if (
        attemptProviderId !== null
        && registry.get(attemptProviderId)?.kind === 'voice.conversation-provider.v1'
    ) {
        return attemptProviderId;
    }
    return resolveVoiceProviderIdForSurface(settings, registry);
}

export function resetVoiceProviderResolverRegistryForTests(): void {
    defaultRegistry = null;
}
