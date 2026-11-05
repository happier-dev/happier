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
import { MANAGED_PROVISIONER_MARK_SIZE } from './useManagedProvisionerPresentation';

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
      /** The machine-scope chip ("Managed from · MacBook Pro"), set on the first section's header. */
      scope?: React.ReactNode;
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
            action={props.scope}
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
            action={local.length > 0 ? undefined : props.scope}
            compact={props.compact}
            testID={`${props.testID}.cloud`}
          />
        ) : null}
        {/* The note is page content: an edge-only section gives it the page column, not a local inset. */}
        {cloud.length > 0 ? (
          <ItemGroup surface="none">
            <AccountsNote compact={props.compact} />
          </ItemGroup>
        ) : null}
      </>
    );
  },
);

function ProvisionerGroup(
  props: Readonly<{
    title: string;
    description: string;
    cards: readonly ManagedProvisionerCard[];
    action?: React.ReactNode;
    compact: boolean;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  if (props.compact) {
    return (
      <ItemGroup title={props.title} description={props.description} action={props.action}
        actionLayout="adaptive">
        {props.cards.map((card) => (
          <Item
            key={card.id}
            testID={`${props.testID}.${card.id}`}
            title={card.title}
            // What it creates is named for cloud rows only, as on the cards.
            subtitle={[card.location === 'cloud' ? card.kind : null, card.status.label]
              .filter(Boolean)
              .join(' · ')}
            subtitleLeading={
              card.status.tone === 'none' ? undefined : (
                <StatusDot color={toneColor(theme, card.status.tone)} />
              )
            }
            icon={card.mark(MANAGED_PROVISIONER_MARK_SIZE.row)}
            onPress={card.action.disabled ? undefined : card.action.onPress}
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
      action={props.action}
        actionLayout="adaptive"
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
          mark: card.mark(MANAGED_PROVISIONER_MARK_SIZE.tile),
          // Four local cards across leave no room for a kind badge (lab note); cloud cards name theirs.
          ...(card.location === 'cloud' && card.kind ? { badge: card.kind } : {}),
        }))}
        onPress={(id) => { const action = byId.get(id)?.action; if (action && !action.disabled) action.onPress(); }}
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
      {/* Every card reads the same at every width: the status line, then its button beneath it on
          the text column. A status never truncates and never decides the button's place. */}
      <View style={styles.statusGroup}>
        {card.status.tone === 'none' ? null : (
          <View style={styles.statusDot}>
            <StatusDot color={toneColor(theme, card.status.tone)} />
          </View>
        )}
        {card.status.label ? <Text style={styles.status}>{card.status.label}</Text> : null}
      </View>
      {/* No step to take means no button: the status, or the catalog's one line with its Retry, says why. */}
      {card.action.disabled ? null : (
        <RoundButton
          testID={`${props.testID}.action`}
          size="small"
          // Ready provisioners open their configurator; a repair step stays quiet beside it.
          display={card.action.kind === 'choose' ? 'secondary' : 'inverted'}
          title={card.action.label}
          accessibilityLabel={`${card.action.label}, ${card.title}`}
          onPress={card.action.onPress}
        />
      )}
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
    alignItems: 'flex-start',
    gap: theme.space.s10,
  },
  statusGroup: {
    flexDirection: 'row',
    // A status that wraps ("Not installed · get it from cua.ai") keeps its dot on the first line.
    alignItems: 'flex-start',
    gap: theme.space.s6,
    alignSelf: 'stretch',
  },
  statusDot: {
    height: happierPageTextMetrics('meta').lineHeight,
    justifyContent: 'center',
  },
  status: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
  },
  noteText: {
    ...Typography.default(),
    ...happierPageTextMetrics('sectionDescription'),
    color: theme.colors.text.secondary,
    flex: 1,
  },
}));
