import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema, PluginContributionIdentityV1Schema, buildQualifiedPluginContributionKey } from '../../plugins/contributionIdentity.js';
import { PluginContributionReferenceV2Schema, PluginLocalizedStringV2Schema } from '../../plugins/contributions/publicTypes.js';
import { PluginUiIconTokenV1Schema } from '../../plugins/contributions/ui/tokens.js';
import { EntityFilterFactValueV1Schema, ExtensionSelectionV1Schema, matchEntityFilterExtensionV1, type EntityFilterFactValueV1, type ExtensionSelectionV1 } from './entityListFilterV1.js';
import { defineEntityFilterFieldV1, type EntityFilterRegistryV1 } from './fieldRegistryV1.js';
import { createEntityFilterConditionCodecV1 } from './fieldConditionsV1.js';

/** V1 constituent of ui.listExtensions; declaration and values contain no executable matcher. */
export const PluginListFilterFieldV1Schema = lazyZodSchema(() => z.strictObject({
    id: asProtocolZod(PluginContributionLocalIdSchema),
    title: PluginLocalizedStringV2Schema,
    icon: z.optional(PluginUiIconTokenV1Schema),
    source: z.union([
        z.strictObject({ factKey: z.string().check(z.minLength(1)) }),
        z.strictObject({ resource: asProtocolZod(PluginContributionReferenceV2Schema) }),
    ]),
    value: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('set'), options: z.optional(z.array(z.strictObject({ value: z.string(), title: PluginLocalizedStringV2Schema }))) }),
        z.strictObject({ kind: z.literal('boolean') }),
        z.strictObject({ kind: z.literal('time') }),
        // Display-only until the filter selection owner supports numeric operators.
        z.strictObject({ kind: z.literal('number'), unit: z.string().check(z.minLength(1)) }),
    ]),
    column: z.optional(z.strictObject({
        title: z.optional(PluginLocalizedStringV2Schema),
        qualifier: z.optional(PluginLocalizedStringV2Schema),
        width: z.optional(z.number().check(z.gt(0))),
        align: z.optional(z.enum(['start', 'end'])),
        priority: z.optional(z.number()),
        defaultHidden: z.optional(z.boolean()),
    })),
}));
export type PluginListFilterFieldV1 = z.infer<typeof PluginListFilterFieldV1Schema>;
export type AdmittedPluginListFilterFieldV1 = Readonly<{ id: string; declaration: PluginListFilterFieldV1 }>;
export type PluginListFilterSelectionV1 = Readonly<{ extensions?: Readonly<Record<string, ExtensionSelectionV1>> }>;
export type PluginListFilterFactsV1 = Readonly<{ extensions?: Readonly<Record<string, EntityFilterFactValueV1>> }>;

/** The Services fact adapter binds one Resource read to its mounted Environment rows. */
export const PluginServiceListFieldResourceInputV1Schema = lazyZodSchema(() => z.strictObject({
    entity: z.literal('service'),
    environmentIds: z.array(z.string().check(z.minLength(1))),
}));
export type PluginServiceListFieldResourceInputV1 = z.infer<typeof PluginServiceListFieldResourceInputV1Schema>;
/** Row addressing only; field-specific value semantics remain at the existing scalar ingress. */
export const PluginServiceListFieldResourceResultV1Schema = lazyZodSchema(() => z.strictObject({
    items: z.array(z.strictObject({
        environmentId: z.string().check(z.minLength(1)),
        value: EntityFilterFactValueV1Schema,
    })),
}));
export type PluginServiceListFieldResourceResultV1 = z.infer<typeof PluginServiceListFieldResourceResultV1Schema>;

/** Current writes require a live declaration of the exact selection kind. Stored reads stay opaque. */
export function validatePluginListFilterSelectionsV1(fields: readonly AdmittedPluginListFilterFieldV1[], extensions: unknown): boolean {
    if (extensions === undefined) return true;
    if (extensions === null || typeof extensions !== 'object' || Array.isArray(extensions)) return false;
    const byId = new Map(fields.map(field => [field.id, field.declaration.value.kind]));
    return Object.entries(extensions).every(([id, value]) => {
        const parsed = ExtensionSelectionV1Schema.safeParse(value);
        return parsed.success && byId.get(id) === parsed.data.kind;
    });
}

