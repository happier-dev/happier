import type { AccountSettings } from '../../account/settings/accountSettings.js';
import type { UsagePacingTargetsV1 } from '../../account/settings/usagePacingPreferencesV1.js';
import { SESSION_PROVIDER_USAGE_GAUGE_WINDOW_MODES } from '../../account/settings/accountSettings.js';
type ScmRemoteConfirmPolicy = AccountSettings['scmRemoteConfirmPolicy'];
type SessionListSettingsDelta = Partial<Pick<AccountSettings, 'sessionListSectionModeV1' | 'sessionListActiveGroupingV1'
    | 'sessionListInactiveGroupingV1' | 'sessionListAttentionPromotionModeV1' | 'sessionListWorkingPlacementModeV1'
    | 'sessionListOrderingModeV1' | 'sessionFolderViewModeV1' | 'sessionListFolderSortModeV1'>>;

export const THINKING_DISPLAY_CHOICES = ['inline_summary', 'inline_full', 'tool', 'hidden'] as const;
export type ThinkingDisplayChoice = typeof THINKING_DISPLAY_CHOICES[number];

export type ThinkingDisplaySettings = Readonly<{
    sessionThinkingDisplayMode?: unknown;
    sessionThinkingInlinePresentation?: unknown;
}>;

export function isThinkingDisplayChoice(value: unknown): value is ThinkingDisplayChoice {
    return typeof value === 'string' && (THINKING_DISPLAY_CHOICES as readonly string[]).includes(value);
}

export function resolveThinkingDisplayChoice(settings: ThinkingDisplaySettings): ThinkingDisplayChoice {
    if (settings.sessionThinkingDisplayMode === 'tool') return 'tool';
    if (settings.sessionThinkingDisplayMode === 'hidden') return 'hidden';
    return settings.sessionThinkingInlinePresentation === 'full' ? 'inline_full' : 'inline_summary';
}

export type ThinkingDisplayChoiceDelta = Readonly<{
    sessionThinkingDisplayMode: 'inline' | 'tool' | 'hidden';
    sessionThinkingInlinePresentation?: 'summary' | 'full';
}>;

/** One write for the whole choice. Tool and Hidden keep the inline presentation for a later return to inline. */
export function resolveThinkingDisplayChoiceDelta(choice: ThinkingDisplayChoice): ThinkingDisplayChoiceDelta {
    switch (choice) {
        case 'inline_summary':
            return { sessionThinkingDisplayMode: 'inline', sessionThinkingInlinePresentation: 'summary' };
        case 'inline_full':
            return { sessionThinkingDisplayMode: 'inline', sessionThinkingInlinePresentation: 'full' };
        case 'tool':
            return { sessionThinkingDisplayMode: 'tool' };
        case 'hidden':
            return { sessionThinkingDisplayMode: 'hidden' };
    }
}

export type ScmRemoteConfirmationKind = 'fetch' | 'pull' | 'push';

export function normalizeScmRemoteConfirmPolicy(value: unknown): ScmRemoteConfirmPolicy {
    if (
        value === 'always'
        || value === 'pull_only'
        || value === 'push_only'
        || value === 'never'
    ) {
        return value;
    }
    return 'always';
}

export function shouldConfirmRemoteOperation(
    policy: ScmRemoteConfirmPolicy,
    kind: ScmRemoteConfirmationKind,
): boolean {
    if (kind === 'fetch') return false;

    const normalized = normalizeScmRemoteConfirmPolicy(policy);
    if (normalized === 'always') return true;
    if (normalized === 'pull_only') return kind === 'pull';
    if (normalized === 'push_only') return kind === 'push';
    return false;
}

export function setRemoteConfirmationForKind(
    policy: ScmRemoteConfirmPolicy,
    kind: Extract<ScmRemoteConfirmationKind, 'pull' | 'push'>,
    enabled: boolean,
): ScmRemoteConfirmPolicy {
    const confirmsPull = kind === 'pull' ? enabled : shouldConfirmRemoteOperation(policy, 'pull');
    const confirmsPush = kind === 'push' ? enabled : shouldConfirmRemoteOperation(policy, 'push');

    if (confirmsPull && confirmsPush) return 'always';
    if (confirmsPull) return 'pull_only';
    if (confirmsPush) return 'push_only';
    return 'never';
}

