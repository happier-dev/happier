/**
 * Registry of the collapsible banner surfaces that sit around the session composer.
 *
 * A banner may only be registered here when it also publishes a status badge into the
 * composer action bar: collapsing must demote the signal to the badge, never destroy it.
 */
export const SESSION_COMPOSER_BANNER_KINDS = [
    'usageLimitRecovery',
    'staleSessionRunner',
    'externalTranscriptSnapshot',
    'localControl',
    'directControlTakeover',
    'sessionNotice',
    'agentTransitionOutcome',
    'draftConflict',
    'cliVersionOutdated',
] as const;

export type SessionComposerBannerKind = (typeof SESSION_COMPOSER_BANNER_KINDS)[number];

const REGISTERED_KINDS: ReadonlySet<string> = new Set(SESSION_COMPOSER_BANNER_KINDS);

/**
 * Kinds whose banner starts closed: only the status chip shows until it is pressed (owner 11-16, the 0.2
 * "Older CLI" chip). Every other kind starts open and its Hide folds it into the chip.
 */
const DEFAULT_COLLAPSED_KINDS: ReadonlySet<SessionComposerBannerKind> = new Set<SessionComposerBannerKind>(['cliVersionOutdated']);

export function isSessionComposerBannerKindCollapsedByDefault(kind: SessionComposerBannerKind): boolean {
    return DEFAULT_COLLAPSED_KINDS.has(kind);
}

export function isSessionComposerBannerKind(value: unknown): value is SessionComposerBannerKind {
    return typeof value === 'string' && REGISTERED_KINDS.has(value);
}
