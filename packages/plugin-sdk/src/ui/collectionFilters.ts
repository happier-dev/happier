/** Public collection semantics delegate to the single Protocol evaluator and registry. */
import {
    matchEntityFilterTimeV1 as canonicalMatchTime,
    matchEntityFilterExtensionV1 as canonicalMatchExtension,
    type EntityFilterFactValueV1,
} from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import type { EntityFilterRegistryV1, EntityFilterMatchV1 } from '@happier-dev/protocol/collections/filter/fieldRegistryV1';
import {
    createPluginListFilterFieldRegistryV1 as canonicalCreatePluginRegistry,
    type AdmittedPluginListFilterFieldV1, type PluginListFilterFactsV1,
} from '@happier-dev/protocol/collections/filter/pluginListFilterFieldV1';
import type { UpdatedSelectionV1, ExtensionSelectionV1 } from '../actions/dtos/pluginActionDtoSupport.generated.js';
import { PluginServiceListFieldResourceInputV1Schema as canonicalServiceResourceInput,
    PluginServiceListFieldResourceResultV1Schema as canonicalServiceResourceResult,
    type PluginServiceListFieldResourceInputV1, type PluginServiceListFieldResourceResultV1,
} from '@happier-dev/protocol/collections/filter/pluginListFilterFieldV1';
import type { PluginUiSchema } from './publicContract.js';

export const PluginServiceListFieldResourceInputV1Schema: PluginUiSchema<PluginServiceListFieldResourceInputV1> = canonicalServiceResourceInput;
export const PluginServiceListFieldResourceResultV1Schema: PluginUiSchema<PluginServiceListFieldResourceResultV1> = canonicalServiceResourceResult;

// The generated Action DTOs supply the public selection vocabulary; Protocol still owns all matching.
export type { UpdatedSelectionV1, ExtensionSelectionV1 } from '../actions/dtos/pluginActionDtoSupport.generated.js';
export type PluginListFilterSelectionV1 = Readonly<{ extensions?: Readonly<Record<string, ExtensionSelectionV1>> }>;
export const matchEntityFilterTimeV1: (selection: UpdatedSelectionV1, value: number | undefined) => EntityFilterMatchV1 = canonicalMatchTime;
export const matchEntityFilterExtensionV1: (selection: ExtensionSelectionV1, value: EntityFilterFactValueV1 | undefined) => EntityFilterMatchV1 = canonicalMatchExtension;
export const createPluginListFilterFieldRegistryV1: <Filter extends PluginListFilterSelectionV1, Facts extends PluginListFilterFactsV1>(
    fields: readonly AdmittedPluginListFilterFieldV1[],
) => EntityFilterRegistryV1<Filter, Facts> = canonicalCreatePluginRegistry;

export {
    createEntityFilterConditionCodecV1,
    type EntityFilterConditionCodecV1,
    type EntityFilterConditionOperatorV1,
    type EntityFilterConditionV1,
} from '@happier-dev/protocol/collections/filter/fieldRegistryV1';
export {
    compileEntityListFilterV1,
    combineEntityFilterMatchesV1,
    matchEntityFilterKnownV1,
    matchEntityFilterSetV1,
    type SetSelectionV1,
    type EntityFilterFactValueV1,
    type EntityListFilterResultV1,
} from '@happier-dev/protocol/collections/filter/entityListFilterV1';
export {
    defineEntityFilterFieldV1,
    getUnsupportedEntityFilterFieldsV1,
    type EntityFilterFieldV1,
    type CompilableEntityFilterFieldV1,
    type EntityFilterRegistryV1,
    type EntityFilterMatchV1,
    type EntityFilterEvaluatorV1,
    type EntityFilterFieldKindV1,
} from '@happier-dev/protocol/collections/filter/fieldRegistryV1';
export {
    admitPluginListFilterFieldV1,
    admitPluginListFilterFieldValueV1,
    validatePluginListFilterSelectionsV1,
    type PluginServiceListFieldResourceInputV1,
    type PluginServiceListFieldResourceResultV1,
    type PluginListFilterFieldV1,
    type AdmittedPluginListFilterFieldV1,
    type PluginListFilterFactsV1,
} from '@happier-dev/protocol/collections/filter/pluginListFilterFieldV1';
