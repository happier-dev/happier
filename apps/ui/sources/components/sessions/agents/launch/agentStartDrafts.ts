import type {
    DetailsTabState,
    DetailsWorkspaceGroupView,
} from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { DiscussionSelectionSourceV1Schema, type DiscussionSelectionSourceV1 } from '@happier-dev/protocol/discussions/content';
import { scmComparisonKey } from '@/components/sessions/files/comparison/filesComparison';
import type { ComparisonReviewDraftInput } from '@/components/sessions/runs/launcher/useComparisonReviewDraft';
import {
    resolveExecutionRunLauncherIntent,
    type ExecutionRunIntent,
} from '@/components/sessions/runs/launcher/executionRunLauncherModel';

/**
 * A start with unsent work in it: open in a Details tab beside the Session (lab `convo-S1` Start
 * row), or only retained in the Session's draft when no tab shows it (a phone's Run page, or a tab
 * that was closed).
 */
export type AgentStartDraft = Readonly<{
    /** The launcher's draft key on the Session's one draft owner (`executionRunLauncherDraftKey`). */
    key: string;
    /** The Details tab showing it; `null` when only the retained draft remains. */
    tabKey: string | null;
    /** `null` for a plain conversation. */
    intent: ExecutionRunIntent | null;
    roleId: string | null;
    comparison?: true;
    /** The tab the person is looking at. */
    active: boolean;
}>;

/**
 * Where a launcher keeps its unsent text on the Session's draft: the start's intent (a plain
 * conversation is `conversation`) and role, or its Discussion selection. The launcher writes it and
 * the Work list reads it through this one function.
 */
export function executionRunLauncherDraftKey(start: Readonly<{
    intent: ExecutionRunIntent | null;
    roleId?: string | null;
    discussionCorrelationId?: string | null;
    comparisonReview?: ComparisonReviewDraftInput | null;
}>): string {
    if (start.discussionCorrelationId) return `discussion:${start.discussionCorrelationId}`;
    if (start.comparisonReview) {
        const { cwd, comparison, comparisonId } = start.comparisonReview;
        return `comparison:${JSON.stringify([start.roleId ?? null, cwd,
            scmComparisonKey(comparisonId ? { ...comparison, comparisonId } : comparison)])}`;
    }
    return `${start.intent ?? 'conversation'}${start.roleId ? `:${start.roleId}` : ''}`;
}

/** The start a retained launcher draft key names; `null` for a Discussion draft (its selection owns it) or an unknown key. */
function readRetainedStart(key: string): Pick<AgentStartDraft, 'intent' | 'roleId' | 'comparison'> | null {
    if (key.startsWith('comparison:')) {
        try {
            const identity: unknown = JSON.parse(key.slice('comparison:'.length));
            if (Array.isArray(identity) && identity.length === 3 && (identity[0] === null || typeof identity[0] === 'string')) {
                return { intent: 'review', roleId: identity[0], comparison: true };
            }
        } catch { /* An invalid retained key is not a launcher address. */ }
        return null;
    }
    const [head, ...rest] = key.split(':');
    const roleId = rest.length > 0 ? rest.join(':') : null;
    if (head === 'conversation' && roleId === null) return { intent: null, roleId: null };
    const intent = resolveExecutionRunLauncherIntent(head);
    return intent ? { intent, roleId } : null;
}

const NO_DRAFTS: readonly AgentStartDraft[] = Object.freeze([]);

/** What an open start tab is for; `null` when the tab is not an unsent Agent start. */
export type AgentStartDraftTarget = Readonly<{
    /** `null` for a plain conversation. */
    intent: ExecutionRunIntent | null;
    roleId: string | null;
    comparisonReview?: ComparisonReviewDraftInput;
    /** The selected discussion messages a conversation draft was started from, when it has them. */
    discussion: Readonly<{
        source: DiscussionSelectionSourceV1 & Readonly<{ draftCorrelationId: string }>;
        initialText: string;
    }> | null;
}>;

export function readAgentStartDraftTarget(resource: unknown): AgentStartDraftTarget | null {
    if (!resource || typeof resource !== 'object') return null;
    const value = resource as { kind?: unknown; mode?: unknown; intent?: unknown; roleId?: unknown; source?: unknown; initialInstructions?: unknown;
        comparisonReview?: ComparisonReviewDraftInput };
    if (value.kind !== 'executionRunLauncher') return null;
    if (value.mode === 'conversation') {
        const source = DiscussionSelectionSourceV1Schema.safeParse(value.source);
        const draftCorrelationId = source.success ? source.data.draftCorrelationId : undefined;
        return {
            intent: null,
            roleId: null,
            discussion: source.success && draftCorrelationId
                ? { source: { ...source.data, draftCorrelationId }, initialText: typeof value.initialInstructions === 'string' ? value.initialInstructions : '' }
                : null,
        };
    }
    // The intent-less launcher tab is "Advanced": a review with every choice.
    const intent = value.intent === undefined ? 'review' : resolveExecutionRunLauncherIntent(value.intent);
    if (!intent) return null;
    return { intent, roleId: typeof value.roleId === 'string' && value.roleId.length > 0 ? value.roleId : null, discussion: null,
        ...(value.comparisonReview ? { comparisonReview: value.comparisonReview } : {}) };
}

/**
 * The unsent starts of this Session, read from the owners that hold them — the Details panes for the
 * tabs, the Session's draft for text no tab shows — never a second draft registry. A draft stops
 * being listed the moment its first Send turns it into its Run.
 */
export function projectAgentStartDrafts(details: Readonly<{
    isOpen: boolean;
    tabs: ReadonlyArray<DetailsTabState>;
    activeTabKey: string | null;
    /** Split groups, when the workspace has them; one implicit group otherwise. */
    groups?: ReadonlyArray<Pick<DetailsWorkspaceGroupView, 'activeTabKey' | 'tabs'>>;
}> | null | undefined, retainedDraftKeys: readonly string[] = []): readonly AgentStartDraft[] {
    const drafts: AgentStartDraft[] = [];
    const seen = new Set<string>();
    const shownKeys = new Set<string>();
    const groups = details ? details.groups ?? [{ activeTabKey: details.activeTabKey, tabs: details.tabs }] : [];
    for (const group of groups) {
        for (const tab of group.tabs) {
            if (seen.has(tab.key)) continue;
            const target = readAgentStartDraftTarget(tab.resource);
            if (!target) continue;
            seen.add(tab.key);
            const key = executionRunLauncherDraftKey({
                ...target,
                discussionCorrelationId: target.discussion?.source.draftCorrelationId,
            });
            shownKeys.add(key);
            drafts.push({
                key,
                tabKey: tab.key,
                intent: target.intent,
                roleId: target.roleId,
                ...(target.comparisonReview ? { comparison: true as const } : {}),
                active: Boolean(details?.isOpen) && group.activeTabKey === tab.key,
            });
        }
    }
    for (const key of retainedDraftKeys) {
        if (shownKeys.has(key)) continue;
        const start = readRetainedStart(key);
        if (!start) continue;
        shownKeys.add(key);
        drafts.push({ key, tabKey: null, ...start, active: false });
    }
    return drafts.length > 0 ? drafts : NO_DRAFTS;
}
