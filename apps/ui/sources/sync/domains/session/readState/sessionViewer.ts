import { SessionViewerProjectionV1Schema, type SessionViewerProjectionV1 } from '@happier-dev/protocol/sessions/personal/viewer';
import { isSessionPersonallyTrackedForViewerV1 } from '@happier-dev/protocol/sessions/personal/tracking';
import type { SessionPersonalAttentionReasonV1 } from '@happier-dev/protocol/sessions/personal/attention';
import {
    isSessionAccessOwner,
    type NormalizedSessionAccessProjection,
} from '@/sync/engine/sessions/normalizeSessionAccessProjection';

type SessionViewerTrackingInput = Readonly<{
    viewer?: unknown;
    owner?: string;
    accessLevel?: 'view' | 'edit' | 'admin';
    access?: NormalizedSessionAccessProjection | null;
}>;

type NormalizedSessionViewerCompatibility =
    | Readonly<{ kind: 'current'; viewer: SessionViewerProjectionV1 }>
    | Readonly<{ kind: 'legacy_owner' }>
    | Readonly<{ kind: 'untracked' }>;

/**
 * Single UI compatibility decision for current viewer facts and released
 * pre-viewer rows. A malformed current projection is evidence of neither a
 * viewer nor an owner, so it fails closed instead of entering the legacy path.
 */
export function normalizeSessionViewerCompatibility(
    session: SessionViewerTrackingInput,
): NormalizedSessionViewerCompatibility {
    if (session.viewer !== undefined) {
        const parsed = SessionViewerProjectionV1Schema.safeParse(session.viewer);
        return parsed.success
            ? { kind: 'current', viewer: parsed.data }
            : { kind: 'untracked' };
    }
    // A sourced access projection is current-generation evidence. If its
    // required viewer companion is absent, do not reinterpret even an owner
    // access role through the released fallback.
    if (session.access?.sources !== undefined) return { kind: 'untracked' };
    return session.owner === undefined
        && isSessionAccessOwner(session.access, session.accessLevel)
        ? { kind: 'legacy_owner' }
        : { kind: 'untracked' };
}

/**
 * Tracking is owner-or-active-Follow, decided by the one Protocol predicate the
 * Home itself uses. A retained read cursor is the cursor fact and never
 * authority: seeding one for an explicit mark used to enroll a non-Follower in
 * another Account's unread state, personal Activity and local notifications
 * while the Home's own attention projection said otherwise.
 *
 * The 0.2.11 list/detail wire has no viewer projection and identifies shared
 * recipients through `share`, normalized here as owner/accessLevel. Preserve
 * owner tracking for those Homes without enrolling their shared recipients.
 * Remove this fallback when pre-viewer Homes are no longer supported.
 */
export function isSessionPersonallyTrackedForViewer(session: SessionViewerTrackingInput): boolean {
    const normalized = normalizeSessionViewerCompatibility(session);
    if (normalized.kind === 'legacy_owner') return true;
    if (normalized.kind !== 'current') return false;
    return isSessionPersonallyTrackedForViewerV1({
        isSessionOwner: isSessionAccessOwner(session.access, session.accessLevel),
        followFacts: normalized.viewer.follow,
    });
}

/**
 * The one derivation of "this Session carries new content this viewer has not
 * seen", shared by the Session row, Activity, Inbox and the badge counts. New
 * Discussion content and a mention of the viewer are unread facts exactly like
 * transcript unread — Lane 09B coalesces transcript and Discussion reasons onto
 * one Session, so no consumer may re-compose that set locally.
 *
 * `ready_after_read`, `reminder_due` and `manual` are deliberately excluded:
 * they are attention without new content and carry their own presentation.
 */
const UNREAD_CONTENT_ATTENTION_REASONS_V1: ReadonlySet<SessionPersonalAttentionReasonV1> = new Set([
    'unread',
    'unread_discussion',
    'mentioned',
]);

export function isUnreadContentAttentionReason(reason: SessionPersonalAttentionReasonV1): boolean {
    return UNREAD_CONTENT_ATTENTION_REASONS_V1.has(reason);
}

export function hasUnreadActivityForSessionViewer(viewer: SessionViewerProjectionV1): boolean {
    return viewer.readState.state === 'tracking'
        && viewer.attention.reasons.some(isUnreadContentAttentionReason);
}

export function resolveSessionViewerProjectionUpdate(
    value: unknown,
    previous: SessionViewerProjectionV1 | undefined,
): SessionViewerProjectionV1 | undefined {
    if (value === undefined) return previous;
    const parsed = SessionViewerProjectionV1Schema.safeParse(value);
    return parsed.success ? parsed.data : previous;
}
