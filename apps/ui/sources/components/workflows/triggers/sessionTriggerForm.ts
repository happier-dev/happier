import { normalizeWorkflowIngress } from '@happier-dev/protocol/workflows/workflowValidationV1';
import { SessionInitialTriggerDefinitionV1Schema, type WorkflowTriggerSetV1, type SessionInitialTriggerDefinitionV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { AutomationSessionLifecycleEvent } from '@happier-dev/protocol/automations/automationSessionLifecycle';
import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { TriggerTargetV1 } from '@happier-dev/protocol/workflows/triggers/triggerTargetV1';
import type { WorkflowBlock, WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';

import { readSessionLifecycleKind } from './formatTriggerSummary';
import { buildSimpleScheduleCron, parseSimpleSchedule, type SimpleSchedule } from './triggerSchedule';

/**
 * What a session or Account trigger's popover edits (FIN 04 §5.4–§5.5; 07 S16, S16b): **When** and
 * **Then**, written as the Protocol trigger definition and target through the one owner of each
 * (`session.trigger.*` / `workflow.trigger.*`). This module only translates between the two; it
 * decides nothing about admission, which the trigger owner refuses with its typed reason.
 */

/** The session kinds, in 07 S16's order. */
export const SESSION_TRIGGER_WHEN_KINDS = [
    'turnEnds',
    'needsYou',
    'sessionArchived',
    'sessionStarts',
    'schedule',
    'prComment',
    'ciFailed',
] as const;
export type SessionTriggerWhenKind = (typeof SESSION_TRIGGER_WHEN_KINDS)[number];

export type TriggerWhenValue =
    | Readonly<{
        kind: 'turnEnds';
        /** "When this turn finishes…" (04 §5.5): bound to that exact turn, it fires once for it. */
        sourceTurnId?: string;
    }>
    | Readonly<{ kind: 'needsYou' | 'sessionArchived' | 'sessionStarts' }>
    /**
     * A simple schedule, a cron kept as written, or an interval ("Every hour", `everyMs`) kept as it
     * was saved until the person picks a simple schedule instead.
     */
    | Readonly<{ kind: 'schedule'; schedule: SimpleSchedule | null; expression: string; everyMs?: number; timezone: string | null }>
    | Readonly<{ kind: 'prComment' | 'ciFailed'; pullRequest: Readonly<{ repository: string; number: number }> | null }>;

export const TRIGGER_THEN_KINDS = ['sendPrompt', 'doAction', 'notifyMe', 'runWorkflow'] as const;
export type TriggerThenKind = (typeof TRIGGER_THEN_KINDS)[number];

export const NOTIFY_ME_ACTION_ID = 'notifications.notify_me';

/**
 * Where an Account trigger's prompt goes (07 S16b "Runs in", X12): a new session on Runs on's
 * machine and folder, an existing session there, or a background run. A session trigger's prompt
 * always continues its own session.
 */
export type TriggerRunsIn =
    | Readonly<{ kind: 'newSession' }>
    | Readonly<{ kind: 'session'; sessionId: string; machineId: string }>
    | Readonly<{ kind: 'backgroundRun' }>;

export type TriggerThenValue =
    | Readonly<{ kind: 'sendPrompt'; prompt: string; runsIn?: TriggerRunsIn;
        /** The compact form edits text and Runs in, not the retained step's other settings. */
        sourceDefinition?: WorkflowDefinitionV1 }>
    /** One Action step with literal field values, its fields drawn from the Action's own input hints. */
    | Readonly<{ kind: 'doAction'; actionId: string | null; input: Readonly<Record<string, unknown>> }>
    | Readonly<{ kind: 'notifyMe'; message: string; title: string; channels: readonly string[] }>
    | Readonly<{ kind: 'runWorkflow'; ref: string | null; inputs: Readonly<Record<string, JsonValue>> }>
    /** Steps this popover does not author (several steps, an Action step): kept exactly as they are. */
    | Readonly<{ kind: 'kept'; target: TriggerTargetV1; inputs: Readonly<Record<string, JsonValue>> }>;

export type TriggerFormValue = Readonly<{ when: TriggerWhenValue; then: TriggerThenValue; enabled: boolean }>;

const LIFECYCLE_EVENTS: Readonly<Record<'turnEnds' | 'needsYou' | 'sessionArchived' | 'sessionStarts', readonly AutomationSessionLifecycleEvent[]>> = {
    // A turn that completes, fails or is stopped all end it (04 §5.5 kind 1, `parentTurn*`).
    turnEnds: ['parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled'],
    needsYou: ['userActionRequired'],
    sessionArchived: ['sessionArchived'],
    sessionStarts: ['sessionStarted'],
};

/** The device's own zone, which a new schedule is written in (07 S4 "At", its description). */
export function readDeviceTimeZone(): string | null {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
        return null;
    }
}

export function createDefaultWhen(
    kind: SessionTriggerWhenKind | 'schedule',
    pullRequestLinks: readonly Readonly<{ repository: string; number: number }>[] = [],
): TriggerWhenValue {
    if (kind === 'schedule') {
        const schedule: SimpleSchedule = { repeat: 'daily', hour: 9, minute: 0, day: 1 };
        return { kind: 'schedule', schedule, expression: buildSimpleScheduleCron(schedule), timezone: readDeviceTimeZone() };
    }
    if (kind === 'prComment' || kind === 'ciFailed') {
        const link = pullRequestLinks.length === 1 ? pullRequestLinks[0] : undefined;
        return { kind, pullRequest: link ? { repository: link.repository, number: link.number } : null };
    }
    return { kind };
}

export function createDefaultThen(kind: TriggerThenKind): TriggerThenValue {
    switch (kind) {
        case 'sendPrompt':
            return { kind: 'sendPrompt', prompt: '' };
        case 'doAction':
            return { kind: 'doAction', actionId: null, input: {} };
        case 'notifyMe':
            return { kind: 'notifyMe', message: '', title: '', channels: [] };
        case 'runWorkflow':
            return { kind: 'runWorkflow', ref: null, inputs: {} };
    }
}

/** The trigger definition for a When, or null while it is not complete (a schedule without a valid cron). */
export function buildTriggerDefinition(params: Readonly<{
    when: TriggerWhenValue;
    enabled: boolean;
    sessionId: string | null;
}>): AutomationTriggerDefinitionInput | null {
    const { when, enabled } = params;
    if (when.kind === 'schedule') {
        if (when.schedule === null && when.everyMs !== undefined) {
            return { kind: 'schedule', enabled, schedule: { kind: 'interval', scheduleExpr: null, everyMs: when.everyMs, timezone: when.timezone } };
        }
        const expression = when.schedule ? buildSimpleScheduleCron(when.schedule) : when.expression.trim();
        if (expression.length === 0) return null;
        return { kind: 'schedule', enabled, schedule: { kind: 'cron', scheduleExpr: expression, everyMs: null, timezone: when.timezone } };
    }
    if (params.sessionId === null) return null;
    if (when.kind === 'prComment' || when.kind === 'ciFailed') {
        return when.pullRequest === null ? null : { kind: when.kind, enabled, pullRequest: when.pullRequest };
    }
    return {
        kind: 'sessionLifecycle',
        enabled,
        sourceSessionId: params.sessionId,
        events: [...LIFECYCLE_EVENTS[when.kind]],
        policy: when.kind === 'turnEnds' && when.sourceTurnId !== undefined
            ? { kind: 'currentTurn', sourceTurnId: when.sourceTurnId }
            : { kind: 'everyMatch' },
    };
}

/** A creation draft leaves the lifecycle source to the session-birth owner. */
export function buildInitialTriggerDefinition(params: Readonly<{
    when: TriggerWhenValue;
    enabled: boolean;
}>): SessionInitialTriggerDefinitionV1 | null {
    const { when, enabled } = params;
    if (when.kind === 'schedule') {
        const trigger = buildTriggerDefinition({ ...params, sessionId: null });
        return trigger?.kind === 'schedule' ? trigger : null;
    }
    if (when.kind === 'prComment' || when.kind === 'ciFailed') {
        return when.pullRequest === null ? null : { kind: when.kind, enabled, pullRequest: when.pullRequest };
    }
    if (when.kind === 'turnEnds' && when.sourceTurnId !== undefined) return null;
    return SessionInitialTriggerDefinitionV1Schema.parse({
        kind: 'sessionLifecycle', enabled, events: [...LIFECYCLE_EVENTS[when.kind]], policy: { kind: 'everyMatch' },
    });
}

function normalizeInline(ingress: unknown): WorkflowDefinitionV1 | null {
    const outcome = normalizeWorkflowIngress(ingress);
    return outcome.kind === 'parsed' ? outcome.definition : null;
}

/**
 * The target a Then writes, or null while it is incomplete. A session trigger's prompt continues
 * the session it belongs to (`origin_session`, 01 §5.5); an Account trigger's prompt starts a new
 * session (`fresh`, 07 S16b "A new session"). Notify me is one Notify me Action step whose empty
 * **Send to** means your notification settings (03 §3.4).
 */
export function buildTriggerTarget(then: TriggerThenValue, scope: 'session' | 'account' = 'session'): TriggerTargetV1 | null {
    switch (then.kind) {
        case 'kept':
            return then.target;
        case 'runWorkflow':
            return then.ref === null ? null : { kind: 'workflow', ref: then.ref };
        case 'sendPrompt': {
            const prompt = then.prompt.trim();
            if (prompt.length === 0) return null;
            const conversation = scope === 'session'
                ? { kind: 'origin_session' }
                : then.runsIn?.kind === 'session'
                    ? { kind: 'existing_session', sessionId: then.runsIn.sessionId, machineId: then.runsIn.machineId }
                    : { kind: 'fresh' };
            const source = then.sourceDefinition;
            const only = source?.blocks.length === 1 ? source.blocks[0] : undefined;
            const definition = normalizeInline(source && only?.kind === 'step'
                ? { ...source, defaults: { ...source.defaults, conversation }, blocks: [{ ...only,
                    document: { ...only.document, text: prompt },
                    ...(only.execution?.conversation ? { execution: { ...only.execution, conversation } } : {}),
                }] }
                : { version: 1, defaults: { conversation }, blocks: [prompt] });
            return definition === null ? null : { kind: 'inline', definition };
        }
        case 'doAction': {
            if (then.actionId === null) return null;
            const input = Object.fromEntries(Object.entries(then.input)
                .filter(([, value]) => value !== undefined && value !== '')
                .map(([key, value]) => [key, { kind: 'literal', value }]));
            const definition = normalizeInline({ version: 1, blocks: [{ kind: 'action', id: 'action', actionId: then.actionId, input }] });
            return definition === null ? null : { kind: 'inline', definition };
        }
        case 'notifyMe': {
            const message = then.message.trim();
            if (message.length === 0) return null;
            const title = then.title.trim();
            const definition = normalizeInline({
                version: 1,
                blocks: [{
                    kind: 'action',
                    id: 'notify',
                    actionId: NOTIFY_ME_ACTION_ID,
                    input: {
                        message: { kind: 'literal', value: message },
                        ...(title.length === 0 ? {} : { title: { kind: 'literal', value: title } }),
                        ...(then.channels.length === 0 ? {} : { channels: { kind: 'literal', value: [...then.channels] } }),
                    },
                }],
            });
            return definition === null ? null : { kind: 'inline', definition };
        }
    }
}

type ActionBinding = Extract<WorkflowBlock, Readonly<{ kind: 'action' }>>['input'][string] | undefined;

/** The trigger set's execution target a Then implies: a background run for "Runs in · A background run". */
export function buildTriggerExecutionTarget(then: TriggerThenValue): Readonly<{ kind: 'session' | 'detached_run' }> {
    return then.kind === 'sendPrompt' && then.runsIn?.kind === 'backgroundRun' ? { kind: 'detached_run' } : { kind: 'session' };
}

function readLiteralString(binding: ActionBinding): string | null {
    return binding?.kind === 'literal' && typeof binding.value === 'string' ? binding.value : null;
}

function readLiteralStrings(binding: ActionBinding): readonly string[] {
    return binding?.kind === 'literal' && Array.isArray(binding.value)
        ? binding.value.filter((entry): entry is string => typeof entry === 'string')
        : [];
}

/** Reads a target back as the Then it was written with; anything else is kept as it is. */
export function readTriggerThen(
    target: TriggerTargetV1,
    executionTarget?: Readonly<{ kind: string }>,
    inputs: Readonly<Record<string, JsonValue>> = {},
): TriggerThenValue {
    if (target.kind === 'workflow') return { kind: 'runWorkflow', ref: target.ref, inputs };
    // The compact prompt/Action forms cannot reconstruct declared inputs or their bindings.
    if (target.definition.inputs.length > 0) return { kind: 'kept', target, inputs };
    const blocks = target.definition.blocks;
    const only = blocks.length === 1 ? blocks[0] : undefined;
    if (only?.kind === 'step') {
        const conversation = only.execution?.conversation ?? target.definition.defaults.conversation;
        const runsIn: TriggerRunsIn | undefined = executionTarget?.kind === 'detached_run'
            ? { kind: 'backgroundRun' }
            : conversation?.kind === 'existing_session'
                ? { kind: 'session', sessionId: conversation.sessionId, machineId: conversation.machineId }
                : conversation?.kind === 'fresh' ? { kind: 'newSession' } : undefined;
        return { kind: 'sendPrompt', prompt: only.document.text, sourceDefinition: target.definition,
            ...(runsIn === undefined ? {} : { runsIn }) };
    }
    if (only?.kind === 'action' && only.actionId === NOTIFY_ME_ACTION_ID) {
        const message = readLiteralString(only.input['message']);
        if (message !== null) {
            return {
                kind: 'notifyMe',
                message,
                title: readLiteralString(only.input['title']) ?? '',
                channels: readLiteralStrings(only.input['channels']),
            };
        }
    }
    if (only?.kind === 'action') {
        const entries = Object.entries(only.input);
        // Only literal values are this popover's to edit; a step bound to anything else is kept.
        if (entries.every(([, binding]) => binding.kind === 'literal')) {
            return {
                kind: 'doAction',
                actionId: only.actionId,
                input: Object.fromEntries(entries.map(([key, binding]) => [key, binding.kind === 'literal' ? binding.value : undefined])),
            };
        }
    }
    return { kind: 'kept', target, inputs };
}

type SetTrigger = WorkflowTriggerSetV1['triggers'][number];

/** The one reading of a saved schedule as a When: a cron as written, or an interval as its period. */
export function readScheduleWhen(schedule: Readonly<{
    kind: 'cron' | 'interval';
    scheduleExpr: string | null;
    everyMs: number | null;
    timezone: string | null;
}>): Extract<TriggerWhenValue, Readonly<{ kind: 'schedule' }>> {
    if (schedule.kind === 'interval' && schedule.everyMs !== null) {
        return { kind: 'schedule', schedule: null, expression: '', everyMs: schedule.everyMs, timezone: schedule.timezone };
    }
    const expression = schedule.scheduleExpr ?? '';
    return { kind: 'schedule', schedule: parseSimpleSchedule(expression), expression, timezone: schedule.timezone };
}

/** Reads a saved trigger back as the When it was written with. */
export function readTriggerWhen(trigger: SetTrigger | SessionInitialTriggerDefinitionV1): TriggerWhenValue | null {
    if (trigger.kind === 'prComment' || trigger.kind === 'ciFailed') {
        return { kind: trigger.kind, pullRequest: trigger.pullRequest ?? null };
    }
    if (trigger.kind === 'schedule') return readScheduleWhen(trigger.schedule);
    if (trigger.kind === 'sessionLifecycle') {
        const kind = readSessionLifecycleKind(trigger.events);
        // A trigger bound to one turn stays bound when edited.
        return kind === 'turnEnds' && trigger.policy.kind === 'currentTurn'
            ? { kind, sourceTurnId: trigger.policy.sourceTurnId }
            : { kind };
    }
    return null;
}
