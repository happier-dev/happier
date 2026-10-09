import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type {
  ManagedProvisionerCard,
  ManagedStatusTone,
} from './managedMachineDisplay';

/**
 * Add a machine → Create one (lab `m-add`): the provisioners, grouped by the first question people
 * have — on this computer and free, or in the cloud and billed. Each card's status and step come from
 * the provisioner's own `check`; nothing is faked ready. Desktop draws cards; a phone draws push rows.
 */
export const MachineProvisionerSections = React.memo(
  function MachineProvisionerSections(
    props: Readonly<{
      cards: readonly ManagedProvisionerCard[];
      /** "On this Mac" (the platform's word for this computer). */
      localTitle: string;
      /** The live, personal line: what the local provisioners share ("12 cores, 36 GB of memory…"). */
      localDescription: string;
      compact: boolean;
      testID: string;
    }>,
  ) {
    const local = props.cards.filter((card) => card.location === 'local');
    const cloud = props.cards.filter((card) => card.location === 'cloud');
    return (
      <>
        {local.length > 0 ? (
          <ProvisionerGroup
            title={props.localTitle}
            description={props.localDescription}
            cards={local}
            compact={props.compact}
            testID={`${props.testID}.local`}
          />
        ) : null}
        {cloud.length > 0 ? (
          <ProvisionerGroup
            title={t('managedMachines.add.cloudTitle')}
            description={
              props.compact
                ? t('managedMachines.add.cloudDescriptionShort')
                : t('managedMachines.add.cloudDescription')
            }
            cards={cloud}
            compact={props.compact}
            testID={`${props.testID}.cloud`}
          />
        ) : null}
        {cloud.length > 0 ? <AccountsNote compact={props.compact} /> : null}
      </>
    );
  },
);

function ProvisionerGroup(
  props: Readonly<{
    title: string;
    description: string;
    cards: readonly ManagedProvisionerCard[];
    compact: boolean;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  if (props.compact) {
    return (
      <ItemGroup title={props.title} description={props.description}>
        {props.cards.map((card) => (
          <Item
            key={card.id}
            testID={`${props.testID}.${card.id}`}
            title={card.title}
            subtitle={[card.kind, card.status.label]
              .filter(Boolean)
              .join(' · ')}
            subtitleLeading={
              card.status.tone === 'none' ? undefined : (
                <StatusDot color={toneColor(theme, card.status.tone)} />
              )
            }
            icon={card.mark}
            onPress={card.action.onPress}
          />
        ))}
      </ItemGroup>
    );
  }
  const byId = new Map(props.cards.map((card) => [card.id, card]));
  return (
    <ItemGroup
      title={props.title}
      description={props.description}
      surface="none"
    >
      <SelectionTiles<string>
        variant="action"
        accessibilityLabel={props.title}
        testIdPrefix={props.testID}
        options={props.cards.map((card) => ({
          id: card.id,
          title: card.title,
          subtitle: card.description,
          mark: card.mark,
          badge: card.kind,
        }))}
        onPress={(id) => byId.get(id)?.action.onPress()}
        renderOptionFooter={({ option }) => {
          const card = byId.get(option.id);
          return card ? (
            <ProvisionerFooter
              card={card}
              testID={`${props.testID}.${card.id}`}
            />
          ) : null;
        }}
      />
    </ItemGroup>
  );
}

function ProvisionerFooter(
  props: Readonly<{ card: ManagedProvisionerCard; testID: string }>,
) {
  const { theme } = useUnistyles();
  const { card } = props;
  return (
    <View style={styles.footer}>
      {card.status.tone === 'none' ? null : (
        <StatusDot color={toneColor(theme, card.status.tone)} />
      )}
      <Text style={styles.status} numberOfLines={1}>
        {card.status.label}
      </Text>
      <RoundButton
        testID={`${props.testID}.action`}
        size="small"
        // Ready provisioners open their configurator; a repair step stays quiet beside it.
        display={card.action.kind === 'choose' ? 'secondary' : 'inverted'}
        title={card.action.label}
        accessibilityLabel={`${card.action.label}, ${card.title}`}
        onPress={card.action.onPress}
      />
    </View>
  );
}

function AccountsNote(props: Readonly<{ compact: boolean }>) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.note} testID="managed-machines.accounts-note">
      <Icon name="lock" size={14} color={theme.colors.text.tertiary} />
      <Text style={styles.noteText}>
        {props.compact
          ? t('managedMachines.add.accountsNoteShort')
          : t('managedMachines.add.accountsNote')}
      </Text>
    </View>
  );
}

function toneColor(
  theme: ReturnType<typeof useUnistyles>['theme'],
  tone: ManagedStatusTone,
): string {
  return tone === 'ready'
    ? theme.colors.status.connected
    : theme.colors.state.warning.foreground;
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  status: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    flex: 1,
    minWidth: 0,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 4,
  },
  noteText: {
    ...Typography.default(),
    ...happierPageTextMetrics('sectionDescription'),
    color: theme.colors.text.secondary,
    flex: 1,
  },
}));
