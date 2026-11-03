import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { QualifiedProjectKeyV1Schema } from '../../workspaces/workspaceRefV1.js';
import { PluginUiIconTokenV1Schema } from '../../plugins/contributions/ui/tokens.js';
import { SessionListFilterV1Schema, normalizeSessionListFilterV1, getSessionListFilterUnsupportedFieldsV1 } from '../../sessions/listFilter/sessionListFilterV1.js';
import { WorkflowListFilterV1Schema, DEFAULT_WORKFLOW_LIST_FILTER_V1, workflowListFilterFieldsV1 } from '../../workflows/listing/workflowListFilterV1.js';
import { DiscussionListFilterV1Schema, DEFAULT_DISCUSSION_LIST_FILTER_V1, discussionListFilterFieldsV1 } from '../../discussions/listing/discussionListFilterV1.js';
import type { CollectionFilterMapV1 } from '../filter/entityListFilterV1.js';
import { getUnsupportedEntityFilterFieldsV1 } from '../filter/fieldRegistryV1.js';
export type { CollectionFilterMapV1 } from '../filter/entityListFilterV1.js';

/** V1 persisted identities and mutation envelopes are closed; settings owns byte bounds and sealing. */
export const CollectionEntityKindV1Schema = lazyZodSchema(() => z.enum(['sessionWork', 'workflow', 'discussion']));
export type CollectionEntityKindV1 = keyof CollectionFilterMapV1;
const IdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
export const CollectionSpaceIconV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('icon'), name: PluginUiIconTokenV1Schema }),
    z.strictObject({ kind: z.literal('project'), project: QualifiedProjectKeyV1Schema }),
]));
export type CollectionSpaceIconV1 = z.infer<typeof CollectionSpaceIconV1Schema>;
export const QualifiedSessionSpaceTagV1Schema = lazyZodSchema(() => z.strictObject({ serverId: IdSchema, accountId: IdSchema, tagId: IdSchema }));
export type QualifiedSessionSpaceTagV1 = Readonly<z.infer<typeof QualifiedSessionSpaceTagV1Schema>>;
export const SessionSpaceMembershipV1Schema = lazyZodSchema(() => z.strictObject({
    mode: z.enum(['filter_or_manual', 'manual_only']), tags: z.array(QualifiedSessionSpaceTagV1Schema)
        .check(z.refine(tags => new Set(tags.map(tag => JSON.stringify([tag.serverId, tag.accountId]))).size === tags.length)),
}));
export type SessionSpaceMembershipV1 = Readonly<{ mode: 'filter_or_manual' | 'manual_only'; tags: readonly QualifiedSessionSpaceTagV1[] }>;
export type CollectionSpaceV1<K extends CollectionEntityKindV1 = CollectionEntityKindV1> = {
    [E in K]: Readonly<{ entityKind: E; id: string; name: string; icon: CollectionSpaceIconV1;
        filter: CollectionFilterMapV1[E]; includeNeedsYouEverywhere: boolean;
        membership?: E extends 'sessionWork' ? SessionSpaceMembershipV1 : never }>;
}[K];
export type CollectionSpacesV1 = Readonly<{ v: 1; spaces: readonly CollectionSpaceV1[] }>;
export type CollectionSpaceSelectionV1 = Readonly<{ v: 1; byAccountScope: Readonly<Record<string,
    Partial<Readonly<Record<CollectionEntityKindV1, Readonly<{ spaceId: string }>>>>>> }>;
const DEFAULT_IDS = { sessionWork: 'my-work', workflow: 'all-workflows', discussion: 'all-discussions' } as const satisfies Record<CollectionEntityKindV1, string>;
const DEFAULT_NAMES = { sessionWork: 'My work', workflow: 'All workflows', discussion: 'All discussions' } as const satisfies Record<CollectionEntityKindV1, string>;
export function getDefaultCollectionSpaceIdV1<K extends CollectionEntityKindV1>(entityKind: K): typeof DEFAULT_IDS[K] {
    return DEFAULT_IDS[entityKind];
}
function belongsToKind(id: string, entityKind: CollectionEntityKindV1): boolean {
    return !Object.values(DEFAULT_IDS).some(defaultId => defaultId === id) || id === DEFAULT_IDS[entityKind];
}
function spaceFields<FilterSchema extends z.core.$ZodType>(filter: FilterSchema) {
    return { id: IdSchema, name: IdSchema, icon: CollectionSpaceIconV1Schema, filter, includeNeedsYouEverywhere: z.boolean() };
}
const SessionSpaceSchema = lazyZodSchema(() => z.strictObject({ entityKind: z.literal('sessionWork'), ...spaceFields(SessionListFilterV1Schema), membership: z.optional(SessionSpaceMembershipV1Schema) }));
const WorkflowSpaceSchema = lazyZodSchema(() => z.strictObject({ entityKind: z.literal('workflow'), ...spaceFields(WorkflowListFilterV1Schema) }));
const DiscussionSpaceSchema = lazyZodSchema(() => z.strictObject({ entityKind: z.literal('discussion'), ...spaceFields(DiscussionListFilterV1Schema) }));
export const CollectionSpaceV1Schema = lazyZodSchema(() => z.discriminatedUnion('entityKind', [
    SessionSpaceSchema, WorkflowSpaceSchema, DiscussionSpaceSchema,
]).check(z.refine(space => belongsToKind(space.id, space.entityKind))));
export const CollectionSpacesV1Schema = lazyZodSchema(() => z.strictObject({ v: z.literal(1), spaces: z.array(CollectionSpaceV1Schema)
    .check(z.refine(spaces => new Set(spaces.map(space => space.id)).size === spaces.length)) }));
