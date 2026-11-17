import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
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
 * Only a provisioner one of your computers runs (its placement) names that computer: the chip sits on the
 * section holding one (or on the folded row of computer-run machines), and Account-run ones never show it.
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
    // The chip belongs with this computer's machines (or their folded row); a cloud provider a computer runs
    // (Modal, or one this browser cannot reach) carries it only without them.
    const collapsedNames = props.localCollapsed?.names ?? [];
    const scoped = local.length > 0 || collapsedNames.length === 0
      ? [local, sandboxes, cloud].find((cards) => cards.some((card) => card.acquire === 'daemon'))
      : 'collapsed';
    const scopeFor = (cards: readonly ManagedProvisionerCard[] | 'collapsed') =>
      props.scope && cards === scoped ? props.scope : undefined;
    // Every provider this browser cannot reach shares one state and one next step: the page says it once, above
    // the first group holding one, with one Get the app; those cards stay quiet (each still opens the same hand-off).
    const onHandoff = props.onHandoff;
    const handoffGroup = onHandoff
      ? [local, sandboxes, cloud].find((cards) => cards.some((card) => card.action.kind === 'handoff'))
      : undefined;
    const group = (cards: readonly ManagedProvisionerCard[], key: 'local' | 'cloud-sandboxes' | 'cloud') => {
      if (cards.length === 0) return null;
      const scope = scopeFor(cards);
      return (
        <React.Fragment key={key}>
          {cards === handoffGroup && onHandoff ? (
            <ItemGroup surface="none">
              <SurfaceStateCard
                testID={`${props.testID}.handoff`}
                kind="unavailable"
                size="line"
                title={t('managedMachines.add.status.needsApp')}
                reason={t('managedMachines.add.handoff.cloudBody')}
                action={{ label: t('managedMachines.add.action.getTheApp'), onPress: onHandoff, testID: `${props.testID}.handoff.action` }}
              />
            </ItemGroup>
          ) : null}
          {scope?.placement === 'row' ? <ManagedScopeRow testID="managed-picker.scope" chip={scope.chip} /> : null}
          <ProvisionerGroup
            title={key === 'local' ? props.localTitle : t(key === 'cloud-sandboxes'
              ? 'managedMachines.add.cloudSandboxesTitle' : 'managedMachines.add.cloudTitle')}
            // On a phone the note below says what both cloud groups share; each description says what its group creates.
            description={key === 'local' ? props.localDescription : props.compact ? undefined
              : t(key === 'cloud-sandboxes' ? 'managedMachines.add.cloudSandboxesDescription' : 'managedMachines.add.cloudDescription')}
            cards={cards}
            action={scope?.placement === 'header' ? scope.chip : undefined}
            compact={props.compact}
            quietHandoff={!!handoffGroup}
            testID={`${props.testID}.${key}`}
          />
        </React.Fragment>
      );
    };
    const collapsedScope = scopeFor('collapsed');
    const collapsed = props.localCollapsed && collapsedNames.length > 0 ? (
      <React.Fragment key="collapsed">
        {collapsedScope?.placement === 'row' ? <ManagedScopeRow testID="managed-picker.scope" chip={collapsedScope.chip} /> : null}
        <LocalCollapsedGroup names={collapsedNames} onAddComputer={props.localCollapsed.onAddComputer}
          action={collapsedScope?.placement === 'header' ? collapsedScope.chip : undefined}
          compact={props.compact} testID={`${props.testID}.local.collapsed`} />
      </React.Fragment>
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

/** Placeholder offers before the first catalog read answers: a wide page's tile grid, a phone's rows. */
const SKELETON_OFFERS = Array.from({ length: 6 }, (_, index) => `offer-${index}`);

/**
 * The catalog's first read, drawn in the catalog's own layout: offer cards' skeletons through the same
 * tile owner the offers use (a phone: the rows its offers become), so the answer replaces them in place.
 */
export const MachineProvisionerSectionsSkeleton = React.memo(function MachineProvisionerSectionsSkeleton(
  props: Readonly<{ compact: boolean; testID: string }>,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const label = t('managedMachines.providers.loading');
  if (props.compact) {
    return (
      <View testID={props.testID} accessibilityLabel={label}>
        <ItemGroup>
          <ItemLoadStateRows state={{ kind: 'loading' }} rows={4} lines={2} accessibilityLabel={label} />
        </ItemGroup>
      </View>
    );
  }
  const bar = (width: `${number}%` | number, role: 'meta' | 'rowTitle' = 'meta') => (
    <HappierSkeletonBlock width={width} height={happierPageTextMetrics(role).lineHeight - 4}
      color={theme.colors.surface.skeleton} reducedMotion={reducedMotion} />
  );
  return (
    <View testID={props.testID} accessibilityLabel={label} aria-busy>
      <ItemGroup surface="none">
        <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <SelectionTiles<string>
            variant="action"
            options={SKELETON_OFFERS.map((id) => ({
              id,
              title: '',
              mark: (
                <View style={styles.skeletonHead}>
                  <HappierSkeletonBlock width={MANAGED_PROVISIONER_MARK_SIZE.tile} height={MANAGED_PROVISIONER_MARK_SIZE.tile}
                    color={theme.colors.surface.skeleton} reducedMotion={reducedMotion} />
                  {bar(96, 'rowTitle')}
                </View>
              ),
            }))}
            onPress={() => {}}
            renderOptionFooter={() => (
              <View style={styles.skeletonFooter}>
                {bar('92%')}
                {bar('64%')}
                <View style={styles.skeletonStatus}>{bar('40%')}</View>
              </View>
            )}
          />
        </View>
      </ItemGroup>
    </View>
  );
});

/** Machines a computer you've added runs, folded until one can run them. */
function LocalCollapsedGroup(
  props: Readonly<{ names: readonly string[]; onAddComputer: () => void; action?: React.ReactNode; compact: boolean; testID: string }>,
) {
  const { theme } = useUnistyles();
  const label = t('managedMachines.add.action.addComputer');
  return (
    <ItemGroup title={t('managedMachines.add.onThisComputer')} action={props.action} actionLayout="adaptive">
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
    description?: string;
    cards: readonly ManagedProvisionerCard[];
    action?: React.ReactNode;
    compact: boolean;
    /** The page's one hand-off line speaks for this browser's unreachable providers; their cards stay quiet. */
    quietHandoff: boolean;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const quiet = (card: ManagedProvisionerCard) => props.quietHandoff && card.action.kind === 'handoff';
  if (props.compact) {
    return (
      <ItemGroup title={props.title} description={props.description} action={props.action}
        actionLayout="adaptive">
        {props.cards.map((card) => (
          <React.Fragment key={card.id}>
          <Item
            testID={`${props.testID}.${card.id}`}
            title={card.title}
            // Lab m-add-Ap: a cloud row says what it creates, then its state ("Server · No account yet").
            subtitle={[cloudKindLabel(card), quiet(card) ? undefined : card.status.label]
              .filter(Boolean).join(' · ') || undefined}
            subtitleLeading={
              card.status.tone === 'none' || quiet(card) ? undefined : (
                <StatusDot color={toneColor(theme, card.status.tone)} />
              )
            }
            icon={card.mark(MANAGED_PROVISIONER_MARK_SIZE.row)}
            onPress={card.action.disabled ? undefined : card.action.onPress}
          />
          {card.repairFailure && !quiet(card) ? <ManagedProvisionerRepairFailureNotice failure={card.repairFailure}
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
      <SelectionTiles<string>
        variant="action"
        accessibilityLabel={props.title}
        testIdPrefix={props.testID}
        options={props.cards.map((card) => ({
          id: card.id,
          title: card.title,
          subtitle: card.description,
          // Four local cards across leave no room for a kind (lab m-add); cloud cards name theirs ("Server").
          ...(cloudKindLabel(card) ? { badge: cloudKindLabel(card) } : {}),
          mark: card.mark(MANAGED_PROVISIONER_MARK_SIZE.tile),
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

/** What a cloud card creates, in sentence case ("Server"); none when its name already says it ("Maritime Sandbox"). */
function cloudKindLabel(card: ManagedProvisionerCard): string | undefined {
  if (card.location !== 'cloud' || !card.kind || card.title.toLocaleLowerCase().includes(card.kind.toLocaleLowerCase())) return undefined;
  return card.kind.charAt(0).toLocaleUpperCase() + card.kind.slice(1);
}

function ProvisionerFooter(
  props: Readonly<{ card: ManagedProvisionerCard; testID: string }>,
) {
  const { theme } = useUnistyles();
  const { card } = props;
  return (
    <View style={styles.footer}>
      {/* Lab m-add: the provider's state on the left, its one step on the right. A long status wraps
          beside the button; it never truncates and never pushes the button off the card's floor. */}
      <View style={styles.footerRow}>
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
      </View>
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
  skeletonHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  skeletonFooter: {
    alignSelf: 'stretch',
    gap: theme.space.s6,
  },
  skeletonStatus: {
    paddingTop: theme.space.s10,
  },
  footer: {
    alignSelf: 'stretch',
    gap: theme.space.s10,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  statusGroup: {
    flexDirection: 'row',
    // A status that wraps ("Not installed · get it from cua.ai") keeps its dot on the first line.
    alignItems: 'flex-start',
    gap: theme.space.s6,
    flex: 1,
    minWidth: 0,
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
