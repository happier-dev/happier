import type { ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';

import { HappierRadioChoiceList } from '../presentation/form/RadioChoiceList.js';
import { useHappierColumnEdgeRemainder } from '../presentation/layout/columnEdge.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import { HappierText } from '../presentation/text/Text.js';
import { Select } from './Form.js';
import { ItemGroup } from './List.js';
import { SettingRow } from './Setting.js';
import {
  usePluginTheme,
  usePluginTranslation,
  type PluginTranslate,
} from './PluginUiProvider.js';

/**
 * How one followed event reaches the person: it interrupts (push), arrives quietly (Inbox), or is left out.
 * For a Session receiver the same two channels read Wake and Next turn.
 */
export type FollowPolicyEditorDelivery = 'interrupt' | 'quiet' | 'off';

/**
 * One event row. `id` is the canonical event: `needs_you.decision`, `needs_you.approval`,
 * `needs_you.blocked`, `finished`, `failed_or_stopped`, `stalled`, `update_posted`, `person_wrote`,
 * `goal_changed` or `message`. The editor names each one; hosts and plugins pass ids, never copy.
 */
export type FollowPolicyEditorEvent = Readonly<{
  id: string;
  delivery: FollowPolicyEditorDelivery;
}>;

/** Who hears the followed events: a `person` (Push, Inbox; the default) or a `session` (Wake, Next turn). */
export type FollowPolicyEditorReceiver = 'person' | 'session';

export type FollowPolicyEditorProps = Readonly<{
  /** Names the two delivery channels the way this receiver gets them; defaults to `person`. */
  receiver?: FollowPolicyEditorReceiver;
  /** `everything`, `important`, `quiet` or `custom`. */
  preset: string;
  presets: readonly string[];
  events: readonly FollowPolicyEditorEvent[];
  onSelectPreset: (preset: string) => void;
  /** Custom only: one event's delivery. */
  onSetDelivery: (
    eventId: string,
    delivery: FollowPolicyEditorDelivery,
  ) => void;
  disabled?: boolean;
  testID?: string;
}>;

const KEY = 'happier.plugin-ui.follow';

const PRESET_LABELS: Readonly<Record<string, string>> = {
  everything: 'Everything',
  important: 'Important',
  quiet: 'Quiet',
  custom: 'Custom',
};
const PERSON_COPY = {
  presetLabel: 'How much you hear',
  presetDescriptions: {
    everything: 'Interrupts you whenever something happens.',
    important: 'Interrupts you only when it needs you, fails or stalls.',
    quiet: 'Nothing interrupts you. Updates wait quietly in Inbox.',
    custom: 'Choose how each event reaches you.',
  },
  deliveries: { quiet: 'Inbox', interrupt: 'Push' },
} as const;
const SESSION_COPY = {
  presetLabel: 'How much it hears',
  presetDescriptions: {
    everything: 'Wakes it whenever something happens.',
    important: 'Wakes it only when something needs it, fails or stalls.',
    quiet: 'Nothing wakes it. Updates wait for its next turn.',
    custom: 'Choose how each event reaches it.',
  },
  deliveries: { quiet: 'Next turn', interrupt: 'Wake' },
} as const;
const EVENT_LABELS: Readonly<Record<string, string>> = {
  needs_you: 'Needs you',
  'needs_you.decision': 'Needs a decision',
  'needs_you.approval': 'Needs approval',
  'needs_you.blocked': 'Blocked',
  finished: 'Finished',
  failed_or_stopped: 'Failed or stopped',
  stalled: 'Stalled',
  update_posted: 'Update posted',
  person_wrote: 'A person wrote in it',
  goal_changed: 'Goal changed',
  message: 'Every message',
};
const EVENT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  needs_you: 'A decision, an approval, or it’s blocked',
  failed_or_stopped: 'Also when a run ends without a word',
  person_wrote: 'A notice and a link, never their words',
};
const DELIVERIES = [
  'off',
  'quiet',
  'interrupt',
] as const satisfies readonly FollowPolicyEditorDelivery[];
/** The chosen level's breakdown, loudest first: what interrupts, what waits, what is left out. */
const LEGEND_DELIVERIES = ['interrupt', 'quiet', 'off'] as const satisfies readonly FollowPolicyEditorDelivery[];

function eventLabel(translate: PluginTranslate, id: string): string {
  return translate(`${KEY}.event.${id}`, EVENT_LABELS[id] ?? id);
}
function eventDescription(
  translate: PluginTranslate,
  id: string,
): string | undefined {
  const fallback = EVENT_DESCRIPTIONS[id];
  return fallback === undefined
    ? undefined
    : translate(`${KEY}.eventDescription.${id}`, fallback);
}

/** A preset's rows: the three needs-you kinds read as one "Needs you" row when they arrive the same way. */
function presetRows(
  events: readonly FollowPolicyEditorEvent[],
): FollowPolicyEditorEvent[] {
  const needsYou = events.filter((event) => event.id.startsWith('needs_you.'));
  const together =
    needsYou.length > 1 &&
    needsYou.every((event) => event.delivery === needsYou[0]!.delivery);
  const rows: FollowPolicyEditorEvent[] = [];
  for (const event of events) {
    if (together && event.id.startsWith('needs_you.')) {
      if (event === needsYou[0])
        rows.push({ id: 'needs_you', delivery: event.delivery });
    } else rows.push(event);
  }
  return rows;
}

