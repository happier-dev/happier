import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DetectedMcpServerV1 } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { useWhereItsOnNames } from '@/components/capabilities/where/useWhereItsOnNames';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import {
  useReachMachines,
  type ReachMachine,
} from '@/sync/domains/capabilities/reach/useReachProjection';
import {
  loadFoundWarmCacheEntry,
  subscribeFoundWarmCacheEntry,
} from '@/sync/domains/state/warmCachePersistence';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { MCP_FOUND_ROUTE } from '../collection/mcpServerCollectionModel';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { useMcpServersSettings } from '../useMcpServersSettings';

type FoundOnMachine = Readonly<{
  machine: ReachMachine;
  server: DetectedMcpServerV1;
}>;

/**
 * What the machines' agents already run that Happier does not hold yet, as last seen by the Found page
 * (its per-machine warm cache; nothing is probed from here). Servers already in the Account are left out.
 */
function useFoundOnMachines(): readonly FoundOnMachine[] {
  const { settings, scope } = useMcpServersSettings();
  const { machines } = useReachMachines();
  const [version, setVersion] = React.useState(0);
  const serverId = scope?.serverId;
  const accountId = scope?.accountId;
  React.useEffect(() => {
    const bump = () => setVersion((value) => value + 1);
    const stops = machines.map((machine) =>
      subscribeFoundWarmCacheEntry(
        serverId,
        accountId,
        'mcp_server',
        machine.machineId,
        bump,
      ),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [accountId, machines, serverId]);
  return React.useMemo(() => {
    const held = new Set(
      settings.servers.map((server) => server.name.toLocaleLowerCase()),
    );
    const seen = new Set<string>();
    const found: FoundOnMachine[] = [];
    for (const machine of machines) {
      const entry = loadFoundWarmCacheEntry(
        serverId,
        accountId,
        'mcp_server',
        machine.machineId,
      );
      if (entry?.kind !== 'mcp_server' || !entry.result.ok) continue;
      for (const server of entry.result.servers) {
        const key = server.name.toLocaleLowerCase();
        if (held.has(key) || seen.has(key)) continue;
        seen.add(key);
        found.push({ machine, server });
      }
    }
    return found;
    // `version` re-reads the caches when one of them is written.
  }, [accountId, machines, serverId, settings.servers, version]);
}

/**
 * Found on your machines: the homepage section (one row per server, lab hm-A2) or the empty state's one
 * anticipation line ("2 servers are already on MacBook Pro · Review", lab mp-E). Nothing found, no block.
 */
export const McpFoundBlock = React.memo(function McpFoundBlock(
  props: Readonly<{ presentation: 'section' | 'line' }>,
) {
  const found = useFoundOnMachines();
  const router = useRouter();
  const { theme } = useUnistyles();
  const agentIds = React.useMemo(
    () => [...new Set(found.map((item) => item.server.provider))],
    [found],
  );
  const { names } = useWhereItsOnNames({
    agentIds,
    machines: [],
  });
  const review = React.useCallback(() => {
    const result = runGuardedNavigation(() =>
      router.push(MCP_FOUND_ROUTE as never),
    );
    if (result !== true) fireAndForget(result, { tag: 'McpFoundBlock.review' });
  }, [router]);
  if (found.length === 0) return null;
  const machineName = (machine: ReachMachine) =>
    machine.name ?? machine.machineId;
  if (props.presentation === 'line') {
    const machines = new Set(found.map((item) => item.machine.machineId));
    const title =
      machines.size === 1
        ? t('capabilities.mcpHome.foundLine', {
            count: found.length,
            machine: machineName(found[0]!.machine),
          })
        : t('capabilities.mcpHome.foundLineMachines', {
            count: found.length,
            machines: machines.size,
          });
    return (
      <ItemGroup header="none">
        <Item
          testID="mcp.empty.found"
          title={title}
          subtitle={
            <Text variant="meta" style={styles.secondary} numberOfLines={3}>
              <Text variant="meta" style={[styles.secondary, Typography.mono()]}>
                {found
                  .slice(0, 3)
                  .map((item) => item.server.name)
                  .join(', ')}
              </Text>
              {` · ${t('capabilities.mcpHome.foundLineBody')}`}
            </Text>
          }
          icon={
            <Icon
              name="desktop"
              size={20}
              color={theme.colors.text.secondary}
            />
          }
          rightElementOutsidePressable
          rightElement={
            <RoundButton
              testID="mcp.empty.found.review"
              size="small"
              display="secondary"
              title={t('capabilities.mcpHome.review')}
              onPress={review}
            />
          }
          showChevron={false}
          onPress={review}
        />
      </ItemGroup>
    );
  }
  return (
    <ItemGroup
      title={t('capabilities.mcpHome.foundTitle')}
      description={t('capabilities.mcpHome.foundBody')}
    >
      {found.map((item) => (
        <CapabilityRow
          key={`${item.machine.machineId}:${item.server.name}`}
          testID={`mcp.home.found.${item.server.name}`}
          title={item.server.name}
          description={`${names.agentName(item.server.provider)} · ${machineName(item.machine)}`}
          mark={<HappierBrandMark brand={{ displayName: item.server.name }} pixelSize={20} externallyLabelled />}
          facts={{
            presentation: 'row',
            extra: [
              item.server.transport === 'stdio'
                ? t('capabilities.mcp.local')
                : t('capabilities.mcp.remote'),
            ],
          }}
          action={
            <View>
              <RoundButton
                size="small"
                display="secondary"
                title={t('capabilities.mcpHome.shelfAdd')}
                onPress={review}
              />
            </View>
          }
          onPress={review}
        />
      ))}
    </ItemGroup>
  );
});

const styles = StyleSheet.create((theme) => ({
  secondary: { color: theme.colors.text.secondary },
}));
