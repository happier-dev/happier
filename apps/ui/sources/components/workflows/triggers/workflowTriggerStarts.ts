import { readAutomationEventSubjectKindsV1, type PluginEventAutomationDeclarationV1 } from '@happier-dev/protocol/automations/automationEventDeclarationV1';
import { isPluginAutomationActionSubjectV1 } from '@happier-dev/protocol/automations/automationPluginSubjectV1';
import { DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DEPLOYMENT_RECEIPT_CHANGED_EVENT_REF_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import type { AutomationSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import type { WorkflowActionSpec } from '../presentation/workflowActionCatalog';
import type { AutomationTriggerId } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { AUTOMATION_SESSION_LIFECYCLE_EVENT_GROUPS_V1 } from '@happier-dev/protocol/automations/automationSessionLifecycle';
import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import type { WorkflowActivityLiveFact } from '@/sync/domains/workflows/workflowActivityTypes';

import type { IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import { buildTriggerDefinition, createDefaultWhen, isSessionLifecycleWhen, SESSION_TRIGGER_WHEN_KINDS, type TriggerWhenValue } from './sessionTriggerForm';
import { ACTION_PHASE_GLYPHS, resolveTriggerEventGroup, TRIGGER_LIFECYCLE_GLYPHS } from './triggerEventGroups';
import { isDeployFinishedTrigger } from './formatTriggerSummary';
export { isDeployFinishedTrigger } from './formatTriggerSummary';
import { editWorkflowTriggerDraft, type WorkflowTriggerDraft } from './workflowTriggerDraft';

type SessionEventKind = keyof typeof AUTOMATION_SESSION_LIFECYCLE_EVENT_GROUPS_V1;
/** The Session starts in menu order: "A session starts" leads its group (lab round 1116c), the rest as declared. */
export const WORKFLOW_SESSION_EVENT_KINDS: readonly SessionEventKind[] = Object.freeze([
    'sessionStarts' satisfies SessionEventKind,
    ...(Object.keys(AUTOMATION_SESSION_LIFECYCLE_EVENT_GROUPS_V1) as SessionEventKind[]).filter((kind) => kind !== 'sessionStarts'),
]);

/** A plugin-declared Event on the trigger set's Machine, as the trigger-event catalog presents it. */
export type WorkflowTriggerEventOption = Readonly<{
    eventRef: Readonly<{ pluginId: string; localId: string }>;
    title: string;
    /** The plugin's name, when the catalog supplies one. */
    pluginName: string | null;
    /** The public Event declaration owns which resource kinds it can observe. */
    automation?: PluginEventAutomationDeclarationV1;
    /** Retain the declaration for Event setup and Insert value authoring. */
    payloadSchema?: PluginJsonSchemaV2;
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

export type ActionWorkflowTriggerStartOption = Omit<Extract<ResourceWorkflowTriggerStartOption,
    { relation: 'before' | 'after' }>, 'subject'>;
export type WorkflowLinkTriggerStartOption = ResourceWorkflowTriggerStartOption | ActionWorkflowTriggerStartOption;

export function buildActionWorkflowTriggerStartOptions(params: Readonly<{
    actionId: string; actions: readonly WorkflowActionSpec[];
}>): readonly ActionWorkflowTriggerStartOption[] {
    return params.actions.filter(action => action.id === params.actionId).flatMap(action => ACTION_PHASES.flatMap(phase => {
        if (action.automation?.[phase] !== true) return [];
        const start = createWorkflowTriggerStartWhen(actionStartId(phase));
        if (start?.kind !== 'action') return [];
        const when = { ...start, actionIds: [action.id] };
        return [{ id: `${actionStartId(phase)}:${action.id}`, label: action.title,
            relation: phase, when, setupRequired: false as const, trigger: { ...when, enabled: true } }];
    }));
}

export function formatWorkflowLinkStartLabel(option: WorkflowLinkTriggerStartOption): string {
    if (option.relation === 'event') return option.label;
    const before = option.relation === 'before';
    if ('subject' in option && option.subject.kind === 'database' && option.when.actionIds.includes(DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1)) {
        return t(before ? 'workflows.triggers.link.beforeDatabaseRestore' : 'workflows.triggers.link.afterDatabaseRestore');
    }
    return t(before ? 'workflows.triggers.link.beforeAction' : 'workflows.triggers.link.afterAction', { action: option.label });
}

export function buildResourceWorkflowTriggerStartOptions(params: Readonly<{
    subject: AutomationSubjectV1;
    contextSubjects?: readonly AutomationSubjectV1[];
    actions: readonly WorkflowActionSpec[];
    events: readonly WorkflowTriggerEventOption[];
    machineId: string | null;
}>): readonly ResourceWorkflowTriggerStartOption[] {
    const { subject } = params;
    const options: ResourceWorkflowTriggerStartOption[] = [];
    for (const action of params.actions) {
        if (!action.automation?.subjectKinds?.includes(subject.kind)) continue;
        if (subject.kind === 'plugin' && (!action.plugin || !isPluginAutomationActionSubjectV1(subject, {
            pluginId: action.plugin.id, approvalScope: action.approvalScope,
        }))) continue;
        for (const option of buildActionWorkflowTriggerStartOptions({ actionId: action.id, actions: [action] })) {
            const when = { ...option.when, subject };
            options.push({ ...option, subject, when, trigger: { ...when, enabled: true } });
        }
    }
    for (const event of params.events) {
        const subjectKinds = readAutomationEventSubjectKindsV1(event.automation);
        if (!subjectKinds.includes(subject.kind)) continue;
        if (subject.kind === 'plugin' && (event.eventRef.pluginId !== subject.pluginId
            || !event.automation?.subjects?.some(kind => kind.subjectKindId === subject.subjectKindId))) continue;
        const id = eventId(event.eventRef);
        const when = createWorkflowTriggerStartWhen(id);
        if (when?.kind !== 'pluginEvent') continue;
        const backupCompletion = subject.kind === 'environment' && subjectKinds.includes('backup')
            && event.automation?.completesActionIds?.includes(DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1);
        const eventSubject = backupCompletion ? params.contextSubjects?.find(candidate => candidate.kind === 'backup'
            && candidate.serverId === subject.serverId && candidate.environmentId === subject.environmentId) : subject;
        if (!eventSubject) continue;
        options.push({ id, label: event.title, relation: 'event', subject: eventSubject, when, trigger: null, setupRequired: true,
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
    /** The host Session seeds new starts; an existing row's deliberate Any selection wins. */
    session?: Readonly<{
        subject: Extract<AutomationSubjectV1, { kind: 'session' }>;
        pullRequestLinks?: readonly Readonly<{ repository: string; number: number }>[];
    }>;
}>;

const SCHEDULE_ID = 'schedule';
const ACTION_PHASES = ['before', 'after'] as const;
type ActionPhase = (typeof ACTION_PHASES)[number];
const actionStartId = (phase: ActionPhase) => `action:${phase}`;
const DEPLOY_FINISHED_START_ID = `${actionStartId('after')}:${DEPLOYMENT_DEPLOY_ACTION_ID_V1}`;

function isDeployTerminalEvent(event: WorkflowTriggerEventOption): boolean {
    return event.automation?.completionOutcome !== undefined
        && event.automation.completesActionIds?.includes(DEPLOYMENT_DEPLOY_ACTION_ID_V1) === true;
}
const NATIVE_EVENT_GROUPS = [
    'groupDeployments', 'groupHealthChecks', 'groupMachines', 'groupDatabasesAndBackups',
] as const;

function readNativeEventGroup(event: WorkflowTriggerEventOption): (typeof NATIVE_EVENT_GROUPS)[number] | undefined {
    const kinds = readAutomationEventSubjectKindsV1(event.automation);
    if (kinds.includes('healthCheck')) return 'groupHealthChecks';
    if (kinds.includes('database') || kinds.includes('backup')) return 'groupDatabasesAndBackups';
    if (isDeployTerminalEvent(event) || kinds.includes('environment') || kinds.includes('app')) return 'groupDeployments';
    if (event.automation?.source.nativeActivity?.kind === 'machinePresence' || kinds.includes('machine')) return 'groupMachines';
    return undefined;
}

const sessionId = (kind: SessionEventKind) => `session:${kind}`;
const eventId = (eventRef: Readonly<{ pluginId: string; localId: string }>) => `event:${eventRef.pluginId}/${eventRef.localId}`;

/** The start a When reads as in the When select; `null` for the kinds the card lists but does not author. */
export function readWorkflowTriggerStartId(when: TriggerWhenValue): string | null {
    if (isSessionLifecycleWhen(when)) return sessionId(when.kind);
    switch (when.kind) {
        case 'schedule':
            return SCHEDULE_ID;
        case 'pluginEvent': {
            const eventRef = when.value?.eventRef ?? when.eventRef;
            return eventRef ? eventId(eventRef) : null;
        }
        case 'action':
            return isDeployFinishedTrigger(when) ? DEPLOY_FINISHED_START_ID : actionStartId(when.phase);
        case 'prComment':
        case 'ciFailed':
            return `session:${when.kind}`;
        default:
            return null;
    }
}

/**
 * Every start in menu order, decided here. Time, Actions and Sessions come first, followed by the
 * declared resource categories in the Plan 05 order. Other Events are grouped by plugin and
 * sorted by plugin name, in declaration order within a plugin. A resource
 * context moves its own starts to the front under its name. `current` keeps a saved start that the
 * catalog no longer offers (an Event whose plugin is gone, "A session starts") choosable as it is.
 */
export function buildWorkflowTriggerStartOptions(
    events: readonly WorkflowTriggerEventOption[],
    current?: Readonly<{ when: TriggerWhenValue; title: string }>,
    context?: WorkflowTriggerStartContext,
): readonly WorkflowTriggerStartOption[] {
    const options: WorkflowTriggerStartOption[] = [
        { id: SCHEDULE_ID, group: t('workflows.triggers.card.groupTime'), section: 'builtin', title: t('workflows.triggers.card.schedule'), glyph: 'clock' },
        { id: actionStartId('before'), group: t('workflows.triggers.card.groupActions'), section: 'builtin',
            title: t('workflows.triggers.card.actionBefore'), glyph: ACTION_PHASE_GLYPHS.before },
        { id: actionStartId('after'), group: t('workflows.triggers.card.groupActions'), section: 'builtin',
            title: t('workflows.triggers.card.actionAfter'), glyph: ACTION_PHASE_GLYPHS.after },
        ...WORKFLOW_SESSION_EVENT_KINDS.map((kind): WorkflowTriggerStartOption => ({
            id: sessionId(kind), group: t('workflows.triggers.card.groupSessions'), section: 'builtin',
            title: t(`workflows.triggers.card.sessionStart.${kind}`), glyph: TRIGGER_LIFECYCLE_GLYPHS[kind],
        })),
        ...(context?.session === undefined ? [] : SESSION_TRIGGER_WHEN_KINDS.flatMap((kind): WorkflowTriggerStartOption[] =>
            kind === 'prComment' || kind === 'ciFailed' ? [{
                group: t('workflows.triggers.card.groupSessions'), section: 'builtin',
                ...resolveTriggerEventGroup({ kind }), id: `session:${kind}` }] : [])),
    ];
    let offeredDeploy = false;
    const append = (event: WorkflowTriggerEventOption, group: string, section: WorkflowTriggerStartOption['section']) => {
        if (eventId(event.eventRef) === eventId(DEPLOYMENT_RECEIPT_CHANGED_EVENT_REF_V1)) return;
        if (isDeployTerminalEvent(event)) {
            if (!offeredDeploy) {
                options.push({ id: DEPLOY_FINISHED_START_ID, group, section,
                    title: t('workflows.triggers.card.deployFinished'), glyph: 'lightning' });
                offeredDeploy = true;
            }
            return;
        }
        options.push({ id: eventId(event.eventRef), group, section, title: event.title, glyph: 'lightning' });
    };
    const grouped = events.map(event => ({ event, group: readNativeEventGroup(event) }));
    for (const group of NATIVE_EVENT_GROUPS) {
        for (const row of grouped) if (row.group === group) append(row.event, t(`workflows.triggers.card.${group}`), 'builtin');
    }
    const pluginEvents = grouped.flatMap(row => row.group === undefined ? [row.event] : []);
    // Remaining plugins keep their declaration order within each named plugin group.
    const plugins = [...new Map(pluginEvents.map((event) => [event.eventRef.pluginId, event.pluginName])).entries()]
        .sort(([, left], [, right]) => {
            if (left === null) return right === null ? 0 : 1;
            return right === null ? -1 : left.localeCompare(right);
        });
    for (const [pluginId, pluginName] of plugins) {
        for (const event of pluginEvents) if (event.eventRef.pluginId === pluginId) append(event, pluginName ?? '', 'plugins');
    }
    const currentId = current ? readWorkflowTriggerStartId(current.when) : null;
    if (current && currentId !== null && !options.some((option) => option.id === currentId)) {
        const eventRef = current.when.kind === 'pluginEvent' ? current.when.value?.eventRef ?? current.when.eventRef : undefined;
        options.push({ id: currentId, group: eventRef?.pluginId ?? '', section: 'plugins',
            title: currentId === DEPLOY_FINISHED_START_ID ? t('workflows.triggers.card.deployFinished') : current.title, glyph: 'lightning' });
    }
    const resource = context?.resource;
    if (resource === undefined) return options;
    const led = resource.startIds.flatMap((id) => {
        const option = options.find((candidate) => candidate.id === id);
        return option === undefined ? [] : [{ ...option, group: resource.title, section: 'resource' as const }];
    });
    return [...led, ...options.filter((option) => !resource.startIds.includes(option.id))];
}


/**
 * The When a newly chosen start begins with; a session event keeps a Session already chosen. An Action
 * trigger keeps the Action and subject already chosen; before starts waiting for its result (the
 * consequential default, said on its row), and after carries no wait policy.
 */
export function createWorkflowTriggerStartWhen(id: string, previous?: TriggerWhenValue | null,
    context?: WorkflowTriggerStartContext): TriggerWhenValue | null {
    if (id === SCHEDULE_ID) return createDefaultWhen('schedule');
    if (id === DEPLOY_FINISHED_START_ID) {
        if (previous?.kind === 'action' && isDeployFinishedTrigger(previous)) return previous;
        return { kind: 'action', phase: 'after', actionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1] };
    }
    const phase = ACTION_PHASES.find((candidate) => id === actionStartId(candidate));
    if (phase !== undefined) {
        // Leaving the specialized start for generic After returns to its Action picker.
        const kept = previous?.kind === 'action' && !(phase === 'after' && isDeployFinishedTrigger(previous))
            ? previous : null;
        return {
            kind: 'action',
            phase,
            actionIds: kept?.actionIds ?? [],
            ...(kept?.subject === undefined ? {} : { subject: kept.subject }),
            ...(phase === 'before' ? { mode: 'wait' as const } : {}),
        };
    }
    const kind = WORKFLOW_SESSION_EVENT_KINDS.find(candidate => id === sessionId(candidate));
    if (kind !== undefined) {
        const kept = previous && isSessionLifecycleWhen(previous) ? previous : null;
        if (kept?.kind === kind) return kept;
        return {
            kind,
            ...(kept === null ? context?.session === undefined ? {} : { subject: context.session.subject }
                : kept.subject === undefined ? {} : { subject: kept.subject }),
            ...(kept?.nextTimeOnly === undefined ? {} : { nextTimeOnly: kept.nextTimeOnly }),
            ...(kept?.policy === undefined ? {} : { policy: kept.policy }),
        };
    }
    if (context?.session !== undefined) {
        const kind = SESSION_TRIGGER_WHEN_KINDS.find(kind => (kind === 'prComment' || kind === 'ciFailed') && id === `session:${kind}`);
        if (kind === 'prComment' || kind === 'ciFailed') return previous?.kind === kind ? previous
            : createDefaultWhen(kind, context.session.pullRequestLinks);
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
export type WorkflowTriggerDraftSeedIntent = Readonly<{
    eventSeed?: PluginUiOpenAutomationEventRequestV1;
    /** The watched resource is independent of the controller the author selects later. */
    nativeEvent?: Extract<WorkflowActivityLiveFact, { kind: 'machine' }>;
}>;
export type WorkflowTriggerIncomplete = Readonly<{
    pending: readonly Readonly<{ clientId: string; when: TriggerWhenValue; enabled?: boolean } & WorkflowTriggerDraftSeedIntent>[];
    edits: Readonly<Record<string, TriggerWhenValue>>;
}>;
export const EMPTY_WORKFLOW_TRIGGER_INCOMPLETE: WorkflowTriggerIncomplete = Object.freeze({ pending: Object.freeze([]), edits: Object.freeze({}) });

export function createWorkflowTriggerIncompleteSeed(intent?: WorkflowTriggerDraftSeedIntent): WorkflowTriggerIncomplete | undefined {
    if (intent?.eventSeed === undefined && intent?.nativeEvent === undefined) return undefined;
    return { pending: [{ clientId: createWorkflowTriggerClientId(), when: { kind: 'pluginEvent', value: null,
        ...(intent.eventSeed === undefined ? {} : { eventRef: intent.eventSeed.eventRef }) },
        ...(intent.eventSeed === undefined ? {} : { eventSeed: intent.eventSeed }),
        ...(intent.nativeEvent === undefined ? {} : { nativeEvent: intent.nativeEvent }) }], edits: {} };
}

export type WorkflowTriggerRowRef =
    | Readonly<{ kind: 'saved'; triggerId: AutomationTriggerId }>
    | Readonly<{ kind: 'new'; clientId: string }>;

/**
 * Applies a card edit to the Account set's draft once the When is complete; `null` while it is not
 * (no Session or Event chosen yet). The card keeps an incomplete When on screen; Save writes only
 * complete ones. A Run Event seed already carries its source and condition.
 */
export function commitWorkflowTriggerWhen(params: Readonly<{
    draft: WorkflowTriggerDraft;
    row: WorkflowTriggerRowRef;
    when: TriggerWhenValue;
    enabled: boolean;
    sessionId?: string | null;
}>): WorkflowTriggerDraft | null {
    const { when, enabled } = params;
    const trigger = buildTriggerDefinition({ when, enabled, sessionId: params.sessionId ?? null });
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
 * the draft when it is complete, else held beside it as incomplete until its Session or Event is chosen. Returns the
 * new row's on-screen identity.
 */
export function addWorkflowTriggerWhen(params: Readonly<{
    draft: WorkflowTriggerDraft;
    when: TriggerWhenValue;
    seed?: WorkflowTriggerDraftSeedIntent;
    sessionId?: string | null;
    onChangeDraft: (next: WorkflowTriggerDraft) => void;
    updateIncomplete: (update: (current: WorkflowTriggerIncomplete) => WorkflowTriggerIncomplete) => void;
}>): string {
    const clientId = createWorkflowTriggerClientId();
    const next = commitWorkflowTriggerWhen({ draft: params.draft, row: { kind: 'new', clientId }, when: params.when, enabled: true,
        sessionId: params.sessionId });
    if (next !== null) params.onChangeDraft(next);
    else params.updateIncomplete((current) => ({ ...current, pending: [...current.pending, { clientId, when: params.when,
        ...params.seed }] }));
    return clientId;
}

export function removeWorkflowTriggerRow(draft: WorkflowTriggerDraft, row: WorkflowTriggerRowRef): WorkflowTriggerDraft {
    return row.kind === 'new'
        ? editWorkflowTriggerDraft(draft, { kind: 'discardAdd', clientId: row.clientId })
        : editWorkflowTriggerDraft(draft, { kind: 'remove', triggerId: row.triggerId });
}
