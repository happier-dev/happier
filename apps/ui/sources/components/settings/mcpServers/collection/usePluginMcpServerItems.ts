import * as React from 'react';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import {
  McpPluginItemMetadataV1Schema,
  type McpPluginItemMetadataV1,
} from '@happier-dev/protocol/mcp/servers/settingsV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

const NONE: readonly McpPluginItemMetadataV1[] = [];

export const PluginMcpServerItemsContext = React.createContext(NONE);

/**
 * Read declarations through the shared MCP Actions. Detail asks for one server;
 * the collection asks for the metadata list.
 */
export function usePluginMcpServerItems(serverId?: string): readonly McpPluginItemMetadataV1[] {
  const activeScope = useAccountSettingsScope();
  const homeId = activeScope?.serverId;
  const accountId = activeScope?.accountId;
  const scope = React.useMemo(
    () => (homeId && accountId ? { serverId: homeId, accountId } : null),
    [homeId, accountId],
  );
  const { execute, ready } = useMountedActionExecution(scope);
  const key = scope ? JSON.stringify([scope.serverId, scope.accountId, serverId]) : null;
  const [result, setResult] = React.useState<Readonly<{
    key: string;
    items: readonly McpPluginItemMetadataV1[];
  }> | null>(null);

  React.useEffect(() => {
    if (key === null || !ready) return;
    let cancelled = false;
    void (async () => {
      if (serverId !== undefined) {
        const receipt = await execute('mcp.servers.read', { serverId }).catch(() => null);
        if (cancelled || !receipt?.ok) return;
        const parsed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.read'].safeParse(receipt.result);
        if (parsed.success && parsed.data.status === 'plugin') {
          setResult({ key, items: [parsed.data.server] });
        }
        return;
      }
      const receipt = await execute('mcp.servers.list', {}).catch(() => null);
      if (cancelled || !receipt?.ok) return;
      const parsed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1[
        'mcp.servers.list'
      ].safeParse(receipt.result);
      if (
        !parsed.success ||
        (parsed.data.status !== 'ready' && parsed.data.status !== 'partial')
      )
        return;
      const next = parsed.data.catalog.servers.flatMap((server) => {
        const plugin = McpPluginItemMetadataV1Schema.safeParse(server);
        return plugin.success ? [plugin.data] : [];
      });
      setResult({ key, items: next.length === 0 ? NONE : next });
    })();
    return () => {
      cancelled = true;
    };
  }, [execute, key, ready, serverId]);

  return result && result.key === key ? result.items : NONE;
}
