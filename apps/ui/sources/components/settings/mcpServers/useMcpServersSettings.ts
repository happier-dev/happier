import * as React from 'react';
import type { McpServersSettingsV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { emptyMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { McpServerCatalogRowMutationResponseV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { MCP_SERVER_ACTION_INPUT_SCHEMAS_V1, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1,
    type McpServerActionIdV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import type { z } from 'zod';

import { useSettingMutable } from '@/sync/domains/state/storage';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { observeMcpServerCatalog, refreshMcpServerCatalog } from '@/sync/engine/settings/mcpServerCatalogEngine';
import { getMcpServerCatalogSnapshot, projectMcpServerCatalogSnapshot, subscribeMcpServerCatalogSnapshots,
    type McpServerCatalogValueSnapshot } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { McpServerCatalogOperationError } from '@/sync/api/account/apiMcpServerCatalog';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

const emptyCatalog = emptyMcpServerCatalogV1();
export type McpCatalogAuthoringActionId = Exclude<McpServerActionIdV1,
    'mcp.servers.list' | 'mcp.servers.read' | 'mcp.servers.test' | 'mcp.servers.probe'>;
type ExecuteMcpCatalogMutation = <A extends McpCatalogAuthoringActionId>(actionId: A,
    input: z.input<(typeof MCP_SERVER_ACTION_INPUT_SCHEMAS_V1)[A]>) => Promise<McpServerCatalogRowMutationResponseV1>;

/** Read the selected Home's Account, rather than borrowing the focused Account's projection. */
export function useMcpServerCatalogForServer(targetServerId: string | null | undefined): McpServerCatalogValueSnapshot {
    const { resolution, binding } = useServerCredentialAccountScopeBinding(targetServerId);
    const unavailable = React.useMemo(() => {
        if (!targetServerId || resolution.kind === 'resolving') return null;
        if (resolution.kind === 'bound') return projectMcpServerCatalogSnapshot({ status: 'unavailable', reason: 'scope-retired' });
        return projectMcpServerCatalogSnapshot({ status: 'unavailable', reason: resolution.kind === 'signed_out'
            ? 'unauthorized' : resolution.kind === 'unknown_home' ? 'scope-retired' : 'unreachable' });
    }, [resolution, targetServerId]);
    React.useEffect(() => binding ? observeMcpServerCatalog(binding.scope) : undefined, [binding]);
    const read = React.useCallback(() => binding?.isCurrent()
        ? getMcpServerCatalogSnapshot(binding.scope)
        : unavailable ?? getMcpServerCatalogSnapshot(null), [binding, unavailable]);
    return React.useSyncExternalStore(subscribeMcpServerCatalogSnapshots, read, read);
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
    approval: ReturnType<typeof useMountedActionExecution>['approval'];
}> {
    const activeScope = useAccountSettingsScope();
    const serverId = activeScope?.serverId;
    const accountId = activeScope?.accountId;
    const scope = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    const execution = useMountedActionExecution(scope);
    const [strictMode, setStrictMode] = useSettingMutable('mcpServersStrictMode');
    React.useEffect(() => scope ? observeMcpServerCatalog(scope) : undefined, [scope]);
    const read = React.useCallback(() => getMcpServerCatalogSnapshot(scope), [scope]);
    const snapshot = React.useSyncExternalStore(subscribeMcpServerCatalogSnapshots, read, read);
    const settings = React.useMemo(() => ({ ...(snapshot.value ?? emptyCatalog), strictMode: strictMode === true }), [snapshot.value, strictMode]);
    const writable = snapshot.status === 'ready' && snapshot.authority === 'active' && !snapshot.stale ? settings : null;
    const mutate: ExecuteMcpCatalogMutation = React.useCallback(async (actionId, input) => {
        if (!scope || !writable || snapshot.revision === 'absent') throw new McpServerCatalogOperationError('authority-not-confirmed');
        const result = await execution.execute(actionId, input);
        if (!result.ok) throw new McpServerCatalogOperationError(result.errorCode ?? 'mcp_catalog_operation_failed');
        return MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(result.result);
    }, [execution.execute, scope, writable, snapshot.revision]);
    const reload = React.useCallback(() => scope ? refreshMcpServerCatalog(scope) : Promise.resolve(), [scope]);
    return React.useMemo(() => ({ settings, writable, snapshot, scope, mutate, setStrictMode, reload, approval: execution.approval }),
        [settings, writable, snapshot, scope, mutate, setStrictMode, reload, execution.approval]);
}