/** The one account-wide personal target the Plans views offer; pool and per-meter targets keep their own owners. */
const PERSONAL_TARGET_ID = 'personal';

export function readUsagePersonalPaceTarget(targets: UsagePacingTargetsV1): number | null {
    const target = targets.find((entry) => entry.scope.kind === 'personal' && entry.meterId === undefined);
    return target ? target.utilizationFraction : null;
}

/** Sets or clears the personal target in place; every other target is kept exactly. */
export function setUsagePersonalPaceTarget(targets: UsagePacingTargetsV1, fraction: number | null): UsagePacingTargetsV1 {
    const others = targets.filter((entry) => !(entry.scope.kind === 'personal' && entry.meterId === undefined));
    return fraction === null ? others
        : [...others, { id: PERSONAL_TARGET_ID, scope: { kind: 'personal' }, utilizationFraction: fraction }];
}

export const QUOTA_GAUGE_WINDOW_MODES = SESSION_PROVIDER_USAGE_GAUGE_WINDOW_MODES;
export type ConnectedServiceQuotaGaugeWindowMode = typeof QUOTA_GAUGE_WINDOW_MODES[number];

export function isQuotaGaugeWindowMode(value: string): value is ConnectedServiceQuotaGaugeWindowMode {
    return QUOTA_GAUGE_WINDOW_MODES.some((mode) => mode === value);
}

/** An explicit choice overrides the predecessor single-window preference. */
export function resolveQuotaGaugeWindowModes(
    modes: readonly ConnectedServiceQuotaGaugeWindowMode[] | null | undefined,
    legacyMode: ConnectedServiceQuotaGaugeWindowMode = 'most_constrained',
): ConnectedServiceQuotaGaugeWindowMode[] {
    if (!modes?.length) return [legacyMode];
    if (modes.includes('most_constrained')) return ['most_constrained'];
    return [...new Set(modes)];
}

export const SESSION_LIST_LAYOUT_CHOICES = ['projects', 'recent_activity', 'active_inactive'] as const;
export type SessionListLayoutChoice = typeof SESSION_LIST_LAYOUT_CHOICES[number];
export type SessionListGroupingMode = 'project' | 'date';
export type SessionListSectionMode = 'activity' | 'single';

export type SessionListLayoutSettings = Readonly<{
    sessionListSectionModeV1?: unknown;
    sessionListActiveGroupingV1?: unknown;
    sessionListInactiveGroupingV1?: unknown;
    sessionListOrderingModeV1?: unknown;
}>;

export function normalizeSessionListSectionModeV1(value: unknown): SessionListSectionMode {
    return value === 'activity' ? 'activity' : 'single';
}

export function normalizeSessionListGroupingModeV1(value: unknown): SessionListGroupingMode {
    return value === 'date' ? 'date' : 'project';
}

/**
 * Derives the arranged layout from the incumbent Account settings.
 *
 * `transientIntent` is a presentation-only override owned by a route or host for the
 * lifetime of that visit. It never writes, shadows or migrates the stored preference,
 * so a compatibility deep link can present Recent activity while the Account keeps
 * whatever the person last chose in View options.
 */
export function resolveSessionListLayoutChoice(
    settings: SessionListLayoutSettings,
    transientIntent?: SessionListLayoutChoice | null,
): SessionListLayoutChoice {
    if (transientIntent) {
        return transientIntent;
    }
    if (normalizeSessionListSectionModeV1(settings.sessionListSectionModeV1) === 'activity') {
        return 'active_inactive';
    }
    return normalizeSessionListGroupingModeV1(settings.sessionListActiveGroupingV1) === 'date'
        ? 'recent_activity'
        : 'projects';
}

