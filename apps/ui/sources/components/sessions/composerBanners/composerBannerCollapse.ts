import { isSessionComposerBannerKind, type SessionComposerBannerKind } from './composerBannerKinds';

/**
 * Persisted collapse state. Only collapsed kinds are stored, so an absent key always
 * means "expanded" and retiring a banner kind cannot leave a dangling hidden banner.
 */
export type ComposerBannerCollapseRecord = Readonly<Record<string, boolean>>;

export function isComposerBannerCollapsedInRecord(
    record: ComposerBannerCollapseRecord | null | undefined,
    kind: SessionComposerBannerKind,
): boolean {
    return record?.[kind] === true;
}

export function normalizeComposerBannerCollapseRecord(
    record: ComposerBannerCollapseRecord | null | undefined,
): Record<string, boolean> {
    if (!record) return {};
    const normalized: Record<string, boolean> = {};
    for (const [kind, collapsed] of Object.entries(record)) {
        if (collapsed !== true) continue;
        if (!isSessionComposerBannerKind(kind)) continue;
        normalized[kind] = true;
    }
    return normalized;
}

export function toggleComposerBannerCollapsedInRecord(
    record: ComposerBannerCollapseRecord | null | undefined,
    kind: SessionComposerBannerKind,
): Record<string, boolean> {
    const next = normalizeComposerBannerCollapseRecord(record);
    if (next[kind] === true) {
        delete next[kind];
        return next;
    }
    next[kind] = true;
    return next;
}

/**
 * Which record the banner stack reads. The persisted device record is consulted only while the
 * account preference is enabled, so turning the preference off restores the pre-setting behavior
 * immediately without discarding what the user already collapsed.
 */
export function resolveComposerBannerCollapseState(params: Readonly<{
    remember: boolean;
    persisted: ComposerBannerCollapseRecord | null | undefined;
    ephemeral: ComposerBannerCollapseRecord | null | undefined;
}>): Record<string, boolean> {
    return normalizeComposerBannerCollapseRecord(params.remember ? params.persisted : params.ephemeral);
}

export type ComposerBannerCollapseTogglePlan = Readonly<{
    /** Next device record, or `null` when device storage must not be written. */
    persisted: Record<string, boolean> | null;
    /** Next session-scoped record, or `null` when ephemeral state must not change. */
    ephemeral: Record<string, boolean> | null;
}>;

export function planComposerBannerCollapseToggle(params: Readonly<{
    remember: boolean;
    persisted: ComposerBannerCollapseRecord | null | undefined;
    ephemeral: ComposerBannerCollapseRecord | null | undefined;
    kind: SessionComposerBannerKind;
}>): ComposerBannerCollapseTogglePlan {
    if (params.remember) {
        return {
            persisted: toggleComposerBannerCollapsedInRecord(params.persisted, params.kind),
            ephemeral: null,
        };
    }
    return {
        persisted: null,
        ephemeral: toggleComposerBannerCollapsedInRecord(params.ephemeral, params.kind),
    };
}

export type ComposerBannerBadgeAccessibility = Readonly<{
    accessibilityLabel: string;
    accessibilityHint: string;
    accessibilityState: Readonly<{ expanded: boolean }>;
}>;

/**
 * The badge is the only remaining affordance once a banner is collapsed, so the live status
 * text stays the accessible name and the show/hide verb moves to the hint. Overriding the
 * label with the verb would announce "Show banner" and drop the status entirely.
 */
export function buildComposerBannerBadgeAccessibility(params: Readonly<{
    statusLabel: string;
    collapsed: boolean;
    expandHint: string;
    collapseHint: string;
}>): ComposerBannerBadgeAccessibility {
    return {
        accessibilityLabel: params.statusLabel,
        accessibilityHint: params.collapsed ? params.expandHint : params.collapseHint,
        accessibilityState: { expanded: !params.collapsed },
    };
}
