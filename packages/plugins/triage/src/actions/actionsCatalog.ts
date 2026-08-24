import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';

import { mintTriageOpaqueIdV1 } from '../opaqueId.js';
import {
    mutateTriageAction,
    readTriageActions,
    type TriageActionCommandV1,
    type TriageActionV1,
    type TriageActionsDepsV1,
} from '../settings/actions.js';
import type {
    TriageAdministerActionInputV1,
    TriageAdministerActionResultV1,
    TriageReadActionsInputV1,
    TriageReadActionsResultV1,
} from './actionsCatalogProtocol.js';

/**
 * The two action-catalog Actions: the Settings editor's only path to the one
 * `triage.actions` CAS owner.
 *
 * Neither is a second authority. `settings/actions.ts` still mints the action
 * id, validates every bound and closed vocabulary before the write, decides the
 * conflict verdict, refuses a reorder that is not an exact permutation, and
 * declines to overwrite a stored value it cannot read. This module transports
 * the editor's intent to it and projects its answer back.
 */

export type TriageActionsCatalogDepsV1 = Readonly<{
    settings: TriageActionsDepsV1['settings'];
    mintActionId: () => string;
    signal?: AbortSignal;
}>;

function projectActions(
    actions: readonly TriageActionV1[],
): TriageReadActionsResultV1['actions'] {
    return actions.map((action) => ({
        actionId: action.actionId,
        label: action.label,
        enabled: action.enabled,
        appliesTo: [...action.appliesTo],
        profileId: action.profileId,
        workspaceMode: action.workspaceMode,
        target: action.target.kind === 'reviewStart'
            ? { kind: 'reviewStart' as const, promptInvocationId: action.target.promptInvocationId }
            : {
                kind: 'agent' as const,
                promptInvocationId: action.target.promptInvocationId,
                delivery: action.target.delivery,
            },
    }));
}

export async function readTriageActionsForSurface(
    _input: TriageReadActionsInputV1,
    deps: Pick<TriageActionsCatalogDepsV1, 'settings' | 'signal'>,
): Promise<TriageReadActionsResultV1> {
    const read = await readTriageActions({
        settings: deps.settings,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    return {
        v: 1,
        // `unreadable` is reported as `unavailable` rather than collapsed into
        // `absent`: the editor must be able to say the catalog belongs to a
        // newer writer instead of offering the seed as a replacement for it.
        availability: read.kind === 'unreadable' ? 'unavailable' : read.kind,
        actions: projectActions(read.value.actions),
        // Carried to the caller unread. It is what makes the NEXT write a
        // statement about the catalogue this reader is looking at, rather than
        // about whatever the record held a moment before that write.
        revision: read.revision,
    };
}

function commandFrom(input: TriageAdministerActionInputV1): TriageActionCommandV1 {
    const expectedRevision = input.expectedRevision;
    if (input.kind === 'delete') {
        return { kind: 'delete', actionId: input.actionId, expectedRevision };
    }
    if (input.kind === 'reorder') {
        return { kind: 'reorder', actionIds: [...input.actionIds], expectedRevision };
    }
    const draft = {
        label: input.label,
        enabled: input.enabled,
        appliesTo: [...input.appliesTo],
        profileId: input.profileId,
        workspaceMode: input.workspaceMode,
        target: input.target.kind === 'reviewStart'
            ? { kind: 'reviewStart' as const, promptInvocationId: input.target.promptInvocationId }
            : {
                kind: 'agent' as const,
                promptInvocationId: input.target.promptInvocationId,
                delivery: input.target.delivery,
            },
    };
    return input.kind === 'create'
        ? { kind: 'create', expectedRevision, ...draft }
        : { kind: 'update', actionId: input.actionId, expectedRevision, ...draft };
}

export async function administerTriageAction(
    input: TriageAdministerActionInputV1,
    deps: TriageActionsCatalogDepsV1,
): Promise<TriageAdministerActionResultV1> {
    const result = await mutateTriageAction({
        settings: deps.settings,
        mintActionId: deps.mintActionId,
        ...(deps.signal ? { signal: deps.signal } : {}),
    }, commandFrom(input));

    if (result.status !== 'applied') {
        return result.status === 'rejected'
            ? { v: 1, status: 'rejected', reason: result.reason }
            : { v: 1, status: result.status };
    }
    return {
        v: 1,
        status: 'applied',
        actions: projectActions(result.value.actions),
        revision: result.revision,
    };
}

export function createTriageReadActionsActionHandler(): ActionHandler<
    TriageReadActionsInputV1,
    TriageReadActionsResultV1
> {
    return async (input, context: PluginInvocationContext) => await readTriageActionsForSurface(input, {
        settings: context.services.settings.forScope({ kind: 'account' }),
        signal: context.signal,
    });
}

export function createTriageAdministerActionActionHandler(): ActionHandler<
    TriageAdministerActionInputV1,
    TriageAdministerActionResultV1
> {
    return async (input, context: PluginInvocationContext) => await administerTriageAction(input, {
        settings: context.services.settings.forScope({ kind: 'account' }),
        // Minted at the writer, never by a caller: a client-chosen id would let
        // two devices claim one action.
        mintActionId: () => mintTriageOpaqueIdV1(),
        signal: context.signal,
    });
}
