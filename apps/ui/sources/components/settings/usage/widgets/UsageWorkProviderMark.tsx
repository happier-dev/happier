import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ProviderContributionKeySchema } from '@happier-dev/protocol/providers/ids';
import { normalizeProviderContributionKeyV1, parseProviderContributionIdentityV1 } from '@happier-dev/protocol/providers/contribution-identity';
import { readReusableDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { providerDeclarationContext, readAccountProviderDeclaration } from '@/providers/catalog/accountProviderDeclarations';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { formatUsageDimensionLabel } from '@/sync/api/account/formatUsageDimensionLabel';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { t } from '@/text';
import type { UsageWorkProvider } from './usageWorkPresentation';

/**
 * A witnessed Provider's display metadata. The Machine's admitted catalog names it first; a Machine with no read
 * (offline, never opened) falls back to the Account's bundled declarations. A Provider no catalog declares is
 * named from its contribution's own local id, never shown as the raw qualified id (review J-B31, acceptance r224 #48).
 */
export function resolveUsageWorkProviderDisplay(provider: UsageWorkProvider, serverId: string) {
  const declared = ProviderContributionKeySchema.safeParse(provider.providerId).success;
  const cached = declared ? readReusableDaemonMergedProjectionCacheEntry({
    machineId: provider.machineId,
    serverId,
    sections: ['familiesById.providers'],
  }) : null;
  const projection = cached?.kind === 'ready' ? cached.inputs.pluginProjectionV2 : null;
  const declaration = !declared ? null
    : (projection ? readAccountProviderDeclaration(provider.providerId, providerDeclarationContext(provider.machineId, projection)) : null)
      ?? readAccountProviderDeclaration(provider.providerId, { kind: 'account' });
  const localId = parseProviderContributionIdentityV1(provider.providerId)?.identity.localId ?? provider.providerId;
  return {
    label: declaration?.definition.name
      ?? formatUsageDimensionLabel('source', localId, localId.replace(/^[a-z]/, letter => letter.toUpperCase())),
    contributionKey: declaration?.contributionKey,
    icon: declaration?.definition.icon ?? null,
  };
}

/** Each witnessed Provider once: the same Provider seen on several Machines is one identity. */
export function usageWorkProviderIdentities(providers: readonly UsageWorkProvider[]): readonly UsageWorkProvider[] {
  const byIdentity = new Map<string, UsageWorkProvider>();
  for (const provider of providers) {
    const key = normalizeProviderContributionKeyV1(provider.providerId) ?? provider.providerId;
    if (!byIdentity.has(key)) byIdentity.set(key, provider);
  }
  return byIdentity.size === providers.length ? providers : [...byIdentity.values()];
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
