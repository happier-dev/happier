import { resolveSessionWorkStatePrimaryItemId } from '@happier-dev/protocol';

import type {
    AgentInputStatusBadgeEmphasis,
    AgentInputStatusBadgeTone,
} from '@/components/sessions/agentInput/agentInputContracts';
import {
    hasLiveAgentActivity,
    type AgentActivityCounts,
} from '@/sync/domains/session/agentActivity/deriveAgentActivityCounts';
import { t } from '@/text';

import {
    formatSessionWorkStateBadgeLabel,
    resolveSessionWorkStateBadgeEmphasis,
    resolveSessionWorkStateBadgeTone,
    SESSION_WORK_STATE_STATUS_BADGE_KEY,
} from './sessionWorkStatePresentation';
import type { SessionWorkStateItem, SessionWorkStateSnapshot } from './sessionWorkStateTypes';

/**
 * The ONE compact chip above the AgentInput, and the only seam allowed to build it (§4.6, r4.1).
 *
 * It composes two things and nothing else: the normalized work-state primary item (goal/task/todo)
 * and the **one unified agent-activity tally**. Both are small, memoizable inputs — callers pass
 * snapshots and counts, never a `Session`.
 *
 * **Why the counts and not the workflow headline.** This chip used to read
 * `sessionWorkflowActivityHeadlineV1` and sum `run.totalAgents`, while a *second* chip an inch away
 * counted live entries from `sync/domains/session/agentActivity`. Two models, one population, two
 * numbers that could each be individually correct and still disagree. Composing from the unified
 * counts dissolves that at the source: a workflow's agents and a session's subagents are the same
 * live units, counted once, by the same owner the roster and the Agents tab badge read.
 *
 * **It reports a WORK STATE, never an attention claim.** It answers *what is this session working
 * on*. It does not answer *do you need to act* — the pending-request card below the composer and
 * the session's own status own that channel in full, and this chip makes no permission claim at
 * all. (A dormant `permission` branch survived r4.0 here with no production caller and, after
 * §3.4 removed its string, no copy either; it was deleted at r4.2 under the deletion test.)
 *
 * **Zero moving pixels above the keyboard.** Liveness is a changing tabular integer: a label
 * reading `3` and then `4` is unambiguously alive without animating anything.
 *
 * Goal/task/todo priority is delegated to the protocol resolver
 * `resolveSessionWorkStatePrimaryItemId`, so this module never reimplements the work-state priority
 * list, and it never parses provider-native events.
 */

/**
 * `planItem` rather than `task`, deliberately.
 *
 * Three different things were called "task" inside one composer row: a work-state plan line, a
 * background shell command, and this icon. The chip and the popover beneath it now render all
 * three, so the word had to stop being ambiguous before they shared a surface.
 */
export type SessionActivityBadgeIconKind = 'goal' | 'planItem' | 'agent';

export type SessionActivityStatusBadgePresentation = Readonly<{
    key: string;
    label: string;
    /**
     * What a screen reader announces for the chip.
     *
     * It is the same sentence as `label`, and that is the point: `AgentInputStatusBadge` resolves
     * its accessible name as `accessibilityLabel ?? label`, so anything else passed here *replaces*
     * the visible state instead of adding to it. This chip is the only composer carrier of live
     * agent activity, so the state has to reach a screen reader through the word (R-12). Naming the
     * surface here — as the caller did until r4.2 — announced "Session work state" and never
     * "5 agents working". The field exists so that decision has an owner and a test rather than
     * living in one line of a 4000-line host.
     */
    accessibilityLabel: string;
    tone: AgentInputStatusBadgeTone;
    emphasis: AgentInputStatusBadgeEmphasis;
    iconKind: SessionActivityBadgeIconKind;
    popoverKind: 'workState';
}>;

/**
 * Whether the open work-state popover survives this render — FIX-F1.
 *
 * It takes the COUNTS, not a boolean, and asks `hasLiveAgentActivity` itself. That is the fix: the
 * host used to answer "is there live work" on its own, with `counts.live > 0`, while the chip an
 * inch above answered it by whether it had a label. On a run whose named members have all gone
 * terminal those two disagree, and the effect closed the popover out from under the reader while
 * the chip it belongs to stayed on screen. Handing this seam the raw tally leaves no room for a
 * second derivation to reappear at a call site.
 */
export function shouldRetainSessionActivityStatusBadge(input: Readonly<{
    activeStatusBadgeKey: string | null;
    hasPrimaryWorkStateItem: boolean;
    canShowEmptyGoalControls: boolean;
    /** The ONE agent-activity tally — the same object the chip's label is composed from. */
    agentActivityCounts: AgentActivityCounts;
}>): boolean {
    if (input.activeStatusBadgeKey !== SESSION_WORK_STATE_STATUS_BADGE_KEY) return false;
    return input.hasPrimaryWorkStateItem
        || input.canShowEmptyGoalControls
        || hasLiveAgentActivity(input.agentActivityCounts);
}

