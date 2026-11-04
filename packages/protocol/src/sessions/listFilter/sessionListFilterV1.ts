import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { readSessionBotV1 } from '../identity/sessionBotV1.js';
import { deriveSessionCoordinatorV1, type SessionCoordinatorFactsV1 } from '../follow/sessionCoordinatorV1.js';
import { QualifiedProjectKeyV1Schema, type QualifiedProjectKeyV1, type WorkspaceRefV1 } from '../../workspaces/workspaceRefV1.js';
import { SessionAwarenessPresentationStateV1Schema, SESSION_WORK_STATUS_FILTERS_V1,
    listSessionPresentationStatesForWorkStatusFilterV1, readWorkStatusFilterV1,
    type readSessionAwarenessWorkStatusV1 } from '../awareness/presentationV1.js';
import { resolveSessionProjectKeyV1, type WorkspaceRefResolutionContextV1 } from '../../workspaces/workspaceRefResolutionV1.js';
import type { SessionAwarenessOriginV1 } from '../awareness/projectionV1.js';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { compileEntityListFilterV1, matchEntityFilterKnownV1 as known, matchEntityFilterSetV1,
    matchEntityFilterTimeV1, UpdatedSelectionV1Schema, ExtensionSelectionV1Schema, createEntityListFilterStoredReadSchemaV1,
    type SetSelectionV1, type UpdatedSelectionV1, type ExtensionSelectionV1, type EntityFilterFactValueV1,
} from '../../collections/filter/entityListFilterV1.js';
import { defineEntityFilterFieldV1, defineEntityFilterUnknownFieldsV1, getUnsupportedEntityFilterFieldsV1,
    type EntityFilterEvaluatorV1, type EntityFilterRegistryV1,
} from '../../collections/filter/fieldRegistryV1.js';
import { createPluginListFilterFieldRegistryV1, type AdmittedPluginListFilterFieldV1 } from '../../collections/filter/pluginListFilterFieldV1.js';
import { QualifiedSessionSectionV1Schema, type QualifiedSessionSectionV1 } from '../organization/folders.js';
import { BackendTargetKeyV2Schema, parseBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import { WorkflowRunStateV1Schema } from '../../workflows/workflowRunStateV1.js';
import { createEntityFilterConditionCodecV1 } from '../../collections/filter/fieldConditionsV1.js';

import {
    SessionAttentionFilterV1Schema,
    SessionBotFilterV1Schema,
    SessionAudienceSelectionV1Schema,
    SessionListScopeV1Schema,
    type SessionAttentionFilterV1,
    type SessionBotFilterV1,
    type SessionListScopeV1,
    type SessionAudienceSelectionV1,
} from '../listing/query.js';

export type QualifiedAudienceSelection = Readonly<{ serverId: string }> & SessionAudienceSelectionV1;
export type QualifiedTagAddress = Readonly<{ serverId: string; tagId: string }>;
export type QualifiedMachineV1 = Readonly<{ serverId: string; machineId: string }>;
export type QualifiedAccountV1 = Readonly<{ serverId: string; accountId: string }>;

export const SessionListShowV1Schema = lazyZodSchema(() => z.enum(['sessions', 'runs', 'both']));
export const SessionListStartedByV1Schema = lazyZodSchema(() => z.enum(['you', 'triggers', 'agents']));

/** Closed state identities emitted by the canonical Session/Run Work presenter; no status conversion lives here. */
export const SessionListStatusV1Schema = lazyZodSchema(() => z.union([
    SessionAwarenessPresentationStateV1Schema, WorkflowRunStateV1Schema, z.literal('stopping'),
]));
export type SessionListStatusV1 = z.infer<typeof SessionListStatusV1Schema>;

/** Serializable selection shared by the Sessions list and inline Board filters. */
export type SessionListFilterV1 = Readonly<{
    show: z.infer<typeof SessionListShowV1Schema>;
    startedBy: readonly z.infer<typeof SessionListStartedByV1Schema>[];
    scope: SessionListScopeV1;
    attention: SessionAttentionFilterV1;
    bot?: SessionBotFilterV1;
    coordinator?: 'coordinator';
    projects?: Readonly<{ include: readonly QualifiedProjectKeyV1[]; exclude: readonly QualifiedProjectKeyV1[] }>;
    statuses?: readonly SessionListStatusV1[];
    excludedStatuses?: readonly SessionListStatusV1[];
    machines?: SetSelectionV1<QualifiedMachineV1>;
    agents?: SetSelectionV1<string>;
    sections?: SetSelectionV1<QualifiedSessionSectionV1>;
    owners?: SetSelectionV1<QualifiedAccountV1>;
    branches?: SetSelectionV1<string>;
    updated?: UpdatedSelectionV1;
    includeInactive?: boolean;
    extensions?: Readonly<Record<string, ExtensionSelectionV1>>;
    underSessionId?: string;
    homeServerIds: readonly string[];
    audiences: readonly QualifiedAudienceSelection[];
    tagIds: readonly QualifiedTagAddress[];
    source: 'all' | 'persisted' | 'direct';
}>;

export type SessionListFilterDefaultsInputV1 = Partial<SessionListFilterV1>;

/**
 * Session identity/relations and Project cannot select Runs (a Run's destination is not its owner Session's
 * Project); Status instead consumes each kind's canonical Work presentation state.
 */
export function canSessionListFilterIncludeRunsV1(
    filter: Pick<SessionListFilterV1, 'show' | 'bot' | 'coordinator' | 'projects' | 'statuses'> & Partial<SessionListFilterV1>,
): boolean {
    const selection = normalizeSessionListFilterV1(filter);
    return filter.show !== 'sessions' && !sessionWorkFilterFields.some(field => field.appliesTo
        && !field.appliesTo({ serverId: '', kind: 'run' }) && field.isActive(selection));
}

export type SessionListFilterMatchV1 = 'match' | 'miss' | 'unavailable';
export type SessionListStartedByFactV1 = SessionListFilterV1['startedBy'][number] | 'other_account' | 'non_person';

/** One Started-by clause for public preselection and the final tri-state predicate. */
export function matchSessionListStartedByV1(
    selection: SessionListFilterV1['startedBy'],
    fact: SessionListStartedByFactV1 | undefined,
): SessionListFilterMatchV1 {
    if (selection.length === 0) return 'miss';
    if (['you', 'agents', 'triggers'].every(value => selection.some(selected => selected === value))) return 'match';
    if (fact === undefined) return 'unavailable';
    if (fact === 'non_person') return selection.some(value => value !== 'you') ? 'unavailable' : 'miss';
    return fact !== 'other_account' && selection.includes(fact) ? 'match' : 'miss';
}

/** Immutable creation provenance and Account identity, never a title, Bot marker or hosting daemon. */
export function readSessionListStartedByV1(input: Readonly<{
    origin?: SessionAwarenessOriginV1;
    ownerAccountId?: string;
    viewerAccountId?: string;
}>): SessionListStartedByFactV1 | undefined {
    if (input.origin && input.origin.kind !== 'none') return 'non_person';
    if (!input.origin || !input.ownerAccountId || !input.viewerAccountId) return undefined;
    return input.ownerAccountId === input.viewerAccountId ? 'you' : 'other_account';
}

/** Facts are authorized by the caller; unknown facts stay absent, never guessed from labels. */
export type SessionListFilterFactsV1 = SessionCoordinatorFactsV1 & Readonly<{
    serverId: string;
    kind: 'session' | 'run';
    startedBy?: SessionListStartedByFactV1;
    attentionRequired?: boolean;
    scopeMatches?: Partial<Readonly<Record<SessionListScopeV1, boolean>>>;
    underSessionMatches?: boolean;
    metadata?: unknown;
    /** When presentation metadata differs, only the opened owner view may establish Project identity. */
    projectMetadata?: unknown;
    projectKey?: string | null;
    status?: SessionListStatusV1;
    /** The same canonical presenter result as status, never a Run-to-Session state conversion. */
    workStatus?: Readonly<Pick<ReturnType<typeof readSessionAwarenessWorkStatusV1>, 'bucket' | 'tone'>>;
    audiences?: readonly SessionAudienceSelectionV1[];
    tagIds?: readonly string[];
    source?: 'persisted' | 'direct';
    workspaceRefs?: readonly WorkspaceRefV1[];
    workspaceContext?: WorkspaceRefResolutionContextV1;
    machine?: QualifiedMachineV1 | null;
    agent?: string | null;
    owner?: QualifiedAccountV1;
    section?: QualifiedSessionSectionV1 | null;
    branch?: string | null;
    updatedAt?: number;
    inactive?: boolean;
    extensions?: Readonly<Record<string, EntityFilterFactValueV1>>;
}>;

/** Shared by lists, Boards, rule previews and occurrence matching. No fact lookup or graph traversal. */
export function matchSessionListFilterV1(filter: SessionListFilterV1, facts: SessionListFilterFactsV1,
    evaluator: EntityFilterEvaluatorV1 = 'list'): SessionListFilterMatchV1 {
    return compileEntityListFilterV1(sessionWorkFilterFields, filter, evaluator)(facts);
}

function sameHome(facts: SessionListFilterFactsV1, serverId: string): boolean {
    const normalize = facts.workspaceContext?.normalizeServerId ?? ((value: string) => value.trim());
    return normalize(facts.serverId) === normalize(serverId);
}

function sessionField<K extends keyof SessionListFilterV1>(
    id: K, kind: 'set' | 'boolean' | 'time' | 'domain',
    match: (selection: NonNullable<SessionListFilterV1[K]>, facts: SessionListFilterFactsV1) => SessionListFilterMatchV1,
    options: Readonly<{ listOnly?: boolean; sessionOnly?: boolean; selectionEncoding?: 'set'; active?(value: NonNullable<SessionListFilterV1[K]>): boolean }> = {},
) {
    return defineEntityFilterFieldV1<SessionListFilterV1, SessionListFilterFactsV1, NonNullable<SessionListFilterV1[K]>>({
        id, kind, evaluators: options.listOnly ? ['list'] : ['list', 'daemonRule'],
        readSelection(filter) {
            const value = filter[id];
            return value == null || options.active && !options.active(value) ? undefined : value;
        },
        replaceSelection: (filter, value) => normalizeSessionListFilterV1({ ...filter, [id]: value ?? normalizeSessionListFilterV1()[id] }),
        conditions: createEntityFilterConditionCodecV1({
            encoding: options.selectionEncoding ?? (kind === 'set' ? 'values' : kind === 'time' ? 'time' : 'value'),
            operator: id === 'excludedStatuses' ? 'is_not' : 'is',
            // The dynamic key selects the same member of the canonical shape and Filter type.
            parseValue: value => SessionListFilterFieldsV1Schema.shape[id].parse(value) as NonNullable<SessionListFilterV1[K]>,
            valueOptions: () => {
                switch (id) {
                    case 'show': return Object.values(SessionListShowV1Schema._zod.def.entries);
                    case 'startedBy': return Object.values(SessionListStartedByV1Schema._zod.def.entries);
                    case 'scope': return Object.values(SessionListScopeV1Schema._zod.def.entries);
                    case 'attention': return Object.values(SessionAttentionFilterV1Schema._zod.def.entries);
                    case 'source': return Object.values(SessionListFilterFieldsV1Schema.shape.source._zod.def.entries);
                    case 'bot': return Object.values(SessionBotFilterV1Schema._zod.def.entries);
                    case 'coordinator': return ['coordinator'];
                    case 'includeInactive': return [true, false];
                    case 'statuses': case 'excludedStatuses': return [...new Set([
                        ...Object.values(SessionAwarenessPresentationStateV1Schema._zod.def.entries),
                        ...Object.values(WorkflowRunStateV1Schema._zod.def.entries), 'stopping',
                    ])];
                    default: return [];
                }
            },
            valueGroups: () => id === 'statuses' || id === 'excludedStatuses'
                ? SESSION_WORK_STATUS_FILTERS_V1.map(value => ({ value,
                    values: listSessionPresentationStatesForWorkStatusFilterV1(value) })) : [],
        }),
        match, ...(options.sessionOnly ? { appliesTo: (facts: SessionListFilterFactsV1) => facts.kind === 'session' } : {}),
    });
}
const selectedSet = <T>(selection: SetSelectionV1<T>) => selection.include.length + selection.exclude.length > 0;

function matchSessionListStatusV1(
    values: readonly SessionListStatusV1[], facts: SessionListFilterFactsV1,
): SessionListFilterMatchV1 {
    if (facts.status === undefined) return 'unavailable';
    if (values.includes(facts.status)) return 'match';
    if (facts.kind !== 'run') return 'miss';
    // Existing editor choices store the full Session-state projection of a Work category.
    // Only that complete projection has cross-kind meaning; an exact raw-state subset stays exact.
    let missingWorkStatus = false;
    for (const choice of SESSION_WORK_STATUS_FILTERS_V1) {
        const states = listSessionPresentationStatesForWorkStatusFilterV1(choice);
        if (!states.length || !states.every(state => values.includes(state))) continue;
        if (!facts.workStatus) missingWorkStatus = true;
        else if (readWorkStatusFilterV1({ ...facts.workStatus, state: facts.status }) === choice) return 'match';
    }
    return missingWorkStatus ? 'unavailable' : 'miss';
}

/** The semantic field owner for editor availability, list membership and daemon admission. */
const builtInSessionWorkFilterFields: EntityFilterRegistryV1<SessionListFilterV1, SessionListFilterFactsV1> = [
    sessionField('homeServerIds', 'set', (values, facts) => known(values.some(value => sameHome(facts, value)))),
    sessionField('show', 'domain', (value, facts) => known(value === 'both' || (value === 'runs') === (facts.kind === 'run'))),
    sessionField('startedBy', 'set', (values, facts) => matchSessionListStartedByV1(values, facts.startedBy)),
    sessionField('scope', 'domain', (value, facts) => known(facts.scopeMatches?.[value]), { active: value => value !== 'all_accessible' }),
    sessionField('underSessionId', 'domain', (_value, facts) => known(facts.underSessionMatches)),
    sessionField('attention', 'boolean', (_value, facts) => known(facts.attentionRequired), { listOnly: true, active: value => value !== 'any' }),
    sessionField('source', 'domain', (value, facts) => known(facts.source === undefined ? undefined : value === facts.source), { active: value => value !== 'all' }),
    sessionField('bot', 'domain', (value, facts) => matchSessionBotFilterV1(facts.metadata, value), { sessionOnly: true }),
    sessionField('coordinator', 'domain', (_value, facts) => known(deriveSessionCoordinatorV1(facts)), { sessionOnly: true }),
    sessionField('statuses', 'set', matchSessionListStatusV1, { active: values => values.length > 0 }),
    sessionField('excludedStatuses', 'set', (values, facts) => {
        const result = matchSessionListStatusV1(values, facts);
        return result === 'unavailable' ? result : known(result === 'miss');
    }, { active: values => values.length > 0 }),
    sessionField('audiences', 'set', (values, facts) => known(facts.audiences === undefined ? undefined : values.some(selection => sameHome(facts, selection.serverId)
        && facts.audiences!.some(audience => selection.kind === 'outside_teams' ? audience.kind === 'outside_teams'
            : audience.kind !== 'outside_teams' && audience.teamId === selection.teamId
                && (selection.kind === 'team' || audience.kind === 'group' && audience.groupId === selection.groupId)))), { active: values => values.length > 0 }),
    sessionField('tagIds', 'set', (values, facts) => known(facts.tagIds === undefined ? undefined : values.some(tag => sameHome(facts, tag.serverId) && facts.tagIds!.includes(tag.tagId))), { active: values => values.length > 0 }),
    sessionField('projects', 'set', (value, facts) => matchEntityFilterSetV1(value, project => matchSessionProjectFilterV1(
        Object.hasOwn(facts, 'projectMetadata') ? facts.projectMetadata : facts.metadata, facts.serverId, project, facts.workspaceRefs,
        { ...facts.workspaceContext, projectKey: facts.projectKey })), { active: selectedSet, sessionOnly: true, selectionEncoding: 'set' }),
    sessionField('machines', 'set', (value, facts) => matchEntityFilterSetV1(value, machine => !sameHome(facts, machine.serverId) ? 'miss' : known(facts.machine === undefined ? undefined
        : facts.machine !== null && sameHome(facts, facts.machine.serverId) && machine.machineId === facts.machine.machineId)), { active: selectedSet, sessionOnly: true, selectionEncoding: 'set' }),
    sessionField('agents', 'set', (value, facts) => matchEntityFilterSetV1(value, agent => known(facts.agent === undefined ? undefined : facts.agent === agent)), { active: selectedSet, sessionOnly: true, selectionEncoding: 'set' }),
    sessionField('owners', 'set', (value, facts) => matchEntityFilterSetV1(value, owner => !sameHome(facts, owner.serverId) ? 'miss' : known(facts.owner === undefined ? undefined
        : sameHome(facts, facts.owner.serverId) && owner.accountId === facts.owner.accountId)), { active: selectedSet, selectionEncoding: 'set' }),
    sessionField('sections', 'set', (value, facts) => matchEntityFilterSetV1(value, section => !sameHome(facts, section.serverId) ? 'miss' : known(facts.section === undefined ? undefined
        : facts.section !== null && sameHome(facts, facts.section.serverId) && section.sectionId === facts.section.sectionId)), { active: selectedSet, sessionOnly: true, selectionEncoding: 'set' }),
    sessionField('branches', 'set', (value, facts) => matchEntityFilterSetV1(value, branch => known(facts.branch === undefined ? undefined : facts.branch === branch)), { active: selectedSet, sessionOnly: true, listOnly: true, selectionEncoding: 'set' }),
    sessionField('updated', 'time', (value, facts) => matchEntityFilterTimeV1(value, facts.updatedAt)),
    // Structural admission owns inactive filtering; this record only carries the explicit query override.
    sessionField('includeInactive', 'boolean', () => 'match', { listOnly: true }),
];

/** Installed declarations adapt held values only; the deferred host Resource producer adds no demand here. */
export function createSessionWorkFilterRegistryV1(fields: readonly AdmittedPluginListFilterFieldV1[] = []): EntityFilterRegistryV1<SessionListFilterV1, SessionListFilterFactsV1> {
    return [...builtInSessionWorkFilterFields,
        ...createPluginListFilterFieldRegistryV1<SessionListFilterV1, SessionListFilterFactsV1>(fields),
        defineEntityFilterUnknownFieldsV1<SessionListFilterV1, SessionListFilterFactsV1>([...builtInSessionWorkFilterFields.map(field => field.id), 'extensions']),
    ];
}
export const sessionWorkFilterFields = createSessionWorkFilterRegistryV1();

export function getSessionListFilterUnsupportedFieldsV1(filter: SessionListFilterV1, evaluator: EntityFilterEvaluatorV1): readonly string[] {
    return getUnsupportedEntityFilterFieldsV1(sessionWorkFilterFields, filter, evaluator);
}
export function assertSessionListFilterEvaluatorV1(filter: SessionListFilterV1, evaluator: EntityFilterEvaluatorV1): void {
    const unsupported = getSessionListFilterUnsupportedFieldsV1(filter, evaluator);
    if (unsupported.length) throw new TypeError(`Unsupported ${evaluator} filter fields: ${unsupported.join(', ')}`);
}

/** Owner metadata only. Account/Team admission and corpus membership belong to the list producer. */
export function matchSessionProjectFilterV1(
    metadata: unknown,
    serverId: string,
    project: QualifiedProjectKeyV1,
    workspaceRefs?: readonly WorkspaceRefV1[],
    context: WorkspaceRefResolutionContextV1 = {},
): 'match' | 'miss' | 'unavailable' {
    const home = context.normalizeServerId ?? ((id: string) => id.trim());
    if (home(serverId) !== home(project.serverId)) return 'miss';
    const resolved = context.sessionProjectKeyResolver
        ? context.sessionProjectKeyResolver(metadata, serverId, context.projectKey)
        : resolveSessionProjectKeyV1(metadata, serverId, workspaceRefs, context);
    if (resolved.kind === 'unavailable') return 'unavailable';
    return resolved.kind === 'resolved' && resolved.projectKey.projectKey === project.projectKey ? 'match' : 'miss';
}

/** Metadata must already be authorized/opened; a locked candidate is never an ordinary Session. */
export function matchSessionBotFilterV1(
    metadata: unknown,
    filter?: SessionBotFilterV1,
): 'match' | 'miss' | 'unavailable' {
    if (filter === undefined) return 'match';
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'unavailable';
    const candidate = (metadata as Readonly<Record<string, unknown>>).bot;
    const marker = readSessionBotV1(candidate);
    if (candidate !== undefined && marker === null) return 'unavailable';
    return (marker !== null) === (filter === 'bot') ? 'match' : 'miss';
}

function normalizeId(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim() : '';
}

function normalizeProjects(values: readonly QualifiedProjectKeyV1[]): QualifiedProjectKeyV1[] {
    const seen = new Set<string>();
    return values.flatMap(value => {
        const serverId = normalizeId(value.serverId);
        const projectKey = normalizeId(value.projectKey);
        const key = JSON.stringify([serverId, projectKey]);
        if (!serverId || !projectKey || seen.has(key)) return [];
        seen.add(key);
        return [{ serverId, projectKey }];
    });
}

export function normalizeSessionListFilterHomeIds(values: readonly string[] | undefined): string[] {
    const seen = new Set<string>();
    const next: string[] = [];
    for (const raw of values ?? []) {
        const value = normalizeId(raw);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        next.push(value);
    }
    return next;
}

function normalizeAudience(audience: QualifiedAudienceSelection): QualifiedAudienceSelection | null {
    const serverId = normalizeId(audience.serverId);
    if (!serverId) return null;
    if (audience.kind === 'outside_teams') return { serverId, kind: 'outside_teams' };
    const teamId = normalizeId(audience.teamId);
    if (!teamId) return null;
    if (audience.kind === 'team') return { serverId, kind: 'team', teamId };
    const groupId = normalizeId(audience.groupId);
    return groupId ? { serverId, kind: 'group', teamId, groupId } : null;
}

export function buildQualifiedAudienceSelectionKey(audience: QualifiedAudienceSelection): string {
    if (audience.kind === 'outside_teams') return JSON.stringify([normalizeId(audience.serverId), audience.kind]);
    if (audience.kind === 'team') {
        return JSON.stringify([normalizeId(audience.serverId), audience.kind, normalizeId(audience.teamId)]);
    }
    return JSON.stringify([
        normalizeId(audience.serverId), audience.kind, normalizeId(audience.teamId), normalizeId(audience.groupId),
    ]);
}

export function buildQualifiedTagAddressKey(address: QualifiedTagAddress): string {
    return JSON.stringify([normalizeId(address.serverId), normalizeId(address.tagId)]);
}

export function normalizeSessionListFilterAudiences(
    values: readonly QualifiedAudienceSelection[] | undefined,
): QualifiedAudienceSelection[] {
    const seen = new Set<string>();
    const next: QualifiedAudienceSelection[] = [];
    for (const value of values ?? []) {
        const normalized = normalizeAudience(value);
        if (!normalized) continue;
        const key = buildQualifiedAudienceSelectionKey(normalized);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(normalized);
    }
    return next;
}

export function normalizeSessionListFilterTagIds(values: readonly QualifiedTagAddress[] | undefined): QualifiedTagAddress[] {
    const seen = new Set<string>();
    const next: QualifiedTagAddress[] = [];
    for (const value of values ?? []) {
        const serverId = normalizeId(value.serverId);
        const tagId = normalizeId(value.tagId);
        if (!serverId || !tagId) continue;
        const normalized = { serverId, tagId };
        const key = buildQualifiedTagAddressKey(normalized);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(normalized);
    }
    return next;
}

/** Retains the live list's defaults, identity qualification, order and deduplication. */
export function normalizeSessionListFilterV1(input: SessionListFilterDefaultsInputV1 = {}): SessionListFilterV1 {
    return {
        // Stored future narrowing survives normalization; current writes validate before reaching here.
        ...input,
        show: input.show ?? 'both',
        startedBy: [...new Set<SessionListFilterV1['startedBy'][number]>(input.startedBy ?? ['you'])],
        scope: input.scope ?? 'my_work',
        attention: input.attention ?? 'any',
        ...(input.bot === undefined ? {} : { bot: input.bot }),
        ...(input.coordinator === undefined ? {} : { coordinator: input.coordinator }),
        ...(input.projects === undefined ? {} : { projects: { include: normalizeProjects(input.projects.include), exclude: normalizeProjects(input.projects.exclude) } }),
        ...(input.statuses === undefined ? {} : { statuses: [...new Set(input.statuses)] }),
        ...(input.excludedStatuses === undefined ? {} : { excludedStatuses: [...new Set(input.excludedStatuses)] }),
        ...(normalizeId(input.underSessionId) ? { underSessionId: normalizeId(input.underSessionId) } : {}),
        homeServerIds: normalizeSessionListFilterHomeIds(input.homeServerIds),
        audiences: normalizeSessionListFilterAudiences(input.audiences),
        tagIds: normalizeSessionListFilterTagIds(input.tagIds),
        source: input.source ?? 'all',
    };
}

const SelectionIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const AgentTargetKeySchema = lazyZodSchema(() => z.pipe(BackendTargetKeyV2Schema,
    z.string().check(z.refine(value => parseBackendTargetKeyV2(value).kind === 'agent'))));
const QualifiedAudienceSelectionSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionAudienceSelectionV1Schema._zod.def.options[0], { serverId: SelectionIdSchema })),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionAudienceSelectionV1Schema._zod.def.options[1], { serverId: SelectionIdSchema })),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionAudienceSelectionV1Schema._zod.def.options[2], { serverId: SelectionIdSchema })),
]));

