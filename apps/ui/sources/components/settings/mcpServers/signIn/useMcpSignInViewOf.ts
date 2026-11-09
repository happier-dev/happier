import * as React from 'react';
import type { McpServersSettingsV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { useReachMachines } from '@/sync/domains/capabilities/reach/useReachProjection';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { getStorage } from '@/sync/domains/state/storageStore';

import { aggregateMcpMachineOnline, findMcpSignInGrant, mcpSignInGrantView, type McpSignInView } from './mcpSignInGrantView';
import { useMcpSignInGrantDiagnostics } from './useMcpSignInGrantDiagnostics';

/**
 * Each server's sign-in, read the one way every list reads it: the Account's grants and their safe configuration
 * through `mcpSignInGrantView`. The homepage legend and the rail both take their sign-in status from this.
 */
export function useMcpSignInViewOf(
  settings: McpServersSettingsV1,
  scope: AccountSettingsScope | null | undefined,
): (serverId: string) => McpSignInView | null {
  const grants = getStorage()((state) => state.profile.connectedAccountsV4);
  const { machines } = useReachMachines();
  const diagnostics = useMcpSignInGrantDiagnostics(
    grants,
    scope,
  );
  return React.useMemo(() => {
    const anyMachineOnline = aggregateMcpMachineOnline(machines);
    return (serverId) => {
      const server = settings.servers.find((candidate) => candidate.id === serverId);
      return server
        ? mcpSignInGrantView(server, findMcpSignInGrant(grants, serverId), anyMachineOnline, diagnostics[serverId])
        : null;
    };
  }, [diagnostics, grants, machines, settings.servers]);
}
