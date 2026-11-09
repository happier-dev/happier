import * as React from 'react';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { PageLeaveActions } from '@/components/ui/layout/PageLeaveActions';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';

import { usePluginMcpServerItems } from '../collection/usePluginMcpServerItems';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import type { McpSavedSecretAvailability } from '../status/mcpServerStatus';
import { resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import {
  McpServerBanner,
  McpServerMachinesAndDetails,
  McpServerWhereAndTools,
  useMcpServerDetail,
} from './McpServerDetailBody';

const NO_SECRETS: McpSavedSecretAvailability = { resolveReference: ref => resolveSavedSecretReference(null, [], ref) };

/**
 * A server a plugin declares (T8): the same page as a catalog server, without Configuration or Remove.
 * Where it's on and its Tools are the person's; the server itself comes and goes with its plugin.
 */
export const McpPluginServerDetailPage = React.memo(
  function McpPluginServerDetailPage(props: Readonly<{ itemId: string }>) {
    const items = usePluginMcpServerItems();
    const item = items.find((candidate) => candidate.id === props.itemId);
    if (!item) {
      return (
        <ItemList>
          <EmptyState
            testID="mcp.plugin.missing"
            layout="page"
            title={t('settings.mcpServersServerNotFound')}
          />
        </ItemList>
      );
    }
    // The item as the shared detail owners read a server: declaration facts only, nothing to configure.
    const server: McpServerCatalogEntryV1 = {
      id: item.id,
      name: item.name,
      ...(item.title ? { title: item.title } : {}),
      ...(item.description ? { description: item.description } : {}),
      transport: item.transport,
      env: {},
      createdAt: 0,
      updatedAt: 0,
    };
    return (
      <McpPluginServerDetail
        server={server}
        pluginName={item.source.pluginName}
      />
    );
  },
);

const McpPluginServerDetail = React.memo(function McpPluginServerDetail(
  props: Readonly<{ server: McpServerCatalogEntryV1; pluginName: string }>,
) {
  const { server } = props;
  const detail = useMcpServerDetail(server, null, NO_SECRETS);
  const name = server.title ?? server.name;
  const list = detail.tools.list;
  const toolCount = list?.snapshot?.tools.length;
  return (
    <ItemList keyboardShouldPersistTaps="handled">
      <CapabilityDetailHeader
        testID="mcp.plugin.header"
        mark={<HappierBrandMark brand={{ displayName: name }} pixelSize={28} externallyLabelled />}
        title={name}
        purpose={server.description}
        facts={{
          source: { kind: 'plugin', pluginName: props.pluginName },
          extra: [
            server.transport === 'stdio'
              ? t('capabilities.mcp.local')
              : t('capabilities.mcp.remote'),
          ],
          ...(toolCount !== undefined
            ? {
                cost: {
                  toolCount,
                  ...(list?.tokens != null
                    ? { tokensPerTurn: list.tokens }
                    : {}),
                },
              }
            : {}),
        }}
      />
      <McpServerBanner detail={detail} name={name} toolCount={toolCount} />
      <McpServerWhereAndTools detail={detail} />
      <McpServerMachinesAndDetails detail={detail} server={server} />
      <PageLeaveActions
        testID="mcp.plugin.leave"
        actions={[]}
        footnote={t('capabilities.mcp.detail.pluginFootnote', {
          plugin: props.pluginName,
        })}
      />
    </ItemList>
  );
});
