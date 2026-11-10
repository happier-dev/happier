import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { compileEntityListFilterV1, createEntityListFilterStoredReadSchemaV1, ExtensionSelectionV1Schema, matchEntityFilterKnownV1 } from '../../collections/filter/entityListFilterV1.js';
import { defineEntityFilterFieldV1, defineEntityFilterUnknownFieldsV1, type EntityFilterEvaluatorV1 } from '../../collections/filter/fieldRegistryV1.js';
import { createPluginListFilterFieldRegistryV1, type AdmittedPluginListFilterFieldV1, type PluginListFilterFactsV1 } from '../../collections/filter/pluginListFilterFieldV1.js';
import { createEntityFilterConditionCodecV1 } from '../../collections/filter/fieldConditionsV1.js';

export const DiscussionListFilterV1Schema = lazyZodSchema(() => z.strictObject({
    state: z.enum(['active', 'archived']), attention: z.enum(['any', 'needs_you']), unreadOnly: z.boolean(),
    extensions: z.optional(z.record(z.string(), ExtensionSelectionV1Schema)),
}));
export type DiscussionListFilterV1 = z.infer<typeof DiscussionListFilterV1Schema>;
export const DiscussionListFilterPatchV1Schema = lazyZodSchema(() => z.partial(DiscussionListFilterV1Schema));
export const DiscussionListFilterV1StoredSchema = lazyZodSchema(() => createEntityListFilterStoredReadSchemaV1(DiscussionListFilterV1Schema));
defineStoredReadProjection(DiscussionListFilterV1Schema, () => DiscussionListFilterV1StoredSchema);
export const DEFAULT_DISCUSSION_LIST_FILTER_V1: DiscussionListFilterV1 = Object.freeze({ state: 'active', attention: 'any', unreadOnly: false });
export type DiscussionListFilterFactsV1 = PluginListFilterFactsV1 & Readonly<{ state: 'active' | 'archived'; needsYou?: boolean; unread?: boolean }>;

const state = defineEntityFilterFieldV1<DiscussionListFilterV1, DiscussionListFilterFactsV1, DiscussionListFilterV1['state']>({
    id: 'state', kind: 'domain', evaluators: ['list'],
    readSelection: filter => filter.state,
    replaceSelection: (filter, selection) => ({ ...filter, state: selection ?? 'active' }),
    match: (selection, facts) => matchEntityFilterKnownV1(selection === facts.state),
    conditions: createEntityFilterConditionCodecV1({ encoding: 'value',
        parseValue: value => DiscussionListFilterV1Schema.shape.state.parse(value),
        valueOptions: () => Object.values(DiscussionListFilterV1Schema.shape.state._zod.def.entries),
    }),
});
const attention = defineEntityFilterFieldV1<DiscussionListFilterV1, DiscussionListFilterFactsV1, true>({
    id: 'attention', kind: 'boolean', evaluators: ['list'],
    readSelection: filter => filter.attention === 'needs_you' ? true : undefined,
    replaceSelection: (filter, selection) => ({ ...filter, attention: selection ? 'needs_you' : 'any' }),
    match: (_selection, facts) => matchEntityFilterKnownV1(facts.needsYou),
    conditions: createEntityFilterConditionCodecV1({ encoding: 'value', parseValue: value => {
        if (value !== true) throw new TypeError('Remove the attention condition to show all Discussions');
        return value;
    }, valueOptions: () => [true] }),
});
const unread = defineEntityFilterFieldV1<DiscussionListFilterV1, DiscussionListFilterFactsV1, true>({
    id: 'unreadOnly', kind: 'boolean', evaluators: ['list'],
    readSelection: filter => filter.unreadOnly ? true : undefined,
    replaceSelection: (filter, selection) => ({ ...filter, unreadOnly: selection === true }),
    match: (_selection, facts) => matchEntityFilterKnownV1(facts.unread),
    conditions: createEntityFilterConditionCodecV1({ encoding: 'value', parseValue: value => {
        if (value !== true) throw new TypeError('Remove the unread condition to show read Discussions');
        return value;
    }, valueOptions: () => [true] }),
});
export function createDiscussionListFilterRegistryV1(fields: readonly AdmittedPluginListFilterFieldV1[] = []) {
    return [state, attention, unread, defineEntityFilterUnknownFieldsV1<DiscussionListFilterV1, DiscussionListFilterFactsV1>(['state', 'attention', 'unreadOnly', 'extensions']),
        ...createPluginListFilterFieldRegistryV1<DiscussionListFilterV1, DiscussionListFilterFactsV1>(fields)] as const;
}
export const discussionListFilterFieldsV1 = createDiscussionListFilterRegistryV1();
export function compileDiscussionListFilterV1(filter: DiscussionListFilterV1, fields: readonly AdmittedPluginListFilterFieldV1[] = [], evaluator: EntityFilterEvaluatorV1 = 'list') {
    return compileEntityListFilterV1(fields.length ? createDiscussionListFilterRegistryV1(fields) : discussionListFilterFieldsV1, filter, evaluator);
}
