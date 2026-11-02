import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import type { PluginJsonSchemaV2 } from '../plugins/contributions/jsonSchema.js';
import { walkWorkflowBlocks } from './workflowDefinitionEditV1.js';
import type { WorkflowBlock, WorkflowDefinitionV1 } from './workflowV1.js';

/** Schema values are already semantically equal; only declared field order remains. */
function schemaPropertyOrdersEqual(left: PluginJsonSchemaV2, right: PluginJsonSchemaV2): boolean {
  const pending: Array<readonly [PluginJsonSchemaV2, PluginJsonSchemaV2]> = [[left, right]];
  while (pending.length > 0) {
    const [before, after] = pending.pop()!;
    if (!sameStrictJsonValue(Object.keys(before.properties ?? {}), Object.keys(after.properties ?? {}))) return false;
    for (const key of ['properties', '$defs', 'definitions'] as const) {
      for (const name of Object.keys(before[key] ?? {})) pending.push([before[key]![name]!, after[key]![name]!]);
    }
    for (const key of ['items', 'additionalProperties', 'propertyNames', 'not'] as const) {
      const child = before[key];
      const counterpart = after[key];
      if (typeof child === 'object' && typeof counterpart === 'object') pending.push([child, counterpart]);
    }
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
      before[key]?.forEach((child, index) => pending.push([child, after[key]![index]!]));
    }
  }
  return true;
}

/** Compare presentation-bearing field order after the caller established semantic content equality. */
export function sameWorkflowResultFieldOrderV1(left: readonly WorkflowBlock[], right: readonly WorkflowBlock[]): boolean {
  const before = walkWorkflowBlocks(left);
  const after = walkWorkflowBlocks(right);
  return before.every((block, index) => {
    const counterpart = after[index]!;
    return !('result' in block) || block.result?.kind !== 'json'
      || ('result' in counterpart && counterpart.result?.kind === 'json'
        && schemaPropertyOrdersEqual(block.result.schema, counterpart.result.schema));
  });
}

/** Saved authoring content includes visible result-field order; execution and Plan identity remain semantic. */
export function sameWorkflowDefinitionAuthoringContentV1(left: WorkflowDefinitionV1, right: WorkflowDefinitionV1): boolean {
  return sameStrictJsonValue(left, right) && sameWorkflowResultFieldOrderV1(left.blocks, right.blocks);
}
