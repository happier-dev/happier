import { collapseToSingleLine } from '../presentation/collapseToSingleLine';

/**
 * A BOUNDED look at one agent's sidechain: the last few steps, the last useful line, and whether a
 * person is being waited on.
 *
 * **Bounded means bounded.** This is a disclosure inside a popover that opens above a keyboard, not
 * a transcript — the transcript already exists, has an owner, and is one press further on. So the
 * output shape is fixed: at most `AGENT_ACTIVITY_PREVIEW_STEP_LIMIT` steps and one clamped line,
 * whether the sidechain holds four messages or four thousand. A preview whose cost grows with the
 * transcript is a transcript.
 *
 * It reads the messages the reducer already holds for that sidechain (V-1) and parses nothing: no
 * JSONL, no logs, no provider payloads. Everything here is a projection of what
 * `useEnsureSidechainsLoaded` put in the store.
 *
 * Two facts are deliberately NOT derived here, because they already have owners and a second
 * derivation would be a second answer: elapsed time (the row's time slot) and staleness (the shared
 * clock in `useAgentActivityStalenessResolver`). The row above this body is still the row.
 */

export const AGENT_ACTIVITY_PREVIEW_STEP_LIMIT = 3;
/** One line's character budget. Long enough to be a sentence, short enough not to be a paragraph. */
export const AGENT_ACTIVITY_PREVIEW_LINE_MAX_CHARS = 160;

/**
 * What a sidechain message must look like for this projection, and nothing more.
 *
 * Structural, exactly like `deriveSessionSubagentActivityPreview` beside it, because the reducer
 * stores `ReducerMessage` (a flat `{ text, tool }` record) while the transcript renders `Message`
 * (a discriminated union). Both satisfy this shape, so the preview reads the store directly with no
 * conversion pass and no second message model.
 */
export type AgentActivityPreviewMessage = Readonly<{
    id?: string | null;
    text?: string | null;
    tool?: Readonly<{
        name?: string | null;
        description?: string | null;
        state?: string | null;
        permission?: Readonly<{ status?: string | null }> | null;
    }> | null;
}>;

const STEP_STATES: ReadonlySet<string> = new Set(['running', 'completed', 'error', 'unavailable']);

export type AgentActivityPreviewStep = Readonly<{
    id: string;
    name: string;
    /** The tool's own description — a path, a pattern, a command — or `null` when it states none. */
    detail: string | null;
    state: 'running' | 'completed' | 'error' | 'unavailable';
}>;

export type AgentActivityPreviewModel = Readonly<{
    /** Oldest first, newest last, so the eye lands on the newest step where the row's clock is. */
    steps: readonly AgentActivityPreviewStep[];
    /** The newest line worth showing, collapsed and clamped, or `null`. */
    lastLine: string | null;
    /**
     * A permission prompt is outstanding somewhere in this sidechain.
     *
     * A status, not a badge: it is the one state where the agent is not working and nothing will
     * change until a person acts. The row already renders `waiting` for it where the roster knows;
     * an orphan sidechain has no subagent for the roster to know it through, so the preview is the
     * only place it can be stated.
     */
    pendingPermission: boolean;
    /** Nothing to show, as opposed to nothing loaded — the caller distinguishes those. */
    isEmpty: boolean;
}>;

const EMPTY_PREVIEW: AgentActivityPreviewModel = Object.freeze({
    steps: Object.freeze([]) as readonly AgentActivityPreviewStep[],
    lastLine: null,
    pendingPermission: false,
    isEmpty: true,
});

export function deriveAgentActivityPreview(
    messages: readonly AgentActivityPreviewMessage[],
): AgentActivityPreviewModel {
    if (messages.length === 0) return EMPTY_PREVIEW;

    const steps: AgentActivityPreviewStep[] = [];
    let lastLine: string | null = null;
    let pendingPermission = false;

    // Backwards, and stopping as soon as both budgets are met: a sidechain with four thousand
    // messages must cost the same as one with four. Pending permission is the exception — it is a
    // property of the whole sidechain, so it is answered by a separate bounded scan below.
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message) continue;

        const tool = message.tool;
        if (tool) {
            if (steps.length < AGENT_ACTIVITY_PREVIEW_STEP_LIMIT) {
                const name = collapseToSingleLine(tool.name);
                if (name) {
                    steps.push({
                        id: normalizeStepId(message.id, index),
                        name,
                        detail: clampLine(collapseToSingleLine(tool.description)),
                        state: normalizeStepState(tool.state),
                    });
                }
            }
            continue;
        }

        if (lastLine === null) {
            lastLine = clampLine(collapseToSingleLine(message.text));
        }

        if (lastLine !== null && steps.length >= AGENT_ACTIVITY_PREVIEW_STEP_LIMIT) break;
    }

    // The newest prompt is the one a person can act on, so the scan runs from the end and stops at
    // the first one it finds — the same direction and the same bound as everything above.
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.tool?.permission?.status === 'pending') {
            pendingPermission = true;
            break;
        }
    }

    steps.reverse();
    return {
        steps,
        lastLine,
        pendingPermission,
        isEmpty: steps.length === 0 && lastLine === null && !pendingPermission,
    };
}

function normalizeStepId(id: string | null | undefined, index: number): string {
    const normalized = typeof id === 'string' ? id.trim() : '';
    return normalized.length > 0 ? normalized : `step:${index}`;
}

function normalizeStepState(state: string | null | undefined): AgentActivityPreviewStep['state'] {
    return typeof state === 'string' && STEP_STATES.has(state)
        ? (state as AgentActivityPreviewStep['state'])
        : 'completed';
}

function clampLine(value: string | null): string | null {
    if (value === null) return null;
    if (value.length <= AGENT_ACTIVITY_PREVIEW_LINE_MAX_CHARS) return value;
    return `${value.slice(0, AGENT_ACTIVITY_PREVIEW_LINE_MAX_CHARS).trimEnd()}…`;
}
