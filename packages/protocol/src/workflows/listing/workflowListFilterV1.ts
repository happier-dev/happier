import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { compileEntityListFilterV1, createEntityListFilterStoredReadSchemaV1, ExtensionSelectionV1Schema, matchEntityFilterKnownV1 } from '../../collections/filter/entityListFilterV1.js';
import { defineEntityFilterFieldV1, defineEntityFilterUnknownFieldsV1, type EntityFilterEvaluatorV1 } from '../../collections/filter/fieldRegistryV1.js';
import { createPluginListFilterFieldRegistryV1, type AdmittedPluginListFilterFieldV1, type PluginListFilterFactsV1 } from '../../collections/filter/pluginListFilterFieldV1.js';
import { createEntityFilterConditionCodecV1 } from '../../collections/filter/fieldConditionsV1.js';

export const WorkflowListFilterViewV1Schema = lazyZodSchema(() => z.enum(['all', 'triggered', 'running', 'hunts']));
export const WorkflowListFilterV1Schema = lazyZodSchema(() => z.strictObject({
    view: WorkflowListFilterViewV1Schema,
    extensions: z.optional(z.record(z.string(), ExtensionSelectionV1Schema)),
}));
export type WorkflowListFilterV1 = z.infer<typeof WorkflowListFilterV1Schema>;
export const WorkflowListFilterPatchV1Schema = lazyZodSchema(() => z.partial(WorkflowListFilterV1Schema));
export const WorkflowListFilterV1StoredSchema = lazyZodSchema(() => createEntityListFilterStoredReadSchemaV1(WorkflowListFilterV1Schema));
defineStoredReadProjection(WorkflowListFilterV1Schema, () => WorkflowListFilterV1StoredSchema);
export const DEFAULT_WORKFLOW_LIST_FILTER_V1: WorkflowListFilterV1 = Object.freeze({ view: 'all' });
export type WorkflowListFilterFactsV1 = PluginListFilterFactsV1 & Readonly<{ triggered?: boolean; running?: boolean; hunts?: boolean }>;

const view = defineEntityFilterFieldV1<WorkflowListFilterV1, WorkflowListFilterFactsV1, Exclude<WorkflowListFilterV1['view'], 'all'>>({
    id: 'view', kind: 'domain', evaluators: ['list'],
    readSelection: filter => filter.view === 'all' ? undefined : filter.view,
    replaceSelection: (filter, selection) => ({ ...filter, view: selection ?? 'all' }),
    match: (selection, facts) => matchEntityFilterKnownV1(facts[selection]),
    conditions: createEntityFilterConditionCodecV1({ encoding: 'value',
        parseValue: value => {
            const parsed = WorkflowListFilterViewV1Schema.parse(value);
            if (parsed === 'all') throw new TypeError('Remove the view condition to show all Workflows');
            return parsed;
        },
        valueOptions: () => Object.values(WorkflowListFilterViewV1Schema._zod.def.entries).filter(value => value !== 'all'),
    }),
});
export function createWorkflowListFilterRegistryV1(fields: readonly AdmittedPluginListFilterFieldV1[] = []) {
    return [view, defineEntityFilterUnknownFieldsV1<WorkflowListFilterV1, WorkflowListFilterFactsV1>(['view', 'extensions']),
        ...createPluginListFilterFieldRegistryV1<WorkflowListFilterV1, WorkflowListFilterFactsV1>(fields)] as const;
}
export const workflowListFilterFieldsV1 = createWorkflowListFilterRegistryV1();
export function compileWorkflowListFilterV1(filter: WorkflowListFilterV1, fields: readonly AdmittedPluginListFilterFieldV1[] = [], evaluator: EntityFilterEvaluatorV1 = 'list') {
    return compileEntityListFilterV1(fields.length ? createWorkflowListFilterRegistryV1(fields) : workflowListFilterFieldsV1, filter, evaluator);
}
