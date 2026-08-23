import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { unlinkEntryFromSession } from '../sessions/entrySessionLinks.js';
import type { TriageSessionActionInvokerV1 } from '../sessions/entrySessionOpen.js';
import {
    startEntrySession,
    type TriageEntrySessionDestinationV1,
    type TriageEntrySessionStartResultV1,
} from '../sessions/entrySessionOrchestrator.js';
import type {
    TriageStartEntrySessionInputV1,
    TriageStartEntrySessionResultV1,
    TriageUnlinkEntryFromSessionActionInputV1,
    TriageUnlinkEntryFromSessionActionResultV1,
} from './entrySessionProtocol.js';

/**
 * The registered Session-start and unlink transport.
 *
 * This is not a second orchestrator. `startEntrySession` still owns the
 * workspace-mode gate, the materialization decision, the one creation key it
 * is handed, the create-versus-rejoin consumption, the idempotent link and the
 * canonical open; `unlinkEntryFromSession` still owns the removal. This module
 * carries a mounted surface's settled choice to them and projects their own
 * verdict back — which is what the header press had no way to reach.
 *
 * It writes no Session state, derives no Session id, mints no creation key,
 * seeds no draft and sends no Message. Every phase-local outcome is returned as
 * the owner produced it, so the surface can retry exactly the phase that failed.
 */

export type TriageEntrySessionActionDepsV1 = Readonly<{
    /** The `session-links` Collection. It is the only Collection these Actions touch. */
    collections: Pick<CorpusCollectionsV1, 'sessionLinks'>;
    /** The host invoker for the two generic Session Actions this start consumes. */
    execute: TriageSessionActionInvokerV1;
    nowMs: () => number;
    signal?: AbortSignal;
}>;

/**
 * Carries the caller's settled destination into the orchestrator's own
 * vocabulary.
 *
 * The two materialization arms travel unchanged; nothing here invents a
 * directory, upgrades a reference-only Ask into a project, or reaches for the
 * pull-request preparation the wire deliberately cannot request.
 */
function destinationFrom(
    destination: TriageStartEntrySessionInputV1['destination'],
): TriageEntrySessionDestinationV1 {
    if (destination.kind === 'existing') {
        return { kind: 'existing', sessionId: destination.sessionId };
    }
    return {
        kind: 'new',
        creationKey: destination.creationKey,
        spawn: {
            executionTarget: destination.spawn.executionTarget,
            agentTarget: destination.spawn.agentTarget,
        },
        materialization: destination.materialization,
    };
}

/**
 * Projects the orchestrator's verdict onto the wire.
 *
 * The prepared-workspace facts an arm can also carry are dropped rather than
 * restated: this Action cannot request that materialization, and the directory
 * the reachable arms would report is the one the caller just sent.
 */
function projectStartResult(
    result: TriageEntrySessionStartResultV1,
): TriageStartEntrySessionResultV1 {
    switch (result.type) {
        case 'opened':
        case 'linkPending':
        case 'openPending':
            return {
                v: 1,
                type: result.type,
                sessionId: result.sessionId,
                disposition: result.disposition,
            };
        case 'creationPending':
            return { v: 1, type: 'creationPending', outcome: result.outcome };
        case 'creationFailed':
            return { v: 1, type: 'creationFailed' };
        case 'workspacePreparationFailed':
            return {
                v: 1,
                type: 'workspacePreparationFailed',
                reason: result.reason,
                retryable: result.retryable,
            };
        case 'rejected':
            return { v: 1, type: 'rejected', reason: result.reason };
    }
}

export async function startTriageEntrySession(
    input: TriageStartEntrySessionInputV1,
    deps: TriageEntrySessionActionDepsV1,
): Promise<TriageStartEntrySessionResultV1> {
    const result = await startEntrySession({
        collections: deps.collections,
        execute: deps.execute,
        nowMs: deps.nowMs(),
        ...(deps.signal ? { signal: deps.signal } : {}),
    }, {
        // Passed through exactly as the caller's projection produced it, for the
        // same reason the link Action does: the link's address is derived from
        // this reference, so a reference this module rebuilt could address a
        // second row for one relationship.
        entryRef: input.entryRef,
        display: input.display,
        workspaceMode: input.workspaceMode,
        destination: destinationFrom(input.destination),
    });
    return projectStartResult(result);
}

export async function unlinkTriageEntryFromSession(
    input: TriageUnlinkEntryFromSessionActionInputV1,
    deps: Pick<TriageEntrySessionActionDepsV1, 'collections' | 'signal'>,
): Promise<TriageUnlinkEntryFromSessionActionResultV1> {
    const result = await unlinkEntryFromSession({
        collections: deps.collections,
        entryRef: input.entryRef,
        sessionId: input.sessionId,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    // The writer's own verdict, minus the storage tag: a row id is plaintext
    // server metadata and nothing a surface renders needs one.
    return { v: 1, status: result.status };
}

export function createTriageStartEntrySessionActionHandler(): ActionHandler<
    TriageStartEntrySessionInputV1,
    TriageStartEntrySessionResultV1
> {
    return async (input, context: PluginInvocationContext) => await startTriageEntrySession(input, {
        collections: bindCorpusCollections(requireTriageAccountStorage(context)),
        execute: async (actionId, actionInput, options) => await context.services.actions.execute(
            actionId,
            actionInput,
            options ?? {},
        ),
        nowMs: () => Date.now(),
        ...(context.signal ? { signal: context.signal } : {}),
    });
}

export function createTriageUnlinkEntryFromSessionActionHandler(): ActionHandler<
    TriageUnlinkEntryFromSessionActionInputV1,
    TriageUnlinkEntryFromSessionActionResultV1
> {
    return async (input, context: PluginInvocationContext) => await unlinkTriageEntryFromSession(
        input,
        {
            collections: bindCorpusCollections(requireTriageAccountStorage(context)),
            ...(context.signal ? { signal: context.signal } : {}),
        },
    );
}
