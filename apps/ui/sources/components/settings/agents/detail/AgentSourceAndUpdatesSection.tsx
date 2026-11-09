import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierPressable,
  happierPageTextMetrics,
} from '@happier-dev/plugin-ui/presentation';

import { BUILT_IN_REGISTRY_SOURCES_V1 } from '@happier-dev/protocol/registries';
import type { AcpBackendDefinitionV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';

import { areAgentRegistryChecksumsPublished } from '@/agents/registry/agentRegistryChecksums';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { fireAndForget } from '@/utils/system/fireAndForget';

/** What the update check knows right now, from the page's one checker (P4 `registries.updates.check`). */
export type AgentUpdateCheckState = Readonly<{
  checking: boolean;
  failed: boolean;
  checkedAt: number | null;
}>;

function sourceTitle(definition: AcpBackendDefinitionV1): string {
  const provenance = definition.origin?.provenance;
  if (!provenance) return '';
  const builtIn = BUILT_IN_REGISTRY_SOURCES_V1.find(
    (source) => source.id === provenance.sourceId,
  );
  if (builtIn) return builtIn.title;
  if (provenance.ref.kind === 'packageContent') return provenance.ref.pluginId;
  if (provenance.sourceUrl === undefined) return provenance.sourceId;
  try {
    return new URL(provenance.sourceUrl).host;
  } catch {
    return provenance.sourceUrl;
  }
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function launchVersion(definition: AcpBackendDefinitionV1): string | null {
  return definition.launch.kind === 'command'
    ? null
    : definition.launch.version;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * "Source and updates" (P9 row 25, F10): where a registry agent comes from, the version the person
 * chose and what the registry says now, and whether downloads are checked. Registry definitions only.
 * Updates never apply on their own: Update re-adds the newer version through `installFromRegistry`.
 */
export function AgentSourceAndUpdatesSection(
  props: Readonly<{
    definition: AcpBackendDefinitionV1;
    check: AgentUpdateCheckState;
    onCheckNow: () => void;
    /** Present when the registry lists a newer version: re-adds it (one confirm) on the machines it's on. */
    onUpdate: ((version: string) => void) | null;
    updating: boolean;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { definition, check } = props;
  const origin = definition.origin;
  if (!origin) return null;
  const version = launchVersion(definition);
  const upstream = origin.upstream;
  const latest =
    upstream?.state === 'update_available' &&
    upstream.latest?.kind === 'version'
      ? upstream.latest.version
      : null;
  const facts = [origin.publisher, origin.license].filter(
    (fact): fact is string => Boolean(fact),
  );
  const link = origin.repository ?? origin.website ?? null;
  const versionDescription = check.checking
    ? t('settingsAgents.detailPage.versionChecking')
    : check.failed
      ? t('settingsAgents.detailPage.versionCheckFailed')
      : upstream?.state === 'removed_from_source'
        ? t('settingsAgents.detailPage.versionNotListed')
        : latest
          ? t('settingsAgents.detailPage.versionAvailable', { version: latest })
          : check.checkedAt !== null
            ? t('settingsAgents.detailPage.versionLatestChecked', {
                time: formatClock(check.checkedAt),
              })
            : t('settingsAgents.detailPage.versionChosen');
  const archive =
    definition.launch.kind === 'archive' ? definition.launch : null;
  const checksumPublished = archive
    ? areAgentRegistryChecksumsPublished(archive.assetsByPlatform)
    : false;

  return (
    <ItemGroup
      testID={props.testID}
      title={t('settingsAgents.detailPage.sourceTitle')}
      description={t('settingsAgents.detailPage.sourceDescription')}
    >
      <Item
        testID={`${props.testID}:registry`}
        icon={
          <Icon name="cube" size={20} color={theme.colors.text.secondary} />
        }
        title={sourceTitle(definition)}
        subtitle={
          facts.length > 0 || link ? (
            <View style={styles.facts}>
              {facts.length > 0 ? (
                <Text style={styles.fact} numberOfLines={1}>
                  {facts.join(' · ')}
                </Text>
              ) : null}
              {link ? (
                <HappierPressable
                  testID={`${props.testID}:repository`}
                  accessibilityRole="link"
                  onPress={() =>
                    fireAndForget(openExternalUrl(link), {
                      tag: 'AgentSourceAndUpdates.repository',
                    })
                  }
                  style={styles.linkPress}
                >
                  <Text style={[styles.fact, styles.link]} numberOfLines={1}>
                    {displayUrl(link)}
                  </Text>
                  <Icon
                    name="arrow-square-out"
                    size={12}
                    color={theme.colors.text.tertiary}
                  />
                </HappierPressable>
              ) : null}
            </View>
          ) : undefined
        }
        showChevron={false}
      />
      <Item
        testID={`${props.testID}:version`}
        title={t('settingsAgents.detailPage.versionTitle')}
        titleAccessory={
          version ? <Text style={styles.version}>{version}</Text> : undefined
        }
        subtitle={versionDescription}
        subtitleLines={0}
        rightElement={
          latest && props.onUpdate ? (
            <RoundButton
              testID={`${props.testID}:update`}
              size="small"
              display="secondary"
              title={t('settingsAgents.detailPage.updateTo', {
                version: latest,
              })}
              loading={props.updating}
              disabled={props.updating}
              onPress={() => props.onUpdate?.(latest)}
            />
          ) : (
            <RoundButton
              testID={`${props.testID}:checkNow`}
              size="small"
              display="inverted"
              title={
                check.failed
                  ? t('common.retry')
                  : t('settingsAgents.detailPage.checkNow')
              }
              leading={
                <Icon
                  name="arrow-clockwise"
                  size={14}
                  color={theme.colors.text.secondary}
                />
              }
              loading={check.checking}
              disabled={check.checking}
              onPress={props.onCheckNow}
            />
          )
        }
        rightElementOutsidePressable
        accessoryLayout="adaptive"
        showChevron={false}
      />
      {archive ? (
        <Item
          testID={`${props.testID}:checksum`}
          title={t('settingsAgents.detailPage.checksumTitle')}
          subtitle={
            checksumPublished
              ? t('settingsAgents.detailPage.checksumVerifiedDescription')
              : t('settingsAgents.detailPage.checksumNotPublished')
          }
          subtitleLines={0}
          rightElement={
            checksumPublished ? (
              <View style={styles.verified}>
                <Icon
                  name="shield-check"
                  size={16}
                  color={theme.colors.text.secondary}
                />
                <Text style={styles.fact}>
                  {t('settingsAgents.detailPage.checksumVerified')}
                </Text>
              </View>
            ) : undefined
          }
          showChevron={false}
        />
      ) : null}
    </ItemGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  facts: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    flexWrap: 'wrap',
    // Facts and the repository link wrap as two units, so a narrow row never starts a line with a separator.
    columnGap: theme.space.s12,
  },
  fact: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
  linkPress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    minWidth: 0,
  },
  link: {
    textDecorationLine: 'underline',
    textDecorationColor: theme.colors.border.default,
  },
  version: {
    ...Typography.mono(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
    marginLeft: theme.space.s6,
  },
  verified: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
}));
