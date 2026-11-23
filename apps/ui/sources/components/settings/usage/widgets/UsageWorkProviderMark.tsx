import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ProviderContributionKeySchema } from '@happier-dev/protocol/providers/ids';
import { normalizeProviderContributionKeyV1, parseProviderContributionIdentityV1 } from '@happier-dev/protocol/providers/contribution-identity';
import { readReusableDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { providerDeclarationContext, readAccountProviderDeclaration } from '@/providers/catalog/accountProviderDeclarations';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { formatUsageDimensionLabel } from '@/sync/api/account/formatUsageDimensionLabel';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { t } from '@/text';
import type { UsageWorkProvider } from './usageWorkPresentation';

/** One witnessed Provider identity and every Machine that witnessed it. */
export type UsageWorkProviderIdentity = Readonly<{ providerId: string; machineIds: readonly (string | null)[] }>;

/**
 * A witnessed Provider's display metadata. Any witnessing Machine whose admitted catalog declares it names it; then
 * the Account's bundled declarations; only then the contribution's own local id, never the raw qualified id
 * (review J-B31, acceptance r224 #48).
 */
export function resolveUsageWorkProviderDisplay(provider: UsageWorkProviderIdentity, serverId: string) {
  return usageWorkProviderDisplay(provider.providerId, provider.machineIds.map(machineId => {
    const cached = readReusableDaemonMergedProjectionCacheEntry({ machineId, serverId, sections: ['familiesById.providers'] });
    return { machineId, projection: cached?.kind === 'ready' ? cached.inputs.pluginProjectionV2 : null };
  }));
}

/** What one witnessing Machine admits about Providers; `null` when that Machine has no retained read. */
export type UsageWorkWitnessedProjection = Readonly<{ machineId: string | null; projection: PluginProjectionV2 | null | undefined }>;

/** The display of one Provider from its witnesses' admitted catalogs; see `resolveUsageWorkProviderDisplay`. */
export function usageWorkProviderDisplay(providerId: string, witnessed: readonly UsageWorkWitnessedProjection[]) {
  const declared = ProviderContributionKeySchema.safeParse(providerId).success;
  let declaration = null;
  for (const { machineId, projection } of declared ? witnessed : []) {
    declaration = projection ? readAccountProviderDeclaration(providerId, providerDeclarationContext(machineId, projection)) : null;
    if (declaration) break;
  }
  declaration ??= declared ? readAccountProviderDeclaration(providerId, { kind: 'account' }) : null;
  const localId = parseProviderContributionIdentityV1(providerId)?.identity.localId ?? providerId;
  return {
    label: declaration?.definition.name
      ?? formatUsageDimensionLabel('source', localId, localId.replace(/^[a-z]/, letter => letter.toUpperCase())),
    contributionKey: declaration?.contributionKey,
    icon: declaration?.definition.icon ?? null,
  };
}

/** Each witnessed Provider once, by identity: the same Provider seen on several Machines keeps all its witnesses. */
export function usageWorkProviderIdentities(providers: readonly UsageWorkProvider[]): readonly UsageWorkProviderIdentity[] {
  const byIdentity = new Map<string, { providerId: string; machineIds: (string | null)[] }>();
  for (const provider of providers) {
    const key = normalizeProviderContributionKeyV1(provider.providerId) ?? provider.providerId;
    const identity = byIdentity.get(key);
    if (identity) identity.machineIds.push(provider.machineId);
    else byIdentity.set(key, { providerId: provider.providerId, machineIds: [provider.machineId] });
  }
  return [...byIdentity.values()];
}

/**
 * One name per identity, in order. Identity decides, never the label: a name another identity on the same line also
 * carries (another Provider, or an Agent in `taken`) is told apart by the Provider's whole contribution identity in
 * words ("Gateway (Acme First Gateway)"), never by the raw qualified id.
 */
export function usageWorkProviderNames(providers: readonly UsageWorkProviderIdentity[], serverId: string,
  taken: readonly string[] = []): readonly string[] {
  const labels = providers.map(provider => resolveUsageWorkProviderDisplay(provider, serverId).label);
  const counts = new Map<string, number>();
  for (const label of [...taken, ...labels]) counts.set(label, (counts.get(label) ?? 0) + 1);
  return labels.map((label, index) => (counts.get(label) ?? 0) < 2 ? label
    : `${label} (${formatUsageDimensionLabel('source', providers[index]!.providerId)})`);
}

/** A Provider mark, with the same name in its spoken label and optional visible text. */
export function UsageWorkProviderMark(
  props: Readonly<{ provider: UsageWorkProviderIdentity; serverId: string; label?: string; showLabel?: boolean; testID?: string }>,
) {
  const { theme } = useUnistyles();
  const metrics = usePageRowMetrics('list');
  const display = resolveUsageWorkProviderDisplay(props.provider, props.serverId);
  const { contributionKey, icon } = display;
  // The strip passes the name it tells apart from its neighbours; a mark alone says its display name.
  const label = props.label ?? display.label;
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
