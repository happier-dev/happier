import * as React from 'react';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useFoundMachineScans, type FoundMachineScanOf, type FoundMachineScanOutcome } from '@/sync/domains/capabilities/found/useFoundMachineScans';
import type { DaemonMcpServersDetectResponse } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

const NOT_AVAILABLE = /RPC_METHOD_(NOT_AVAILABLE|NOT_FOUND)|unsupported_action/;

export type FoundMcpServers = Readonly<{
  scope: ReturnType<typeof useAccountSettingsScope>;
  execution: ReturnType<typeof useMountedActionExecution>;
  scans: readonly FoundMachineScanOf<DaemonMcpServersDetectResponse>[];
  scan: (machineId: string) => Promise<void>;
}>;

/**
 * MCP "Found on your machines" data (P7 §T6): one `mcp.found.list` per machine through the mounted Action
 * executor, whose ingress keeps each machine's last whole-machine result in the device-local warm cache. The
 * page reads that cache first, so a machine that is offline now keeps its last known servers, and a machine
 * whose read fails keeps its own failure. Adopt reuses the same executor.
 */
export function useFoundMcpServers(machineIds: readonly string[]): FoundMcpServers {
  const scope = useAccountSettingsScope();
  const execution = useMountedActionExecution(scope?.serverId ?? null);
  const { execute } = execution;
  const scanOne = React.useCallback(
    async (machineId: string): Promise<FoundMachineScanOutcome> => {
      // No `providers` filter: the daemon on that machine owns its MCP discovery-source registry, including
      // the sources an installed Agent contributes.
      const receipt = await execute('mcp.found.list', { machineId });
      if (!receipt.ok) {
        return NOT_AVAILABLE.test(`${receipt.errorCode ?? ''} ${receipt.error ?? ''}`) ? 'older_machine'
          : { failure: 'failed', cause: receipt.errorCode ?? null };
      }
      const response = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.found.list'].safeParse(receipt.result);
      return response.success && response.data.ok ? null : 'failed';
    },
    [execute],
  );
  const { scans, scan } = useFoundMachineScans('mcp_server', machineIds, scanOne);
  return { scope, execution, scans, scan };
}
