import type { ComponentType, ReactNode } from 'react';
import { View } from 'react-native';
import { resolveHappierUiPalette, useOptionalHappierUiPalette, useOptionalHappierUiTheme } from '../../environment/context.js';
import { HappierText } from '../text/Text.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HappierSegmentedChoice } from '../form/SegmentedChoice.js';

export type HappierShareTextProps = Readonly<{
  children: ReactNode;
  tone?: 'primary' | 'secondary' | 'selected' | 'strong' | 'destructive';
  testID?: string;
  accessibilityLiveRegion?: 'polite';
}>;

/** A grant's few access levels as one single-choice control; the caller's choice order is kept. */
export type HappierShareChoiceProps = Readonly<{
  accessibilityLabel: string;
  choices: readonly (HappierShareAction & Readonly<{ id: string }>)[];
  disabled?: boolean;
}>;

export type HappierShareHost = Readonly<{
  Text: ComponentType<HappierShareTextProps>;
  /** The host's segmented value control; plugin surfaces draw the shared segmented choice. */
  Choice?: ComponentType<HappierShareChoiceProps>;
  focusColor: string;
  borderColor: string;
  noteColor: string;
  /** The host's hit-area request for row actions; it sizes their hit area, never their drawing. */
  minimumTargetSize?: number;
}>;

/** Core injects its typography/theme; plugin surfaces use their mounted environment. */
export function useHappierShareHost(host: HappierShareHost | undefined): HappierShareHost {
  const theme = useOptionalHappierUiTheme();
  if (host) return host;
  if (!theme) throw new Error('Sharing presentation requires a mounted theme or a host binding.');
  return { Text: DefaultText, focusColor: theme.colors.focus, borderColor: theme.colors.divider, noteColor: theme.colors.surface };
}

function DefaultText({ tone = 'primary', ...props }: HappierShareTextProps) {
  return <HappierText {...props} variant="label" tone={tone === 'secondary' ? 'secondary' : tone === 'selected' ? 'accent'
    : tone === 'destructive' ? 'danger' : 'neutral'} style={tone === 'strong' ? { fontWeight: '600' } : undefined} />;
}

function DefaultChoice(props: HappierShareChoiceProps) {
  const theme = useOptionalHappierUiTheme();
  if (!theme) throw new Error('Sharing level choices require a mounted theme or a Choice binding.');
  const palette = useOptionalHappierUiPalette(theme) ?? resolveHappierUiPalette(theme);
  return <HappierSegmentedChoice accessibilityLabel={props.accessibilityLabel} disabled={props.disabled}
    segments={props.choices.map(choice => ({ key: choice.id, label: choice.label, selected: choice.selected === true,
      disabled: choice.disabled === true, testID: choice.testID, accessibilityLabel: choice.accessibilityLabel }))}
    onSelect={index => { const choice = props.choices[index]; if (choice && !choice.selected && !choice.disabled) void choice.onPress(); }}
    colors={{ track: palette.segmentTrack, thumb: palette.segmentThumb, thumbLift: palette.segmentThumbLift,
      label: theme.colors.secondaryText, activeLabel: theme.colors.text, focusRing: theme.colors.focus }} />;
}

export type HappierShareAction = Readonly<{
  label: string;
  onPress: () => unknown;
  testID?: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  selected?: boolean;
  /** An action that takes access away reads as one. */
  tone?: 'destructive';
  trailing?: ReactNode;
}>;

export type HappierShareRowActionProps = HappierShareAction & Readonly<{
  host?: HappierShareHost;
  /** Set where the action is a row's trailing value: its text ends on the row's edge, like static meta beside it. */
  endsRow?: boolean;
  /** Set where the action leads a line of the row's column: its text starts on the column's edge, under the title. */
  startsRow?: boolean;
}>;

