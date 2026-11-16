import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { defineStoredReadProjection } from '../json/storedReadSchema.js';
import {
  compileEntityListFilterV1,
  createEntityListFilterStoredReadSchemaV1,
  matchEntityFilterKnownV1,
  matchEntityFilterSetV1,
  StringSetSelectionV1Schema,
  type SetSelectionV1,
} from '../collections/filter/entityListFilterV1.js';
import {
  defineEntityFilterFieldV1,
  defineEntityFilterUnknownFieldsV1,
  type EntityFilterEvaluatorV1,
} from '../collections/filter/fieldRegistryV1.js';
import { createEntityFilterConditionCodecV1 } from '../collections/filter/fieldConditionsV1.js';

/**
 * What a Services row is doing, as its filter reads it: its latest deploy needs the person (failed, unconfirmed), is at
 * work, is live, or nothing was ever deployed.
 */
export const DeploymentEnvironmentListStateV1Schema = lazyZodSchema(() =>
  z.enum(['needsYou', 'deploying', 'deployed', 'notDeployed']),
);
export type DeploymentEnvironmentListStateV1 = z.infer<
  typeof DeploymentEnvironmentListStateV1Schema
>;
const StateSetSelectionV1Schema = lazyZodSchema(() =>
  z.strictObject({
    include: z.array(DeploymentEnvironmentListStateV1Schema),
    exclude: z.array(DeploymentEnvironmentListStateV1Schema),
  }),
);

/** Services → Apps narrowing (owner D5): by Project, state and Machine; every field is optional, none narrows nothing. */
export const DeploymentEnvironmentListFilterV1Schema = lazyZodSchema(() =>
  z.strictObject({
    projects: z.optional(StringSetSelectionV1Schema),
    states: z.optional(StateSetSelectionV1Schema),
    machines: z.optional(StringSetSelectionV1Schema),
  }),
);
export type DeploymentEnvironmentListFilterV1 = z.infer<
  typeof DeploymentEnvironmentListFilterV1Schema
>;
export const DeploymentEnvironmentListFilterPatchV1Schema = lazyZodSchema(() =>
  z.partial(DeploymentEnvironmentListFilterV1Schema),
);
export const DeploymentEnvironmentListFilterV1StoredSchema = lazyZodSchema(() =>
  createEntityListFilterStoredReadSchemaV1(
    DeploymentEnvironmentListFilterV1Schema,
  ),
);
defineStoredReadProjection(
  DeploymentEnvironmentListFilterV1Schema,
  () => DeploymentEnvironmentListFilterV1StoredSchema,
);
export const DEFAULT_DEPLOYMENT_ENVIRONMENT_LIST_FILTER_V1: DeploymentEnvironmentListFilterV1 =
  Object.freeze({});

/** The facts one Services row holds for its filter: its Project Source, its state and the Machine that runs it. */
export type DeploymentEnvironmentListFilterFactsV1 = Readonly<{
  projectSourceId: string;
  state: DeploymentEnvironmentListStateV1;
  machineId: string | null;
}>;

type SetKey = 'projects' | 'states' | 'machines';
function withSelection<K extends SetKey>(
  filter: DeploymentEnvironmentListFilterV1,
  key: K,
  selection: DeploymentEnvironmentListFilterV1[K] | undefined,
): DeploymentEnvironmentListFilterV1 {
  if (selection !== undefined) return { ...filter, [key]: selection };
  const { [key]: _removed, ...rest } = filter;
  return rest;
}
function setField<K extends SetKey, T extends string>(
  id: K,
  schema: z.ZodMiniType<SetSelectionV1<T>>,
  fact: (facts: DeploymentEnvironmentListFilterFactsV1) => T | null,
  valueOptions?: () => readonly T[],
) {
  return defineEntityFilterFieldV1<
    DeploymentEnvironmentListFilterV1,
    DeploymentEnvironmentListFilterFactsV1,
    SetSelectionV1<T>
  >({
    id,
    kind: 'set',
    evaluators: ['list'],
    readSelection: (filter) => filter[id] as SetSelectionV1<T> | undefined,
    replaceSelection: (filter, selection) =>
      withSelection(
        filter,
        id,
        selection as DeploymentEnvironmentListFilterV1[K],
      ),
    match: (selection, facts) => {
      const value = fact(facts);
      return matchEntityFilterSetV1(selection, (selected) =>
        matchEntityFilterKnownV1(value === selected),
      );
    },
    conditions: createEntityFilterConditionCodecV1({
      encoding: 'set',
      parseValue: (value) => schema.parse(value),
      ...(valueOptions ? { valueOptions } : {}),
    }),
  });
}

const projects = setField(
  'projects',
  StringSetSelectionV1Schema,
  (facts) => facts.projectSourceId,
);
const states = setField(
  'states',
  StateSetSelectionV1Schema,
  (facts) => facts.state,
  () => Object.values(DeploymentEnvironmentListStateV1Schema._zod.def.entries),
);
const machines = setField(
  'machines',
  StringSetSelectionV1Schema,
  (facts) => facts.machineId,
);

export const deploymentEnvironmentListFilterFieldsV1 = [
  projects,
  states,
  machines,
  defineEntityFilterUnknownFieldsV1<
    DeploymentEnvironmentListFilterV1,
    DeploymentEnvironmentListFilterFactsV1
  >(['projects', 'states', 'machines']),
] as const;
export function compileDeploymentEnvironmentListFilterV1(
  filter: DeploymentEnvironmentListFilterV1,
  evaluator: EntityFilterEvaluatorV1 = 'list',
) {
  return compileEntityListFilterV1(
    deploymentEnvironmentListFilterFieldsV1,
    filter,
    evaluator,
  );
}
