import { VoiceRuntimePlatformSchema, type VoiceRuntimePlatform } from '@happier-dev/protocol/voice/realtime/capabilities';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { projectVoiceProviderSettings, type VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { projectVoiceCredentialReadiness } from '@/voice/credentials/credentialReadiness';
import { resolveAccountVoiceCredentialStatus } from '@/voice/credentials/accountVoiceCredential';
import { projectVoiceProviderRequirements, projectVoiceReadinessRequirement, type VoiceRoleReadiness } from '@/voice/registry/readiness';
import {
    isExternalVoiceProviderConnectedServicesBindingReady,
    type ExternalVoiceProviderSettingsDescriptor,
} from '@/voice/settings/externalProviderSettings';
import { resolveVoiceProviderIdForBindingScope } from '@/voice/settings/resolveVoiceProviderId';

export type VoiceStartRefusal = Readonly<{
    reasonKey: string;
    recoveryAction: 'open_session' | 'open_setup' | VoiceRoleReadiness['recoveryAction'];
}>;

export type VoiceStartAdmission = Readonly<{
    /** Whether a Voice attempt may be started at all. */
    canStart: boolean;
    /** The same decision supplies the explanation and remedy; consumers never infer a refusal. */
    refusal: VoiceStartRefusal | null;
    /**
     * Whether the provider's connected-services reference is present (or the provider needs none).
     *
     * Returned rather than recomputed by callers: it is the one refusal a surface explains in copy,
     * and a second derivation of it is a second answer waiting to diverge.
     */
    connectedServicesBindingReady: boolean;
    credentialReady: boolean;
}>;

/**
 * The single owner of Voice **start admission**.
 *
 * Every surface that can begin a conversation — the glance through
 * `useVoiceSurfaceModel`, the shell and composer through `useVoiceAttemptControl` — asks this function
 * and nothing else. Before this existed the orb re-derived its own weaker rule
 * (`providerReady && allowsGlobalStart`) and offered a Start on providers the surface had already
 * refused: a transport that cannot do anything, which §2.2 forbids.
 *
 * It decides admission only. The target owner resolves retained start preference or explicit
 * composer/Home intent before admission; container placement never chooses the target.
 */
export function resolveVoiceStartAdmission(input: Readonly<{
    /** The scope resolved by the canonical idle-target policy or an explicit caller intent. */
    bindingScope: 'global' | 'session';
    /** The daemon-backed conversation needs the server's `voice.agent` feature and lacks it. */
    daemonLocalVoiceUnavailable: boolean;
    /** A start with no session bound to the caller is authorized. */
    globalStartAuthorized: boolean;
    providerId: string;
    platform: VoiceRuntimePlatform | 'unknown';
    providerSettings: ExternalVoiceProviderSettingsDescriptor | null;
    registry: VoiceProviderRegistry;
    /** The session a scoped start would bind to, when the caller has one. */
    startSessionId: string | null;
    voiceSettings: Pick<VoiceSettings, 'providerId' | 'providers'>;
    credentialContext?: Omit<Parameters<typeof projectVoiceCredentialReadiness>[0], 'entry' | 'envelope'>;
}>): VoiceStartAdmission {
    const providerReadyForBinding = resolveVoiceProviderIdForBindingScope(
        input.voiceSettings,
        input.bindingScope,
        input.registry,
    ) === input.providerId;
    const entry = input.registry.get(input.providerId);
    const platformSupported = input.platform !== 'unknown'
        && entry !== null
        && entry.supportedPlatforms.includes(input.platform);
    // A session-scoped start binds through the session, so the global connected-services
    // reference is not its prerequisite.
    const connectedServicesBindingReady =
        input.bindingScope === 'session'
        || !input.providerSettings
        || isExternalVoiceProviderConnectedServicesBindingReady(
            input.voiceSettings.providers?.[input.providerId] ?? null,
            input.providerSettings,
        );
    const envelope = input.voiceSettings.providers?.[input.providerId] ?? null;
    const projection = entry ? projectVoiceProviderSettings(entry, envelope) : null;
    const requirements = entry ? projectVoiceProviderRequirements(entry, projection?.modeId, null, projection?.requirements) : null;
    // Built-in Local's aggregate speech requirements have no provider credential
    // slot; its speech engines own those facts. Compose the selected conversation
    // declaration's credential through the same owner Settings uses.
    const hasCredentialSlot = entry?.kind === 'voice.conversation-provider.v1' && Boolean(entry.declaration?.credentials);
    const credential = hasCredentialSlot && entry && input.credentialContext
        ? projectVoiceCredentialReadiness({ ...input.credentialContext, entry, envelope }).credential : 'unknown';
    // Start supplies preparation demand. Its activation owner already joins the
    // credential catalogs before use; opening Set up is not a prerequisite for
    // resolving a saved selection. Known missing/withdrawn credentials still refuse.
    const selectedCredential = credential === 'unknown' && entry?.kind === 'voice.conversation-provider.v1'
        && entry.declaration?.credentials && input.credentialContext
        ? resolveAccountVoiceCredentialStatus({ settings: input.credentialContext.settings,
            contribution: { pluginId: entry.pluginId, localId: entry.declaration.id },
            credentialSlotId: entry.declaration.credentials.slot.id,
            resolveSavedSecret: input.credentialContext.resolveSavedSecret }) : null;
    const awaitingSelectedCredential = selectedCredential?.reference != null && selectedCredential.status !== 'missing';
    const credentialRefusal = hasCredentialSlot && requirements?.includes('credential') && entry
        && !awaitingSelectedCredential
        ? projectVoiceReadinessRequirement(entry.roles[0] ?? 'realtime_conversation', input.providerId, 'credential',
            credential)
        : null;
    const credentialReady = credentialRefusal === null;
    const refusal: VoiceStartRefusal | null = !entry
        ? { reasonKey: 'voice.readiness.provider_unselected', recoveryAction: 'open_setup' }
        : input.daemonLocalVoiceUnavailable
        ? { reasonKey: 'voice.readiness.server_feature_disabled', recoveryAction: 'switch_provider' }
        : !platformSupported
            ? { reasonKey: 'voice.readiness.platform_unsupported', recoveryAction: 'switch_provider' }
            : !connectedServicesBindingReady
                ? { reasonKey: 'voice.readiness.settings_missing_required_setting', recoveryAction: 'open_provider_settings' }
                : credentialRefusal
                    ? credentialRefusal
                    : !providerReadyForBinding
                        ? { reasonKey: 'voice.readiness.settings_unknown', recoveryAction: 'open_provider_settings' }
                        : !input.globalStartAuthorized && !input.startSessionId
                            ? { reasonKey: 'commandPalette.commands.sessionRequiredBody', recoveryAction: 'open_session' }
                            : null;
    return {
        canStart: refusal === null,
        refusal,
        connectedServicesBindingReady,
        credentialReady,
    };
}

export function resolveCurrentVoiceRuntimePlatform(platform: unknown): VoiceRuntimePlatform | 'unknown' {
    const parsed = VoiceRuntimePlatformSchema.safeParse(platform);
    return parsed.success ? parsed.data : 'unknown';
}