/** The list's fact adapter owns the allowlist; this operation acquires no facts or Resources. */
export function admitPluginListFilterFieldV1(input: Readonly<{
    pluginId: string; field: unknown; factKeys: ReadonlySet<string>; hostFieldIds?: ReadonlySet<string>;
}>): Readonly<{ kind: 'admitted'; field: AdmittedPluginListFilterFieldV1 }>
    | Readonly<{ kind: 'invalid'; reason: 'invalid_declaration' | 'host_field_collision' | 'unavailable_fact_source' }> {
    const parsed = PluginListFilterFieldV1Schema.safeParse(input.field);
    if (!parsed.success) return { kind: 'invalid', reason: 'invalid_declaration' };
    const identity = PluginContributionIdentityV1Schema.safeParse({ pluginId: input.pluginId, localId: parsed.data.id });
    if (!identity.success) return { kind: 'invalid', reason: 'invalid_declaration' };
    const id = buildQualifiedPluginContributionKey(identity.data);
    if (input.hostFieldIds?.has(id)) return { kind: 'invalid', reason: 'host_field_collision' };
    if ('factKey' in parsed.data.source && !input.factKeys.has(parsed.data.source.factKey)) return { kind: 'invalid', reason: 'unavailable_fact_source' };
    return { kind: 'admitted', field: { id, declaration: parsed.data } };
}

/** Called once by the existing value ingress. Evaluation consumes the admitted scalar/set/time. */
export function admitPluginListFilterFieldValueV1(field: Pick<PluginListFilterFieldV1, 'value'>, value: unknown):
    Readonly<{ kind: 'available'; value: EntityFilterFactValueV1 }> | Readonly<{ kind: 'invalid' }> {
    const valid = field.value.kind === 'set'
        ? value === null || typeof value === 'string' || Array.isArray(value) && value.every(item => typeof item === 'string')
        : field.value.kind === 'boolean' ? typeof value === 'boolean'
            : field.value.kind === 'number' ? typeof value === 'number' && Number.isFinite(value)
                : typeof value === 'number' && Number.isSafeInteger(value);
    if (!valid) return { kind: 'invalid' };
    // The closed value check above is the boundary from untyped Resource or plugin-page data.
    return { kind: 'available', value: value as EntityFilterFactValueV1 };
}

/** Public pure adapter: held facts only; no activation, Action, Resource read, watch or predicate callback. */
export function createPluginListFilterFieldRegistryV1<Filter extends PluginListFilterSelectionV1, Facts extends PluginListFilterFactsV1>(
    fields: readonly AdmittedPluginListFilterFieldV1[],
): EntityFilterRegistryV1<Filter, Facts> {
    const registry = fields.flatMap(field => {
        const value = field.declaration.value;
        if (value.kind === 'number') return [];
        return [defineEntityFilterFieldV1<Filter, Facts, ExtensionSelectionV1 | null>({
            id: field.id, kind: value.kind, evaluators: ['list'],
            readSelection(filter) {
                if (!filter.extensions || !Object.hasOwn(filter.extensions, field.id)) return undefined;
                const parsed = ExtensionSelectionV1Schema.safeParse(filter.extensions[field.id]);
                return parsed.success && parsed.data.kind === value.kind ? parsed.data : null;
            },
            replaceSelection(filter, selection) {
                const extensions = { ...filter.extensions };
                if (selection == null) delete extensions[field.id];
                else extensions[field.id] = selection;
                return { ...filter, extensions };
            },
            match: (selection, facts) => selection === null ? 'unavailable' : matchEntityFilterExtensionV1(selection, facts.extensions?.[field.id]),
            conditions: createEntityFilterConditionCodecV1({
                encoding: value.kind === 'boolean' ? 'value' : value.kind,
                valueFromSelection(selection) {
                    if (!selection || selection.kind !== value.kind) throw new TypeError('Unavailable plugin condition');
                    return selection.kind === 'time' ? selection.selection : selection.kind === 'boolean' ? selection.value : selection;
                },
                parseValue(conditionValue) {
                    const kind = value.kind;
                    const candidate = kind === 'set' && conditionValue && typeof conditionValue === 'object' && !Array.isArray(conditionValue)
                        ? { ...conditionValue, kind } : kind === 'boolean' ? { kind, value: conditionValue } : { kind, selection: conditionValue };
                    const parsed = ExtensionSelectionV1Schema.parse(candidate);
                    if (parsed.kind !== kind) throw new TypeError('Mismatched plugin condition');
                    return parsed;
                },
                valueOptions: () => value.kind === 'set' ? value.options?.map(option => option.value) ?? []
                    : value.kind === 'boolean' ? [true, false] : [],
            }),
        })];
    });
    const known = new Set(registry.map(field => field.id));
    return [...registry, defineEntityFilterFieldV1<Filter, Facts, true>({
        id: 'unavailableExtensions', kind: 'domain', evaluators: [],
        readSelection: filter => Object.keys(filter.extensions ?? {}).some(id => !known.has(id)) ? true : undefined,
        replaceSelection(filter) {
            return { ...filter, extensions: Object.fromEntries(Object.entries(filter.extensions ?? {}).filter(([id]) => known.has(id))) };
        },
        match: () => 'unavailable',
    })];
}
