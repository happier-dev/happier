import type { SessionPublicLinkSettingsV1 } from '@happier-dev/protocol';

/**
 * The canonical publication projection plus the bearer this device generated.
 *
 * The Home stores only the bearer's hash and never returns it, so the
 * generating device is the one place a usable link can be assembled. Every
 * other field is the Protocol-owned public projection; this module adds no
 * second shape for publication settings.
 */
export type SessionPublicLinkPublication = SessionPublicLinkSettingsV1 & Readonly<{
    token: string | null;
    /** Current isolated link, kept solely by the generating host. */
    publicUrl?: string | null;
}>;

export type SessionPublicLinkReadOutcome =
    | Readonly<{ ok: true; publication: SessionPublicLinkSettingsV1 | null }>
    | Readonly<{ ok: false }>;

/**
 * A failed read preserves the last known publication rather than flashing an
 * empty link. A byte-identical successful settings read may keep the local
 * bearer for UI continuity; this is not bearer authorization, and any
 * observable publication change or absence clears it.
 */
export function mergeSessionPublicLinkWithCachedBearer(params: Readonly<{
    previousPublication: SessionPublicLinkPublication | null;
    cachedToken: string | null;
    outcome: SessionPublicLinkReadOutcome;
}>): Readonly<{ publication: SessionPublicLinkPublication | null; cachedToken: string | null }> {
    if (!params.outcome.ok) {
        return { publication: params.previousPublication, cachedToken: params.cachedToken };
    }
    if (!params.outcome.publication) {
        return { publication: null, cachedToken: null };
    }
    const previous = params.previousPublication;
    const refreshed = params.outcome.publication;
    const settingsAreIdentical = previous !== null
        && previous.id === refreshed.id
        && previous.expiresAt === refreshed.expiresAt
        && previous.maxUses === refreshed.maxUses
        && previous.useCount === refreshed.useCount
        && previous.isConsentRequired === refreshed.isConsentRequired
        && (previous.networkOff ?? false) === (refreshed.networkOff ?? false)
        && previous.keyDerivation === refreshed.keyDerivation
        && previous.isolatedOrigin === refreshed.isolatedOrigin
        && previous.updatedAt === refreshed.updatedAt;
    if (settingsAreIdentical) {
        return {
            publication: { ...refreshed, token: params.cachedToken, ...(previous.publicUrl ? { publicUrl: previous.publicUrl } : {}) },
            cachedToken: params.cachedToken,
        };
    }
    return {
        publication: { ...refreshed, token: null },
        cachedToken: null,
    };
}
