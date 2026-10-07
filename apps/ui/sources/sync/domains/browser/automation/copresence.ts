import { BrowserActiveTargetV1Schema } from '@happier-dev/protocol/browser/events/activeTarget';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import type { BrowserAutomationControllerStateV1 } from '@happier-dev/protocol/browser/automation/v1';

/**
 * What the agent is doing in the page, as a person would say it. The narration vocabulary is small
 * on purpose: a verb the user recognises ("Typing"), never the automation action id.
 */
export type BrowserAgentActivity =
    | 'click'
    | 'type'
    | 'fill'
    | 'scroll'
    | 'navigate'
    | 'history'
    | 'reload'
    | 'press'
    | 'select'
    | 'drag'
    | 'upload'
    | 'look'
    | 'other';

/**
 * Who is driving a browser view, projected for the presence capsule (lab `browser` A/K/H).
 *
 * - `agent`: the agent is working in this page — an action is in flight, or the agent's turn is still
 *   running and its last hand on the page was the agent's (so the capsule does not blink off between
 *   two consecutive clicks).
 * - `stopping`: the person took control, but the agent's interrupted action has not settled at its
 *   owner yet, so nothing may claim human control.
 * - `human`: the person took control and has not handed it back. `interruptedCompletion` is
 *   `'unknown'` when the takeover interrupted an agent action whose effect the owner could not
 *   confirm (it may have landed; it is never retried). It is a fact to say, never a refusal: Hand back
 *   stays available, and the agent's next mutation needs a fresh observation, which clears it.
 * - `idle`: nobody is driving; the page is simply shown.
 *
 * `controlEpoch` is the controller owner's own takeover counter, carried so a surface can tell that
 * a takeover it asked for has landed. No new state: this reads the controller snapshot the automation
 * owner already publishes.
 */
export type BrowserCopresence =
    | Readonly<{ kind: 'idle'; controlEpoch: number }>
    | Readonly<{
        kind: 'agent';
        activity: BrowserAgentActivity | null;
        /** Where the agent's in-flight action lands on the page (0..1), when its owner reports it. */
        target: BrowserAgentTargetPoint | null;
        controlEpoch: number;
    }>
    | Readonly<{ kind: 'stopping'; controlEpoch: number }>
    /**
     * The person stopped the agent but its owner could not confirm the agent's input was released (an
     * interrupted action whose completion is unknown). Not human control: nothing may claim the person
     * has the surface until a fresh look proves it. Computer use produces it; the browser has no such fact.
     */
    | Readonly<{ kind: 'unconfirmed'; controlEpoch: number }>
    | Readonly<{ kind: 'human'; controlEpoch: number; interruptedCompletion: 'unknown' | null }>;

export type BrowserAgentTargetPoint = Readonly<{ x: number; y: number; width?: number; height?: number; label?: string }>;

