import type { z } from 'zod/mini';
import { SessionTriggerAddRequestV1Schema, SessionTriggerListRequestV1Schema, SessionTriggerListResultV1Schema, SessionTriggerRemoveRequestV1Schema, SessionTriggerUpdateRequestV1Schema, WorkflowTriggerAddRequestV1Schema, WorkflowTriggerListRequestV1Schema, WorkflowTriggerListResultV1Schema, WorkflowTriggerRemoveRequestV1Schema, WorkflowTriggerRemoveResultV1Schema, WorkflowTriggerUpdateRequestV1Schema, WorkflowTriggerWriteResultV1Schema, type WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { AutomationEventTriggerDefinitionStoredPayloadV1 } from '@happier-dev/protocol/automations/automationEventV1';

import { callWorkflowAction, type WorkflowActionExecute } from './callWorkflowAction';
import { getStorage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeCurrentness, captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { WorkflowActionError } from './workflowActionError';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { workflowTriggerQueryKey } from './workflowTriggerQuery';
import { readManagedMachineTriggerAction } from '@happier-dev/protocol/actions/executor/workflowTriggerActions';

/**
 * The trigger client: `workflow.trigger.list | add | update | remove` (03 §5.3–§5.5) and the
 * session-scoped `session.trigger.list | add | update | remove` (03 §5.4, §5.7), and nothing else. It names the Action, hands the one workflow Action front door a request the canonical
 * Protocol schema accepts, and parses the reply through the canonical result schema. There is no
 * second trigger owner: parsed observations land in the existing Automation store domain.
 *
 * Failures surface as `WorkflowActionError` with the owner's closed code, so a surface branches on
 * a revision conflict or a typed refusal rather than on prose.
 */

export type WorkflowTriggerWriteResult = Readonly<{
    set: WorkflowTriggerSetV1;
    triggerId?: string;
    triggerRevision?: number;
}>;

type CallOptions = Readonly<{
    signal?: AbortSignal;
    /** Routed details consume their addressed credential binding, independent of focused Home. */
    accountLifetime?: ServerAccountScopeLifetime | null;
    execute?: WorkflowActionExecute;
    /** Host-owned target facts, used only when the Action needs native host observations. */
    context?: Omit<ActionExecutorContext, 'signal'>;
    /** The captured list observation still owns publication after awaiting its transport. */
    isTriggerListCurrent?: () => boolean;
}>;

type TriggerListPublication = { current: boolean };
/** Publication fences only; each Action is admitted independently and the HTTP owner shares bytes. */
const triggerListPublications = new Map<ServerAccountScopeLifetime, Map<string, Set<TriggerListPublication>>>();

function sameTriggerAccountScope(left: ServerAccountScope, right: ServerAccountScope) {
    return left.accountId === right.accountId && areServerProfileIdentifiersEquivalent(left.serverId, right.serverId);
}

function invalidateTriggerListPublications(scope: ServerAccountScope, automationId: string, written: WorkflowTriggerSetV1 | null,
    requestedWorkflow: string | null) {
    const queries = new Set(['account_all']);
    if (requestedWorkflow) queries.add(`workflow:${requestedWorkflow}`);
    if (written && !written.scopeSessionId && (written.target || written.observationOnly)) {
        queries.add(written.target?.kind === 'workflow' ? `workflow:${written.target.ref}` : 'account_inline');
    }
    const managed = written?.target && readManagedMachineTriggerAction(written.target);
    if (managed) queries.add(workflowTriggerQueryKey({ managedTarget: managed.input }));
    const state = getStorage().getState();
    if (state.profileScope && sameTriggerAccountScope(state.profileScope, scope)) {
        for (const [query, ids] of Object.entries(state.workflowTriggerSetIdsByQuery)) {
            if (ids.includes(automationId)) queries.add(query);
        }
    }
    for (const [lifetime, publications] of triggerListPublications) {
        if (!sameTriggerAccountScope(lifetime.scope, scope)) continue;
        for (const key of publications.keys()) {
            // A non-focused Home has no store memberships to name the old target
            // after retarget/removal. Fence its pending exact reads too.
            if (!queries.has(key) && !key.startsWith('managed:')) continue;
            for (const publication of publications.get(key) ?? []) publication.current = false;
            publications.delete(key);
        }
        if (publications.size === 0 && triggerListPublications.get(lifetime) === publications) triggerListPublications.delete(lifetime);
    }
}

async function callTriggerAction<TResult>(
    actionId: ActionId,
    input: unknown,
    parseResult: (value: unknown) => TResult,
    options: CallOptions,
): Promise<TResult> {
    const scope = options.accountLifetime === undefined ? captureActiveServerAccountScopeCurrentness() : options.accountLifetime;
    const accountScope = options.accountLifetime === undefined ? getActiveServerAccountScope() : options.accountLifetime?.scope ?? null;
    const result = await callWorkflowAction({
        actionId,
        input,
        parseResult,
        fallbackMessage: 'Workflow trigger request failed',
        ...(options.accountLifetime === undefined ? {} : { accountLifetime: options.accountLifetime }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.execute === undefined ? {} : { execute: options.execute }),
        ...(options.context === undefined ? {} : { context: options.context }),
    });
    if (!scope?.isCurrent()) throw new WorkflowActionError({ message: 'action_account_scope_changed', rawCode: 'action_account_scope_changed' });
    throwIfAborted(options.signal);
    const request = typeof input === 'object' && input !== null ? input : {};
    const workflow = 'workflow' in request && typeof request.workflow === 'string' ? request.workflow : null;
    const written = !actionId.endsWith('.list') && typeof result === 'object' && result !== null && 'set' in result
        ? WorkflowTriggerWriteResultV1Schema.parse(result).set : null;
    const removed = actionId === 'workflow.trigger.remove' && typeof result === 'object' && result !== null && 'deleted' in result
        ? WorkflowTriggerRemoveResultV1Schema.parse(result) : null;
    const mutatedId = written?.automationId ?? (removed && 'deleted' in removed ? removed.automationId : null);
    if (accountScope && mutatedId) {
        // Reads already in flight can predate this successful write, including
        // reads started while it was pending. Keep their shared transport alive,
        // but retire their publication before the canonical receipt is applied.
        invalidateTriggerListPublications(accountScope, mutatedId, written, workflow);
    }
    // The incumbent Automation store is focused-Account content. An addressed read returns
    // the same FIN observation to its mounted consumer without publishing into another Home.
    if (options.accountLifetime) {
        const active = getActiveServerAccountScope();
        if (!active || !sameTriggerAccountScope(active, options.accountLifetime.scope)) return result;
    }
    // A deliberate private review or exact Event read is not an Account list observation.
    if (actionId === 'workflow.trigger.list' && (('review' in request && request.review === true) || 'triggerId' in request)) return result;
    const sessionId = 'sessionId' in request && typeof request.sessionId === 'string' ? request.sessionId : null;
    const queryKey = actionId.endsWith('.list') && actionId === 'workflow.trigger.list'
        ? workflowTriggerQueryKey(WorkflowTriggerListRequestV1Schema.parse(request))
        : sessionId ? `session:${sessionId}` : workflow ? `workflow:${workflow}` : 'account_inline';
    if (actionId.endsWith('.list')) {
        if (options.isTriggerListCurrent?.() === false) return result;
        const page = WorkflowTriggerListResultV1Schema.shape.sets.parse(
            typeof result === 'object' && result !== null && 'sets' in result ? result.sets : undefined,
        );
        getStorage().getState().applyWorkflowTriggerSetPage({ queryKey, sets: page });
    } else if (removed && 'deleted' in removed) {
        getStorage().getState().removeAutomation(removed.automationId, removed.removedRevision);
    } else {
        if (!written) return result;
        // A missing-source result has no readable target. Keep its known
        // memberships rather than guessing that it belongs to Account inline.
        const writtenQueryKey = sessionId || workflow ? queryKey
            : written.target?.kind === 'workflow' ? `workflow:${written.target.ref}`
                : written.target?.kind === 'inline' || written.observationOnly ? 'account_inline' : undefined;
        getStorage().getState().upsertWorkflowTriggerSet({
            set: written,
            ...(writtenQueryKey === undefined ? {} : { queryKey: writtenQueryKey }),
        });
    }
    return result;
}

/** A workflow's trigger sets (one per Account and workflow, U1), or the Account's inline triggers. */
export async function listWorkflowTriggerSets(
    request: z.input<typeof WorkflowTriggerListRequestV1Schema>,
    options: CallOptions = {},
): Promise<readonly WorkflowTriggerSetV1[]> {
    return (await listWorkflowTriggerPage(request, options)).sets;
}

/** Retain the selected owner's attachment page as well as opened trigger sets. */
export async function listWorkflowTriggerPage(
    request: z.input<typeof WorkflowTriggerListRequestV1Schema>,
    options: CallOptions = {},
): Promise<z.output<typeof WorkflowTriggerListResultV1Schema>> {
    const parsed = WorkflowTriggerListRequestV1Schema.parse(request);
    const lifetime = options.accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : options.accountLifetime;
    // A list result may predate a successful local write. Keep that publication
    // fence while every caller enters its own Action admission and cancellation.
    throwIfAborted(options.signal);
    const key = workflowTriggerQueryKey(parsed);
    const publication: TriggerListPublication = { current: true };
    let publications = lifetime ? triggerListPublications.get(lifetime) : undefined;
    if (lifetime && !publications) { publications = new Map(); triggerListPublications.set(lifetime, publications); }
    let readers = publications?.get(key);
    if (publications && !readers) { readers = new Set(); publications.set(key, readers); }
    readers?.add(publication);
    try {
        const result = await callTriggerAction('workflow.trigger.list', parsed,
            value => WorkflowTriggerListResultV1Schema.parse(value), { ...options,
                isTriggerListCurrent: () => publication.current && !options.signal?.aborted
                    && options.isTriggerListCurrent?.() !== false });
        throwIfAborted(options.signal);
        return result;
    } finally {
        readers?.delete(publication);
        if (publications && readers?.size === 0 && publications.get(key) === readers) publications.delete(key);
        if (publications?.size === 0 && lifetime && triggerListPublications.get(lifetime) === publications) triggerListPublications.delete(lifetime);
    }
}

export async function addWorkflowTrigger(request: z.input<typeof WorkflowTriggerAddRequestV1Schema>, options: CallOptions = {}): Promise<WorkflowTriggerWriteResult> {
    return callTriggerAction(
        'workflow.trigger.add',
        WorkflowTriggerAddRequestV1Schema.parse(request),
        (value) => WorkflowTriggerWriteResultV1Schema.parse(value),
        options,
    );
}

/** Open retained Session ciphertext on this device only; never publish its plaintext into list state. */
export async function reviewWorkflowTriggerSet(automationId: string, options: CallOptions = {}): Promise<WorkflowTriggerSetV1> {
    const result = await callTriggerAction(
        'workflow.trigger.list',
        WorkflowTriggerListRequestV1Schema.parse({ automationId, review: true }),
        (value) => WorkflowTriggerListResultV1Schema.parse(value),
        options,
    );
    const set = result.sets.find((candidate) => candidate.automationId === automationId);
    if (!set || result.sets.length !== 1) throw new WorkflowActionError({ message: 'source_unavailable', rawCode: 'source_unavailable' });
    return set;
}

/** Open one retained Event on demand through the same Account Action owner as the editor. */
export async function readWorkflowTriggerEventDefinition(
    request: Readonly<{ automationId: string; triggerId: string }>, options: CallOptions = {},
): Promise<AutomationEventTriggerDefinitionStoredPayloadV1> {
    const result = await callTriggerAction('workflow.trigger.list', WorkflowTriggerListRequestV1Schema.parse(request),
        value => WorkflowTriggerListResultV1Schema.parse(value), options);
    if (!result.triggerDefinition) throw new WorkflowActionError({ message: 'source_unavailable', rawCode: 'source_unavailable' });
    return result.triggerDefinition.definition;
}

export async function updateWorkflowTrigger(request: z.input<typeof WorkflowTriggerUpdateRequestV1Schema>, options: CallOptions = {}): Promise<WorkflowTriggerWriteResult> {
    return callTriggerAction(
        'workflow.trigger.update',
        WorkflowTriggerUpdateRequestV1Schema.parse(request),
        (value) => WorkflowTriggerWriteResultV1Schema.parse(value),
        options,
    );
}

export function removeWorkflowTrigger(
    request: z.input<typeof WorkflowTriggerRemoveRequestV1Schema> & Readonly<{ triggerId: string }>,
    options?: CallOptions,
): Promise<z.output<typeof WorkflowTriggerWriteResultV1Schema>>;
export function removeWorkflowTrigger(
    request: z.input<typeof WorkflowTriggerRemoveRequestV1Schema>,
    options?: CallOptions,
): Promise<z.output<typeof WorkflowTriggerRemoveResultV1Schema>>;
export async function removeWorkflowTrigger(request: z.input<typeof WorkflowTriggerRemoveRequestV1Schema>, options: CallOptions = {}): Promise<z.output<typeof WorkflowTriggerRemoveResultV1Schema>> {
    return callTriggerAction(
        'workflow.trigger.remove',
        WorkflowTriggerRemoveRequestV1Schema.parse(request),
        (value) => WorkflowTriggerRemoveResultV1Schema.parse(value),
        options,
    );
}

/** A session's trigger sets (03 §5.7): the triggers scoped to it, which never enter the Library. */
export async function listSessionTriggerSets(
    request: z.input<typeof SessionTriggerListRequestV1Schema>,
    options: CallOptions = {},
): Promise<readonly WorkflowTriggerSetV1[]> {
    return (await listSessionTriggers(request, options)).sets;
}

/** Preserve the binding-owned PR links alongside the session's trigger sets. */
export async function listSessionTriggers(
    request: z.input<typeof SessionTriggerListRequestV1Schema>,
    options: CallOptions = {},
): Promise<z.output<typeof SessionTriggerListResultV1Schema>> {
    const result = await callTriggerAction(
        'session.trigger.list',
        SessionTriggerListRequestV1Schema.parse(request),
        (value) => SessionTriggerListResultV1Schema.parse(value),
        options,
    );
    return result;
}

export async function addSessionTrigger(request: z.input<typeof SessionTriggerAddRequestV1Schema>, options: CallOptions = {}): Promise<WorkflowTriggerWriteResult> {
    return callTriggerAction(
        'session.trigger.add',
        SessionTriggerAddRequestV1Schema.parse(request),
        (value) => WorkflowTriggerWriteResultV1Schema.parse(value),
        options,
    );
}

export async function updateSessionTrigger(request: z.input<typeof SessionTriggerUpdateRequestV1Schema>, options: CallOptions = {}): Promise<WorkflowTriggerWriteResult> {
    return callTriggerAction(
        'session.trigger.update',
        SessionTriggerUpdateRequestV1Schema.parse(request),
        (value) => WorkflowTriggerWriteResultV1Schema.parse(value),
        options,
    );
}

export async function removeSessionTrigger(request: z.input<typeof SessionTriggerRemoveRequestV1Schema>, options: CallOptions = {}): Promise<WorkflowTriggerWriteResult> {
    return callTriggerAction(
        'session.trigger.remove',
        SessionTriggerRemoveRequestV1Schema.parse(request),
        (value) => WorkflowTriggerWriteResultV1Schema.parse(value),
        options,
    );
}
