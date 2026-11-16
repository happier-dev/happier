import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { t } from '@/text';

import { isSessionComposerBannerKind, isSessionComposerBannerKindCollapsedByDefault, type SessionComposerBannerKind } from './composerBannerKinds';

/**
 * Persisted collapse state. Only kinds toggled away from their default are stored, so an absent key
 * always means "as the kind starts" (open, or closed for a default-closed kind) and retiring a banner kind
 * cannot leave a dangling hidden banner.
 */
export type ComposerBannerCollapseRecord = Readonly<Record<string, boolean>>;

export function isComposerBannerCollapsedInRecord(
    record: ComposerBannerCollapseRecord | null | undefined,
    kind: SessionComposerBannerKind,
): boolean {
    return (record?.[kind] === true) !== isSessionComposerBannerKindCollapsedByDefault(kind);
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
 * One message per state: a collapsible composer banner and its status chip never speak at once.
 * The expanded banner says everything and carries its own Hide (see `buildComposerBannerHideAction`);
 * only once it is collapsed does the chip stand in for it, and pressing the chip brings it back.
 *
 * The chip is then the banner's only trace, so the live status text stays its accessible name and
 * the "show" verb goes in the hint; overriding the label with the verb would drop the status.
 */
export function buildCollapsedComposerBannerBadge(params: Readonly<{
    collapsed: boolean;
    badge: AgentInputStatusBadge;
    statusLabel: string;
    expandHint: string;
}>): AgentInputStatusBadge | null {
    if (!params.collapsed) return null;
    return {
        ...params.badge,
        accessibilityLabel: params.statusLabel,
        accessibilityHint: params.expandHint,
        accessibilityState: { expanded: false },
    } satisfies AgentInputStatusBadge & ComposerBannerBadgeAccessibility;
}

export type ComposerBannerHideAction = Readonly<{
    key: 'hide';
    testID: string;
    label: string;
    accessibilityLabel: string;
    variant: 'quiet';
    onPress: () => void;
}>;

/** The expanded banner's own quiet Hide; it calls the same collapse toggle the chip does. */
export function buildComposerBannerHideAction(params: Readonly<{
    bannerTestID: string;
    accessibilityLabel: string;
    onPress: () => void;
}>): ComposerBannerHideAction {
    return {
        key: 'hide',
        testID: `${params.bannerTestID}-hide`,
        label: t('common.hide'),
        accessibilityLabel: params.accessibilityLabel,
        variant: 'quiet',
        onPress: params.onPress,
    };
}
