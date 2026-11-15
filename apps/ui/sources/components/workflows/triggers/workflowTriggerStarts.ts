import type { AutomationTriggerId } from '@happier-dev/protocol/automations/automationTriggerIdentity';

import { buildTriggerDefinition, createDefaultWhen, type TriggerWhenValue } from './sessionTriggerForm';
import { editWorkflowTriggerDraft, type WorkflowTriggerDraft } from './workflowTriggerDraft';

/**
 * The "When it runs" card's **Starts** choice (lab round-1115 `trigger-card-*`): one entry per way a
 * workflow starts, each grouping the trigger kinds it is edited with. Pull requests, failed checks and
 * pushes are plugin Events on a repository (the SCM plugins declare them), so "On an event" covers
 * them without a Session.
 */
export const WORKFLOW_TRIGGER_START_KINDS = ['manual', 'schedule', 'pluginEvent', 'sessionEvent'] as const;
export type WorkflowTriggerStartKind = (typeof WORKFLOW_TRIGGER_START_KINDS)[number];
/**
 * What a saved trigger reads as. A run event is created from the run it follows and a Session's
 * pull-request trigger from that Session; the card lists them but does not author them.
 */
export type WorkflowTriggerStart = Exclude<WorkflowTriggerStartKind, 'manual'> | 'runEvent' | 'sessionPullRequest';

/** A session that already exists cannot start again, so "It starts" is not offered for a chosen Session. */
export const WORKFLOW_SESSION_EVENT_KINDS = ['turnEnds', 'needsYou', 'sessionArchived'] as const;

export function readWorkflowTriggerStart(when: TriggerWhenValue): WorkflowTriggerStart {
    switch (when.kind) {
        case 'schedule':
        case 'pluginEvent':
            return when.kind;
        case 'turnEnds':
        case 'needsYou':
        case 'sessionArchived':
        case 'sessionStarts':
            return 'sessionEvent';
        case 'prComment':
        case 'ciFailed':
            return 'sessionPullRequest';
        case 'runLifecycle':
            return 'runEvent';
    }
}

/** The When a newly chosen Starts begins with; a session event keeps a Session already chosen. */
export function createWorkflowTriggerStartWhen(
    start: Exclude<WorkflowTriggerStartKind, 'manual'>,
    previous?: TriggerWhenValue,
): TriggerWhenValue {
    switch (start) {
        case 'schedule':
        case 'pluginEvent':
            return createDefaultWhen(start);
        case 'sessionEvent': {
            const sourceSessionId = previous && 'sourceSessionId' in previous ? previous.sourceSessionId : undefined;
            return sourceSessionId === undefined ? { kind: 'turnEnds' } : { kind: 'turnEnds', sourceSessionId };
        }
    }
}

export type WorkflowTriggerRowRef =
    | Readonly<{ kind: 'saved'; triggerId: AutomationTriggerId }>
    | Readonly<{ kind: 'new'; clientId: string }>;

/**
 * Applies a card edit to the Account set's draft once the When is complete; `null` while it is not
 * (no Session or Event chosen yet). The card keeps an incomplete When on screen; Save writes only
 * complete ones. Kinds the card lists but does not author are never written here.
 */
export function commitWorkflowTriggerWhen(params: Readonly<{
    draft: WorkflowTriggerDraft;
    row: WorkflowTriggerRowRef;
    when: TriggerWhenValue;
    enabled: boolean;
}>): WorkflowTriggerDraft | null {
    const { when, enabled } = params;
    const start = readWorkflowTriggerStart(when);
    if (start === 'runEvent' || start === 'sessionPullRequest') return null;
    const trigger = buildTriggerDefinition({ when, enabled, sessionId: null });
    if (trigger === null) return null;
    if (params.row.kind === 'new') {
        return editWorkflowTriggerDraft(params.draft, { kind: 'add', clientId: params.row.clientId, trigger });
    }
    const { enabled: _enabled, ...definition } = trigger;
    return editWorkflowTriggerDraft(params.draft, { kind: 'update', triggerId: params.row.triggerId, trigger: definition, enabled });
}

export function removeWorkflowTriggerRow(draft: WorkflowTriggerDraft, row: WorkflowTriggerRowRef): WorkflowTriggerDraft {
    return row.kind === 'new'
        ? editWorkflowTriggerDraft(draft, { kind: 'discardAdd', clientId: row.clientId })
        : editWorkflowTriggerDraft(draft, { kind: 'remove', triggerId: row.triggerId });
}
