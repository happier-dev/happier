import * as React from 'react';
import { View, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierFieldBoxTrigger,
  HappierPressable,
  HappierWhereItsOnControl,
  collectHappierWhereItsOnAgentIds,
  happierWhereItsOnIntentWrites,
  resolveHappierFieldBoxLabel,
  type HappierWhereItsOnChangeResult,
  type HappierWhereItsOnControlProps,
  type HappierWhereItsOnHost,
  type HappierWhereItsOnIntent,
  type HappierWhereItsOnMenuItem,
  type HappierWhereItsOnState,
} from '@happier-dev/plugin-ui/presentation';
import type { ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';

import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import type { SessionAgentCatalogIdentity } from '@/agents/registry/useSessionAgentCatalogIdentity';
import { AgentNameRun } from '@/components/capabilities/identity/AgentNameRun';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { ExpandableItem, ExpandableItemCaret } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SectionLeadingColumnProvider } from '@/components/ui/lists/sectionLeadingColumn';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useWhereItsOnNames } from './useWhereItsOnNames';
import { sayWhereItsOn, whereItsOnControlLabels, whereItsOnReach } from './whereItsOnPresentation';

/**
 * Happier's binding of the shared "Where it's on" control (`@happier-dev/plugin-ui` presentation owns what it shows
 * and in which order, and says the person's choice as an intent): Happier's reach rules (protocol
 * `reachRulesChangeV1`, which turns them into the control's state and its intents into one `replace`), names (Agent
 * catalog identities, machines, Account Projects), words and settings primitives.
 */
export type WhereItsOnChangeResult = HappierWhereItsOnChangeResult;
export type WhereItsOnReplaceChange = Extract<ReachRulesChangeV1, { kind: 'replace' }>;
export type WhereItsOnControlProps = Omit<
  HappierWhereItsOnControlProps,
  'state' | 'onIntent' | 'projection' | 'names' | 'labels' | 'host' | 'space'
> &
  Readonly<{
    rules: ReachRulesV1;
    /** Read-only default decided by the capability owner; never becomes a stored rule. */
    defaultEnabled?: boolean;
    projection: NonNullable<HappierWhereItsOnControlProps['projection']> | null;
    /** One change = one call carrying the whole next value. */
    onChange: (change: WhereItsOnReplaceChange) => Promise<WhereItsOnChangeResult>;
    /** Accepted from the detail pages but not drawn: the control has never offered Undo (pre-existing, unchanged). */
    onUndo?: () => Promise<void>;
  }>;

const ICON_SIZES = { xs: ICON_SIZE.xs, sm: ICON_SIZE.sm, md: ICON_SIZE.md } as const;

/** The Agent catalog identities the marks draw, from `useWhereItsOnNames`; the slot components stay stable. */
const WhereIdentityContext = React.createContext<ReadonlyMap<string, SessionAgentCatalogIdentity>>(new Map());

type Host = HappierWhereItsOnHost;

const AgentMark: Host['AgentMark'] = ({ agentId, size }) => {
  const identity = React.useContext(WhereIdentityContext).get(agentId);
  if (!identity) return null;
  return (
    <AgentCatalogIdentityIcon
      entry={identity.entry}
      machineId={null}
      serverId={null}
      current={identity.current}
      size={ICON_SIZES[size]}
    />
  );
};

const PlaceGlyph: Host['PlaceGlyph'] = ({ name, size }) => {
  const { theme } = useUnistyles();
  return <Icon name={name} size={ICON_SIZES[size]} color={theme.colors.text.secondary} />;
};

function useMenuItems(items: readonly HappierWhereItsOnMenuItem[], categoryOf?: (item: HappierWhereItsOnMenuItem) => string) {
  const { theme } = useUnistyles();
  return React.useMemo(
    () =>
      items.map((item): DropdownMenuItem => ({
        id: item.id,
        title: item.title,
        testID: item.testID,
        ...(categoryOf ? { category: categoryOf(item) } : {}),
        ...(item.checked !== undefined ? { checked: item.checked } : {}),
        ...(item.mark?.kind === 'agent'
          ? { icon: <AgentMark agentId={item.mark.agentId} size="sm" /> }
          : item.mark?.kind === 'icon'
            ? { icon: <PlaceGlyph name={item.mark.name} size="sm" /> }
            : {}),
        ...(item.trailing
          ? {
              rightElement: (
                <Text
                  variant="meta"
                  style={[{ color: theme.colors.text.tertiary }, item.trailing.tabular ? styles.tabular : null]}
                >
                  {item.trailing.text}
                </Text>
              ),
            }
          : {}),
      })),
    [items, categoryOf, theme],
  );
}

