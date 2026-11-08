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
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type {
  ManagedProvisionerCard,
  ManagedStatusTone,
} from './managedMachineDisplay';
import { MANAGED_PROVISIONER_MARK_SIZE, ManagedProvisionerRepairFailureNotice } from './useManagedProvisionerPresentation';
import { ManagedScopeRow } from './ManagedScopeRow';
import { joinList } from '@/utils/text/joinList';

/** Where the "Managed from" chip sits: a page section's header, or its own row where headers carry no actions. */
export type ManagedProvisionerScope = Readonly<{ chip: React.ReactNode; placement: 'header' | 'row' }>;

/**
 * Add a machine → Create one (lab `m-add`, `af-add`): the provisioners, grouped by the first question people
 * have — on a computer they control, a cloud sandbox, or a cloud server. Each card's status and step come from
 * the provisioner's own `check`; nothing is faked ready. Desktop draws cards; a phone draws push rows.
 * Only a provisioner one of your computers creates (its declared acquire role) names that computer: the
 * chip sits on the section holding one, and Account-created ones never show it.
 */
export const MachineProvisionerSections = React.memo(
  function MachineProvisionerSections(
    props: Readonly<{
      cards: readonly ManagedProvisionerCard[];
      /** The translated group title for computers the person controls. */
      localTitle: string;
      /** The live, personal line: what the local provisioners share ("12 cores, 36 GB of memory…"). */
      localDescription: string;
      compact: boolean;
      testID: string;
      /** The machine-scope chip ("Managed from · MacBook Pro"), for the section of computer-run provisioners. */
      scope?: ManagedProvisionerScope;
      /** Computer-run machines while no computer can run them: one row naming them, leading to adding a computer. */
      localCollapsed?: Readonly<{ names: readonly string[]; onAddComputer: () => void }>;
      /** Opens the one hand-off for every provider this browser cannot reach, named once per group. */
      onHandoff?: () => void;
    }>,
  ) {
    const local = props.cards.filter((card) => card.location === 'local');
    const sandboxes = props.cards.filter((card) => card.location === 'cloud' && card.enrollmentRole === 'sandbox');
    const cloud = props.cards.filter((card) => card.location === 'cloud' && card.enrollmentRole !== 'sandbox');
    // The chip belongs with this computer's machines; a cloud provider a computer runs (Modal) carries it only without them.
    const scoped = [local, sandboxes, cloud].find((cards) => cards.some((card) => card.acquire === 'daemon'));
    const scopeFor = (cards: readonly ManagedProvisionerCard[]) =>
      props.scope && cards === scoped ? props.scope : undefined;
    const group = (cards: readonly ManagedProvisionerCard[], key: 'local' | 'cloud-sandboxes' | 'cloud') => {
      if (cards.length === 0) return null;
      const scope = scopeFor(cards);
      return (
        <React.Fragment key={key}>
          {scope?.placement === 'row' ? <ManagedScopeRow testID="managed-picker.scope" chip={scope.chip} /> : null}
          <ProvisionerGroup
            title={key === 'local' ? props.localTitle : t(key === 'cloud-sandboxes'
              ? 'managedMachines.add.cloudSandboxesTitle' : 'managedMachines.add.cloudTitle')}
            description={key === 'local' ? props.localDescription
              : props.compact ? t('managedMachines.add.cloudDescriptionShort') : t('managedMachines.add.cloudDescription')}
            cards={cards}
            action={scope?.placement === 'header' ? scope.chip : undefined}
            compact={props.compact}
            onHandoff={props.onHandoff}
            testID={`${props.testID}.${key}`}
          />
        </React.Fragment>
      );
    };
    const collapsed = props.localCollapsed && props.localCollapsed.names.length > 0 ? (
      <LocalCollapsedGroup key="collapsed" names={props.localCollapsed.names} onAddComputer={props.localCollapsed.onAddComputer}
        compact={props.compact} testID={`${props.testID}.local.collapsed`} />
    ) : null;
    return (
      <>
        {/* Computers the person controls lead, then cloud sandboxes and servers. Which
            Add path leads is a separate decision (58d §D2, `machineAddLeadsWithCreate`). */}
        {group(local, 'local')}
        {collapsed}
        {group(sandboxes, 'cloud-sandboxes')}
        {group(cloud, 'cloud')}
        {/* The note is page content: an edge-only section gives it the page column, not a local inset. */}
        {sandboxes.length > 0 || cloud.length > 0 ? (
          <ItemGroup surface="none">
            <AccountsNote compact={props.compact} />
          </ItemGroup>
        ) : null}
      </>
    );
  },
);

