import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';
import {
    compileEntityListFilterV1, createEntityListFilterStoredReadSchemaV1, ExtensionSelectionV1Schema,
    matchEntityFilterKnownV1, matchEntityFilterSetV1, StringSetSelectionV1Schema, type SetSelectionV1,
} from '../../collections/filter/entityListFilterV1.js';
import { defineEntityFilterFieldV1, defineEntityFilterUnknownFieldsV1 } from '../../collections/filter/fieldRegistryV1.js';
import { createEntityFilterConditionCodecV1 } from '../../collections/filter/fieldConditionsV1.js';
import {
    createPluginListFilterFieldRegistryV1, type AdmittedPluginListFilterFieldV1, type PluginListFilterFactsV1,
} from '../../collections/filter/pluginListFilterFieldV1.js';

const FACETS = ['workflows', 'results', 'startedBy', 'projects'] as const;
type Facet = typeof FACETS[number];

export const WorkflowRunListFilterV1Schema = lazyZodSchema(() => z.strictObject({
    workflows: z.optional(StringSetSelectionV1Schema),
    results: z.optional(StringSetSelectionV1Schema),
    startedBy: z.optional(StringSetSelectionV1Schema),
    projects: z.optional(StringSetSelectionV1Schema),
    extensions: z.optional(z.record(z.string(), ExtensionSelectionV1Schema)),
}));
export type WorkflowRunListFilterV1 = z.infer<typeof WorkflowRunListFilterV1Schema>;
export const WorkflowRunListFilterV1StoredSchema = lazyZodSchema(() => createEntityListFilterStoredReadSchemaV1(WorkflowRunListFilterV1Schema));
defineStoredReadProjection(WorkflowRunListFilterV1Schema, () => WorkflowRunListFilterV1StoredSchema);
export const DEFAULT_WORKFLOW_RUN_LIST_FILTER_V1: WorkflowRunListFilterV1 = Object.freeze({});
export type WorkflowRunListFilterFactsV1 = Readonly<Record<Facet, string | null | undefined>> & PluginListFilterFactsV1;

const fields = FACETS.map(id => defineEntityFilterFieldV1<WorkflowRunListFilterV1, WorkflowRunListFilterFactsV1, SetSelectionV1<string>>({
    id,
    kind: 'set',
    evaluators: ['list'],
    readSelection: filter => filter[id],
    replaceSelection: (filter, selection) => {
        if (selection !== undefined) return { ...filter, [id]: selection };
        const { [id]: _removed, ...rest } = filter;
        return rest;
    },
    match: (selection, facts) => matchEntityFilterSetV1(selection, candidate =>
        matchEntityFilterKnownV1(facts[id] === undefined ? undefined : facts[id] === candidate)),
    conditions: createEntityFilterConditionCodecV1({ encoding: 'set', parseValue: value => StringSetSelectionV1Schema.parse(value) }),
}));

export function createWorkflowRunListFilterRegistryV1(extensions: readonly AdmittedPluginListFilterFieldV1[] = []) {
    return [
        ...fields,
        defineEntityFilterUnknownFieldsV1<WorkflowRunListFilterV1, WorkflowRunListFilterFactsV1>([...FACETS, 'extensions']),
        ...createPluginListFilterFieldRegistryV1<WorkflowRunListFilterV1, WorkflowRunListFilterFactsV1>(extensions),
    ];
}
export const workflowRunListFilterFieldsV1 = createWorkflowRunListFilterRegistryV1();
export function compileWorkflowRunListFilterV1(filter: WorkflowRunListFilterV1, extensions: readonly AdmittedPluginListFilterFieldV1[] = []) {
    return compileEntityListFilterV1(extensions.length ? createWorkflowRunListFilterRegistryV1(extensions) : workflowRunListFilterFieldsV1, filter, 'list');
}
