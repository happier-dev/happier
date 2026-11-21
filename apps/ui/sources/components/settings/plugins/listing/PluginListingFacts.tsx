import * as React from 'react';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import type { PluginWorkflowContributionV1 } from '@happier-dev/protocol/plugins/manifest';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';

import { pluginListingAdds } from '../model/pluginContributionKindLabel';
import { browseCategoryTitle } from '../model/pluginMarketplaceModel';
import { describePluginContentCounts, describePluginContentOmissions } from '../model/pluginInstallationReviewFacts';
import type { PluginMarketplaceCatalogEntry } from '../readPluginMarketplaceCatalog';
import { BrowserExtensionListingFacts, type BrowserExtensionListingFactsProps } from './BrowserExtensionListingFacts';

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
    onOpenSuggestedAutomation?: (automation: PluginWorkflowContributionV1) => void;
  }>,
) {
  const vendor = props.entry.vendorPlugin;
  // A vendor package says what it contains in counts and what Happier left out; a Happier listing names the kinds.
  const contents = vendor?.contentCounts ? describePluginContentCounts(vendor.contentCounts) : null;
  const omissions = describePluginContentOmissions(vendor?.notImported);
  const adds = contents ? [] : pluginListingAdds(props.entry.contributions);
  const automations = vendor?.suggestedAutomations ?? [];
  const openSuggestion = props.onOpenSuggestedAutomation;
  const hasAdds = (contents?.length ?? 0) > 0 || adds.length > 0 || omissions.length > 0;
  return (
    <>
      {hasAdds ? (
        <ItemGroup
          title={t('settingsPlugins.catalog.adds')}
          {...(props.description ? { description: props.description } : {})}
        >
          {(contents ?? []).map((content, index) => (
            <Item key={content} testID={index === 0 ? props.testID : undefined} title={content}
              mode="info" showChevron={false} />
          ))}
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
          {omissions.length > 0 ? (
            <Item testID="settings.plugins.listing.notImported" title={t('settingsPlugins.gitInstall.notImported')}
              subtitle={omissions.join(', ')} mode="info" showChevron={false} />
          ) : null}
        </ItemGroup>
      ) : null}
      {openSuggestion && automations.length > 0 ? (
        <ItemGroup title={t('settingsPlugins.surfaces.suggestedAutomationsTitle')}>
          {automations.map((automation) => (
            <Item
              key={automation.id}
              testID={`settings.plugins.listing.suggestedAutomation.${automation.id}`}
              title={automation.title}
              {...(automation.description ? { subtitle: automation.description } : {})}
              onPress={() => openSuggestion(automation)}
            />
          ))}
        </ItemGroup>
      ) : null}
    </>
  );
}

/**
 * A listing's published facts before install (where it runs, platforms, source, categories) and its links. A host
 * that frames these facts as the trust decision (the Add details) passes its own section title and description.
 */
type PluginCatalogListingFactsProps = Readonly<{
    entry: PluginMarketplaceCatalogEntry;
    title?: string;
    description?: string;
    testID?: string;
}>;

export function PluginListingFacts(props: PluginCatalogListingFactsProps | BrowserExtensionListingFactsProps) {
    return 'browserExtension' in props ? <BrowserExtensionListingFacts {...props} /> : <PluginCatalogListingFacts {...props} />;
}

function PluginCatalogListingFacts(props: PluginCatalogListingFactsProps) {
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
        {/* An undeclared fact (a content-only plugin runs nowhere of its own) has no row rather than "None". */}
        {entry.executableRealms.length > 0 ? (
          <Item
            title={t('settingsPlugins.surfaces.listingRunsIn')}
            detail={describeCatalogFacts(realmLabels(entry))}
            mode="info"
            showChevron={false}
          />
        ) : null}
        {entry.platforms.length > 0 ? (
          <Item
            title={t('settingsPlugins.surfaces.listingPlatforms')}
            detail={describeCatalogFacts(platformLabels(entry))}
            mode="info"
            showChevron={false}
          />
        ) : null}
        <Item
          title={t('settingsPlugins.surfaces.listingSource')}
          detail={entry.sourceTitle}
          mode="info"
          showChevron={false}
        />
        {entry.categories.length > 0 ? (
          <Item
            title={t('settingsPlugins.surfaces.listingCategories')}
            detail={entry.categories.map(browseCategoryTitle).join(', ')}
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