export const CollectionSpacesStoredReadV1Schema = createStoredReadSchema(CollectionSpacesV1Schema);
export const CollectionSpaceSelectionV1Schema = lazyZodSchema(() => z.strictObject({ v: z.literal(1), byAccountScope: z.record(IdSchema,
    z.strictObject({ sessionWork: z.optional(z.strictObject({ spaceId: IdSchema })), workflow: z.optional(z.strictObject({ spaceId: IdSchema })),
        discussion: z.optional(z.strictObject({ spaceId: IdSchema })) })) }));
export const CollectionSpaceSelectionValueV1Schema = lazyZodSchema(() => z.strictObject({ spaceId: IdSchema }));

export type CollectionSpaceMutationV1<K extends CollectionEntityKindV1> =
    | Readonly<{ op: 'create'; space: CollectionSpaceV1<K> }>
    | Readonly<{ op: 'edit'; spaceId: string; changes: Partial<Pick<CollectionSpaceV1<K>, 'name' | 'icon' | 'filter' | 'includeNeedsYouEverywhere'>> & { membership?: K extends 'sessionWork' ? Pick<SessionSpaceMembershipV1, 'mode'> : never } }>
    | Readonly<{ op: 'delete'; spaceId: string }>
    | Readonly<{ op: 'reorder'; spaceId: string; beforeSpaceId: string | null }>
    | Readonly<{ op: 'resetDefault' }>
    | (K extends 'sessionWork' ? Readonly<{ op: 'associateTag'; spaceId: string; tag: QualifiedSessionSpaceTagV1 }> : never);
export type CollectionSpaceOperationV1 = { [K in CollectionEntityKindV1]: Readonly<{
    kind: 'collection_space'; entityKind: K; mutation: CollectionSpaceMutationV1<K>;
}> }[CollectionEntityKindV1];
function mutationSchema<FilterSchema extends z.core.$ZodType, SpaceSchema extends z.core.$ZodType<Readonly<{ id: string }>>>(filter: FilterSchema, space: SpaceSchema, entityKind: CollectionEntityKindV1) {
    const entityId = IdSchema.check(z.refine(id => belongsToKind(id, entityKind)));
    return z.discriminatedUnion('op', [
        z.strictObject({ op: z.literal('create'), space }).check(z.refine(input => {
            // The containing strict object has admitted `space` through the supplied id-bearing schema.
            const candidate = (input as Readonly<{ space: z.output<SpaceSchema> }>).space;
            return candidate.id !== DEFAULT_IDS[entityKind] && belongsToKind(candidate.id, entityKind);
        })),
        z.strictObject({ op: z.literal('edit'), spaceId: entityId, changes: z.strictObject({
            name: z.optional(IdSchema), icon: z.optional(CollectionSpaceIconV1Schema), filter: z.optional(filter), includeNeedsYouEverywhere: z.optional(z.boolean()),
            ...(entityKind === 'sessionWork' ? { membership: z.optional(z.strictObject({ mode: SessionSpaceMembershipV1Schema.shape.mode })) } : {}),
        }) }),
        z.strictObject({ op: z.literal('delete'), spaceId: entityId.check(z.refine(id => id !== DEFAULT_IDS[entityKind])) }),
        z.strictObject({ op: z.literal('reorder'), spaceId: entityId, beforeSpaceId: z.nullable(entityId) }),
        z.strictObject({ op: z.literal('resetDefault') }),
        ...(entityKind === 'sessionWork' ? [z.strictObject({ op: z.literal('associateTag'), spaceId: entityId, tag: QualifiedSessionSpaceTagV1Schema })] : []),
    ]);
}
export const CollectionSpaceOperationV1Schema = lazyZodSchema(() => z.discriminatedUnion('entityKind', [
    z.strictObject({ kind: z.literal('collection_space'), entityKind: z.literal('sessionWork'), mutation: mutationSchema(SessionListFilterV1Schema, SessionSpaceSchema, 'sessionWork') }),
    z.strictObject({ kind: z.literal('collection_space'), entityKind: z.literal('workflow'), mutation: mutationSchema(WorkflowListFilterV1Schema, WorkflowSpaceSchema, 'workflow') }),
    z.strictObject({ kind: z.literal('collection_space'), entityKind: z.literal('discussion'), mutation: mutationSchema(DiscussionListFilterV1Schema, DiscussionSpaceSchema, 'discussion') }),
]));