export function resolveSessionListLayoutSettingsDelta(
    choice: SessionListLayoutChoice,
    _currentSettings: SessionListLayoutSettings,
): SessionListSettingsDelta {
    if (choice === 'projects') {
        return {
            sessionListSectionModeV1: 'single',
            sessionListActiveGroupingV1: 'project',
        };
    }
    if (choice === 'recent_activity') {
        return {
            sessionListSectionModeV1: 'single',
            sessionListActiveGroupingV1: 'date',
        };
    }
    return { sessionListSectionModeV1: 'activity' };
}

export function resolveSessionListViewOptionSelectionDelta(
    itemId: string,
    currentSettings: Readonly<{ sessionListOrderingModeV1?: unknown }>,
): SessionListSettingsDelta | null {
    if (itemId.startsWith('layout:')) {
        const choice = itemId.slice('layout:'.length);
        if (choice === 'projects' || choice === 'recent_activity' || choice === 'active_inactive') {
            return resolveSessionListLayoutSettingsDelta(choice, currentSettings);
        }
        return null;
    }
    if (itemId === 'grouping:active:project') return { sessionListActiveGroupingV1: 'project' };
    if (itemId === 'grouping:active:date') return { sessionListActiveGroupingV1: 'date' };
    if (itemId === 'grouping:inactive:project') return { sessionListInactiveGroupingV1: 'project' };
    if (itemId === 'grouping:inactive:date') return { sessionListInactiveGroupingV1: 'date' };
    if (itemId === 'attention:off') return { sessionListAttentionPromotionModeV1: 'off' };
    if (itemId === 'attention:global') return { sessionListAttentionPromotionModeV1: 'global' };
    if (itemId === 'attention:withinGroups') return { sessionListAttentionPromotionModeV1: 'withinGroups' };
    if (itemId === 'working:off') return { sessionListWorkingPlacementModeV1: 'off' };
    if (itemId === 'working:global') return { sessionListWorkingPlacementModeV1: 'global' };
    if (itemId === 'working:withinGroups') return { sessionListWorkingPlacementModeV1: 'withinGroups' };
    if (itemId === 'ordering:custom') return { sessionListOrderingModeV1: 'custom' };
    if (itemId === 'ordering:updated') return { sessionListOrderingModeV1: 'updated' };
    if (itemId === 'ordering:created') return { sessionListOrderingModeV1: 'created' };
    if (itemId === 'folderDisplay:off') return { sessionFolderViewModeV1: 'off' };
    if (itemId === 'folderDisplay:tree') return { sessionFolderViewModeV1: 'tree' };
    if (itemId === 'folderSort:foldersFirst') return { sessionListFolderSortModeV1: 'foldersFirst' };
    if (itemId === 'folderSort:mixed' && normalizeSessionListOrderingModeV1(
        currentSettings.sessionListOrderingModeV1,
    ) === 'custom') {
        return { sessionListFolderSortModeV1: 'mixed' };
    }
    return null;
}

export const SESSION_LIST_ORDERING_MODES_V1 = ['custom', 'created', 'updated'] as const;
export type SessionListOrderingModeV1 = typeof SESSION_LIST_ORDERING_MODES_V1[number];
export const SESSION_LIST_ORDERING_MODE_DEFAULT_V1: SessionListOrderingModeV1 = 'custom';
export function normalizeSessionListOrderingModeV1(value: unknown): SessionListOrderingModeV1 {
    return value === 'created' || value === 'updated' || value === 'custom' ? value : SESSION_LIST_ORDERING_MODE_DEFAULT_V1;
}
export function normalizeSessionListFolderSortModeV1(value: unknown): "foldersFirst" | "mixed" {
    return value === "mixed" ? "mixed" : "foldersFirst";
}
export function resolveEffectiveSessionListFolderSortMode(params: Readonly<{ orderingMode: "custom" | "created" | "updated"; folderSortMode: "foldersFirst" | "mixed" }>): "foldersFirst" | "mixed" {
    return params.orderingMode === "custom" ? params.folderSortMode : "foldersFirst";
}
