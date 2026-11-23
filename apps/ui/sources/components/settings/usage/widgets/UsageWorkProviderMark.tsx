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

/** A witnessed Provider's display metadata reuses the admitted catalog. */
export function resolveUsageWorkProviderDisplay(provider: UsageWorkProvider, serverId: string) {
  const cached = readReusableDaemonMergedProjectionCacheEntry({
    machineId: provider.machineId,
    serverId,
    sections: ['familiesById.providers'],
  });
  const contribution =
    cached?.kind === 'ready'
      ? cached.inputs.pluginProjectionV2?.familiesById.providers?.entriesById[provider.providerId]
      : undefined;
  const parsed = ProviderContributionV1Schema.safeParse(contribution?.definition);
  return {
    label: parsed.success ? parsed.data.name : provider.providerId,
    contributionKey: contribution?.id,
    icon: parsed.success ? parsed.data.icon : null,
  };
}

/** A Provider mark, with the same name in its spoken label and optional visible text. */
export function UsageWorkProviderMark(
  props: UsageWorkProvider & Readonly<{ serverId: string; showLabel?: boolean; testID?: string }>,
) {
  const { theme } = useUnistyles();
  const metrics = usePageRowMetrics('list');
  const { label, contributionKey, icon } = resolveUsageWorkProviderDisplay(props, props.serverId);
  return (
    <View
      testID={props.testID}
      accessible
      accessibilityLabel={`${t('usage.board.work.provider')}: ${label}`}
      style={styles.mark}
    >
      <ProviderIcon
        contributionKey={contributionKey}
        icon={icon}
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
  mark: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
  label: { ...Typography.default(), color: theme.colors.text.secondary },
}));
