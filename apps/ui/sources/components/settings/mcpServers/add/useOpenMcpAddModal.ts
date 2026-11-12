import * as React from 'react';

import { useCapabilityAddRouteParams } from '@/components/capabilities/add/CapabilityAddModal';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  MCP_COLLECTION_ROUTE,
  mcpServerRoute,
} from '../collection/mcpServerCollectionModel';
import { openMcpAddModal, type McpAddModeKey, type OpenMcpAddModalParams } from './openMcpAddModal';

const MODES: readonly McpAddModeKey[] = ['catalog', 'paste', 'custom'];

/**
 * A shared link to a server: the page's own `?install=<base64url>` payload, read by the paste parser exactly like a
 * pasted link (it only needs a URL shape; the origin is never contacted).
 */
export function mcpInstallLinkFromParam(install: string): string {
  return `https://happier.invalid${MCP_COLLECTION_ROUTE}?install=${install}`;
}

/**
 * Every MCP entry to Add (the rail "+", the empty page, `?add=` and `?install=` links) opens the same modal; adding
 * opens the new server. Custom edits its draft inside the same modal.
 */
export function useOpenMcpAddModal(): (
  params?: Omit<OpenMcpAddModalParams, 'onAdded'>,
) => void {
  const router = useRouter();
  const go = React.useCallback(
    (href: string) => {
      const result = runGuardedNavigation(() => router.push(href as never));
      if (result !== true) fireAndForget(result, { tag: 'McpAdd.open' });
    },
    [router],
  );
  return React.useCallback(
    (params) => {
      openMcpAddModal({
        ...(params ?? {}),
        onAdded: (serverId, options) => go(mcpServerRoute(serverId, options)),
      });
    },
    [go],
  );
}

/** `/settings/mcp?add=catalog&q=postgres` or `?install=<payload>` opens Add once. */
export function useMcpAddRouteParams(): void {
  const open = useOpenMcpAddModal();
  useCapabilityAddRouteParams((params) => {
    const modeKey = params.install
      ? 'paste'
      : (MODES.find((mode) => mode === params.modeKey) ?? 'catalog');
    open({
      modeKey,
      ...(params.sourceId ? { sourceId: params.sourceId } : {}),
      ...(params.query ? { query: params.query } : {}),
      ...(params.install ? { installLink: mcpInstallLinkFromParam(params.install) } : {}),
    });
  }, MCP_COLLECTION_ROUTE);
}