/**
 * The label vocabulary for live work — RULING-10.
 *
 * **The run is the stable unit.** An earlier cut collapsed every kind into one noun ("N agents
 * working") because the vocabulary flipped mid-run: a run with no derivable members read as a
 * workflow, and the instant its first agent appeared it read as N subagents. But look at what the
 * noun was keyed on — whether members happened to be locally DERIVABLE, which is a property of the
 * reader and not of the work. Collapsing hid the flip by saying less, and less was wrong: a
 * five-agent workflow was announced as "1 agent working".
 *
 * Keyed on the producer's description of the run instead, the flip is structurally impossible and
 * the copy is honest at the same time. A workflow reads as a workflow with its agent complement
 * ("1 workflow, 5 agents") whether or not this client has derived a single member; plain subagents
 * read as subagents; a headless command is never called an agent at all — counting a shell loop as
 * a colleague would let the composer say "3 agents working" about two agents and a `while` loop.
 * Mixed sets compose, so no reader is ever asked to add two of these together.
 */
export type SessionActivityComposerTranslate = Readonly<{
    /** A run and the agent complement its producer states, e.g. `1 workflow, 5 agents`. */
    workflowsWithAgents: (params: { workflows: number; agents: number }) => string;
    /** A run whose producer states no agents. Never "1 agent": nobody said there was one. */
    workflowsRunning: (params: { count: number }) => string;
    subagentsWorking: (params: { count: number }) => string;
    backgroundTasksRunning: (params: { count: number }) => string;
    /** Join two compact segments, e.g. `3 subagents working · Goal: Ship goals`. */
    join: (params: { left: string; right: string }) => string;
}>;

/**
 * The i18n keys behind that vocabulary, resolved once for every surface that speaks it.
 *
 * Two surfaces say this sentence — the composer chip and the session-list row — and they must say
 * the same one. Binding the keys here rather than at each host is what makes that structural: a
 * host cannot reach a different key, and a row cannot drift back to a different noun.
 */
export function resolveSessionActivityComposerTranslate(): SessionActivityComposerTranslate {
    return {
        workflowsWithAgents: (params) => t('session.agentActivity.composer.workflowsWithAgents', params),
        workflowsRunning: (params) => t('session.agentActivity.composer.workflowsRunning', params),
        subagentsWorking: (params) => t('session.agentActivity.composer.subagentsWorking', params),
        backgroundTasksRunning: (params) => t('session.agentActivity.composer.backgroundTasksRunning', params),
        join: (params) => t('session.workState.workflow.join', params),
    };
}

export type ResolveSessionActivityPresentationInput = Readonly<{
    workStateSnapshot: SessionWorkStateSnapshot | null;
    /** The ONE agent-activity tally — see `deriveAgentActivityCounts`. */
    agentActivityCounts: AgentActivityCounts;
    /** Mirrors the legacy "show empty goal chip when active" affordance (QA-CHIP-1). */
    activeStatusBadgeKey?: string | null;
    editableGoal: boolean;
    /** Work-state badge label/tone formatter (reuses `sessionWorkStatePresentation`). */
    translateWorkState: Parameters<typeof formatSessionWorkStateBadgeLabel>[1];
    /** Live-activity label formatter (i18n strings). */
    translateActivity: SessionActivityComposerTranslate;
}>;

function badgeToneToInputTone(tone: ReturnType<typeof resolveSessionWorkStateBadgeTone>): AgentInputStatusBadgeTone {
    return tone;
}

/** Resolve the normalized work-state primary item via the protocol resolver (no UI reimplementation). */
function resolvePrimaryWorkStateItem(snapshot: SessionWorkStateSnapshot | null): SessionWorkStateItem | null {
    if (!snapshot || snapshot.items.length === 0) return null;
    const primaryId = resolveSessionWorkStatePrimaryItemId(
        snapshot.items,
        typeof snapshot.primaryItemId === 'string' ? snapshot.primaryItemId : null,
    );
    if (!primaryId) return null;
    return snapshot.items.find((item) => item.id === primaryId) ?? null;
}

/**
 * Name the live work, or `null` when there is nothing honest to say about it.
 *
 * One segment per population the model can actually distinguish, joined in place of a single
 * arithmetic total. Runs lead because the chip is one truncating line and a run is the largest,
 * most stable thing on it; the segments a truncation cuts are the smaller populations, never the
 * headline fact that a workflow is running.
 *
 * A run's agents are attributed to it upstream (`deriveAgentActivityCounts`), so `liveSubagents` is
 * only ever the agents no run speaks for. That is what makes the composition safe: no population
 * appears in two segments, and the reader is never handed two numbers about the same agents.
 *
 * The `null` is `hasLiveAgentActivity` and nothing else (FIX-F1). Stating it up front rather than
 * letting it fall out of an empty segment list is what makes "the chip has something to say" and
 * "there is live work" one answer instead of two implementations that happen to agree today: the
 * retention gate reads the same predicate, so the popover can no longer close under a chip that is
 * still rendering.
 */
