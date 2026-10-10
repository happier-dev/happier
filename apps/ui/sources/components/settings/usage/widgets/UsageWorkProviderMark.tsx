import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ProviderContributionV1Schema } from '@happier-dev/protocol/providers/contributions';
import { readReusableDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { t } from '@/text';
import type { UsageWorkProvider } from './usageWorkPresentation';

/**
 * A witnessed model source. Optional display metadata reuses the admitted catalog, never fetches.
 * In a row it is the mark alone, beside the Agent marks; its name stays in the accessible label
 * and is written out only where the caller asks for it.
 */
export function UsageWorkProviderMark(
  props: UsageWorkProvider & Readonly<{ serverId: string; showLabel?: boolean; testID?: string }>,
) {
  const { theme } = useUnistyles();
  const metrics = usePageRowMetrics('list');
  const cached = readReusableDaemonMergedProjectionCacheEntry({
    machineId: props.machineId,
    serverId: props.serverId,
  });
  const definition =
    cached?.kind === 'ready'
      ? cached.inputs.pluginProjectionV2?.familiesById.providers?.entriesById[props.providerId]?.definition
      : undefined;
  const parsed = ProviderContributionV1Schema.safeParse(definition);
  const label = parsed.success ? parsed.data.name : props.providerId;
  return (
    <View
      testID={props.testID}
      accessible
      accessibilityLabel={`${t('usage.board.work.provider')}: ${label}`}
      style={styles.mark}
    >
      <ProviderIcon
        icon={parsed.success ? parsed.data.icon : null}
        size={ICON_SIZE.sm}
        color={theme.colors.text.secondary}
      />
      {props.showLabel ? (
        <Text
          style={[
            styles.label,
            { fontSize: metrics.subtitle.fontSize, lineHeight: metrics.subtitle.lineHeight },
          ]}
        >
          {label}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  mark: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  label: { ...Typography.default(), color: theme.colors.text.secondary },
}));
