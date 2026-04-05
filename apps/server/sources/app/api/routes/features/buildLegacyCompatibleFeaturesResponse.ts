import type { FeaturesResponse } from "@/app/features/types";

type JsonRecord = Record<string, unknown>;

export function buildLegacyCompatibleFeaturesResponse(payload: FeaturesResponse): JsonRecord {
    const legacyFeatures = {
        ...payload.features,
        bugReports: {
            enabled: payload.features.bugReports.enabled,
            providerUrl: payload.capabilities.bugReports.providerUrl,
            defaultIncludeDiagnostics: payload.capabilities.bugReports.defaultIncludeDiagnostics,
            maxArtifactBytes: payload.capabilities.bugReports.maxArtifactBytes,
            acceptedArtifactKinds: [...payload.capabilities.bugReports.acceptedArtifactKinds],
            uploadTimeoutMs: payload.capabilities.bugReports.uploadTimeoutMs,
            contextWindowMs: payload.capabilities.bugReports.contextWindowMs,
        },
        automations: {
            ...payload.features.automations,
            existingSessionTarget: false,
        },
        voice: {
            ...payload.features.voice,
            configured: payload.capabilities.voice.configured,
            provider: payload.capabilities.voice.provider,
        },
        social: {
            friends: {
                enabled: payload.features.social.friends.enabled,
                allowUsername: payload.capabilities.social.friends.allowUsername,
                requiredIdentityProviderId: payload.capabilities.social.friends.requiredIdentityProviderId,
            },
        },
        oauth: {
            providers: payload.capabilities.oauth.providers,
        },
        auth: {
            ...payload.features.auth,
            signup: payload.capabilities.auth.signup,
            login: {
                ...payload.features.auth.login,
                ...payload.capabilities.auth.login,
            },
            recovery: {
                providerReset: {
                    enabled: payload.features.auth.recovery.providerReset.enabled,
                    providers: [...payload.capabilities.auth.recovery.providerReset.providers],
                },
            },
            ui: {
                autoRedirect: payload.capabilities.auth.ui.autoRedirect,
                recoveryKeyReminder: payload.features.auth.ui.recoveryKeyReminder,
            },
            providers: payload.capabilities.auth.providers,
            misconfig: payload.capabilities.auth.misconfig,
            methods: payload.capabilities.auth.methods,
        },
    } satisfies JsonRecord;

    return {
        ...payload,
        features: legacyFeatures,
    };
}
