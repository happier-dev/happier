import { useState, type ReactElement, type ReactNode } from 'react';
import { Platform, View } from 'react-native';

import { useHappierPrecisePrimaryPointer } from '../environment/interactiveTarget.js';
import { List } from './List.js';
import { Row, Stack } from './Layout.js';
import { usePluginTheme } from './PluginUiProvider.js';
import { Text } from './Text.js';

/** Content for one point on a timeline; the author owns its meaning and reading order. */
export type TimelineItemContent = Readonly<{
  /** An author-supplied icon or avatar, framed by the timeline's marker. */
  glyph: ReactNode;
  /** Inline text content for the event's sentence. Omitted, the row is its body alone (a card on the rail). */
  heading?: ReactNode;
  /** Inline time content, following the sentence. Formatting stays author-owned. */
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
  /** Content after the stream, on the sentences' column, scrolling with its rows. */
  endContent?: ReactNode;
  /** Delegates keyed prepend anchoring to the shared List owner. */
  preserveVisibleContentPositionOnPrepend?: boolean;
  testID?: string;
}>;

/** Geometry of the compact event rail; theme tokens own its gaps, typography and ink. */
const TIMELINE_METRICS = Object.freeze({
  markerPx: 24,
  railPx: 1.5,
  rowInsetPx: 7,
  sentenceInsetPx: 3,
});

function TimelineRow({ content, first, last }: Readonly<{
  content: TimelineItemContent;
  first: boolean;
  last: boolean;
}>): ReactElement {
  const theme = usePluginTheme();
  const { markerPx, railPx, rowInsetPx, sentenceInsetPx } = TIMELINE_METRICS;
  const precise = useHappierPrecisePrimaryPointer(Platform.OS);
  const [revealed, setRevealed] = useState(false);
  const heading = content.heading === undefined || content.heading === null ? null : (
    <Text variant="reading">
      {content.heading}
      {content.time === undefined || content.time === null ? null : '  '}
      {content.time}
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
export function Timeline<Item>({ renderItem, endContent, ...props }: TimelineProps<Item>): ReactElement {
  const theme = usePluginTheme();
  const lastIndex = props.items.length - 1;
  return (
    <List<Item>
      {...props}
      // The rows' own inset is the rhythm, so the rail runs unbroken from one marker to the next.
      density="flush"
      {...(endContent === undefined ? {} : {
        endContent: <View style={{ paddingLeft: TIMELINE_METRICS.markerPx + theme.spacing.medium }}>{endContent}</View>,
      })}
      renderItem={(item: Item, index: number) => (
        <View role="listitem">
          <TimelineRow content={renderItem(item, index)} first={index === 0} last={index === lastIndex} />
        </View>
      )}
    />
  );
}
