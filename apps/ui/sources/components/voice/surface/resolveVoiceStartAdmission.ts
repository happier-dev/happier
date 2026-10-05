import { VoiceRuntimePlatformSchema, type VoiceRuntimePlatform } from '@happier-dev/protocol';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import {
    isExternalVoiceProviderConnectedServicesBindingReady,
    type ExternalVoiceProviderSettingsDescriptor,
} from '@/voice/settings/externalProviderSettings';
import { resolveVoiceProviderIdForBindingScope } from '@/voice/settings/resolveVoiceProviderId';

export type VoiceStartAdmission = Readonly<{
    /** Whether a Voice attempt may be started at all. */
    canStart: boolean;
    /**
     * Whether the provider's connected-services reference is present (or the provider needs none).
     *
     * Returned rather than recomputed by callers: it is the one refusal a surface explains in copy,
     * and a second derivation of it is a second answer waiting to diverge.
     */
    connectedServicesBindingReady: boolean;
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
    return {
        canStart:
            !input.daemonLocalVoiceUnavailable
            && providerReadyForBinding
            && platformSupported
            && connectedServicesBindingReady
            && (input.globalStartAuthorized || Boolean(input.startSessionId)),
        connectedServicesBindingReady,
    };
}

export function resolveCurrentVoiceRuntimePlatform(platform: unknown): VoiceRuntimePlatform | 'unknown' {
    const parsed = VoiceRuntimePlatformSchema.safeParse(platform);
    return parsed.success ? parsed.data : 'unknown';
}