/**
 * The one Follow policy editor (C1 §4.3, lab P2): the four levels as one radio choice, each with its own
 * meaning, and under them the chosen level's breakdown — each channel (Push, Inbox, Off) and the events
 * it carries, in the same words Custom's rows use; Custom gives each event its own Off · Inbox · Push.
 * Core's personal Follow, Session sources, rules and plugins bind the same editor; it holds no state and
 * writes nothing — the caller's Follow owner applies each choice.
 */
export function FollowPolicyEditor(
  props: FollowPolicyEditorProps,
): ReactElement {
  const translate = usePluginTranslation();
  const theme = usePluginTheme();
  const testID = props.testID ?? 'follow-policy-editor';
  const custom = props.preset === 'custom';
  // A Session receiver has its own words for the channels; each has its own host translation keys.
  const session = props.receiver === 'session';
  const copy = session ? SESSION_COPY : PERSON_COPY;
  const copyKey = session ? `${KEY}.session` : KEY;
  const presetLabel = translate(`${copyKey}.presetLabel`, copy.presetLabel);
  const rows = custom ? props.events : presetRows(props.events);
  const deliveryOptions = DELIVERIES.map((delivery) => ({
    value: delivery,
    label: delivery === 'off'
      ? translate(`${KEY}.delivery.off`, 'Off')
      : translate(`${copyKey}.delivery.${delivery}`, copy.deliveries[delivery]),
  }));
  // The levels and their breakdown stand on the sheets' edge; a column that already draws it adds none.
  const edgePx = useHappierColumnEdgeRemainder(HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx);
  // What the chosen level means, as facts and not as rows, under that level: each channel, then the events that
  // reach it. Rows here would read as choices; the only choices are the levels (and Custom's own rows).
  const legendRows = LEGEND_DELIVERIES.flatMap((delivery) => {
    const members = rows.filter((row) => row.delivery === delivery);
    if (members.length === 0) return [];
    const channel = delivery === 'off'
      ? translate(`${KEY}.delivery.off`, 'Off')
      : translate(`${copyKey}.delivery.${delivery}`, copy.deliveries[delivery]);
    return [{ delivery, channel, events: members.map((row) => eventLabel(translate, row.id)).join(', ') }];
  });
  // A label | value grid: every row's label cell also holds the other rows' labels at no height, so each cell is
  // as wide as the widest label and the values share one column (a wrapped value hangs in it) on the first frame.
  const legend = custom ? null : (
    <View style={styles.legend} testID={`${testID}.legend`}>
      {legendRows.map((row) => (
        <View key={row.delivery} style={styles.legendRow} testID={`${testID}.group.${row.delivery}`}>
          <View style={styles.legendLabel}>
            <HappierText variant="meta" tone="neutral">{row.channel}</HappierText>
            {legendRows.filter((other) => other !== row).map((other) => (
              <View key={other.delivery} style={styles.legendLabelSizer} aria-hidden importantForAccessibility="no-hide-descendants">
                <HappierText variant="meta">{other.channel}</HappierText>
              </View>
            ))}
          </View>
          <HappierText variant="meta" tone="secondary" style={styles.legendValue}>{row.events}</HappierText>
        </View>
      ))}
    </View>
  );
  return (
    <View testID={testID} style={styles.root}>
      <View style={[styles.levels, { paddingHorizontal: edgePx }]} testID={`${testID}.presets`}>
        <HappierRadioChoiceList
          accessibilityLabel={presetLabel}
          options={props.presets.map((preset) => ({
            id: preset,
            title: translate(`${KEY}.preset.${preset}`, PRESET_LABELS[preset] ?? preset),
            description: translate(
              `${copyKey}.presetDescription.${preset}`,
              copy.presetDescriptions[preset as keyof typeof copy.presetDescriptions] ?? '',
            ),
            testID: `${testID}.preset.${preset}`,
            ...(preset === props.preset && legend !== null ? { detail: legend } : {}),
          }))}
          value={props.preset}
          disabled={props.disabled}
          onChange={props.onSelectPreset}
          theme={theme}
        />
      </View>
      {custom ? (
        <ItemGroup
          title={translate(`${KEY}.customTitle`, 'Each event')}
          testID={`${testID}.events`}
        >
          {rows.map((row) => (
            <SettingRow
              key={row.id}
              title={eventLabel(translate, row.id)}
              {...(eventDescription(translate, row.id) === undefined
                ? {}
                : { hint: eventDescription(translate, row.id) })}
              layout="adaptive"
              disabled={props.disabled}
              testID={`${testID}.event.${row.id}`}
              control={
                <Select
                  label={eventLabel(translate, row.id)}
                  presentation="segmented"
                  options={deliveryOptions.map((option) => ({
                    ...option,
                    testID: `${testID}.event.${row.id}.${option.value}`,
                  }))}
                  value={row.delivery}
                  disabled={props.disabled}
                  onChange={(value) => {
                    if (
                      value === 'off' ||
                      value === 'quiet' ||
                      value === 'interrupt'
                    )
                      props.onSetDelivery(row.id, value);
                  }}
                />
              }
            />
          ))}
        </ItemGroup>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: HAPPIER_PAGE_METRICS.groupSeparatorGapPx },
  // The presets take the container's width (never wider), so a narrow pane can fit the segmented control.
  levels: { gap: HAPPIER_PAGE_METRICS.groupHeadingGapPx },
  legend: { gap: HAPPIER_PAGE_METRICS.groupHeadingGapPx / 2, paddingTop: HAPPIER_PAGE_METRICS.groupHeadingGapPx / 2 },
  legendRow: { flexDirection: 'row', gap: HAPPIER_PAGE_METRICS.groupHeadingGapPx },
  legendLabel: { flexShrink: 0 },
  legendLabelSizer: { height: 0, overflow: 'hidden' },
  legendValue: { flex: 1 },
});