export function createDefaultCollectionSpaceV1<K extends CollectionEntityKindV1>(entityKind: K,
    override?: Readonly<{ name?: string; filter?: CollectionFilterMapV1[K] }>): CollectionSpaceV1<K> {
    const filter = override?.filter ?? (entityKind === 'sessionWork' ? normalizeSessionListFilterV1()
        : entityKind === 'workflow' ? DEFAULT_WORKFLOW_LIST_FILTER_V1 : DEFAULT_DISCUSSION_LIST_FILTER_V1);
    // The discriminant selects the corresponding filter; TypeScript cannot narrow a generic key.
    return { entityKind, id: DEFAULT_IDS[entityKind], name: override?.name ?? DEFAULT_NAMES[entityKind],
        icon: { kind: 'icon', name: entityKind === 'discussion' ? 'conversations' : 'list' }, filter,
        includeNeedsYouEverywhere: false } as CollectionSpaceV1<K>;
}
export function resolveCollectionSpacesV1<K extends CollectionEntityKindV1>(catalog: CollectionSpacesV1, entityKind: K,
    defaultOverride?: Readonly<{ name?: string; filter?: CollectionFilterMapV1[K] }>): readonly CollectionSpaceV1<K>[] {
    const spaces = catalog.spaces.filter((space): space is CollectionSpaceV1 & CollectionSpaceV1<K> => space.entityKind === entityKind);
    const defaultId: string = DEFAULT_IDS[entityKind];
    return spaces.some(space => space.id === defaultId) ? spaces : [createDefaultCollectionSpaceV1(entityKind, defaultOverride), ...spaces];
}
export type CollectionSpacesMutationResultV1 = Readonly<{ ok: true; value: CollectionSpacesV1 }>
    | Readonly<{ ok: false; reason: 'space_not_found' | 'space_already_exists' | 'space_entity_mismatch' | 'default_space_reserved' | 'unsupported_filter_fields' }>;
export type CollectionSpaceDefaultBasisV1 = Partial<Readonly<{ [K in CollectionEntityKindV1]: CollectionSpaceV1<K> }>>;