export function formatSessionAgentActivityLabel(
    counts: AgentActivityCounts,
    t: SessionActivityComposerTranslate,
): string | null {
    if (!hasLiveAgentActivity(counts)) return null;
    const segments: string[] = [];
    if (counts.liveWorkflowRuns > 0) {
        segments.push(counts.liveWorkflowAgents > 0
            ? t.workflowsWithAgents({ workflows: counts.liveWorkflowRuns, agents: counts.liveWorkflowAgents })
            : t.workflowsRunning({ count: counts.liveWorkflowRuns }));
    }
    if (counts.liveSubagents > 0) segments.push(t.subagentsWorking({ count: counts.liveSubagents }));
    if (counts.liveBackgroundTasks > 0) segments.push(t.backgroundTasksRunning({ count: counts.liveBackgroundTasks }));
    // At least one segment exists: the guard above reads exactly the three fields these branches do.
    return segments.reduce((left, right) => t.join({ left, right }));
}

/**
 * Resolve the single compact activity chip. Decision order:
 *   1. live agent work, with an active goal named behind it when there is one.
 *   2. canonical work-state primary item (active task/todo/goal, blocked, paused, pending).
 *   3. the empty "Set goal" affordance.
 *
 * Anything else returns `null`: no placeholder and no reserved space, because an empty slot above
 * the keyboard is a promise that something will appear there. In particular a failure produces no
 * chip at all — it is carried, in full, by its roster row.
 */
export function resolveSessionActivityStatusBadgePresentation(
    input: ResolveSessionActivityPresentationInput,
): SessionActivityStatusBadgePresentation | null {
    const counts = input.agentActivityCounts;
    // The gate is the sentence itself: the chip appears exactly when there is live work it can name.
    // A separate `live > 0` test would be a second decision about the same question, and the two
    // would eventually disagree about a run whose named agents have all finished while it runs on.
    const activityLabel = formatSessionAgentActivityLabel(counts, input.translateActivity);
    const primaryItem = resolvePrimaryWorkStateItem(input.workStateSnapshot);
    const activeGoal = input.workStateSnapshot?.items.find((item) => item.kind === 'goal' && item.status === 'active') ?? null;

    if (activityLabel !== null) {
        // The live count LEADS and the goal trails — reversed at r4.2, and the order is the fix.
        // The chip is one truncating line at 70% of the composer width, so whatever leads survives
        // and whatever trails is cut. A fixed "Goal active" led safely but cost the user the goal's
        // NAME for the entire time anything ran; the name itself cannot lead, because a long
        // objective would push the count — the one datum that changes, and the only thing carrying
        // liveness in a zero-motion row — off the end of the line. Trailing, the goal keeps its name
        // in exactly the wording the idle chip uses, so going live reads as the same sentence
        // growing rather than as a different chip.
        const goalLabel = activeGoal
            ? formatSessionWorkStateBadgeLabel(activeGoal, input.translateWorkState)
            : null;
        const label = goalLabel
            ? input.translateActivity.join({ left: activityLabel, right: goalLabel })
            : activityLabel;
        return {
            key: SESSION_WORK_STATE_STATUS_BADGE_KEY,
            label,
            accessibilityLabel: label,
            // Plain chrome, always. Work in flight is information, not a request; the moment it
            // fills, fill stops meaning anything.
            tone: 'active',
            emphasis: 'quiet',
            // One glyph for every shape of live agent work. A per-kind glyph only ever rendered in
            // the window before a run's first agent appeared, so its whole observable effect was to
            // swap the icon mid-run — and an icon that changes reads as a different chip arriving,
            // where a changing number reads as the same chip updating.
            iconKind: 'agent',
            popoverKind: 'workState',
        };
    }

    // 2. Canonical work-state primary item (active goal alone, tasks, todos, blocked, etc).
    if (primaryItem) {
        const label = formatSessionWorkStateBadgeLabel(primaryItem, input.translateWorkState);
        if (label) {
            return {
                key: SESSION_WORK_STATE_STATUS_BADGE_KEY,
                label,
                accessibilityLabel: label,
                tone: badgeToneToInputTone(resolveSessionWorkStateBadgeTone(primaryItem)),
                emphasis: resolveSessionWorkStateBadgeEmphasis(primaryItem),
                iconKind: primaryItem.kind === 'goal' ? 'goal' : 'planItem',
                popoverKind: 'workState',
            };
        }
    }

    // 3. Empty active goal chip affordance (QA-CHIP-1): show "Set goal" when goal editing is available.
    if (input.editableGoal && input.activeStatusBadgeKey === SESSION_WORK_STATE_STATUS_BADGE_KEY) {
        const label = input.translateWorkState('session.workState.goal.title');
        return {
            key: SESSION_WORK_STATE_STATUS_BADGE_KEY,
            label,
            accessibilityLabel: label,
            tone: 'neutral',
            emphasis: 'quiet',
            iconKind: 'goal',
            popoverKind: 'workState',
        };
    }

    return null;
}
