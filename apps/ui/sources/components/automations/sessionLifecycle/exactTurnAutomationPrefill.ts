import type { Session } from '@/sync/domains/state/storageTypes';
import {
    AutomationSessionLifecycleEventsSchema,
    type AutomationSessionLifecycleEvent,
} from '@happier-dev/protocol/automations/automationSessionLifecycle';

export type ExactTurnAutomationPrefill = Readonly<{
    sourceSessionId: string;
    sourceTurnId: string;
    sourceServerId: string;
    events: readonly AutomationSessionLifecycleEvent[];
}>;

function nonEmpty(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

/** Exact observed parent-turn identity; this never infers or retargets. */
export function readExactActiveParentTurn(
    session: Pick<Session, 'id' | 'serverId' | 'latestTurnId' | 'latestTurnStatus'> | null | undefined,
): ExactTurnAutomationPrefill | null {
    if (!session || session.latestTurnStatus !== 'in_progress') return null;
    const sourceSessionId = nonEmpty(session.id);
    const sourceTurnId = nonEmpty(session.latestTurnId);
    const sourceServerId = nonEmpty(session.serverId);
    return sourceSessionId && sourceTurnId && sourceServerId
        ? Object.freeze({
            sourceSessionId,
            sourceTurnId,
            sourceServerId,
            events: Object.freeze(['parentTurnCompleted'] as const),
        })
        : null;
}

/**
 * Tri-state route outcome. `absent` means the route carries no exact-turn
 * intent at all (a plain composer/edit is correct). `invalid` means the route
 * carries a partial or empty exact-turn intent: the user asked for
 * "when this turn finishes" but the identity is incomplete, so the surface
 * must say so explicitly instead of silently composing without the trigger.
 */
export type ExactTurnAutomationPrefillRoute = Readonly<
    | { kind: 'absent' }
    | { kind: 'invalid' }
    | { kind: 'valid'; prefill: ExactTurnAutomationPrefill }
>;

export function parseExactTurnAutomationPrefillRoute(input: Readonly<{
    sourceSessionId?: unknown;
    sourceTurnId?: unknown;
    sourceServerId?: unknown;
    sessionLifecycleEvents?: unknown;
}>): ExactTurnAutomationPrefillRoute {
    const expressesExactTurnIntent = [
        'sourceSessionId',
        'sourceTurnId',
        'sourceServerId',
        'sessionLifecycleEvents',
    ]
        .some((key) => Object.prototype.hasOwnProperty.call(input, key));
    if (!expressesExactTurnIntent) return { kind: 'absent' };
    const sourceSessionId = nonEmpty(input.sourceSessionId);
    const sourceTurnId = nonEmpty(input.sourceTurnId);
    const sourceServerId = nonEmpty(input.sourceServerId);
    if (!sourceSessionId || !sourceTurnId || !sourceServerId) return { kind: 'invalid' };
    const eventsInput = Object.prototype.hasOwnProperty.call(input, 'sessionLifecycleEvents')
        ? nonEmpty(input.sessionLifecycleEvents)?.split(',')
        : ['parentTurnCompleted'];
    const events = AutomationSessionLifecycleEventsSchema.safeParse(eventsInput);
    if (!events.success) return { kind: 'invalid' };
    return {
        kind: 'valid',
        prefill: Object.freeze({
            sourceSessionId,
            sourceTurnId,
            sourceServerId,
            events: Object.freeze(events.data),
        }),
    };
}

/**
 * Explicit adoption of a newer observed parent turn.
 *
 * `readExactActiveParentTurn` reports the observation default for `events`
 * because an observation cannot know what the author picked. Adoption retargets
 * the turn identity only: the event selection belongs to the author and
 * survives, so this is the one place both adopting surfaces compose the result.
 */
export function adoptExactTurnAutomationPrefill(
    previous: ExactTurnAutomationPrefill,
    current: ExactTurnAutomationPrefill,
): ExactTurnAutomationPrefill {
    return Object.freeze({ ...current, events: previous.events });
}

export function areExactTurnAutomationPrefillsEqual(
    left: ExactTurnAutomationPrefill | null | undefined,
    right: ExactTurnAutomationPrefill | null | undefined,
): boolean {
    return left?.sourceSessionId === right?.sourceSessionId
        && left?.sourceTurnId === right?.sourceTurnId
        && left?.sourceServerId === right?.sourceServerId;
}

export function buildExactTurnAutomationRouteParams(prefill: ExactTurnAutomationPrefill) {
    return {
        sourceSessionId: prefill.sourceSessionId,
        sourceTurnId: prefill.sourceTurnId,
        sourceServerId: prefill.sourceServerId,
        sessionLifecycleEvents: prefill.events.join(','),
    } as const;
}
