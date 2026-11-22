import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import type { DiffViewerBaseProps } from '@/components/ui/code/diff/diffViewerTypes';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { CODE_LINE_BASE_HEIGHT } from '@/components/ui/code/view/CodeLineRow';
import { CODE_GUTTER_METRICS } from '@/components/ui/code/editor/codeEditorFontMetrics';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { useHoverPreviewPopover } from '@/components/ui/popover/useHoverPreviewPopover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { WalkthroughLetteredCaption } from './walkthroughReading';

/**
 * Files' Explain line captions (lab ideas-1118-reviews scene 3): a lettered marker on a caption's first line in
 * the shared code view's leading lane, a hairline bracket over the rest of its range, and the same letter under
 * the stop's note. Pointing at (or focusing) either one tints the lines, lights both letters and floats the
 * caption under the range; on a phone a tapped marker opens the caption sheet. Code never gets rows inserted.
 */

/** The code view's leading-lane cell and line tint, as the diff viewer takes them. */
export type WalkthroughCaptionLaneProps = Pick<
  DiffViewerBaseProps,
  'renderLeadingLane' | 'highlightLineIds'
>;

type ActiveCaption = Readonly<{ key: string; mode: 'preview' | 'open' }>;
type CaptionFileState = Readonly<{
  active: ActiveCaption | null;
  placed: ReadonlySet<string>;
}>;
type CaptionDriver = Readonly<{
  enter: (key: string) => void;
  leave: () => void;
  reveal: (key: string) => boolean;
}>;

const NO_PLACED: ReadonlySet<string> = new Set();
const IDLE: CaptionFileState = { active: null, placed: NO_PLACED };

/**
 * One comparison's caption pairing: per file, the caption the person is on and the captions drawn in its code.
 * The file's code lane owns the hover intent and the callout; the notes and the markers read this record.
 */
export type WalkthroughCaptionFocus = Readonly<{
  read: (path: string) => CaptionFileState;
  subscribe: (path: string, listener: () => void) => () => void;
  publish: (path: string, patch: Partial<CaptionFileState>) => void;
  drive: (path: string, driver: CaptionDriver | null) => void;
  enter: (path: string, key: string) => void;
  leave: (path: string) => void;
  /** Brings a caption's lines into view and keeps its callout open; false when its code is not drawn. */
  reveal: (path: string, key: string) => boolean;
}>;

