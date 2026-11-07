import * as React from 'react';
import type { McpServersSettingsV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { emptyMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { MCP_SERVER_ACTION_INPUT_SCHEMAS_V1, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1,
    type McpServerActionIdV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import type { z } from 'zod/mini';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { McpRulesSetInputV1Schema } from '@happier-dev/protocol/actions/specs/capabilityRules';

import { useSetting } from '@/sync/domains/state/storage';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { observeMcpServerCatalog, refreshMcpServerCatalog } from '@/sync/engine/settings/mcpServerCatalogEngine';
import { getMcpServerCatalogSnapshot, projectMcpServerCatalogSnapshot, subscribeMcpServerCatalogSnapshots,
    type McpServerCatalogValueSnapshot } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { McpServerCatalogOperationError } from '@/sync/api/account/apiMcpServerCatalog';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { SESSION_SETTINGS } from '@/components/settings/session/sessionSettings';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

const emptyCatalog = emptyMcpServerCatalogV1();
export type McpCatalogAuthoringActionId = Extract<McpServerActionIdV1,
    'mcp.servers.create' | 'mcp.servers.update' | 'mcp.servers.duplicate' | 'mcp.servers.delete'>;
type ExecuteMcpCatalogMutation = <A extends McpCatalogAuthoringActionId>(actionId: A,
    input: z.input<(typeof MCP_SERVER_ACTION_INPUT_SCHEMAS_V1)[A]>, operation?: UiActionOperation) => Promise<z.output<(typeof MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1)[A]>>;

function parseMcpCatalogMutationResult<A extends McpCatalogAuthoringActionId>(actionId: A,
    value: unknown): z.output<(typeof MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1)[A]>;
function parseMcpCatalogMutationResult(actionId: McpCatalogAuthoringActionId, value: unknown) {
    return MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(value);
}

/** Read the selected Home's Account, rather than borrowing the focused Account's projection. */
export function useMcpServerCatalogForServer(targetServerId: string | null | undefined, demanded = true,
    requestedScope?: ServerAccountScope | null): McpServerCatalogValueSnapshot {
    const { resolution, binding } = useServerCredentialAccountScopeBinding(targetServerId);
    const matchesAccount = requestedScope === undefined || Boolean(binding && requestedScope
        && binding.scope.accountId === requestedScope.accountId
        && areServerProfileIdentifiersEquivalent(binding.scope.serverId, requestedScope.serverId));
    const retired = React.useMemo(() => projectMcpServerCatalogSnapshot({ status: 'unavailable', reason: 'scope-retired' }), []);
    const unavailable = React.useMemo(() => {
        if (!targetServerId || resolution.kind === 'resolving') return null;
        if (resolution.kind === 'bound') return projectMcpServerCatalogSnapshot({ status: 'unavailable', reason: 'scope-retired' });
        return projectMcpServerCatalogSnapshot({ status: 'unavailable', reason: resolution.kind === 'signed_out'
            ? 'unauthorized' : resolution.kind === 'unknown_home' ? 'scope-retired' : 'unreachable' });
    }, [resolution, targetServerId]);
    React.useEffect(() => demanded && binding && matchesAccount ? observeMcpServerCatalog(binding.scope) : undefined, [binding, demanded, matchesAccount]);
    const read = React.useCallback(() => requestedScope === null || binding && !matchesAccount ? retired
        : !demanded ? getMcpServerCatalogSnapshot(null) : binding?.isCurrent()
        ? getMcpServerCatalogSnapshot(binding.scope)
        : unavailable ?? getMcpServerCatalogSnapshot(null), [binding, unavailable, demanded, matchesAccount, requestedScope, retired]);
    const subscribe = React.useCallback((listener: () => void) => demanded ? subscribeMcpServerCatalogSnapshots(listener) : () => {}, [demanded]);
    return React.useSyncExternalStore(subscribe, read, read);
}

/**
 * The single scoped MCP row projection. Partial/stale neighbors remain displayable but never writable.
 */
export function useMcpServersSettings(): Readonly<{
    settings: McpServersSettingsV1;
    writable: McpServersSettingsV1 | null;
    snapshot: McpServerCatalogValueSnapshot;
    scope: ReturnType<typeof useAccountSettingsScope>;
    setStrictMode: (value: boolean) => void;
    reload: () => Promise<void>;
    mutate: ExecuteMcpCatalogMutation;
    executeRules: (input: z.input<typeof McpRulesSetInputV1Schema>) => Promise<ActionExecuteResult>;
    approval: ReturnType<typeof useMountedActionExecution>['approval'];
}> {
    const activeScope = useAccountSettingsScope();
    const serverId = activeScope?.serverId;
    const accountId = activeScope?.accountId;
    const scope = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    const execution = useMountedActionExecution(scope);
    const strictMode = useSetting('mcpServersStrictMode');
    const { setSetting: writeSetting, approval: settingApproval } = useSettingActionFeedback();
    const setStrictMode = React.useCallback((value: boolean) => {
        void writeSetting(SESSION_SETTINGS.settings.mcpServersStrictMode, value);
    }, [writeSetting]);
    React.useEffect(() => scope ? observeMcpServerCatalog(scope) : undefined, [scope]);
    const read = React.useCallback(() => getMcpServerCatalogSnapshot(scope), [scope]);
    const snapshot = React.useSyncExternalStore(subscribeMcpServerCatalogSnapshots, read, read);
    const settings = React.useMemo(() => ({ ...(snapshot.value ?? emptyCatalog), strictMode: strictMode === true }), [snapshot.value, strictMode]);
    const writable = snapshot.status === 'ready' && snapshot.authority === 'active' && !snapshot.stale ? settings : null;
    const mutate: ExecuteMcpCatalogMutation = React.useCallback(async <A extends McpCatalogAuthoringActionId>(actionId: A,
        input: z.input<(typeof MCP_SERVER_ACTION_INPUT_SCHEMAS_V1)[A]>, operation?: UiActionOperation) => {
        if (!scope || !writable || snapshot.revision === 'absent') throw new McpServerCatalogOperationError('authority-not-confirmed');
        const result = await execution.execute(actionId, input, operation);
        if (!result.ok) throw new McpServerCatalogOperationError(result.errorCode ?? 'mcp_catalog_operation_failed');
        return parseMcpCatalogMutationResult(actionId, result.result);
    }, [execution.execute, scope, writable, snapshot.revision]);
    const reload = React.useCallback(() => scope ? refreshMcpServerCatalog(scope) : Promise.resolve(), [scope]);
    const executeRules = React.useCallback((input: z.input<typeof McpRulesSetInputV1Schema>) => execution.execute('mcp.rules.set', input), [execution.execute]);
    const approval = settingApproval.approvalPending ? settingApproval : execution.approval;
    return React.useMemo(() => ({ settings, writable, snapshot, scope, mutate, executeRules, setStrictMode, reload, approval }),
        [settings, writable, snapshot, scope, mutate, executeRules, setStrictMode, reload, approval]);
}
