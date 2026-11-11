import type { ComponentType, ReactNode } from 'react';
import { View } from 'react-native';

import { useOptionalHappierUiTheme } from '../../environment/context.js';
import type { HappierHitReach } from '../../environment/interactiveTarget.js';
import { HappierListItem } from '../collection/List.js';
import { HAPPIER_COLLECTION_LIST_METRICS } from '../collection/CollectionList.js';
import { HappierToggle } from '../form/Fields.js';
import { HappierText } from '../text/Text.js';
import type { HappierStyleProp, HappierTextHostProps } from '../portableTypes.js';
import type { HappierWorkStatusTone } from './workStatus.js';

/** Finite row facts; bindings retain the incumbent Item/column and platform switch owners. */
export type HappierTriggerRowBodyProps = Readonly<{
  testID: string;
  title: string;
  subtitle: ReactNode;
  subtitleText: string;
  accessibilityLabel?: string;
  icon?: ReactNode;
  enabled: boolean;
  attention: boolean;
  multiline?: boolean;
  presentation?: 'sheet' | 'column';
  onPress?: () => void;
  toggle: ReactNode;
  /** The row's ⋯ (secondary actions), drawn just before the switch in the trailing column. */
  menu?: ReactNode;
  /** The enclosing sheet's hairline decision for this row; rows draw none by default. */
  showDivider?: boolean;
}>;

export type HappierTriggerRowToggleProps = Readonly<{
  testID: string;
  value: boolean;
  disabled?: boolean;
  accessibilityLabel: string;
  onValueChange: (next: boolean) => void;
  /** The switch's hit reach; on the actions line it never reaches up into the row it belongs to. */
  hitReach?: HappierHitReach;
}>;

export type HappierTriggerRowHost = Readonly<{
  Row: ComponentType<HappierTriggerRowBodyProps>;
  Toggle: ComponentType<HappierTriggerRowToggleProps>;
  Text: ComponentType<Pick<HappierTextHostProps, 'children' | 'testID'> & Readonly<{ tone: HappierWorkStatusTone }>>;
  actionsStyle?: HappierStyleProp;
}>;

export type HappierTriggerRowProps = Readonly<{
  testID: string;
  title: string;
  /** Already qualified/localized by the caller, including Off or review attention. */
  qualifier?: string | null;
  qualifierAccessibilityLabel?: string;
  outcome?: Readonly<{ text: string; tone: HappierWorkStatusTone }> | null;
  /**
   * Who last changed what this trigger runs ("Edited by Ada · 2d ago"), already localized. Quiet
   * information that ends the line after the outcome, so it never takes the attention tone.
   */
  provenance?: string | null;
  attention?: boolean;
  enabled: boolean;
  toggleDisabled?: boolean;
  toggleLabel: string;
  onToggle: (next: boolean) => void;
  onPress?: () => void;
  multiline?: boolean;
  presentation?: 'sheet' | 'column';
  icon?: ReactNode;
  actions?: ReactNode;
  /** The row's ⋯ menu trigger: secondary actions wait behind it, beside the switch, instead of on a line of their own. */
  menu?: ReactNode;
  /** The enclosing sheet's hairline decision for this row. */
  showDivider?: boolean;
  /** Core's theme/text/row binding; ordinary plugin surfaces use the mounted environment. */
  host?: HappierTriggerRowHost;
}>;

const TRAILING_CONTROLS = Object.freeze({ flexDirection: 'row', alignItems: 'center', gap: 8 } as const);

function DefaultRow(props: HappierTriggerRowBodyProps) {
  const accessory = props.menu ? <View style={TRAILING_CONTROLS}>{props.menu}{props.toggle}</View> : props.toggle;
  return <HappierListItem testID={props.testID} title={props.title}
    titleContent={!props.enabled && !props.attention ? <HappierText variant="label" tone="muted">{props.title}</HappierText> : undefined}
    subtitle={props.subtitleText || undefined}
    subtitleContent={props.subtitle ? <HappierText variant="micro" tone={props.attention ? 'attention' : props.enabled ? 'secondary' : 'muted'}>{props.subtitle}</HappierText> : undefined}
    accessibilityLabel={props.accessibilityLabel}
    icon={props.icon} onPress={props.onPress} accessory={accessory} accessoryOutsidePressable
    titleNumberOfLines={props.multiline ? 0 : 1} subtitleNumberOfLines={props.multiline ? 0 : 2}
    density={props.presentation === 'column' ? 'compact' : undefined} showDivider={props.showDivider === true} />;
}

