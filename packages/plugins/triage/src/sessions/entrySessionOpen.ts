import type { PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import type { SessionId } from '@happier-dev/plugin-sdk/sessions';

/**
 * Opening a linked Session.
 *
 * Triage introduces no Session-open API. It invokes the incumbent
 * plugin-visible `session.open` Action with the exact stable `SessionId` the
 * canonical creator returned, never a title lookup, an active/focused Session,
 * a route or a Message-derived id — a title resolves ambiguously and would open
 * somebody else's Session.
 *
 * The retry is deliberately the narrowest phase in the whole start: an open
 * failure re-invokes only this Action with the same id. It never respawns,
 * rematerializes, relinks, publishes a card or calls Composer.
 */

/**
 * The host Actions this lane invokes, typed by the canonical generated Action
 * map. The invoker is the host RPC boundary; the orchestrator's own decisions
 * stay in-process.
 *
 * `session.message.send` is here because the structured delivery is a phase of
 * the start rather than something a mounted surface does afterwards
 * (`entrySessionDelivery.ts`), and it therefore travels the same one invoker.
 */
export type TriageSessionActionIdV1 =
    | 'session.spawn_new'
    | 'session.open'
    | 'session.message.send';

export type TriageSessionActionInvokerV1 = <TActionId extends TriageSessionActionIdV1>(
    actionId: TActionId,
    input: PluginActionInputById[TActionId],
    options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<PluginActionResultById[TActionId]>;

/** The narrow host boundary needed by a read-only linked-Session opener. */
export type TriageSessionOpenInvokerV1 = (
    actionId: 'session.open',
    input: PluginActionInputById['session.open'],
    options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<unknown>;

export type TriageOpenLinkedSessionResultV1 =
    | Readonly<{ status: 'opened' }>
    | Readonly<{ status: 'failed' }>;

export async function openLinkedSession(input: Readonly<{
    execute: TriageSessionOpenInvokerV1;
    sessionId: SessionId;
    signal?: AbortSignal;
}>): Promise<TriageOpenLinkedSessionResultV1> {
    try {
        await input.execute(
            'session.open',
            { sessionId: input.sessionId },
            input.signal ? { signal: input.signal } : undefined,
        );
    } catch {
        // An already-open Session is satisfied by the generic Action itself, so
        // a rejection here is a real navigation failure and stays retryable.
        return { status: 'failed' };
    }
    return { status: 'opened' };
}
