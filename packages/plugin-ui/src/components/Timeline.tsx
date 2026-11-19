import { useState, type ReactElement, type ReactNode } from 'react';
import { Platform, View } from 'react-native';

import { useHappierPrecisePrimaryPointer } from '../environment/interactiveTarget.js';
import { HappierList } from '../presentation/collection/List.js';
import { List } from './List.js';
import { Row, Stack } from './Layout.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';
import { Text } from './Text.js';

/** Content for one point on a timeline; the author owns its meaning and reading order. */
export type TimelineItemContent = Readonly<{
  /** An author-supplied icon or avatar, framed by the timeline's marker. */
  glyph: ReactNode;
  /** Inline text content for the event's sentence. Omitted, the row is its body alone (a card on the rail). */
  heading?: ReactNode;
  /** Time content, following the sentence or at the row's end (`timeAlign`). Formatting stays author-owned. */
  time?: ReactNode;
  /** Content beneath the sentence, at the column's full width: a quotation, replies, or event controls. */
  body?: ReactNode;
  /**
   * An independent control at the end of the sentence, such as opening the event. A rare reach beside a scanned rail:
   * under a precise pointer it appears with hover or keyboard focus; under a finger it stays in place.
   */
  trailing?: ReactNode;
}>;

export type TimelineProps<Item> = Readonly<{
  /** Already ordered by the author; Timeline never infers chronology or event policy. */
  items: readonly Item[];
  keyForItem: (item: Item, index: number) => string;
  renderItem: (item: Item, index: number) => TimelineItemContent;
  accessibilityLabel?: string;
  accessibilityLabelKey?: string;
  header?: ReactNode;
  empty?: ReactNode;
  /** Content after the stream, on the sentences' column, scrolling with its rows; with no event, on the page's edge. */
  endContent?: ReactNode;
  /** Delegates keyed prepend anchoring to the shared List owner. */
  preserveVisibleContentPositionOnPrepend?: boolean;
  /**
   * Where the time stands. `sentence` (default) follows the sentence, as a conversation reads ("commented · 2d");
   * `end` holds it in one right-aligned column, as an activity log is scanned by time.
   */
  timeAlign?: 'sentence' | 'end';
  /**
   * A short, bounded stream inside a page that already scrolls (an Overview's recent activity, one page of a
   * history): the rows render in place, with no scroller of their own, and `header` stands on the sentences' column.
   */
  inline?: boolean;
  testID?: string;
}>;

/** Geometry of the compact event rail; theme tokens own its gaps, typography and ink. */
const TIMELINE_METRICS = Object.freeze({
  markerPx: 24,
  railPx: 1.5,
  rowInsetPx: 7,
  sentenceInsetPx: 3,
});

