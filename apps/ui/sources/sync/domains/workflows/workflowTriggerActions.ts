import type { z } from 'zod';
import { SessionTriggerAddRequestV1Schema, SessionTriggerListRequestV1Schema, SessionTriggerListResultV1Schema, SessionTriggerRemoveRequestV1Schema, SessionTriggerUpdateRequestV1Schema, WorkflowTriggerAddRequestV1Schema, WorkflowTriggerListRequestV1Schema, WorkflowTriggerListResultV1Schema, WorkflowTriggerRemoveRequestV1Schema, WorkflowTriggerUpdateRequestV1Schema, WorkflowTriggerWriteResultV1Schema, type WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

import { callWorkflowAction, type WorkflowActionExecute } from './callWorkflowAction';
import { getStorage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeCurrentness, captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { WorkflowActionError } from './workflowActionError';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

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
    context?: Omit<ActionExecutorContext, 'surface' | 'signal'>;
}>;

async function callTriggerAction<TResult>(
    actionId: ActionId,
    input: unknown,
    parseResult: (value: unknown) => TResult,
    options: CallOptions,
): Promise<TResult> {
    const scope = options.accountLifetime === undefined ? captureActiveServerAccountScopeCurrentness() : options.accountLifetime;
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
    options.signal?.throwIfAborted();
    // The incumbent Automation store is focused-Account content. An addressed read returns
    // the same FIN observation to its mounted consumer without publishing into another Home.
    if (options.accountLifetime) {
        const active = getActiveServerAccountScope();
        if (!active || active.accountId !== options.accountLifetime.scope.accountId
            || !areServerProfileIdentifiersEquivalent(active.serverId, options.accountLifetime.scope.serverId)) return result;
    }
    const request = typeof input === 'object' && input !== null ? input : {};
    // A deliberate retained-template review is a private draft, not an Account list observation.
    if (actionId === 'workflow.trigger.list' && 'review' in request && request.review === true) return result;
    const sessionId = 'sessionId' in request && typeof request.sessionId === 'string' ? request.sessionId : null;
    const workflow = 'workflow' in request && typeof request.workflow === 'string' ? request.workflow : null;
    const queryKey = sessionId ? `session:${sessionId}` : workflow ? `workflow:${workflow}`
        : 'scope' in request && request.scope === 'account_all' ? 'account_all' : 'account_inline';
    if (actionId.endsWith('.list')) {
        const page = WorkflowTriggerListResultV1Schema.shape.sets.parse(
            typeof result === 'object' && result !== null && 'sets' in result ? result.sets : undefined,
        );
        getStorage().getState().applyWorkflowTriggerSetPage({ queryKey, sets: page });
    } else {
        const written = WorkflowTriggerWriteResultV1Schema.parse(result).set;
        // A missing-source result has no readable target. Keep its known
        // memberships rather than guessing that it belongs to Account inline.
        const writtenQueryKey = sessionId || workflow ? queryKey
            : written.target?.kind === 'workflow' ? `workflow:${written.target.ref}`
                : written.target?.kind === 'inline' ? 'account_inline' : undefined;
        getStorage().getState().upsertWorkflowTriggerSet({
            set: written,
            ...(writtenQueryKey === undefined ? {} : { queryKey: writtenQueryKey }),
        });
    }
    return result;
}

/** A workflow's trigger sets (one per Account and workflow, U1), or the Account's inline triggers. */
const pendingTriggerLists = new WeakMap<object, Map<string, Promise<readonly WorkflowTriggerSetV1[]>>>();

export async function listWorkflowTriggerSets(
    request: z.input<typeof WorkflowTriggerListRequestV1Schema>,
    options: CallOptions = {},
): Promise<readonly WorkflowTriggerSetV1[]> {
    const parsed = WorkflowTriggerListRequestV1Schema.parse(request);
    const lifetime = options.accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : options.accountLifetime;
    // The rail and sidebar share the Account read; a consumer's cancellation
    // must not cancel the other surface. This stores only pending work, not data.
    options.signal?.throwIfAborted();
    const key = JSON.stringify(parsed);
    const shared = lifetime && !options.execute && !options.context;
    let pending = shared ? pendingTriggerLists.get(lifetime) : undefined;
    if (shared && !pending) { pending = new Map(); pendingTriggerLists.set(lifetime, pending); }
    const existing = pending?.get(key);
    const controller = shared && !existing ? new AbortController() : null;
    const retirement = controller && lifetime ? lifetime.onRetire(() => controller.abort()) : null;
    const promise = existing ?? callTriggerAction(
        'workflow.trigger.list',
        parsed,
        (value) => WorkflowTriggerListResultV1Schema.parse(value),
        shared ? { ...(controller ? { signal: controller.signal } : {}),
            ...(options.accountLifetime === undefined ? {} : { accountLifetime: options.accountLifetime }) } : options,
    ).then(result => result.sets);
    if (pending && !existing) {
        pending.set(key, promise);
        void promise.finally(() => {
            retirement?.dispose();
            if (pending?.get(key) === promise) pending.delete(key);
        }).catch(() => undefined);
    }
    const sets = await promise;
    options.signal?.throwIfAborted();
    return sets;
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

export async function updateWorkflowTrigger(request: z.input<typeof WorkflowTriggerUpdateRequestV1Schema>, options: CallOptions = {}): Promise<WorkflowTriggerWriteResult> {
    return callTriggerAction(
        'workflow.trigger.update',
        WorkflowTriggerUpdateRequestV1Schema.parse(request),
        (value) => WorkflowTriggerWriteResultV1Schema.parse(value),
        options,
    );
}

export async function removeWorkflowTrigger(request: z.input<typeof WorkflowTriggerRemoveRequestV1Schema>, options: CallOptions = {}): Promise<WorkflowTriggerWriteResult> {
    return callTriggerAction(
        'workflow.trigger.remove',
        WorkflowTriggerRemoveRequestV1Schema.parse(request),
        (value) => WorkflowTriggerWriteResultV1Schema.parse(value),
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