function isUnit(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** A page-normalized target from the controller owner's snapshot; anything else is no target. */
function readTarget(value: unknown): BrowserAgentTargetPoint | null {
    if (!value || typeof value !== 'object') return null;
    if (!('x' in value) || !('y' in value) || !isUnit(value.x) || !isUnit(value.y)) return null;
    const label = BrowserActiveTargetV1Schema.shape.label.safeParse('label' in value ? value.label : undefined);
    return {
        x: value.x, y: value.y,
        ...('width' in value && 'height' in value && isUnit(value.width) && isUnit(value.height)
            ? { width: value.width, height: value.height } : {}),
        ...(label.success && label.data ? { label: label.data } : {}),
    };
}

export function classifyBrowserAgentActivity(actionKind: string | null | undefined): BrowserAgentActivity | null {
    switch (actionKind) {
        case undefined:
        case null:
            return null;
        case 'click':
        case 'tap':
        case 'hover':
        case 'focus':
            return 'click';
        case 'type':
            return 'type';
        case 'setValue':
            return 'fill';
        case 'scroll':
            return 'scroll';
        case 'navigate':
            return 'navigate';
        case 'goBack':
        case 'goForward':
            return 'history';
        case 'reload':
            return 'reload';
        case 'press':
            return 'press';
        case 'select':
            return 'select';
        case 'drag':
            return 'drag';
        case 'upload':
            return 'upload';
        case 'snapshot':
        case 'semanticSnapshot':
        case 'queryElements':
        case 'waitFor':
            return 'look';
        default:
            return 'other';
    }
}

type ControllerRecord = Readonly<{
    controller?: unknown;
    controlEpoch?: unknown;
    activeActionKind?: unknown;
    activeTarget?: unknown;
    activeAutomationRequestId?: unknown;
    interruptionSettling?: unknown;
    uncertain?: unknown;
}>;

type TimelineEntry = Readonly<{
    requesterKind: string;
    actionKind: string;
    controlEpochAfter: number;
    status?: string;
    resultSummary?: unknown;
}>;

/**
 * Whether the takeover that opened this control epoch interrupted an agent action whose effect its
 * owner could not confirm. Only the owner's own settled entry decides; a missing fact is not unknown.
 */
function readInterruptedCompletion(timeline: readonly TimelineEntry[] | undefined, controlEpoch: number): 'unknown' | null {
    const last = timeline?.[timeline.length - 1];
    if (!last || last.status !== 'interrupted' || last.requesterKind === 'user' || last.controlEpochAfter !== controlEpoch) return null;
    const summary = last.resultSummary;
    const completion = summary && typeof summary === 'object' ? (summary as Readonly<{ completion?: unknown }>).completion : undefined;
    return completion === 'stopped' ? null : 'unknown';
}

function readControllerRecord(snapshot: unknown, key: string): ControllerRecord | null {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const byKey = (snapshot as Readonly<Record<string, unknown>>).controllerByViewKey;
    if (!byKey || typeof byKey !== 'object' || Array.isArray(byKey)) return null;
    const record = (byKey as Readonly<Record<string, unknown>>)[key];
    return record && typeof record === 'object' && !Array.isArray(record) ? record as ControllerRecord : null;
}

export function selectBrowserCopresence(input: Readonly<{
    /** The automation owner's controller snapshot (`BrowserAutomationControlService.getSnapshot()`). */
    snapshot: unknown;
    /**
     * For a daemon-owned view, the controller the daemon reported (`controllerChanged`, ingested into
     * the view's state). It is that view's owner, so it replaces the in-app snapshot.
     */
    controllerState?: Pick<BrowserAutomationControllerStateV1, 'controller' | 'controlEpoch' | 'activeAutomationRequestId' | 'activeActionKind' | 'activeTarget' | 'interruptionSettling' | 'uncertain'> | null;
    view: Readonly<{ browserSessionId: string; viewId: string }> | null;
    /**
     * Whether the agent's turn is still running (the session's canonical activity). Omitted means the
     * host cannot say, and presence then follows in-flight actions only.
     */
    agentTurnActive?: boolean;
    /** This view's action timeline (oldest first), as the automation owner reports it. */
    timeline?: readonly TimelineEntry[];
}>): BrowserCopresence {
    if (!input.view) return { kind: 'idle', controlEpoch: 0 };
    const record: ControllerRecord | null = input.controllerState
        ? { ...input.controllerState }
        : readControllerRecord(input.snapshot, browserViewKey(input.view));
    const controlEpoch = typeof record?.controlEpoch === 'number' ? record.controlEpoch : 0;
    const controller = record?.controller;
    if (controller === 'human') {
        if (record?.interruptionSettling === true) return { kind: 'stopping', controlEpoch };
        return {
            kind: 'human',
            controlEpoch,
            interruptedCompletion: typeof record?.uncertain === 'boolean'
                ? record.uncertain ? 'unknown' : null
                : readInterruptedCompletion(input.timeline, controlEpoch),
        };
    }
    if (controller === 'agent') {
        const actionKind = typeof record?.activeActionKind === 'string' ? record.activeActionKind : null;
        return {
            kind: 'agent',
            activity: classifyBrowserAgentActivity(actionKind),
            target: readTarget(record?.activeTarget),
            controlEpoch,
        };
    }
    // Between two actions of a running turn the agent still has the page: the last hand on it in
    // this control epoch was the agent's. A takeover or hand-back starts a new epoch, so an older
    // agent action never resurrects the capsule.
    const last = input.timeline?.[input.timeline.length - 1];
    if (input.agentTurnActive === true && last?.requesterKind === 'agent' && last.controlEpochAfter === controlEpoch) {
        return { kind: 'agent', activity: classifyBrowserAgentActivity(last.actionKind), target: null, controlEpoch };
    }
    return { kind: 'idle', controlEpoch };
}
