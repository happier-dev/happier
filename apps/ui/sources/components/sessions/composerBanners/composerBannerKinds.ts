/**
 * Registry of the collapsible banner surfaces that sit around the session composer.
 *
 * A banner may only be registered here when it also publishes a status badge into the
 * composer action bar: collapsing must demote the signal to the badge, never destroy it.
 */
export const SESSION_COMPOSER_BANNER_KINDS = [
    'usageLimitRecovery',
    'staleSessionRunner',
    'authRecovery',
    'pendingQueueResumeFailed',
    'providerBinding',
    'externalTranscriptSnapshot',
    'localControl',
    'directControlTakeover',
    'sessionNotice',
    'agentTransitionOutcome',
    'draftConflict',
] as const;

export type SessionComposerBannerKind = (typeof SESSION_COMPOSER_BANNER_KINDS)[number];

const REGISTERED_KINDS: ReadonlySet<string> = new Set(SESSION_COMPOSER_BANNER_KINDS);

export function isSessionComposerBannerKind(value: unknown): value is SessionComposerBannerKind {
    return typeof value === 'string' && REGISTERED_KINDS.has(value);
}