/** One quiet operation/choice, using the shared keyboard and focus-visible owner. */
export function HappierShareRowAction(props: HappierShareRowActionProps) {
  const host = useHappierShareHost(props.host);
  const { Text } = host;
  return <HappierPressable testID={props.testID} accessibilityRole="button"
    accessibilityLabel={props.accessibilityLabel ?? props.label} selected={props.selected}
    hitTarget={host.minimumTargetSize}
    disabled={props.disabled} onPress={props.onPress} style={state => ({
      justifyContent: 'center', paddingHorizontal: 8,
      paddingLeft: props.startsRow ? 0 : 8,
      paddingRight: props.trailing || props.endsRow ? 0 : 8,
      ...happierFocusRingStyle({ visible: state.focused, color: host.focusColor }),
    })}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Text tone={props.tone ?? (props.selected ? 'selected' : 'primary')}>{props.label}</Text>{props.trailing}
    </View>
  </HappierPressable>;
}

export type HappierShareLevelControlProps = HappierShareRowActionProps & Readonly<{ lock?: ReactNode }>;

/** Already-qualified level and optional lock/chevron; the caller decides what pressing means. */
export function HappierShareLevelControl({ lock, ...props }: HappierShareLevelControlProps) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
    {lock}<HappierShareRowAction {...props} endsRow />
  </View>;
}

export type HappierShareGrantRemoval =
  | Readonly<{ kind: 'allowed'; request: HappierShareAction }>
  | Readonly<{ kind: 'confirming'; consequences: readonly string[]; consequenceTestID?: string; confirm: HappierShareAction; cancel: HappierShareAction }>
  | Readonly<{ kind: 'blocked'; explain: HappierShareAction }>;

export type HappierShareGrantRowProps = Readonly<{
  /** Caller order and supported choices are preserved; this presenter has no level policy. */
  levels?: readonly (HappierShareAction & Readonly<{ id: string }>)[];
  /** The level group's accessible name ("Maya, access level"). */
  levelsAccessibilityLabel?: string;
  busy?: boolean;
  lockedReason?: string;
  details?: ReactNode;
  error?: string;
  retry?: HappierShareAction;
  removal?: HappierShareGrantRemoval;
  host?: HappierShareHost;
}>;

/** One expanded grant's controls. Reads, writes, policy and confirmation state stay caller-owned. */
export function HappierShareGrantRow(props: HappierShareGrantRowProps) {
  const host = useHappierShareHost(props.host);
  const { Text } = host;
  const Choice = host.Choice ?? DefaultChoice;
  const removal = props.removal;
  const action = (value: HappierShareAction, busy = false, startsRow = false) => <HappierShareRowAction {...value}
    disabled={busy || value.disabled} host={host} startsRow={startsRow} />;
  // One choice is not a choice: the row's level control already states it.
  const levels = props.levels && props.levels.length > 1 ? props.levels : undefined;
  const request = removal?.kind === 'allowed' ? removal.request : undefined;
  return <View style={{ gap: 8 }}>
    {props.lockedReason ? <Text tone="secondary">{props.lockedReason}</Text> : null}
    {/* The level and the way out share one line: choose a level, or remove access at its end. */}
    {levels || request ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      {levels ? <Choice accessibilityLabel={props.levelsAccessibilityLabel ?? ''} disabled={props.busy}
        choices={levels.map(level => ({ ...level, disabled: props.busy || level.disabled }))} /> : null}
      {request ? action({ tone: 'destructive', ...request }, props.busy, !levels) : null}
    </View> : null}
    {props.details}
    {props.error ? <Text accessibilityLiveRegion="polite" tone="secondary">{props.error}</Text> : null}
    {props.retry ? action(props.retry, false, true) : null}
    {removal?.kind === 'confirming' ? <>
      {removal.consequences.map(consequence => <Text key={consequence} testID={removal.consequenceTestID}
        accessibilityLiveRegion="polite" tone="secondary">{consequence}</Text>)}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {action({ tone: 'destructive', ...removal.confirm }, props.busy, true)}{action(removal.cancel, props.busy)}
      </View>
    </> : null}
    {removal?.kind === 'blocked' ? action(removal.explain, false, true) : null}
  </View>;
}
