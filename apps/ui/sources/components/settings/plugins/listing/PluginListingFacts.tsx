import * as React from 'react';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';

import { pluginListingAdds } from '../model/pluginContributionKindLabel';
import type { PluginMarketplaceCatalogEntry } from '../readPluginMarketplaceCatalog';

function realmLabels(entry: PluginMarketplaceCatalogEntry): readonly string[] {
  return entry.executableRealms.map((realm) => {
    if (realm === 'daemon')
      return t('settingsPlugins.discover.executableRealm.daemon');
    if (realm === 'client')
      return t('settingsPlugins.discover.executableRealm.client');
    return t('settingsPlugins.discover.executableRealm.hostedWeb');
  });
}

function platformLabels(
  entry: PluginMarketplaceCatalogEntry,
): readonly string[] {
  return entry.platforms.map((platform) => {
    if (platform === 'darwin')
      return t('settingsPlugins.discover.platform.darwin');
    if (platform === 'linux')
      return t('settingsPlugins.discover.platform.linux');
    if (platform === 'windows')
      return t('settingsPlugins.discover.platform.windows');
    if (platform === 'web') return t('settingsPlugins.discover.platform.web');
    if (platform === 'ios') return t('settingsPlugins.discover.platform.ios');
    return t('settingsPlugins.discover.platform.android');
  });
}

/** A fact value from lower-case catalog fragments ("background service · app"). */
function describeCatalogFacts(values: readonly string[]): string {
  const joined = joinHappierFacts(...values);
  if (!joined) return t('settingsPlugins.installReviewSections.none');
  return joined.charAt(0).toLocaleUpperCase() + joined.slice(1);
}

/**
 * What a marketplace listing adds, from its published manifest summary. One owner for the Plugins listing page and
 * every Add flow that offers a plugin (Add an agent, P9 F6).
 */
export function PluginListingAddsSection(
  props: Readonly<{
    entry: PluginMarketplaceCatalogEntry;
    description?: string;
    testID?: string;
  }>,
) {
  const adds = pluginListingAdds(props.entry.contributions);
  if (adds.length === 0) return null;
  return (
    <ItemGroup
      title={t('settingsPlugins.catalog.adds')}
      {...(props.description ? { description: props.description } : {})}
    >
      {adds.map((add, index) => (
        <Item
          key={add.key}
          testID={index === 0 ? props.testID : undefined}
          title={add.title}
          subtitle={add.description}
          mode="info"
          showChevron={false}
        />
      ))}
    </ItemGroup>
  );
}

/**
 * A listing's published facts before install (where it runs, platforms, source, categories) and its links. A host
 * that frames these facts as the trust decision (the Add details) passes its own section title and description.
 */
export function PluginListingFacts(
  props: Readonly<{
    entry: PluginMarketplaceCatalogEntry;
    title?: string;
    description?: string;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { entry } = props;
  const links = [
    {
      id: 'homepage',
      title: t('settingsPlugins.catalog.homepage'),
      url: entry.links.homepage,
    },
    {
      id: 'repository',
      title: t('settingsPlugins.catalog.repository'),
      url: entry.links.repository,
    },
    {
      id: 'support',
      title: t('settingsPlugins.catalog.support'),
      url: entry.links.support,
    },
    {
      id: 'universal',
      title: t('settingsPlugins.catalog.pluginPage'),
      url: entry.links.universal,
    },
  ].filter((link): link is typeof link & { url: string } => Boolean(link.url));
  return (
    <>
      <ItemGroup
        testID={props.testID}
        title={props.title ?? t('common.details')}
        {...(props.description ? { description: props.description } : {})}
      >
        <Item
          title={t('settingsPlugins.surfaces.listingRunsIn')}
          detail={describeCatalogFacts(realmLabels(entry))}
          mode="info"
          showChevron={false}
        />
        <Item
          title={t('settingsPlugins.surfaces.listingPlatforms')}
          detail={describeCatalogFacts(platformLabels(entry))}
          mode="info"
          showChevron={false}
        />
        <Item
          title={t('settingsPlugins.surfaces.listingSource')}
          detail={entry.sourceTitle}
          mode="info"
          showChevron={false}
        />
        {entry.categories.length > 0 ? (
          <Item
            title={t('settingsPlugins.surfaces.listingCategories')}
            detail={entry.categories.join(', ')}
            mode="info"
            showChevron={false}
          />
        ) : null}
      </ItemGroup>
      {links.length > 0 ? (
        <ItemGroup title={t('settingsPlugins.catalog.links')}>
          {links.map((link) => (
            <Item
              key={link.id}
              title={link.title}
              testID={`settings.plugins.listing.link.${link.id}`}
              rightElement={
                <Icon
                  name="arrow-square-out"
                  size={16}
                  color={theme.colors.text.secondary}
                />
              }
              showChevron={false}
              onPress={async () => {
                if (!(await openExternalUrl(link.url)))
                  Modal.alert(t('common.error'), t('common.requestFailed'));
              }}
            />
          ))}
        </ItemGroup>
      ) : null}
    </>
  );
}