const Disclosure: Host['Disclosure'] = ({ testID, rowTestID, expanded, onExpandedChange, title, changeLabel, showDivider, children }) => {
  const { theme } = useUnistyles();
  return (
    <ExpandableItem
      testID={testID}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      // The body ends on the sheet's own row hairline, so the consequence reads as the sheet's last row.
      showDivider={showDivider ?? false}
      header={({ headerProps, expanded: open }) => (
        <Item
          {...(headerProps as Readonly<Record<string, unknown>>)}
          testID={rowTestID}
          title={title}
          rightElement={
            changeLabel !== undefined && !open ? (
              <Text variant="label" style={{ color: theme.colors.text.link ?? theme.colors.text.secondary }}>
                {changeLabel}
              </Text>
            ) : (
              <ExpandableItemCaret expanded={open} />
            )
          }
          showChevron={false}
        />
      )}
    >
      {children}
    </ExpandableItem>
  );
};

const AddMenu: Host['AddMenu'] = ({ testID, title, groups, onSelect }) => {
  const [open, setOpen] = React.useState(false);
  const flat = React.useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const categoryOf = React.useCallback(
    (item: HappierWhereItsOnMenuItem) => groups.find((group) => group.items.includes(item))?.title ?? '',
    [groups],
  );
  const items = useMenuItems(flat, categoryOf);
  return (
    <DropdownMenu
      testID={`${testID}Menu`}
      open={open}
      onOpenChange={setOpen}
      items={items}
      onSelect={onSelect}
      showCategoryTitles
      matchTriggerWidth={false}
      rowKind="item"
      popoverPhonePresentation="sheet"
      popoverAccessibilityLabel={title}
      trigger={({ toggle, open: isOpen }) => (
        <SectionActionButton testID={testID} icon="plus" title={title} expanded={isOpen} onPress={toggle} />
      )}
    />
  );
};