/** V1 selection envelope and nested qualified identities are closed; UI state is never serialized. */
export const SessionListFilterFieldsV1Schema = lazyZodSchema(() => z.strictObject({
    show: SessionListShowV1Schema,
    startedBy: z.array(SessionListStartedByV1Schema),
    scope: SessionListScopeV1Schema,
    attention: SessionAttentionFilterV1Schema,
    bot: z.optional(SessionBotFilterV1Schema),
    coordinator: z.optional(z.literal('coordinator')),
    projects: z.optional(z.strictObject({ include: z.array(QualifiedProjectKeyV1Schema), exclude: z.array(QualifiedProjectKeyV1Schema) })),
    statuses: z.optional(z.array(SessionListStatusV1Schema)),
    excludedStatuses: z.optional(z.array(SessionListStatusV1Schema)),
    machines: z.optional(z.strictObject({ include: z.array(z.strictObject({ serverId: SelectionIdSchema, machineId: SelectionIdSchema })), exclude: z.array(z.strictObject({ serverId: SelectionIdSchema, machineId: SelectionIdSchema })) })),
    agents: z.optional(z.strictObject({ include: z.array(AgentTargetKeySchema), exclude: z.array(AgentTargetKeySchema) })),
    sections: z.optional(z.strictObject({ include: z.array(QualifiedSessionSectionV1Schema), exclude: z.array(QualifiedSessionSectionV1Schema) })),
    owners: z.optional(z.strictObject({ include: z.array(z.strictObject({ serverId: SelectionIdSchema, accountId: SelectionIdSchema })), exclude: z.array(z.strictObject({ serverId: SelectionIdSchema, accountId: SelectionIdSchema })) })),
    branches: z.optional(z.strictObject({ include: z.array(z.string()), exclude: z.array(z.string()) })),
    updated: z.optional(UpdatedSelectionV1Schema),
    includeInactive: z.optional(z.boolean()),
    extensions: z.optional(z.record(SelectionIdSchema, ExtensionSelectionV1Schema)),
    underSessionId: z.optional(SelectionIdSchema),
    homeServerIds: z.array(z.string()),
    audiences: z.array(QualifiedAudienceSelectionSchema),
    tagIds: z.array(z.strictObject({ serverId: SelectionIdSchema, tagId: SelectionIdSchema })),
    source: z.enum(['all', 'persisted', 'direct']),
}));

export const SessionListFilterV1Schema: z.ZodMiniType<SessionListFilterV1, SessionListFilterV1> = lazyZodSchema(
    () => z.pipe(SessionListFilterFieldsV1Schema, z.transform((value): SessionListFilterV1 => normalizeSessionListFilterV1(value))),
);

export const SessionListFilterStoredReadV1Schema = lazyZodSchema(() => z.pipe(
    createEntityListFilterStoredReadSchemaV1(SessionListFilterFieldsV1Schema),
    z.transform((value): SessionListFilterV1 => normalizeSessionListFilterV1(value)),
));
defineStoredReadProjection(SessionListFilterV1Schema, () => SessionListFilterStoredReadV1Schema);

export const SessionListFilterDaemonRuleV1Schema = lazyZodSchema(() => SessionListFilterV1Schema.check(
    z.refine(filter => getSessionListFilterUnsupportedFieldsV1(filter, 'daemonRule').length === 0),
));
defineStoredReadProjection(SessionListFilterDaemonRuleV1Schema, () => SessionListFilterStoredReadV1Schema);
