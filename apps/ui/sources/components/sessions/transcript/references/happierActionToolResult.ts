import { getActionSpec } from '@happier-dev/protocol/actions';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { createHappierActionToolNameIndex as createBindingIndex } from '@happier-dev/protocol/actions/happierActionToolResult';

/** Existing authenticated host consumers project bindings from the complete catalog. */
export function createHappierActionToolNameIndex<T extends string>(ids: readonly T[]): ReadonlyMap<string, T> {
    return createBindingIndex(ids.map(actionId => ({ actionId, name: getActionSpec(actionId as ActionId).bindings?.mcpToolName })));
}

export {
    isRecord,
    readHappierActionId,
    readHappierActionToolPayload,
    readHappierActionExecuteActionId,
    readHappierActionToolResultCandidates,
} from '@happier-dev/protocol/actions/happierActionToolResult';