function changedFilter<Filter>(mutation: Readonly<{ op: 'create'; space: Readonly<{ filter: Filter }> }>
    | Readonly<{ op: 'edit'; changes: Readonly<{ filter?: Filter }> }>
    | Readonly<{ op: 'delete' | 'reorder' | 'resetDefault' | 'associateTag' }>): Filter | undefined {
    return mutation.op === 'create' ? mutation.space.filter : mutation.op === 'edit' ? mutation.changes.filter : undefined;
}
/** Only new membership selections are admitted; unrelated edits retain stored unavailable narrowing. */
function supportsChangedFilter(operation: CollectionSpaceOperationV1): boolean {
    switch (operation.entityKind) {
        case 'sessionWork': {
            const filter = changedFilter(operation.mutation);
            return filter === undefined || getSessionListFilterUnsupportedFieldsV1(filter, 'list').length === 0;
        }
        case 'workflow': {
            const filter = changedFilter(operation.mutation);
            return filter === undefined || getUnsupportedEntityFilterFieldsV1(workflowListFilterFieldsV1, filter, 'list').length === 0;
        }
        case 'discussion': {
            const filter = changedFilter(operation.mutation);
            return filter === undefined || getUnsupportedEntityFilterFieldsV1(discussionListFilterFieldsV1, filter, 'list').length === 0;
        }
    }
}
/** Intent is already admitted. Reapply this reducer to each CAS winner, never to a captured replacement array. */
export function reduceCollectionSpacesV1(catalog: CollectionSpacesV1, operation: CollectionSpaceOperationV1,
    defaultBasis: CollectionSpaceDefaultBasisV1 = {}): CollectionSpacesMutationResultV1 {
    const { entityKind, mutation } = operation;
    if (!supportsChangedFilter(operation)) return { ok: false, reason: 'unsupported_filter_fields' };
    const defaultId = DEFAULT_IDS[entityKind];
    const defaultSpace = () => defaultBasis[entityKind] ?? createDefaultCollectionSpaceV1(entityKind);
    const ok = (spaces: readonly CollectionSpaceV1[]): CollectionSpacesMutationResultV1 => ({ ok: true, value: spaces === catalog.spaces ? catalog : { ...catalog, spaces } });
    if (mutation.op === 'create') {
        if (mutation.space.entityKind !== entityKind) return { ok: false, reason: 'space_entity_mismatch' };
        if (!belongsToKind(mutation.space.id, entityKind) || mutation.space.id === defaultId) return { ok: false, reason: 'default_space_reserved' };
        if (catalog.spaces.some(space => space.id === mutation.space.id)) return { ok: false, reason: 'space_already_exists' };
        return ok([...catalog.spaces, mutation.space]);
    }
    const spaceId = mutation.op === 'resetDefault' ? defaultId : mutation.spaceId;
    const target = catalog.spaces.find(space => space.id === spaceId);
    if (target && target.entityKind !== entityKind || !belongsToKind(spaceId, entityKind)) return { ok: false, reason: 'space_entity_mismatch' };
    if (!target && spaceId !== defaultId) return { ok: false, reason: 'space_not_found' };
    if (mutation.op === 'delete') {
        if (spaceId === defaultId) return { ok: false, reason: 'default_space_reserved' };
        return ok(catalog.spaces.filter(space => space.id !== spaceId));
    }
    if (mutation.op === 'resetDefault') return target ? ok(catalog.spaces.map(space => space === target ? defaultSpace() : space)) : ok(catalog.spaces);
    let spaces = catalog.spaces;
    if (!target || mutation.op === 'reorder' && mutation.beforeSpaceId === defaultId && !spaces.some(space => space.id === defaultId)) {
        const first = spaces.findIndex(space => space.entityKind === entityKind);
        const insertion = first < 0 ? spaces.length : first;
        spaces = [...spaces.slice(0, insertion), defaultSpace(), ...spaces.slice(insertion)];
    }
    if (mutation.op === 'edit') return ok(spaces.map(space => {
        if (space.id !== spaceId) return space;
        if (operation.entityKind === 'sessionWork' && operation.mutation.op === 'edit' && space.entityKind === 'sessionWork') {
            const { membership, ...changes } = operation.mutation.changes;
            return { ...space, ...changes, ...(membership ? { membership: { mode: membership.mode, tags: space.membership?.tags ?? [] } } : {}) };
        }
        return { ...space, ...mutation.changes } as CollectionSpaceV1;
    }));
    if (mutation.op === 'associateTag') {
        const current = spaces.find(space => space.id === spaceId);
        if (current?.entityKind !== 'sessionWork') return { ok: false, reason: 'space_entity_mismatch' };
        const tags = current.membership?.tags ?? [];
        const existing = tags.find(tag => tag.serverId === mutation.tag.serverId && tag.accountId === mutation.tag.accountId);
        // An overlapping first use must retain the tag already assigned to earlier Sessions.
        if (existing) return ok(catalog.spaces);
        const membership: SessionSpaceMembershipV1 = { mode: current.membership?.mode ?? 'filter_or_manual',
            tags: [...tags, mutation.tag] };
        return ok(spaces.map(space => space === current ? { ...current, membership } : space));
    }
    const entitySpaces = spaces.filter(space => space.entityKind === entityKind);
    if (mutation.beforeSpaceId !== null && !entitySpaces.some(space => space.id === mutation.beforeSpaceId)) return { ok: false, reason: 'space_not_found' };
    if (mutation.beforeSpaceId === spaceId) return ok(catalog.spaces);
    const ordered = entitySpaces.filter(space => space.id !== spaceId);
    const moving = entitySpaces.find(space => space.id === spaceId)!;
    const before = mutation.beforeSpaceId === null ? ordered.length : ordered.findIndex(space => space.id === mutation.beforeSpaceId);
    ordered.splice(before, 0, moving);
    let index = 0;
    return ok(spaces.map(space => space.entityKind === entityKind ? ordered[index++]! : space));
}
export function selectCollectionSpaceV1(selection: CollectionSpaceSelectionV1, accountScopeKey: string, entityKind: CollectionEntityKindV1, spaceId: string): CollectionSpaceSelectionV1 {
    if (selection.byAccountScope[accountScopeKey]?.[entityKind]?.spaceId === spaceId) return selection;
    return { ...selection, byAccountScope: { ...selection.byAccountScope, [accountScopeKey]: { ...selection.byAccountScope[accountScopeKey], [entityKind]: { spaceId } } } };
}
export function resolveCollectionSpaceSelectionV1<K extends CollectionEntityKindV1>(selection: CollectionSpaceSelectionV1, accountScopeKey: string,
    entityKind: K, spaces: readonly CollectionSpaceV1<K>[], state: Readonly<{ authoritative: boolean }>): string {
    const selectedId = selection.byAccountScope[accountScopeKey]?.[entityKind]?.spaceId ?? DEFAULT_IDS[entityKind];
    return !state.authoritative || spaces.some(space => space.id === selectedId) ? selectedId : DEFAULT_IDS[entityKind];
}