function TimelineRow({ content, first, last, timeAlign }: Readonly<{
  content: TimelineItemContent;
  first: boolean;
  last: boolean;
  timeAlign: 'sentence' | 'end';
}>): ReactElement {
  const theme = usePluginTheme();
  const { markerPx, railPx, rowInsetPx, sentenceInsetPx } = TIMELINE_METRICS;
  const precise = useHappierPrecisePrimaryPointer(Platform.OS);
  const [revealed, setRevealed] = useState(false);
  const time = content.time === undefined || content.time === null ? null : content.time;
  const heading = content.heading === undefined || content.heading === null ? null : (
    <Text variant="reading">
      {content.heading}
      {time === null || timeAlign === 'end' ? null : '  '}
      {timeAlign === 'end' ? null : time}
    </Text>
  );
  const trailing = content.trailing === undefined || content.trailing === null ? null : (
    // A control taller than the sentence's line keeps the rail's rhythm: it hangs over the row's inset, never adds height.
    <View style={{ marginVertical: -sentenceInsetPx - rowInsetPx / 2, flexShrink: 0, opacity: precise && !revealed ? 0 : 1 }}>
      {content.trailing}
    </View>
  );
  return (
    <View {...(precise && trailing !== null ? {
      onPointerEnter: () => setRevealed(true), onPointerLeave: () => setRevealed(false),
      onFocus: () => setRevealed(true), onBlur: () => setRevealed(false),
    } : {})}>
    <Row gap="medium" align="flex-start" style={{ paddingVertical: rowInsetPx }}>
      <Stack align="center" style={{ width: markerPx, alignSelf: 'stretch' }}>
        {first && last ? null : (
          <Stack
            style={{
              // The rail crosses the row's own inset, so it reads as one line through every event.
              position: 'absolute',
              top: first ? markerPx / 2 : -rowInsetPx,
              ...(last ? { height: markerPx / 2 + rowInsetPx } : { bottom: -rowInsetPx }),
              left: (markerPx - railPx) / 2,
              width: railPx,
              backgroundColor: theme.colors.divider,
            }}
          />
        )}
        <Stack
          align="center"
          justify="center"
          style={{
            width: markerPx,
            height: markerPx,
            borderRadius: markerPx / 2,
            backgroundColor: theme.colors.surface,
            borderWidth: railPx,
            borderColor: theme.colors.divider,
          }}
        >
          {content.glyph}
        </Stack>
      </Stack>
      <Stack gap="small" grow style={{ paddingTop: heading === null ? 0 : sentenceInsetPx, minWidth: 0 }}>
        {heading === null ? null : (
          <Row gap="small" align="flex-start">
            <Stack grow style={{ minWidth: 0 }}>{heading}</Stack>
            {timeAlign === 'end' && time !== null ? <View style={{ flexShrink: 0 }}>{time}</View> : null}
            {trailing}
          </Row>
        )}
        {content.body}
      </Stack>
    </Row>
    </View>
  );
}

/** A themed event rail over List's scrolling, accessibility and viewport ownership. */
export function Timeline<Item>({ renderItem, endContent, timeAlign = 'sentence', inline = false, ...props }: TimelineProps<Item>): ReactElement {
  const theme = usePluginTheme();
  const lastIndex = props.items.length - 1;
  const sentenceColumn = { paddingLeft: TIMELINE_METRICS.markerPx + theme.spacing.medium };
  // With no event there is no rail to line up with, so what follows stands where the empty state does.
  const endColumn = props.items.length === 0 ? undefined : sentenceColumn;
  const inlineLabel = resolveAuthorText(usePluginTranslation(), props.accessibilityLabel, props.accessibilityLabelKey);
  if (inline) {
    // In place, inside the page's own scroller: the same rows and rail, no second scroll owner.
    return (
      <View testID={props.testID}>
        {props.header === undefined || props.header === null ? null : <View style={sentenceColumn}>{props.header}</View>}
        {props.items.length === 0 ? props.empty ?? null : (
          // The bare list, never a page sheet's divided rows: the rail runs unbroken from one marker to the next.
          <HappierList {...(inlineLabel === undefined ? {} : { accessibilityLabel: inlineLabel })}>
            {props.items.map((item, index) => (
              <View key={props.keyForItem(item, index)} role="listitem">
                <TimelineRow content={renderItem(item, index)} first={index === 0} last={index === lastIndex} timeAlign={timeAlign} />
              </View>
            ))}
          </HappierList>
        )}
        {endContent === undefined ? null : <View style={endColumn}>{endContent}</View>}
      </View>
    );
  }
  return (
    <List<Item>
      {...props}
      // The rows' own inset is the rhythm, so the rail runs unbroken from one marker to the next.
      density="flush"
      {...(endContent === undefined ? {} : {
        endContent: <View style={endColumn}>{endContent}</View>,
      })}
      // List owns each row's list membership; a second listitem here would nest one inside another.
      renderItem={(item: Item, index: number) => (
        <TimelineRow content={renderItem(item, index)} first={index === 0} last={index === lastIndex} timeAlign={timeAlign} />
      )}
    />
  );
}
