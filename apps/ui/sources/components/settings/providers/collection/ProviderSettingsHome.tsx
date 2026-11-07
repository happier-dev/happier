import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { t } from '@/text';

import { PROVIDERS_SETTINGS } from '../providersSettings';
import { INVITATION_MARK_COUNT } from './ProviderCollectionInvitation';
import type { ProviderAvailableContribution } from './providerCollectionModel';

/** The card's facts line: what connecting asks for, from the declaration (no invented description). */
const credentialFact = (provider: ProviderAvailableContribution) =>
  provider.credential?.required ? t('settingsProviders.authoring.apiKey') : null;

/**
 * `/settings/providers` beside its column, as the lab's overview (crProv-home): what Providers are for and the page's one
 * Add, then your providers with their state, gateways, what Teams share, and the providers to connect.
 */
export const ProviderSettingsHome = React.memo(function ProviderSettingsHome(
  props: Readonly<{
    available: ReadonlyArray<ProviderAvailableContribution>;
    /** Which Machine "On machines" reads, kept in the header like the page's (Machine context rule). */
    targetChip: React.ReactNode;
    onAdd: () => void;
    onConnect: (contributionKey: string) => void;
    /** Your providers, gateways and Team providers, ahead of the providers to connect. */
    children: React.ReactNode;
  }>,
) {
  const { theme } = useUnistyles();
  const { onAdd, onConnect } = props;
  return (
    <ItemList pageColumn="wide" testID="settings-providers-home">
      <PageContentColumn>
        <PageHeader
          testID="settings-providers-home.header"
          title={t('settingsProviders.title')}
          alwaysShowTitle
          description={t('settingsProvidersCollection.description')}
          actionsPlacement="page"
          actions={
            <View style={styles.actions}>
              {props.targetChip}
              <SettingAnchor setting={PROVIDERS_SETTINGS.settings.add}>
                <SettingAnchor setting={PROVIDERS_SETTINGS.settings.custom}>
                <RoundButton
                  testID="settings-providers-add"
                  title={t('settingsProvidersCollection.addProvider')}
                  leading={
                    <Icon
                      name="plus"
                      size={16}
                      color={theme.colors.button.primary.tint}
                    />
                  }
                  onPress={onAdd}
                />
              </SettingAnchor>
              </SettingAnchor>
            </View>
          }
        />
        {props.children}
        <ProviderConnectShelf available={props.available} onAdd={onAdd} onConnect={onConnect} />
      </PageContentColumn>
    </ItemList>
  );
});

/**
 * "Bring your own models": the contribution-backed providers to connect, as rows with Add, then "Browse all" to every
 * provider (lab crProv-home "Add a provider"). One owner for the wide home and a phone's page; a row hands its
 * contribution to the one authoring route.
 */
export const ProviderConnectShelf = React.memo(function ProviderConnectShelf(
  props: Readonly<{
    available: ReadonlyArray<ProviderAvailableContribution>;
    onAdd: () => void;
    onConnect: (contributionKey: string) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { onAdd, onConnect } = props;
  if (props.available.length === 0) return null;
  // A few to start with, in the catalog's own order; the rest are one press away, never a catalog on the overview.
  const featured = props.available.slice(0, INVITATION_MARK_COUNT);
  const more = props.available.length - featured.length;
  return (
    <ItemGroup
      testID="settings-providers-home.shelf"
      title={t('settingsProvidersCollection.invitationTitle')}
      description={t('settingsProviders.availableFooter')}
    >
      {featured.map((provider) => (
        <Item
          key={provider.contributionKey}
          testID={`settings-providers-home.row.${provider.contributionKey}`}
          title={provider.name}
          subtitle={credentialFact(provider) ?? undefined}
          icon={<ProviderIcon contributionKey={provider.contributionKey} icon={provider.icon} size={20} color={theme.colors.text.secondary} />}
          showChevron={false}
          onPress={() => onConnect(provider.contributionKey)}
          rightElement={(
            <RoundButton
              testID={`settings-providers-home.connect.${provider.contributionKey}`}
              size="small"
              display="secondary"
              title={t('common.add')}
              accessibilityLabel={`${t('common.add')} ${provider.name}`}
              onPress={() => onConnect(provider.contributionKey)}
            />
          )}
          rightElementOutsidePressable
        />
      ))}
      <Item
        testID="settings-providers-home.browse-all"
        title={t('capabilities.skillsUpdates.shelf.browseAll')}
        subtitle={more > 0 ? t('tools.common.more', { count: more }) : undefined}
        icon={<Icon name="squares-four" size={20} color={theme.colors.text.secondary} />}
        onPress={onAdd}
      />
    </ItemGroup>
  );
});

const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));
