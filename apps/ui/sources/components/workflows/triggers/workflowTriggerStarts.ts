import type { AutomationTriggerId } from '@happier-dev/protocol/automations/automationTriggerIdentity';

import type { IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import { buildTriggerDefinition, createDefaultWhen, type TriggerWhenValue } from './sessionTriggerForm';
import { TRIGGER_LIFECYCLE_GLYPHS } from './triggerEventGroups';
import { editWorkflowTriggerDraft, type WorkflowTriggerDraft } from './workflowTriggerDraft';

/**
 * What a saved trigger reads as. A run event is created from the run it follows and a Session's
 * pull-request trigger from that Session; the card lists them but does not author them.
 */
export type WorkflowTriggerStart = 'schedule' | 'pluginEvent' | 'sessionEvent' | 'runEvent' | 'sessionPullRequest';

/** A session that already exists cannot start again, so "A session starts" is not offered for a chosen Session. */
export const WORKFLOW_SESSION_EVENT_KINDS = ['turnEnds', 'needsYou', 'sessionArchived'] as const;
type SessionEventKind = (typeof WORKFLOW_SESSION_EVENT_KINDS)[number] | 'sessionStarts';

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

/** A plugin-declared Event on the trigger set's Machine, as the trigger-event catalog presents it. */
export type WorkflowTriggerEventOption = Readonly<{
    eventRef: Readonly<{ pluginId: string; localId: string }>;
    title: string;
    /** The plugin's name: the Event's group in the menu. */
    pluginName: string;
}>;

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
        default:
            return null;
    }
}

/**
 * Every start in menu order, decided once here. Built-in triggers come first, grouped by resource kind in
 * the approved fixed order (Time, Sessions, Projects, Machines, Deployments, Health checks, Databases and
 * backups, Sites, Workflows, Accounts, Actions; today Happier ships Time and Sessions), then each plugin's
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

/** The When a newly chosen start begins with; a session event keeps a Session already chosen. */
export function createWorkflowTriggerStartWhen(id: string, previous?: TriggerWhenValue | null): TriggerWhenValue | null {
    if (id === SCHEDULE_ID) return createDefaultWhen('schedule');
    if (id.startsWith('session:')) {
        const kind = id.slice('session:'.length);
        if (!(WORKFLOW_SESSION_EVENT_KINDS as readonly string[]).includes(kind) && kind !== 'sessionStarts') return null;
        const sourceSessionId = previous && 'sourceSessionId' in previous ? previous.sourceSessionId : undefined;
        const nextTimeOnly = previous && 'nextTimeOnly' in previous ? previous.nextTimeOnly : undefined;
        return {
            kind: kind as SessionEventKind,
            ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
            ...(nextTimeOnly === undefined ? {} : { nextTimeOnly }),
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
    pending: readonly Readonly<{ clientId: string; when: TriggerWhenValue }>[];
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

export function removeWorkflowTriggerRow(draft: WorkflowTriggerDraft, row: WorkflowTriggerRowRef): WorkflowTriggerDraft {
    return row.kind === 'new'
        ? editWorkflowTriggerDraft(draft, { kind: 'discardAdd', clientId: row.clientId })
        : editWorkflowTriggerDraft(draft, { kind: 'remove', triggerId: row.triggerId });
}
