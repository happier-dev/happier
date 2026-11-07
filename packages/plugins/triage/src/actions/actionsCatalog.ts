import type { TriageDataActionContext, TriageDataActionHandler } from './dataContext.js';
import { TRIAGE_DEFAULT_FIX_ACTION_ID_V1, TRIAGE_DEFAULT_INVESTIGATE_ACTION_ID_V1, type TriageSessionHandoffChoicesV1 } from '@happier-dev/triage-protocol/v1';

import { mintTriageOpaqueIdV1 } from '../opaqueId.js';
import {
    applyTriageActionLaunchModeV1,
    mutateTriageAction,
    planTriageOfferedActionsV1,
    readTriageActionLaunchModeV1,
    readTriageActionTitleKeyV1,
    readTriageActions,
    TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1,
    type TriageActionCommandV1,
    type TriageActionV1,
    type TriageActionsDepsV1,
} from '../settings/actions.js';
import type {
    TriageAdministerActionInputV1,
    TriageAdministerActionResultV1,
    TriageReadActionsInputV1,
    TriageReadActionsResultV1,
    TriageReadActionsActionInputV1,
    TriageReadActionsActionResultV1,
} from './actionsCatalogProtocol.js';
import { createTriageAccountKvCatalogStore } from '../settings/accountKvCatalogStore.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';

/**
 * The two action-catalog Actions: the mounted editor's daemon path to the one
 * `triage.actions` CAS owner.
 *
 * Neither is a second authority. `settings/actions.ts` still mints the action
 * id, validates every bound and closed vocabulary before the write, decides the
 * conflict verdict, refuses a reorder that is not an exact permutation, and
 * declines to overwrite a stored value it cannot read. This module transports
 * the editor's intent to it and projects its answer back.
 */

export type TriageActionsCatalogDepsV1 = Readonly<{
    catalog: TriageActionsDepsV1['catalog'];
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
            ? {
                kind: 'reviewStart' as const,
                promptInvocationId: action.target.promptInvocationId,
                ...(action.target.promptArgsText === undefined
                    ? {}
                    : { promptArgsText: action.target.promptArgsText }),
                ...(action.target.seededFallbackInstruction === undefined
                    ? {}
                    : { seededFallbackInstruction: action.target.seededFallbackInstruction }),
            }
            : {
                kind: 'agent' as const,
                promptInvocationId: action.target.promptInvocationId,
                ...(action.target.promptArgsText === undefined
                    ? {}
                    : { promptArgsText: action.target.promptArgsText }),
                ...(action.target.seededFallbackInstruction === undefined
                    ? {}
                    : { seededFallbackInstruction: action.target.seededFallbackInstruction }),
                delivery: action.target.delivery,
            },
    }));
}

export async function readTriageActionsForSurface(
    _input: TriageReadActionsInputV1,
    deps: Pick<TriageActionsCatalogDepsV1, 'catalog' | 'signal'>,
): Promise<TriageReadActionsResultV1> {
    const read = await readTriageActions({
        catalog: deps.catalog,
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
    if (input.kind === 'reset') return { kind: 'reset', expectedRevision };
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
            ? {
                kind: 'reviewStart' as const,
                promptInvocationId: input.target.promptInvocationId,
                ...(input.target.promptArgsText === undefined
                    ? {}
                    : { promptArgsText: input.target.promptArgsText }),
            }
            : {
                kind: 'agent' as const,
                promptInvocationId: input.target.promptInvocationId,
                ...(input.target.promptArgsText === undefined
                    ? {}
                    : { promptArgsText: input.target.promptArgsText }),
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
        catalog: deps.catalog,
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

export function createTriageReadActionsActionHandler(): TriageDataActionHandler<
    TriageReadActionsActionInputV1,
    TriageReadActionsActionResultV1
> {
    return async (input, context: TriageDataActionContext) => {
        const deps = {
            catalog: createTriageAccountKvCatalogStore(
                requireTriageAccountStorage(context).kv,
                TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1,
            ),
            signal: context.signal,
        };
        if (!('projection' in input)) return await readTriageActionsForSurface(input, deps);
        const read = await readTriageActions(deps);
        if (read.kind === 'unreadable') return { v: 1, kind: 'unavailable', reason: 'catalogUnavailable' };
        // A handoff without an entry addresses a native record, whose declared source workflow subject is `other`
        // (triage-protocol investigationSubjects.ts). The one planner decides, so a pull-request-only or
        // subject-owned record (a deployment Environment's "Set it up") is never offered on an unrelated failure.
        // A page that names its own native subject also gets that subject's records, marked so it draws them.
        const shared = planTriageOfferedActionsV1(read.value.actions, 'other');
        const own = input.subject === undefined ? [] : planTriageOfferedActionsV1(read.value.actions, input.subject);
        const actions: Extract<TriageSessionHandoffChoicesV1, { kind: 'choices' }>['actions'] = read.value.actions
            .filter(action => action.target.kind === 'agent' && (shared.includes(action) || own.includes(action)))
            .map(action => {
                const titleKey = readTriageActionTitleKeyV1(action);
                return { label: action.label, selection: {
                    configuredActionId: action.actionId,
                    sessionChoice: { kind: 'configured' }, agentChoice: { kind: 'configured' }, delivery: 'configured',
                }, launchMode: readTriageActionLaunchModeV1(action),
                startable: applyTriageActionLaunchModeV1(action, 'start') !== null,
                ...(titleKey === null ? {} : { titleKey }),
                ...(own.includes(action) ? { forSubject: true as const } : {}) };
            });
        const defaultActionId = input.task === 'investigate' ? TRIAGE_DEFAULT_INVESTIGATE_ACTION_ID_V1 : TRIAGE_DEFAULT_FIX_ACTION_ID_V1;
        return { v: 1, kind: 'choices', actions,
            defaultActionId: actions.some(action => action.selection.configuredActionId === defaultActionId) ? defaultActionId : null };
    };
}

export function createTriageAdministerActionActionHandler(): TriageDataActionHandler<
    TriageAdministerActionInputV1,
    TriageAdministerActionResultV1
> {
    return async (input, context: TriageDataActionContext) => await administerTriageAction(input, {
        catalog: createTriageAccountKvCatalogStore(
            requireTriageAccountStorage(context).kv,
            TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1,
        ),
        // Minted at the writer, never by a caller: a client-chosen id would let
        // two devices claim one action.
        mintActionId: () => mintTriageOpaqueIdV1(),
        signal: context.signal,
    });
}
