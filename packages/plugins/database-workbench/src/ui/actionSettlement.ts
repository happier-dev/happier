import { DatabaseOperationResultV1Schema, type DatabaseOperationResultV1 } from '@happier-dev/database-protocol';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiActionControlExecution } from '@happier-dev/plugin-sdk/ui';
import type { PluginTranslate } from '@happier-dev/plugin-ui';
import { projectPluginActionControlExecutionV1, projectPluginActionRejectionV1, type PluginActionExecution } from '@happier-dev/plugin-ui/hostApi';

const text: PluginTranslate = (key, fallback) => fallback ?? key;
/** The host owns transport uncertainty and approval; this only opens its business result. */
export function databaseActionSettlement(execution: PluginUiActionControlExecution,
    operation: Extract<DatabaseOperationResultV1, { ok: true }>['operation']): PluginActionExecution<DatabaseOperationResultV1> {
    const settled = projectPluginActionControlExecutionV1(execution, text);
    if (settled.status !== 'success') return settled;
    if (isPluginActionApprovalRequestCreated(settled.result)) return { status: 'pending' };
    const result = DatabaseOperationResultV1Schema.safeParse(settled.result);
    return result.success && (!result.data.ok || result.data.operation === operation) ? { ...settled, result: result.data }
        : projectPluginActionRejectionV1(new TypeError('Database Action returned an invalid result.'), text);
}
