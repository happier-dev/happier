import { readAutomationEventSubjectKindsV1, type PluginEventAutomationDeclarationV1 } from '@happier-dev/protocol/automations/automationEventDeclarationV1';
import type { AutomationSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import type { WorkflowActionSpec } from '../presentation/workflowActionCatalog';
import type { AutomationTriggerId } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';

import type { IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import { buildTriggerDefinition, createDefaultWhen, isSessionLifecycleWhen, type TriggerWhenValue } from './sessionTriggerForm';
import { TRIGGER_LIFECYCLE_GLYPHS } from './triggerEventGroups';
import { editWorkflowTriggerDraft, type WorkflowTriggerDraft } from './workflowTriggerDraft';

/**
 * What a saved trigger reads as. A run event is created from the run it follows and a Session's
 * pull-request trigger from that Session; the card lists them but does not author them.
 */
export type WorkflowTriggerStart = 'schedule' | 'pluginEvent' | 'sessionEvent' | 'runEvent' | 'sessionPullRequest' | 'action';

/** A session that already exists cannot start again, so "A session starts" is not offered for a chosen Session. */
export const WORKFLOW_SESSION_EVENT_KINDS = ['turnEnds', 'needsYou', 'sessionArchived'] as const;
type SessionEventKind = (typeof WORKFLOW_SESSION_EVENT_KINDS)[number] | 'sessionStarts';

export function readWorkflowTriggerStart(when: TriggerWhenValue): WorkflowTriggerStart {
    switch (when.kind) {
        case 'schedule':
        case 'pluginEvent':
        case 'action':
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

/** A plugin-declared Event on the trigger set's Machine, as the trigger-event catalog presents it. */
export type WorkflowTriggerEventOption = Readonly<{
    eventRef: Readonly<{ pluginId: string; localId: string }>;
    title: string;
    /** The plugin's name: the Event's group in the menu. */
    pluginName: string;
    /** The public Event declaration owns which resource kinds it can observe. */
    automation?: PluginEventAutomationDeclarationV1;
}>;

/** A resource Link chooses an ordinary trigger start; Event setup stays with the Event editor. */
export type ResourceWorkflowTriggerStartOption = Readonly<{
    id: string;
    label: string;
    subject: AutomationSubjectV1;
}> & (Readonly<{ relation: 'before' | 'after'; setupRequired: false;
        when: Extract<TriggerWhenValue, { kind: 'action' }>;
        trigger: Extract<TriggerWhenValue, { kind: 'action' }> & Readonly<{ enabled: boolean }> }>
    | Readonly<{ relation: 'event'; setupRequired: true;
        when: Extract<TriggerWhenValue, { kind: 'pluginEvent' }>;
        trigger: null; eventSeed: PluginUiOpenAutomationEventRequestV1 }>);

export function buildResourceWorkflowTriggerStartOptions(params: Readonly<{
    subject: AutomationSubjectV1;
    actions: readonly WorkflowActionSpec[];
    events: readonly WorkflowTriggerEventOption[];
    machineId: string | null;
}>): readonly ResourceWorkflowTriggerStartOption[] {
    const { subject } = params;
    const options: ResourceWorkflowTriggerStartOption[] = [];
    for (const action of params.actions) {
        if (!action.automation?.subjectKinds?.includes(subject.kind)) continue;
        if (subject.kind === 'plugin') {
            const kind = action.approvalScope;
            if (typeof kind !== 'object' || kind.kind !== 'plugin' || action.plugin?.id !== subject.pluginId
                || kind.subjectKindId !== subject.subjectKindId) continue;
        }
        for (const phase of ACTION_PHASES) {
            if (action.automation[phase] !== true) continue;
            const start = createWorkflowTriggerStartWhen(actionStartId(phase));
            if (start?.kind !== 'action') continue;
            const when = { ...start, actionIds: [action.id], subject };
            options.push({ id: `${actionStartId(phase)}:${action.id}`, label: action.title,
                relation: phase, subject, when, setupRequired: false, trigger: { ...when, enabled: true } });
        }
    }
    for (const event of params.events) {
        if (!readAutomationEventSubjectKindsV1(event.automation).includes(subject.kind)) continue;
        if (subject.kind === 'plugin' && (event.eventRef.pluginId !== subject.pluginId
            || !event.automation?.subjects?.some(kind => kind.subjectKindId === subject.subjectKindId))) continue;
        const id = eventId(event.eventRef);
        const when = createWorkflowTriggerStartWhen(id);
        if (when?.kind !== 'pluginEvent') continue;
        options.push({ id, label: event.title, relation: 'event', subject, when, trigger: null, setupRequired: true,
            eventSeed: { eventRef: event.eventRef, setupInput: {},
                ...(params.machineId === null ? {} : { monitoringMachineId: params.machineId }) } });
    }
    return options;
}

/**
 * One way a trigger starts, as every start menu lists it (the When card's **When** select and **Add a
 * trigger**, the sentence's trigger chips and "or…", "Automate this…"; lab round 1116c "grouped once").
 */
export type WorkflowTriggerStartOption = Readonly<{
    id: string;
    /** The menu group's title ("Time", "Sessions", the plugin's name, the resource's name). */
    group: string;
    /**
     * `resource`: a resource host's own triggers, first ("Production · happier-web"); `builtin`: Happier's
     * triggers by resource kind; `plugins`: each plugin's declared Events, after a "From plugins" rule.
     */
    section: 'resource' | 'builtin' | 'plugins';
    title: string;
    glyph: IconName;
}>;

/** A resource host ("Automate this…" on an environment): its own starts lead the menu under its name (Q5). */
export type WorkflowTriggerStartContext = Readonly<{
    resource?: Readonly<{ title: string; startIds: readonly string[] }>;
}>;

const SCHEDULE_ID = 'schedule';
const ACTION_PHASES = ['before', 'after'] as const;
type ActionPhase = (typeof ACTION_PHASES)[number];
const actionStartId = (phase: ActionPhase) => `action:${phase}`;
const sessionId = (kind: SessionEventKind) => `session:${kind}`;
const eventId = (eventRef: Readonly<{ pluginId: string; localId: string }>) => `event:${eventRef.pluginId}/${eventRef.localId}`;

/** The start a When reads as in the When select; `null` for the kinds the card lists but does not author. */
export function readWorkflowTriggerStartId(when: TriggerWhenValue): string | null {
    switch (when.kind) {
        case 'schedule':
            return SCHEDULE_ID;
        case 'pluginEvent': {
            const eventRef = when.value?.eventRef ?? when.eventRef;
            return eventRef ? eventId(eventRef) : null;
        }
        case 'turnEnds':
        case 'needsYou':
        case 'sessionArchived':
        case 'sessionStarts':
            return sessionId(when.kind);
        case 'action':
            return actionStartId(when.phase);
        default:
            return null;
    }
}

/**
 * Every start in menu order, decided once here. Built-in triggers come first, grouped by resource kind in
 * the approved fixed order (Time, Actions, Sessions, Deployments, Health checks, Machines, Databases and
 * backups, Workflows; lab `actrig:v:amenu`; today Happier ships Time, Actions and Sessions), then each plugin's
 * Events grouped by plugin and sorted by plugin name, in declaration order within a plugin. A resource
 * context moves its own starts to the front under its name. `current` keeps a saved start that the
 * catalog no longer offers (an Event whose plugin is gone, "A session starts") choosable as it is.
 */
export function buildWorkflowTriggerStartOptions(
    events: readonly WorkflowTriggerEventOption[],
    current?: Readonly<{ when: TriggerWhenValue; title: string }>,
    context?: WorkflowTriggerStartContext,
): readonly WorkflowTriggerStartOption[] {
    const sessionKinds: readonly SessionEventKind[] = current?.when.kind === 'sessionStarts'
        ? [...WORKFLOW_SESSION_EVENT_KINDS, 'sessionStarts'] : WORKFLOW_SESSION_EVENT_KINDS;
    const options: WorkflowTriggerStartOption[] = [
        { id: SCHEDULE_ID, group: t('workflows.triggers.card.groupTime'), section: 'builtin', title: t('workflows.triggers.card.schedule'), glyph: 'clock' },
        // Before and after an Action (PROGRAM D1–D3): the Action and its subject are chosen on the trigger's own rows.
        { id: actionStartId('before'), group: t('workflows.triggers.card.groupActions'), section: 'builtin',
            title: t('workflows.triggers.card.actionBefore'), glyph: ACTION_PHASE_GLYPHS.before },
        { id: actionStartId('after'), group: t('workflows.triggers.card.groupActions'), section: 'builtin',
            title: t('workflows.triggers.card.actionAfter'), glyph: ACTION_PHASE_GLYPHS.after },
        ...sessionKinds.map((kind): WorkflowTriggerStartOption => ({
            id: sessionId(kind), group: t('workflows.triggers.card.groupSessions'), section: 'builtin',
            title: t(`workflows.triggers.card.sessionStart.${kind}`), glyph: TRIGGER_LIFECYCLE_GLYPHS[kind],
        })),
    ];
    // Grouped by plugin, by plugin name; a plugin keeps its declaration order.
    const plugins = [...new Map(events.map((event) => [event.eventRef.pluginId, event.pluginName])).entries()]
        .sort(([, left], [, right]) => left.localeCompare(right));
    for (const [pluginId] of plugins) {
        for (const event of events) {
            if (event.eventRef.pluginId !== pluginId) continue;
            options.push({ id: eventId(event.eventRef), group: event.pluginName, section: 'plugins', title: event.title, glyph: 'lightning' });
        }
    }
    const currentId = current ? readWorkflowTriggerStartId(current.when) : null;
    if (current && currentId !== null && !options.some((option) => option.id === currentId)) {
        const eventRef = current.when.kind === 'pluginEvent' ? current.when.value?.eventRef ?? current.when.eventRef : undefined;
        options.push({ id: currentId, group: eventRef?.pluginId ?? '', section: 'plugins', title: current.title, glyph: 'lightning' });
    }
    const resource = context?.resource;
    if (resource === undefined) return options;
    const led = resource.startIds.flatMap((id) => {
        const option = options.find((candidate) => candidate.id === id);
        return option === undefined ? [] : [{ ...option, group: resource.title, section: 'resource' as const }];
    });
    return [...led, ...options.filter((option) => !resource.startIds.includes(option.id))];
}

/** The relation glyph of an Action trigger: before (into the Action) and after (out of it). */
export const ACTION_PHASE_GLYPHS = { before: 'sign-in', after: 'sign-out' } as const satisfies Record<ActionPhase, IconName>;

/**
 * The When a newly chosen start begins with; a session event keeps a Session already chosen. An Action
 * trigger keeps the Action and subject already chosen; before starts waiting for its result (the
 * consequential default, said on its row), and after carries no wait policy.
 */
export function createWorkflowTriggerStartWhen(id: string, previous?: TriggerWhenValue | null): TriggerWhenValue | null {
    if (id === SCHEDULE_ID) return createDefaultWhen('schedule');
    const phase = ACTION_PHASES.find((candidate) => id === actionStartId(candidate));
    if (phase !== undefined) {
        const kept = previous?.kind === 'action' ? previous : null;
        return {
            kind: 'action',
            phase,
            actionIds: kept?.actionIds ?? [],
            ...(kept?.subject === undefined ? {} : { subject: kept.subject }),
            ...(phase === 'before' ? { mode: 'wait' as const } : {}),
        };
    }
    if (id.startsWith('session:')) {
        const kind = id.slice('session:'.length);
        if (!(WORKFLOW_SESSION_EVENT_KINDS as readonly string[]).includes(kind) && kind !== 'sessionStarts') return null;
        const kept = previous && isSessionLifecycleWhen(previous) ? previous : null;
        return {
            kind: kind as SessionEventKind,
            ...(kept?.subject === undefined ? {} : { subject: kept.subject }),
            ...(kept?.nextTimeOnly === undefined ? {} : { nextTimeOnly: kept.nextTimeOnly }),
            ...(kept?.policy === undefined ? {} : { policy: kept.policy }),
        };
    }
    if (id.startsWith('event:')) {
        const ref = id.slice('event:'.length);
        const slash = ref.indexOf('/');
        if (slash <= 0) return null;
        return { kind: 'pluginEvent', value: null, eventRef: { pluginId: ref.slice(0, slash), localId: ref.slice(slash + 1) } };
    }
    return null;
}

/**
 * Triggers on screen that are not complete yet (no Session or Event chosen): new ones (`pending`) and
 * edits of listed ones (`edits`, by row key). Held beside the trigger draft, never in it, so the When
 * card and the Sentence view show the same ones.
 */
export type WorkflowTriggerIncomplete = Readonly<{
    pending: readonly Readonly<{ clientId: string; when: TriggerWhenValue; enabled?: boolean; eventSeed?: PluginUiOpenAutomationEventRequestV1 }>[];
    edits: Readonly<Record<string, TriggerWhenValue>>;
}>;
export const EMPTY_WORKFLOW_TRIGGER_INCOMPLETE: WorkflowTriggerIncomplete = Object.freeze({ pending: Object.freeze([]), edits: Object.freeze({}) });

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
    const declaration = when.kind === 'pluginEvent' && when.payloadSchema !== undefined ? { payloadSchema: when.payloadSchema } : {};
    if (params.row.kind === 'new') {
        return editWorkflowTriggerDraft(params.draft, { kind: 'add', clientId: params.row.clientId, trigger, ...declaration });
    }
    const { enabled: _enabled, ...definition } = trigger;
    return editWorkflowTriggerDraft(params.draft, { kind: 'update', triggerId: params.row.triggerId, trigger: definition, enabled, ...declaration });
}

let triggerClientSequence = 0;
/** A new trigger's identity on screen until Save gives it one. */
export function createWorkflowTriggerClientId(): string {
    triggerClientSequence += 1;
    return `trigger-draft-${Date.now().toString(36)}-${triggerClientSequence}`;
}

/**
 * Adds one new trigger that starts with this When (Add a trigger, Live events' "Add to this workflow"): into
 * the draft when it is complete, else held beside it as incomplete until its Session or Event is chosen.
 */
export function addWorkflowTriggerWhen(params: Readonly<{
    draft: WorkflowTriggerDraft;
    when: TriggerWhenValue;
    onChangeDraft: (next: WorkflowTriggerDraft) => void;
    updateIncomplete: (update: (current: WorkflowTriggerIncomplete) => WorkflowTriggerIncomplete) => void;
}>): void {
    const clientId = createWorkflowTriggerClientId();
    const next = commitWorkflowTriggerWhen({ draft: params.draft, row: { kind: 'new', clientId }, when: params.when, enabled: true });
    if (next !== null) params.onChangeDraft(next);
    else params.updateIncomplete((current) => ({ ...current, pending: [...current.pending, { clientId, when: params.when }] }));
}

export function removeWorkflowTriggerRow(draft: WorkflowTriggerDraft, row: WorkflowTriggerRowRef): WorkflowTriggerDraft {
    return row.kind === 'new'
        ? editWorkflowTriggerDraft(draft, { kind: 'discardAdd', clientId: row.clientId })
        : editWorkflowTriggerDraft(draft, { kind: 'remove', triggerId: row.triggerId });
}