export function createWalkthroughCaptionFocus(): WalkthroughCaptionFocus {
  const states = new Map<string, CaptionFileState>();
  const listeners = new Map<string, Set<() => void>>();
  const drivers = new Map<string, CaptionDriver>();
  return {
    read: (path) => states.get(path) ?? IDLE,
    subscribe: (path, listener) => {
      const set = listeners.get(path) ?? new Set();
      listeners.set(path, set);
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    publish: (path, patch) => {
      const current = states.get(path) ?? IDLE;
      const next = { ...current, ...patch };
      if (
        next.active?.key === current.active?.key &&
        next.active?.mode === current.active?.mode &&
        next.placed === current.placed
      )
        return;
      states.set(path, next);
      listeners.get(path)?.forEach((listener) => listener());
    },
    drive: (path, driver) => {
      if (driver) drivers.set(path, driver);
      else drivers.delete(path);
    },
    enter: (path, key) => drivers.get(path)?.enter(key),
    leave: (path) => drivers.get(path)?.leave(),
    reveal: (path, key) => drivers.get(path)?.reveal(key) ?? false,
  };
}

function useCaptionFileState(
  focus: WalkthroughCaptionFocus,
  path: string,
): CaptionFileState {
  return React.useSyncExternalStore(
    React.useCallback(
      (listener) => focus.subscribe(path, listener),
      [focus, path],
    ),
    () => focus.read(path),
    () => focus.read(path),
  );
}

/** "L14–15" or "L18": the caption's lines on its side. */
export function captionLinesLabel(
  caption: Pick<WalkthroughLetteredCaption, 'startLine' | 'endLine'>,
): string {
  return t('walkthrough.explain.captionLines', {
    start: caption.startLine,
    end: caption.endLine,
  });
}

function captionA11y(caption: WalkthroughLetteredCaption): string {
  return t('walkthrough.explain.captionA11y', {
    letter: caption.letter,
    lines: captionLinesLabel(caption),
  });
}

/** The caption's letter: 16 px, micro type, bordered like the stop number; filled while its caption is on. */
export const WalkthroughCaptionLetter = React.memo(
  function WalkthroughCaptionLetter(
    props: Readonly<{
      letter: string;
      state?: 'rest' | 'on' | 'dim';
    }>,
  ) {
    const state = props.state ?? 'rest';
    return (
      <View
        style={[
          styles.letter,
          state === 'on' ? styles.letterOn : null,
          state === 'dim' ? styles.letterDim : null,
        ]}
      >
        <Text
          style={[
            styles.letterText,
            state === 'on' ? styles.letterTextOn : null,
          ]}
        >
          {props.letter}
        </Text>
      </View>
    );
  },
);

type CaptionPlacement = Readonly<{
  /** The caption's drawn lines, in display order. */
  lineIds: ReadonlyMap<string, readonly string[]>;
  /** Per line: the captions it starts (markers) and the ones it continues (brackets), by lane column. */
  cells: ReadonlyMap<
    string,
    readonly (Readonly<{
      caption: WalkthroughLetteredCaption;
      first: boolean;
      last: boolean;
    }> | null)[]
  >;
  columns: number;
}>;

/**
 * Puts each caption on the code drawn for its captured hunk. A caption whose lines are not in the drawn diff (a
 * changed capture, a window that omits them) gets no marker: its note still reads, without a jump.
 */
function placeCaptions(
  captions: readonly WalkthroughLetteredCaption[],
  lines: readonly CodeLine[],
): CaptionPlacement {
  const lineIds = new Map<string, string[]>();
  for (const caption of captions) {
    const ids: string[] = [];
    for (const line of lines) {
      // A line's side and number name it in any drawn patch of this file: the whole captured diff (Files) or a stop's
      // own hunks (the Walkthrough card), whose hunks are renumbered.
      if (line.renderIsHeaderLine) continue;
      const number =
        caption.side === 'after'
          ? line.kind === 'remove'
            ? null
            : line.newLine
          : line.kind === 'add'
            ? null
            : line.oldLine;
      if (
        number !== null &&
        number >= caption.startLine &&
        number <= caption.endLine
      )
        ids.push(line.id);
    }
    if (ids.length > 0) lineIds.set(caption.key, ids);
  }
  // Overlapping ranges take side-by-side columns: each caption the first column free over its lines.
  const order = new Map(lines.map((line, index) => [line.id, index]));
  const taken: (readonly [number, number])[][] = [];
  const columnOf = new Map<string, number>();
  for (const caption of captions) {
    const ids = lineIds.get(caption.key);
    if (!ids) continue;
    const span = [
      order.get(ids[0]!)!,
      order.get(ids[ids.length - 1]!)!,
    ] as const;
    let column = taken.findIndex((spans) =>
      spans.every(([from, to]) => span[1] < from || span[0] > to),
    );
    if (column < 0) {
      column = taken.length;
      taken.push([]);
    }
    taken[column]!.push(span);
    columnOf.set(caption.key, column);
  }
  const cells = new Map<
    string,
    (Readonly<{
      caption: WalkthroughLetteredCaption;
      first: boolean;
      last: boolean;
    }> | null)[]
  >();
  for (const caption of captions) {
    const ids = lineIds.get(caption.key);
    if (!ids) continue;
    ids.forEach((id, index) => {
      const row =
        cells.get(id) ?? Array.from({ length: taken.length }, () => null);
      row[columnOf.get(caption.key)!] = {
        caption,
        first: index === 0,
        last: index === ids.length - 1,
      };
      cells.set(id, row);
    });
  }
  return { lineIds, cells, columns: taken.length };
}

const LANE_COLUMN_WIDTH_PX = CODE_GUTTER_METRICS.markerLaneWidth;
const LETTER_SIZE_PX = 16;
const CALLOUT_WIDTH_PX = 380;

type CaptionCellEntry = NonNullable<
  NonNullable<ReturnType<CaptionPlacement['cells']['get']>>[number]
>;

/** One line's lane cell: a marker where a caption starts, its bracket where it continues, blank elsewhere. */
const CaptionCell = React.memo(function CaptionCell(
  props: Readonly<{
    path: string;
    entries: readonly (CaptionCellEntry | null)[] | undefined;
    columns: number;
    focus: WalkthroughCaptionFocus;
    registerAnchor: (
      key: string,
      node: View | null,
      kind: 'marker' | 'last',
    ) => void;
    onMarkerFocus: (key: string) => void;
    onMarkerBlur: () => void;
    onMarkerPress: (key: string) => void;
  }>,
) {
  if (!props.entries)
    return <View style={{ width: props.columns * LANE_COLUMN_WIDTH_PX }} />;
  return (
    <View style={styles.cell}>
      {props.entries.map((entry, column) =>
        entry ? (
          <CaptionCellColumn key={column} {...props} entry={entry} />
        ) : (
          <View key={column} style={styles.column} />
        ),
      )}
    </View>
  );
});

function CaptionCellColumn(
  props: Readonly<{
    path: string;
    entry: CaptionCellEntry;
    focus: WalkthroughCaptionFocus;
    registerAnchor: (
      key: string,
      node: View | null,
      kind: 'marker' | 'last',
    ) => void;
    onMarkerFocus: (key: string) => void;
    onMarkerBlur: () => void;
    onMarkerPress: (key: string) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { caption, first, last } = props.entry;
  const active = useCaptionFileState(props.focus, props.path).active;
  const on = active?.key === caption.key;
  const bracketColor = on
    ? theme.colors.accent.blue
    : theme.colors.border.strong;
  const { registerAnchor } = props;
  const registerLast = React.useCallback(
    (node: View | null) => {
      if (last) registerAnchor(caption.key, node, 'last');
    },
    [caption.key, last, registerAnchor],
  );
  const registerMarker = React.useCallback(
    (node: unknown) => registerAnchor(caption.key, node as View | null, 'marker'),
    [caption.key, registerAnchor],
  );
  return (
    <View ref={registerLast} collapsable={false} style={styles.column}>
      {first ? (
        <HappierPressable
          controlRef={registerMarker}
          testID={`walkthrough-caption-marker-${caption.letter}`}
          accessibilityRole="button"
          accessibilityLabel={captionA11y(caption)}
          accessibilityHint={caption.text}
          onHoverChange={(hovered) =>
            hovered
              ? props.focus.enter(props.path, caption.key)
              : props.focus.leave(props.path)
          }
          onFocusChange={(focused) =>
            focused ? props.onMarkerFocus(caption.key) : props.onMarkerBlur()
          }
          onPress={() => props.onMarkerPress(caption.key)}
          style={(state) => [
            styles.marker,
            focusRingStyle({
              focused: state.focused,
              color: theme.colors.border.focus,
            }),
          ]}
        >
          <WalkthroughCaptionLetter
            letter={caption.letter}
            state={on ? 'on' : active ? 'dim' : 'rest'}
          />
        </HappierPressable>
      ) : null}
      {first && last ? null : (
        <View
          pointerEvents="none"
          style={[
            styles.bracket,
            first ? styles.bracketFromMarker : null,
            last ? styles.bracketEnd : null,
            { backgroundColor: bracketColor },
          ]}
        />
      )}
    </View>
  );
}

/**
 * The code lane of one file's captions: places them on the drawn diff, owns the hover intent (the shared hover
 * preview: rest to open, a grace on leave, a press or Enter keeps it), and floats the caption under its range.
 * A file without captions never mounts this; the diff draws exactly as without Explain's captions.
 */
export function WalkthroughCaptionLane(
  props: Readonly<{
    path: string;
    /** The pairing record's key when one path is drawn in several places (a Walkthrough stop's card); defaults to the path. */
    focusKey?: string;
    captions: readonly WalkthroughLetteredCaption[];
    focus: WalkthroughCaptionFocus;
    unifiedDiff: string;
    onReadInWalkthrough?: (stopId: string) => void;
    children: (lane: WalkthroughCaptionLaneProps) => React.ReactNode;
  }>,
) {
  const { path, captions, focus } = props;
  const focusKey = props.focusKey ?? path;
  const lines = React.useMemo(
    () =>
      buildCodeLinesFromUnifiedDiff({
        unifiedDiff: props.unifiedDiff,
        hideFilePrelude: true,
      }),
    [props.unifiedDiff],
  );
  const placement = React.useMemo(
    () => placeCaptions(captions, lines),
    [captions, lines],
  );
  const placed = React.useMemo(
    () => captions.filter((caption) => placement.lineIds.has(caption.key)),
    [captions, placement],
  );
  const hover = useHoverPreviewPopover<string>({
    enabled: Platform.OS === 'web',
  });
  const markers = React.useRef(new Map<string, View>());
  const ends = React.useRef(new Map<string, View>());
  // The callout hangs from its range's last drawn line, read when the popover measures: a recycled row keeps
  // the anchor current.
  const anchorKey = React.useRef<string | null>(null);
  const [anchorRef] = React.useState(() => ({
    get current(): View | null {
      return anchorKey.current ? (ends.current.get(anchorKey.current) ?? null) : null;
    },
  }));
  const pinned = React.useRef(false);

  React.useLayoutEffect(() => {
    focus.publish(focusKey, { placed: new Set(placement.lineIds.keys()) });
  }, [focus, focusKey, placement]);
  React.useLayoutEffect(() => () => focus.publish(focusKey, IDLE), [focus, focusKey]);
  const activeKey = hover.mode === 'closed' ? null : hover.target;
  React.useLayoutEffect(() => {
    focus.publish(focusKey, {
      active: activeKey
        ? { key: activeKey, mode: hover.mode === 'open' ? 'open' : 'preview' }
        : null,
    });
  }, [activeKey, focus, focusKey, hover.mode]);

  const { triggerHoverProps, open, close } = hover;
  const show = React.useCallback(
    (key: string) => {
      anchorKey.current = key;
      open(key);
    },
    [open],
  );
  const driver = React.useMemo<CaptionDriver>(
    () => ({
      enter: (key) => {
        if (!placement.lineIds.has(key)) return;
        anchorKey.current = key;
        triggerHoverProps(key)?.onPointerEnter();
      },
      leave: () => triggerHoverProps('')?.onPointerLeave(),
      reveal: (key) => {
        const marker = markers.current.get(key);
        if (!placement.lineIds.has(key) || !marker) return false;
        const node = marker as unknown as {
          scrollIntoView?: (options: object) => void;
          focus?: () => void;
        };
        node.scrollIntoView?.({ block: 'nearest' });
        // Focus first: the marker's focus opens the callout like a key would, then the choice pins it, so the
        // focus a closing list hands back to its stop header does not take the caption away.
        node.focus?.();
        pinned.current = true;
        show(key);
        return true;
      },
    }),
    [placement, show, triggerHoverProps],
  );
  React.useLayoutEffect(() => {
    focus.drive(focusKey, driver);
    return () => focus.drive(focusKey, null);
  }, [driver, focus, focusKey]);

  const registerAnchor = React.useCallback(
    (key: string, node: View | null, kind: 'marker' | 'last') => {
      const map = kind === 'marker' ? markers.current : ends.current;
      if (node) map.set(key, node);
      else map.delete(key);
    },
    [],
  );
  const onMarkerFocus = React.useCallback(
    (key: string) => {
      // Focus returning to the caption already showing keeps it as it was (pinned by a press or a choice).
      if (anchorKey.current !== key) pinned.current = false;
      show(key);
    },
    [show],
  );
  const onMarkerBlur = React.useCallback(() => {
    if (!pinned.current) close();
  }, [close]);
  const onMarkerPress = React.useCallback(
    (key: string) => {
      pinned.current = true;
      show(key);
    },
    [show],
  );
  const requestClose = React.useCallback(() => {
    pinned.current = false;
    close();
  }, [close]);

  const renderLeadingLane = React.useCallback(
    (line: CodeLine) => (
      <CaptionCell
        path={focusKey}
        entries={placement.cells.get(line.id)}
        columns={placement.columns}
        focus={focus}
        registerAnchor={registerAnchor}
        onMarkerFocus={onMarkerFocus}
        onMarkerBlur={onMarkerBlur}
        onMarkerPress={onMarkerPress}
      />
    ),
    [
      focus,
      onMarkerBlur,
      onMarkerFocus,
      onMarkerPress,
      focusKey,
      placement,
      registerAnchor,
    ],
  );
  const highlightLineIds = React.useMemo(
    () =>
      activeKey ? new Set(placement.lineIds.get(activeKey) ?? []) : undefined,
    [activeKey, placement],
  );
  const lane = React.useMemo<WalkthroughCaptionLaneProps>(
    () => ({ renderLeadingLane, highlightLineIds }),
    [highlightLineIds, renderLeadingLane],
  );

  const caption = activeKey
    ? (placed.find((entry) => entry.key === activeKey) ?? null)
    : null;
  const index = caption ? placed.indexOf(caption) : -1;
  const step = (delta: number) => {
    const next = placed[index + delta];
    if (next) {
      pinned.current = true;
      show(next.key);
    }
  };
  return (
    <>
      {props.children(lane)}
      {caption && anchorRef.current ? (
        <Popover
          open
          anchorRef={anchorRef}
          placement="bottom"
          gap={6}
          backdrop={false}
          onRequestClose={requestClose}
          layer={hover.popoverLayer}
          phonePresentation="sheet"
          sheetHeader="none"
          sheetBackdrop="none"
          sheetMaterial="solid"
          minWidth={0}
          maxWidthCap={CALLOUT_WIDTH_PX}
          accessibilityLabel={captionA11y(caption)}
          portal={{
            web: true,
            native: true,
            matchAnchorWidth: false,
            sizeToContent: true,
            anchorAlign: 'start',
          }}
        >
          {({ maxHeight, presentation }) =>
            presentation === 'sheet' ? (
              <CaptionSheetBody
                caption={caption}
                path={path}
                position={index + 1}
                total={placed.length}
                onPrevious={index > 0 ? () => step(-1) : undefined}
                onNext={index < placed.length - 1 ? () => step(1) : undefined}
                onReadInWalkthrough={
                  props.onReadInWalkthrough
                    ? () => {
                        requestClose();
                        props.onReadInWalkthrough?.(caption.stopId);
                      }
                    : undefined
                }
              />
            ) : (
              <View {...(hover.panelHoverProps ?? {})}>
                <FloatingOverlay maxHeight={maxHeight}>
                  <View
                    testID="walkthrough-caption-callout"
                    style={styles.callout}
                  >
                    <CaptionHeading caption={caption} path={path} />
                    <Text style={styles.calloutText} selectable>
                      {caption.text}
                    </Text>
                  </View>
                </FloatingOverlay>
              </View>
            )
          }
        </Popover>
      ) : null}
    </>
  );
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function CaptionHeading(
  props: Readonly<{
    caption: WalkthroughLetteredCaption;
    path: string;
    trailing?: React.ReactNode;
  }>,
) {
  return (
    <View style={styles.heading}>
      <WalkthroughCaptionLetter letter={props.caption.letter} state="on" />
      <Text
        style={styles.headingRef}
        numberOfLines={1}
      >{`${fileName(props.path)} ${captionLinesLabel(props.caption)}`}</Text>
      {props.trailing ? <View style={styles.spacer} /> : null}
      {props.trailing}
    </View>
  );
}

/** Phone: the tapped marker's caption, its place among the file's captions, and stepping through them. */
function CaptionSheetBody(
  props: Readonly<{
    caption: WalkthroughLetteredCaption;
    path: string;
    /** Its place among the file's drawn captions, the ones previous and next step through. */
    position: number;
    total: number;
    onPrevious?: () => void;
    onNext?: () => void;
    onReadInWalkthrough?: () => void;
  }>,
) {
  const { caption } = props;
  return (
    <View testID="walkthrough-caption-sheet" style={styles.sheet}>
      <CaptionHeading
        caption={caption}
        path={props.path}
        trailing={
          <Text style={styles.meta}>
            {t('walkthrough.explain.captionOf', {
              position: props.position,
              total: props.total,
            })}
          </Text>
        }
      />
      <Text style={styles.sheetText} selectable>
        {caption.text}
      </Text>
      <Text style={styles.meta}>
        {t('walkthrough.explain.captionStop', {
          number: caption.stopNumber,
          title: caption.stopTitle,
        })}
      </Text>
      <View style={styles.sheetFooter}>
        <IconButton
          iconName="caret-left"
          accessibilityLabel={t('walkthrough.explain.previousCaption')}
          disabled={!props.onPrevious}
          onPress={() => props.onPrevious?.()}
        />
        {props.onReadInWalkthrough ? (
          <RoundButton
            display="secondary"
            title={t('walkthrough.explain.readInWalkthrough')}
            onPress={props.onReadInWalkthrough}
            style={styles.sheetRead}
          />
        ) : (
          <View style={styles.spacer} />
        )}
        <IconButton
          iconName="caret-right"
          accessibilityLabel={t('walkthrough.explain.nextCaption')}
          disabled={!props.onNext}
          onPress={() => props.onNext?.()}
        />
      </View>
    </View>
  );
}

/**
 * A stop's captions in this file, under its note (lab "Hover a caption"): letter, lines and the sentence. Pointing at
 * one pairs it with its lines like its marker does; pressing brings the lines into view and focuses the marker. A
 * caption whose lines are not drawn reads as plain text: no pairing, no jump.
 */
export const WalkthroughCaptionList = React.memo(
  function WalkthroughCaptionList(
    props: Readonly<{
      path: string;
      captions: readonly WalkthroughLetteredCaption[];
      focus: WalkthroughCaptionFocus;
      /** Choosing one also closes the surface the list sits in (the phone's stop sheet). */
      onChoose?: (caption: WalkthroughLetteredCaption) => void;
    }>,
  ) {
    const state = useCaptionFileState(props.focus, props.path);
    return (
      <View testID={`walkthrough-captions-${props.path}`} style={styles.list}>
        {props.captions.map((caption) => {
          const placed = state.placed.has(caption.key);
          const on = state.active?.key === caption.key;
          const body = (
            <>
              <WalkthroughCaptionLetter
                letter={caption.letter}
                state={on ? 'on' : 'rest'}
              />
              <Text style={styles.rowText}>
                <Text style={styles.rowLines}>
                  {captionLinesLabel(caption)}
                </Text>
                {` ${caption.text}`}
              </Text>
            </>
          );
          if (!placed) {
            return (
              <View
                key={caption.key}
                testID={`walkthrough-caption-${caption.letter}`}
                style={styles.row}
              >
                {body}
              </View>
            );
          }
          return (
            <CaptionListRow
              key={caption.key}
              caption={caption}
              on={on}
              path={props.path}
              focus={props.focus}
              onChoose={props.onChoose}
            >
              {body}
            </CaptionListRow>
          );
        })}
      </View>
    );
  },
);

function CaptionListRow(
  props: Readonly<{
    caption: WalkthroughLetteredCaption;
    on: boolean;
    path: string;
    focus: WalkthroughCaptionFocus;
    onChoose?: (caption: WalkthroughLetteredCaption) => void;
    children: React.ReactNode;
  }>,
) {
  const { theme } = useUnistyles();
  const { caption, focus, path } = props;
  return (
    <HappierPressable
      testID={`walkthrough-caption-${caption.letter}`}
      accessibilityRole="button"
      accessibilityLabel={`${captionA11y(caption)}. ${caption.text}`}
      onHoverChange={(hovered) =>
        hovered ? focus.enter(path, caption.key) : focus.leave(path)
      }
      onPress={() => {
        props.onChoose?.(caption);
        focus.reveal(path, caption.key);
      }}
      style={(state) => [
        styles.row,
        styles.rowPressable,
        props.on ? styles.rowOn : null,
        focusRingStyle({
          focused: state.focused,
          color: theme.colors.border.focus,
        }),
      ]}
    >
      {props.children}
    </HappierPressable>
  );
}

/** The phone's stop header letters ("A B C"): the captions its sheet lists. */
export function WalkthroughCaptionLetters(
  props: Readonly<{ captions: readonly WalkthroughLetteredCaption[] }>,
) {
  return (
    <Text style={styles.letters} numberOfLines={1}>
      {props.captions.map((caption) => caption.letter).join(' ')}
    </Text>
  );
}

/**
 * Phone (lab "Hover a caption", 390): a stop header's captions as a sheet; choosing one opens its caption sheet
 * at the tinted lines. Read in Walkthrough stays at the foot.
 */
export function WalkthroughStopCaptionsSheet(
  props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    open: boolean;
    onClose: () => void;
    path: string;
    stop: Readonly<{ id: string; number: number; title: string }>;
    captions: readonly WalkthroughLetteredCaption[];
    focus: WalkthroughCaptionFocus;
    onReadInWalkthrough?: (stopId: string) => void;
  }>,
) {
  if (!props.open) return null;
  return (
    <Popover
      open
      anchorRef={props.anchorRef}
      placement="bottom"
      onRequestClose={props.onClose}
      phonePresentation="sheet"
      sheetHeader="none"
      sheetBackdrop="none"
      sheetMaterial="solid"
      accessibilityLabel={props.stop.title}
      portal={{
        web: true,
        native: true,
        matchAnchorWidth: false,
        sizeToContent: true,
        anchorAlign: 'start',
      }}
      maxWidthCap={CALLOUT_WIDTH_PX}
    >
      {({ maxHeight, presentation }) => {
        const body = (
          <View
            testID="walkthrough-stop-captions-sheet"
            style={presentation === 'sheet' ? styles.sheet : styles.callout}
          >
            <View style={styles.heading}>
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {props.stop.title}
              </Text>
              <Text style={styles.meta}>
                {t('walkthrough.explain.stopCaptions', {
                  number: props.stop.number,
                  count: props.captions.length,
                })}
              </Text>
            </View>
            <WalkthroughCaptionList
              path={props.path}
              captions={props.captions}
              focus={props.focus}
              onChoose={props.onClose}
            />
            {props.onReadInWalkthrough ? (
              <View style={styles.sheetFooter}>
                <RoundButton
                  display="secondary"
                  title={t('walkthrough.explain.readInWalkthrough')}
                  style={styles.sheetRead}
                  onPress={() => {
                    props.onClose();
                    props.onReadInWalkthrough?.(props.stop.id);
                  }}
                />
              </View>
            ) : null}
          </View>
        );
        return presentation === 'sheet' ? (
          body
        ) : (
          <FloatingOverlay maxHeight={maxHeight}>{body}</FloatingOverlay>
        );
      }}
    </Popover>
  );
}

const styles = StyleSheet.create((theme) => ({
  letter: {
    width: LETTER_SIZE_PX,
    height: LETTER_SIZE_PX,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    backgroundColor: theme.colors.surface.base,
    borderWidth: 1,
    borderColor: theme.colors.border.strong,
  },
  letterOn: {
    backgroundColor: theme.colors.accent.blue,
    borderColor: theme.colors.accent.blue,
  },
  letterDim: { opacity: 0.45 },
  letterText: {
    ...Typography.variant('micro', 'semiBold'),
    fontSize: 10,
    lineHeight: 12,
    color: theme.colors.text.secondary,
  },
  letterTextOn: { color: theme.colors.surface.base },
  cell: { flexDirection: 'row', flexGrow: 1 },
  column: {
    width: LANE_COLUMN_WIDTH_PX,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  marker: {
    marginTop: (CODE_LINE_BASE_HEIGHT - LETTER_SIZE_PX) / 2,
    borderRadius: 5,
    zIndex: 1,
  },
  bracket: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    left: (LANE_COLUMN_WIDTH_PX - 1) / 2,
  },
  bracketFromMarker: { top: (CODE_LINE_BASE_HEIGHT + LETTER_SIZE_PX) / 2 },
  bracketEnd: { bottom: (CODE_LINE_BASE_HEIGHT - LETTER_SIZE_PX) / 2 },
  callout: {
    width: CALLOUT_WIDTH_PX,
    maxWidth: '100%',
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
    gap: theme.space.s4,
  },
  heading: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  headingRef: {
    flexShrink: 1,
    ...Typography.mono(),
    fontSize: 11,
    color: theme.colors.text.secondary,
  },
  calloutText: {
    ...Typography.variant('body'),
    color: theme.colors.text.primary,
  },
  spacer: { flex: 1 },
  meta: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
  sheet: {
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s16,
    gap: theme.space.s8,
  },
  sheetTitle: {
    flexShrink: 1,
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.primary,
  },
  sheetText: {
    ...Typography.variant('reading'),
    color: theme.colors.text.primary,
  },
  sheetFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    marginTop: theme.space.s6,
  },
  sheetRead: { flex: 1 },
  list: { marginTop: theme.space.s10, gap: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
    paddingVertical: theme.space.s4,
    paddingHorizontal: theme.space.s6,
    borderRadius: 8,
  },
  rowPressable: { marginHorizontal: 0 },
  rowOn: { backgroundColor: theme.colors.surface.selected },
  rowText: {
    flex: 1,
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  rowLines: {
    ...Typography.mono(),
    fontSize: 11,
    color: theme.colors.text.secondary,
  },
  letters: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 0,
  },
}));