function DefaultToggle(props: HappierTriggerRowToggleProps) {
  const theme = useOptionalHappierUiTheme();
  if (!theme) throw new Error('TriggerRow requires a mounted theme or a host binding.');
  return <HappierToggle label={props.accessibilityLabel} value={props.value} disabled={props.disabled}
    onChange={props.onValueChange} hitReach={props.hitReach} theme={theme} testID={props.testID} />;
}

const defaultHost: HappierTriggerRowHost = {
  Row: DefaultRow,
  Toggle: DefaultToggle,
  Text: ({ tone, ...props }) => <HappierText {...props} variant="micro" tone={tone === 'neutral' ? 'muted' : tone} />,
};

/** One trigger's presentation; schedules, clocks, source reads and writes remain caller-owned. */
const ACTIONS_LINE_HIT_REACH: HappierHitReach = Object.freeze({ top: 0 });
/**
 * The switch closes the actions line at its far end, in the column every other switch on the page uses,
 * centred on the line's buttons (a switch draws itself at the top of its slot).
 */
const TOGGLE_ENDS_ACTIONS_LINE = Object.freeze({ marginLeft: 'auto', justifyContent: 'center' } as const);

export function HappierTriggerRow(props: HappierTriggerRowProps) {
  const { Row, Toggle, Text, actionsStyle } = props.host ?? defaultHost;
  const lead = props.qualifier;
  const outcome = props.outcome;
  const provenance = props.provenance || null;
  const line = [lead, outcome?.text, provenance].filter(Boolean).join(' · ');
  // The line keeps one order: what fires it, how it last went, then who changed it. Each fact keeps its
  // own tone, so a review pause stays amber while the provenance after it stays quiet; a plain line
  // keeps the row's own ink (dimmed while the trigger is off).
  const subtitle = outcome || (provenance && props.attention) ? <Text tone="neutral">
    {lead ? <Text tone={props.attention ? 'attention' : 'neutral'}>{lead}</Text> : null}
    {lead && outcome ? ' · ' : ''}
    {outcome ? <Text testID={`${props.testID}-outcome`} tone={outcome.tone}>{outcome.text}</Text> : null}
    {provenance ? `${lead || outcome ? ' · ' : ''}${provenance}` : ''}
  </Text> : line || lead;
  // A row with its own actions line (History · Run now) ends that line with the switch, the pause, so the
  // title and its quiet line keep the whole row width (lab `b-habit T`). The row above owns the space over
  // that line: the switch's hit area reaches down and sideways, never up into the row's own target.
  const toggleOnActions = Boolean(props.actions) && props.presentation !== 'column';
  const toggle = <Toggle testID={`${props.testID}-switch`} value={props.enabled} disabled={props.toggleDisabled}
    accessibilityLabel={props.toggleLabel} onValueChange={props.onToggle} hitReach={toggleOnActions ? ACTIONS_LINE_HIT_REACH : undefined} />;
  return <>
    <Row testID={props.testID} title={props.title} subtitle={subtitle} subtitleText={line}
      accessibilityLabel={props.qualifierAccessibilityLabel
        ? [props.title, lead, props.qualifierAccessibilityLabel, outcome?.text, provenance].filter(Boolean).join('. ')
        : undefined}
      enabled={props.enabled} attention={props.attention === true} multiline={props.multiline}
      presentation={props.presentation} icon={props.icon} onPress={props.onPress} toggle={toggleOnActions ? null : toggle}
      menu={toggleOnActions ? undefined : props.menu} showDivider={props.showDivider} />
    {props.actions ? <View testID={`${props.testID}-actions`} style={actionsStyle ?? {
      flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap',
      paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset,
    }}>{props.actions}{toggleOnActions ? <View style={TOGGLE_ENDS_ACTIONS_LINE}>{toggle}</View> : null}</View> : null}
  </>;
}
