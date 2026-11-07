/** Public collection semantics delegate to the single Protocol evaluator and registry. */
export {
    conditionModelFromFilter, applyCollectionConditionEdit,
    compileCollectionConditionValueCountOptions, collectionConditionValueCountsFromFacts,
    collectionConditionOptionValues, isCollectionConditionOptionPicked, collectionConditionValueLabels,
    toggleCollectionConditionValue, isCollectionConditionChoiceOn, collectionConditionChoiceValues,
    type CollectionCondition, type CollectionConditionBindings, type CollectionConditionEdit,
    type CollectionConditionField, type CollectionConditionModel, type CollectionConditionRow, type CollectionConditionValueOption,
    type CollectionConditionValueCountRequest, type CollectionConditionValueCounts,
} from '../presentation/collection/conditionModel.js';
export {
    createEntityFilterConditionCodecV1,
    type EntityFilterConditionCodecV1, type EntityFilterConditionOperatorV1, type EntityFilterConditionV1,
} from '@happier-dev/plugin-sdk/ui';
export {
    compileEntityListFilterV1,
    combineEntityFilterMatchesV1,
    matchEntityFilterKnownV1,
    matchEntityFilterSetV1,
    matchEntityFilterTimeV1,
    matchEntityFilterExtensionV1,
    type SetSelectionV1,
    type EntityFilterFactValueV1,
    type EntityListFilterResultV1,
} from '@happier-dev/plugin-sdk/ui';
import type {
    UpdatedSelectionV1 as SdkUpdatedSelectionV1,
    ExtensionSelectionV1 as SdkExtensionSelectionV1,
} from '@happier-dev/plugin-sdk/ui';
// Keep inferred portable declarations anchored to the SDK: direct re-exports
// let TypeScript name these unions through this native UI package instead.
export type UpdatedSelectionV1 = SdkUpdatedSelectionV1;
export type ExtensionSelectionV1 = SdkExtensionSelectionV1;
export {
    defineEntityFilterFieldV1,
    getUnsupportedEntityFilterFieldsV1,
    type EntityFilterFieldV1,
    type EntityFilterRegistryV1,
    type EntityFilterMatchV1,
    type EntityFilterEvaluatorV1,
    type EntityFilterFieldKindV1,
} from '@happier-dev/plugin-sdk/ui';
export {
    admitPluginListFilterFieldV1,
    admitPluginListFilterFieldValueV1,
    createPluginListFilterFieldRegistryV1,
    validatePluginListFilterSelectionsV1,
    type PluginListFilterFieldV1,
    type AdmittedPluginListFilterFieldV1,
    type PluginListFilterSelectionV1,
    type PluginListFilterFactsV1,
} from '@happier-dev/plugin-sdk/ui';
