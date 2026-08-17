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
 * The two host Actions this lane invokes, typed by the canonical generated
 * Action map. The invoker is the host RPC boundary; the orchestrator's own
 * decisions stay in-process.
 */
export type TriageSessionActionIdV1 = 'session.spawn_new' | 'session.open';

export type TriageSessionActionInvokerV1 = <TActionId extends TriageSessionActionIdV1>(
    actionId: TActionId,
    input: PluginActionInputById[TActionId],
    options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<PluginActionResultById[TActionId]>;

export type TriageOpenLinkedSessionResultV1 =
    | Readonly<{ status: 'opened' }>
    | Readonly<{ status: 'failed' }>;

export async function openLinkedSession(input: Readonly<{
    execute: TriageSessionActionInvokerV1;
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