/** Machines a computer you've added runs, folded until one can run them. */
function LocalCollapsedGroup(
  props: Readonly<{ names: readonly string[]; onAddComputer: () => void; compact: boolean; testID: string }>,
) {
  const { theme } = useUnistyles();
  const label = t('managedMachines.add.action.addComputer');
  return (
    <ItemGroup title={t('managedMachines.add.onThisComputer')}>
      <Item
        testID={props.testID}
        title={t('managedMachines.add.localCollapsedTitle')}
        subtitle={t('managedMachines.add.localCollapsedBody', { names: joinList([...props.names]) })}
        subtitleLines={0}
        icon={<Icon name="laptop" size={MANAGED_PROVISIONER_MARK_SIZE.row} color={theme.colors.text.secondary} />}
        // A phone row pushes; a wide row offers its one quiet step beside it.
        onPress={props.compact ? props.onAddComputer : undefined}
        showChevron={props.compact}
        accessoryLayout={props.compact ? undefined : 'adaptive'}
        rightElement={props.compact ? undefined : (
          <RoundButton testID={`${props.testID}.action`} size="small" display="inverted" title={label}
            accessibilityLabel={label} onPress={props.onAddComputer} />
        )}
      />
    </ItemGroup>
  );
}

function ProvisionerGroup(
  props: Readonly<{
    title: string;
    description: string;
    cards: readonly ManagedProvisionerCard[];
    action?: React.ReactNode;
    compact: boolean;
    onHandoff?: () => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  // Every provider this browser cannot reach shares one state and one next step: the group says it once, with
  // one Get the app, and those cards stay quiet (each still opens the same hand-off when pressed).
  const handoffShared = !!props.onHandoff && props.cards.some((card) => card.action.kind === 'handoff');
  const quiet = (card: ManagedProvisionerCard) => handoffShared && card.action.kind === 'handoff';
  const handoffLine = handoffShared && props.onHandoff ? (
    <SurfaceStateCard
      testID={`${props.testID}.handoff`}
      kind="unavailable"
      size="line"
      title={t('managedMachines.add.status.needsApp')}
      reason={t('managedMachines.add.handoff.cloudBody')}
      action={{ label: t('managedMachines.add.action.getTheApp'), onPress: props.onHandoff, testID: `${props.testID}.handoff.action` }}
    />
  ) : null;
  if (props.compact) {
    return (
      <ItemGroup title={props.title} description={props.description} action={props.action}
        actionLayout="adaptive">
        {handoffLine}
        {props.cards.map((card) => (
          <React.Fragment key={card.id}>
          <Item
            testID={`${props.testID}.${card.id}`}
            title={card.title}
            // What it creates is named for cloud rows only, as on the cards.
            subtitle={[card.location === 'cloud' ? card.kind : null, quiet(card) ? null : card.status.label]
              .filter(Boolean)
              .join(' · ')}
            subtitleLeading={
              card.status.tone === 'none' || quiet(card) ? undefined : (
                <StatusDot color={toneColor(theme, card.status.tone)} />
              )
            }
            icon={card.mark(MANAGED_PROVISIONER_MARK_SIZE.row)}
            onPress={card.action.disabled ? undefined : card.action.onPress}
          />
          {card.repairFailure ? <ManagedProvisionerRepairFailureNotice failure={card.repairFailure}
            testID={`${props.testID}.${card.id}.repairFailure`} /> : null}
          </React.Fragment>
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
      {handoffLine}
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
          if (!card) return null;
          // A quiet card keeps the grid's one card anatomy (mark, name and kind on one line) with an empty floor:
          // the group's line above carries its state and step.
          return quiet(card) ? <View /> : (
            <ProvisionerFooter
              card={card}
              testID={`${props.testID}.${card.id}`}
            />
          );
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
          // A card has one action, so it has one treatment: Choose, Connect and Get the app alike (lab af-add W).
          display="secondary"
          title={card.action.label}
          accessibilityLabel={`${card.action.label}, ${card.title}`}
          onPress={card.action.onPress}
        />
      )}
      {card.repairFailure ? <ManagedProvisionerRepairFailureNotice failure={card.repairFailure}
        testID={`${props.testID}.repairFailure`} /> : null}
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