const AgentSelect: Host['AgentSelect'] = ({ testID, label, accessibilityLabel, selectedAgentId, items, selectedId, onSelect }) => {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const menuItems = useMenuItems(items);
  const fieldColors = resolveFieldBoxColors(theme);
  const fieldLabel = resolveHappierFieldBoxLabel({ value: label, placeholder: label, colors: fieldColors });
  return (
    <DropdownMenu
      testID={testID}
      open={open}
      onOpenChange={setOpen}
      items={menuItems}
      selectedId={selectedId}
      onSelect={onSelect}
      matchTriggerWidth={false}
      popoverPhonePresentation="sheet"
      popoverAccessibilityLabel={accessibilityLabel}
      trigger={({ toggle, open: isOpen }) => (
        <HappierPressable
          testID={`${testID}:trigger`}
          onPress={toggle}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          expanded={isOpen}
          hasPopup="menu"
        >
          <HappierFieldBoxTrigger
            colors={fieldColors}
            span="intrinsic"
            {...(selectedAgentId !== null ? { leading: <AgentMark agentId={selectedAgentId} size="xs" /> } : {})}
            trailing={<Icon name={isOpen ? 'caret-up' : 'caret-down'} size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
          >
            <Text style={fieldLabel.style} numberOfLines={1}>
              {label}
            </Text>
          </HappierFieldBoxTrigger>
        </HappierPressable>
      )}
    />
  );
};

const WhereText: Host['Text'] = ({ variant, tone, emphasis, tabular, hidden, style, testID, children }) => {
  const { theme } = useUnistyles();
  return (
    <Text
      variant={variant}
      {...(emphasis !== undefined ? { emphasis } : {})}
      {...(testID !== undefined ? { testID } : {})}
      {...(hidden ? { 'aria-hidden': true } : {})}
      style={[{ color: theme.colors.text[tone] }, tabular ? styles.tabular : null, style]}
    >
      {children}
    </Text>
  );
};

/** Happier's settings primitives for each slot; stable components, so menus and disclosures keep their state. */
const HOST_SLOTS: Omit<Host, 'hasAgentMark'> = {
  Section: ({ testID, title, description, children }) => (
    <ItemGroup testID={testID} title={title} {...(description !== undefined ? { description } : {})}>
      {children}
    </ItemGroup>
  ),
  Disclosure,
  Everywhere: ({ testID, title, subtitle, options, value, disabled, onChange }) => (
    <SegmentedChoiceItem
      testID={testID}
      testIDPrefix={testID}
      title={title}
      subtitle={subtitle}
      options={options}
      value={value}
      disabled={disabled}
      onChange={onChange}
      showDivider
    />
  ),
  RuleList: SectionLeadingColumnProvider,
  GroupLabel: ({ title }) => <CollectionListGroupLabel title={title} />,
  Rule: ({ testID, title, subtitle, mark, wideControls, controls, note }) => (
    <Item
      testID={testID}
      title={title}
      subtitle={subtitle}
      icon={mark}
      // A lone Remove is a narrow control and stays beside the label; with the agents select the pair moves beneath on a phone.
      {...(wideControls ? { accessoryLayout: 'adaptive' as const } : {})}
      rightElement={controls}
      {...(note !== undefined ? { bottomElement: note, bottomElementInset: 'text' as const } : {})}
      showChevron={false}
      showDivider={false}
    />
  ),
  RemoveButton: ({ testID, accessibilityLabel, onPress }) => (
    <IconButton iconName="x" variant="plain" accessibilityLabel={accessibilityLabel} testID={testID} onPress={onPress} />
  ),
  AddMenu,
  AgentSelect,
  ConsequenceRow: ({ testID, continuesRow, showDivider, children }) => (
    <SectionContentRow testID={testID} showDivider={showDivider} continuesRow={continuesRow}>
      {children}
    </SectionContentRow>
  ),
  ErrorLine: ({ testID, title, diagnostic, actionLabel, onAction }) => (
    <SurfaceStateCard
      testID={testID}
      kind="error"
      size="line"
      title={title}
      diagnosticCode={diagnostic}
      action={{ label: actionLabel, onPress: onAction }}
    />
  ),
  Text: WhereText,
  PlaceGlyph,
  AgentMark,
  AgentNames: ({ agentIds, machines, testID }) => <AgentNameRun agentIds={agentIds} machines={machines} testID={testID} />,
};

export const WhereItsOnControl = React.memo(function WhereItsOnControl({
  onUndo: _onUndo,
  rules: storedRules,
  onChange,
  defaultEnabled = false,
  ...props
}: WhereItsOnControlProps) {
  const { theme } = useUnistyles();
  const agentIds = React.useMemo(
    () => collectHappierWhereItsOnAgentIds(props.places.agentIds, storedRules, props.projection),
    [props.places.agentIds, storedRules, props.projection],
  );
  const { names, identityById } = useWhereItsOnNames({
    agentIds,
    machines: props.places.machines,
    projects: props.places.projects,
  });
  const host = React.useMemo<Host>(
    () => ({ ...HOST_SLOTS, hasAgentMark: (agentId) => identityById.has(agentId) }),
    [identityById],
  );
  // Old stored duplicates collapse to the precedence owner's winner; the sentence states only rules that decide.
  const rules = React.useMemo(() => whereItsOnReach.normalize(storedRules), [storedRules]);
  const state = React.useMemo<HappierWhereItsOnState>(() => {
    const base = rules.find((rule) => rule.target.t === 'allMachines' && rule.agentId === undefined);
    return {
      everywhere: (base?.enabled ?? defaultEnabled) ? 'on' : 'off',
      rules: rules
        .filter((rule) => rule !== base)
        .map((rule) => ({
          key: whereItsOnReach.key(rule),
          place: rule.target,
          ...(rule.agentId !== undefined ? { agentId: rule.agentId } : {}),
          on: rule.enabled,
        })),
      sentence: sayWhereItsOn(rules, names, defaultEnabled),
    };
  }, [rules, names, defaultEnabled]);
  const onIntent = React.useCallback(
    (intent: HappierWhereItsOnIntent) => onChange(applyWhereItsOnIntent(rules, intent)),
    [rules, onChange],
  );
  return (
    <WhereIdentityContext.Provider value={identityById}>
      <HappierWhereItsOnControl
        {...props}
        state={state}
        onIntent={onIntent}
        names={names}
        labels={whereItsOnControlLabels}
        host={host}
        space={theme.space}
      />
    </WhereIdentityContext.Provider>
  );
});

/**
 * Add flows before the item exists: a local draft that starts from the protocol's create-time default and the
 * create Action's `where` (undefined until the person changes the pick, then the last `replace`).
 */
export function useDraftReachRules(kind: 'skill' | 'mcp_server'): Readonly<{
  rules: ReachRulesV1;
  where: ReachRulesChangeV1 | undefined;
  onChange: WhereItsOnControlProps['onChange'];
}> {
  const [state, setState] = React.useState<Readonly<{ rules: ReachRulesV1; where: ReachRulesChangeV1 | undefined }>>(
    () => ({ rules: whereItsOnReach.createDefault(kind), where: undefined }),
  );
  const onChange = React.useCallback<WhereItsOnControlProps['onChange']>(async (change) => {
    setState((current) => ({ rules: whereItsOnReach.apply(current.rules, change), where: change }));
    return { ok: true };
  }, []);
  return { rules: state.rules, where: state.where, onChange };
}

/** The person's choice applied by the reach engine, as the one `replace` the caller saves. */
function applyWhereItsOnIntent(rules: ReachRulesV1, intent: HappierWhereItsOnIntent): WhereItsOnReplaceChange {
  const next = happierWhereItsOnIntentWrites(intent).reduce<ReachRulesV1>(
    (current, write) => whereItsOnReach.apply(current, { kind: 'write', write }),
    rules,
  );
  return { kind: 'replace', rules: whereItsOnReach.toDrafts(next) };
}

const styles = StyleSheet.create(() => ({
  tabular: { fontVariant: ['tabular-nums'] },
}));
