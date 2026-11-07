import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { RuntimeActionExecute } from '@happier-dev/protocol';

/** Validate the real producer's payload before an executor can turn drift into invalid_action_output. */
export function assertActionOutputContract(actionId: ActionId, output: unknown): void {
    const schema = getActionSpec(actionId).outputSchema;
    if (!schema) throw new Error(`Action ${actionId} has no registered output schema`);
    // Keep the registry's exact parser and its field-level errors; no test-owned schema or projection.
    schema.parse(output);
}

/** Assert raw route outputs while preserving the real producer and its failure path. */
export function withActionOutputContract(execute: RuntimeActionExecute): RuntimeActionExecute {
    return async args => {
        const output = await execute(args);
        if (output !== null && typeof output === 'object' && 'ok' in output && output.ok === false) {
            ActionExecuteFailureSchema.parse(output);
        } else {
            assertActionOutputContract(args.actionId, output);
        }
        return output;
    };
}
