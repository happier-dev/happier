import * as React from 'react';
import {
  Platform,
  Pressable,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import { captureDocPassageV1 } from '@happier-dev/protocol/artifacts/artifactPassageV1';

import {
  useRouter,
  type Href,
} from '@/components/appShell/workspace/destinationRoute';
import {
  mapMarkdownSourceToRenderedRange,
  mapRenderedSelectionToMarkdownSource,
} from '@/components/markdown/rendering/markdownSelectionSource';
import { type MarkdownRenderedSelection, type MarkdownSelectionAction, type MarkdownSourceRangeAction } from '@/components/markdown/MarkdownView';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Text } from '@/components/ui/text/Text';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { ProseDiffViewer } from '@/components/ui/code/diff/prose/ProseDiffViewer';

import { useArtifactActionsClient } from './artifactActionsClient';
import type { DocPassageMarginLocation } from './docPassageMargin';
import { ArtifactProseBody } from './ArtifactProseBody';
import type { DocBodySegment, DocSuggestionPaint } from './docSuggestionPaint';

type Revision = Readonly<{ headerVersion: number; bodyVersion: number }>;
type Selected = Readonly<{
  range: Readonly<{ start: number; end: number }>;
  top: number;
  left: number;
}>;

/** A passage the Doc shows a thread for; `location` places it in this revision's source. */
export type ArtifactMarginPassage = Readonly<{
  id: string;
  location: DocPassageMarginLocation;
}>;

export type ArtifactPassageMargin = Readonly<{
  passages: readonly ArtifactMarginPassage[];
  focusedId: string | null;
  onFocus: (id: string) => void;
  /** Narrow layouts have no margin: a passage opens its thread instead. */
  onOpen: (id: string) => void;
  /** An ambiguous native block opens the existing complete thread list, never its first thread. */
  onOpenThreadList?: () => void;
  renderCard: (id: string) => React.ReactNode;
  /**
   * A changed thread waiting for the text it belongs to now: the next captured selection is handed to
   * it (the same capture a new comment uses) instead of starting a new comment.
   */
  attach?: Readonly<{ discussionId: string; complete: (passage: DocPassageRefV1) => void }> | null;
  /** Whether the threads sit beside the passages (wide) or open on their own (narrow). */
  reportShown?: (shown: boolean) => void;
  /**
   * What the comments column shows while it has no thread cards (loading, none yet, unavailable). The
   * column stands beside the body whenever it fits, so the body never moves when threads arrive.
   */
  idle?: React.ReactNode;
  /** Current suggestions painted in the body (web); `null`/absent when the body reads as written. */
  paint?: DocSuggestionPaint | null;
  /** Start a comment as a new thread beside its passage (lab K1-S); only while the margin is shown. */
  startComment?: (passage: DocPassageRefV1) => void;
}>;

/** UI-D supplies the visible native refinement host without replacing rich Markdown or its marks. */
export type ArtifactNativeSelectionRequest = Readonly<{
  /** Render this captured block through the same enriched native primitive/menu. */
  markdown: string;
  /** Return that menu's actual text snapshot and exact UTF-16 selection. */
  complete: (selection: MarkdownRenderedSelection) => boolean;
}>;

type Rect = Readonly<{
  top: number;
  left: number;
  width: number;
  height: number;
}>;

/** The Comment affordance sits above the selection's middle, kept inside the body column. */
const AFFORDANCE_HALF_WIDTH = 56;
const AFFORDANCE_LIFT = 44;
/** The margin opens beside the passage only when the body keeps a readable measure next to it. */
const MARGIN_MIN_FRAME_WIDTH = 860;
/** The Doc comments column beside the body: its thread cards and their specimens share this width. */
export const DOC_PASSAGE_MARGIN_WIDTH = 288;

/**
 * A Doc's Markdown body with its passages (C5 lab K1-S/A/R/ST):
 * - select text, then Comment: the selection is placed in the canonical Markdown source by the
 *   Markdown owner's projection (never by searching for the quote), captured as a passage at the
 *   revision being read, and opens the one Discussion composer with that passage;
 * - each commented passage is marked where its stored source range lands in this revision, and its
 *   thread sits beside it in the margin; a mark and its thread focus each other.
 * Web reads browser selection and geometry; native menus report actual rendered text and UTF-16
 * offsets through the same mapper. Marked native blocks retain their renderer and request an exact
 * selection host; without that host, no block-sized substitute is published.
 */
export function ArtifactPassageSelection(
  props: Readonly<{
    artifactId: string;
    markdown: string;
    revision: Revision | null;
    margin?: ArtifactPassageMargin;
    onRequestNativeSelection?: (request: ArtifactNativeSelectionRequest) => void;
  }>,
): React.ReactElement {
  const scope = useActiveServerAccountScope();
  if (props.revision === null)
    return <ArtifactProseBody testID="artifact:body" markdown={props.markdown} />;
  if (Platform.OS !== 'web')
    return <NativePassageSelection key={JSON.stringify([props.artifactId, scope?.serverId, scope?.accountId])}
      {...props} revision={props.revision} scope={scope} />;
  return <WebPassageSelection {...props} revision={props.revision} />;
}

/**
 * Without a margin beside the body (a phone, a narrow pane) a passage that changed after its comment
 * has no place to stand in the text, so its own thread card follows the body: the same card the margin
 * draws, carrying the notice, Open version and Attach to new text. It comes after the text so the Doc
 * never moves down when threads arrive; the Comments list marks it Changed. Placed threads open as pages.
 */
function ChangedPassageCards(props: Readonly<{ margin: ArtifactPassageMargin | undefined }>) {
  const ids = (props.margin?.passages ?? []).filter((passage) => passage.location.state === 'detached').map((passage) => passage.id);
  if (ids.length === 0 || !props.margin) return null;
  return (
    <View testID="artifact:passage-changed" style={styles.changed}>
      {ids.map((id) => <React.Fragment key={id}>{props.margin?.renderCard(id)}</React.Fragment>)}
    </View>
  );
}

function overlapsBlock(range: Readonly<{ start: number; end: number }>, block: MarkdownSourceRangeAction): boolean {
  return range.start < block.sourceStart + block.sourceLength && range.end > block.sourceStart;
}

/** A hit shared by several threads opens the existing list, never an arbitrary first thread. */
function activatePassageThreads(ids: readonly string[], margin: ArtifactPassageMargin | undefined, shownInMargin: boolean): void {
  if (ids.length > 1) margin?.onOpenThreadList?.();
  else if (ids.length === 1) {
    if (shownInMargin) margin?.onFocus(ids[0]!);
    else margin?.onOpen(ids[0]!);
  }
}

function NativePassageSelection(
  props: Readonly<{
    artifactId: string;
    markdown: string;
    revision: Revision;
    scope: ReturnType<typeof useActiveServerAccountScope>;
    margin?: ArtifactPassageMargin;
    onRequestNativeSelection?: (request: ArtifactNativeSelectionRequest) => void;
  }>,
) {
  const router = useRouter();
  const client = useArtifactActionsClient();
  const scope = props.scope;
  const margin = props.margin;
  // Native has no margin beside the body: a passage opens its thread (the phone thread page).
  const reportShown = margin?.reportShown;
  React.useEffect(() => {
    reportShown?.(false);
  }, [reportShown]);
  const placed = React.useMemo(
    () => (margin?.passages ?? []).flatMap((passage) =>
      passage.location.state === 'detached' ? [] : [{ id: passage.id, range: passage.location.range }]),
    [margin?.passages],
  );
  const focusedId = margin?.focusedId ?? null;
  const marks = React.useMemo(
    () => placed.length === 0 ? undefined
      : placed.map((passage) => ({ ...passage.range, current: passage.id === focusedId }))
        .sort((left, right) => left.start - right.start),
    [focusedId, placed],
  );
  const marginRef = React.useRef(margin);
  marginRef.current = margin;
  const passagesIn = React.useCallback(
    (block: MarkdownSourceRangeAction) => placed.filter((passage) => overlapsBlock(passage.range, block)),
    [placed],
  );
  const openPassage = React.useCallback((block: MarkdownSourceRangeAction) => {
    activatePassageThreads(passagesIn(block).map(passage => passage.id), marginRef.current, false);
  }, [passagesIn]);
  const isMarked = React.useCallback((block: MarkdownSourceRangeAction) => passagesIn(block).length > 0, [passagesIn]);
  const { artifactId, markdown, revision } = props;
  const basis = React.useRef({ artifactId, markdown, revision, client, scope });
  basis.current = { artifactId, markdown, revision, client, scope };
  const mounted = React.useRef(false);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const attaching = margin?.attach != null;
  const selectionActions = React.useMemo<readonly MarkdownSelectionAction[] | undefined>(() => !client || !scope ? undefined : [{
    label: t(attaching ? 'artifacts.browser.passage.attachHere' : 'artifacts.browser.passage.comment'),
    onPress: (block, selection) => {
      const publish = (input: Readonly<{ renderedText: string; start: number; end: number }>): boolean => {
        const current = basis.current;
        if (!mounted.current || current.artifactId !== artifactId || current.markdown !== markdown || current.client !== client
          || current.scope?.serverId !== scope.serverId || current.scope.accountId !== scope.accountId
          || current.revision.headerVersion !== revision.headerVersion || current.revision.bodyVersion !== revision.bodyVersion
          || markdown.slice(block.sourceStart, block.sourceStart + block.sourceLength) !== block.markdown
          || !Number.isInteger(input.start) || !Number.isInteger(input.end)) return false;
        const range = mapRenderedSelectionToMarkdownSource({ markdown, rendered: input.renderedText,
          start: input.start, end: input.end, sourceRange: { start: block.sourceStart, end: block.sourceStart + block.sourceLength } });
        if (!range) return false;
        const passage = captureDocPassageV1({ ref: { kind: 'doc', artifactId, serverId: scope.serverId }, revision, source: markdown,
          range });
        const attach = marginRef.current?.attach;
        if (attach) attach.complete(passage);
        else router.push(client.beginPassageComment(passage) as Href);
        return true;
      };
      if (selection && typeof selection.renderedText === 'string'
        && selection.renderedText.slice(selection.start, selection.end) === selection.text
        && publish({ ...selection, renderedText: selection.renderedText })) return;
      props.onRequestNativeSelection?.({ markdown: block.renderMarkdown ?? block.markdown,
        complete: (input) => typeof input.renderedText === 'string'
          && input.renderedText.slice(input.start, input.end) === input.text
          && publish({ ...input, renderedText: input.renderedText }) });
    },
  }], [artifactId, attaching, client, markdown, props.onRequestNativeSelection, revision, router, scope]);
  return (
    <View>
      <ArtifactProseBody
        testID="artifact:body"
        markdown={markdown}
        selectionActions={selectionActions}
        sourceMarkKind="passage"
        findSourceRanges={marks}
        onPressSourceRange={marks ? openPassage : undefined}
        sourceRangePressable={isMarked}
      />
      <ChangedPassageCards margin={margin} />
    </View>
  );
}

/** Text nodes in document order with their offsets in the element's `textContent`. */
function domRangeAt(
  element: HTMLElement,
  start: number,
  end: number,
): Range | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

function WebPassageSelection(
  props: Readonly<{
    artifactId: string;
    markdown: string;
    revision: Revision;
    margin?: ArtifactPassageMargin;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const client = useArtifactActionsClient();
  const scope = useActiveServerAccountScope();
  const container = React.useRef<View>(null);
  // The body as read: one run of the Doc's own Markdown, or runs around each painted suggestion. Each run is
  // its own Markdown at its own source offset, so selections and passages map into the Doc exactly as before.
  const paint = props.margin?.paint ?? null;
  const segments = React.useMemo<readonly DocBodySegment[]>(
    // A plan made for other text (the body moved on under it) is not used: the runs must be this body.
    () => paint && paint.segments.map((segment) => segment.markdown).join('') === props.markdown
      ? paint.segments : [{ kind: 'prose', start: 0, markdown: props.markdown }],
    [paint, props.markdown],
  );
  const segmentViews = React.useRef(new Map<number, View>());
  const segmentsRef = React.useRef(segments);
  segmentsRef.current = segments;
  const [selected, setSelected] = React.useState<Selected | null>(null);
  const [width, setWidth] = React.useState(0);
  // Measure before the first paint: onLayout reports a frame later, which would paint the body at full
  // width once before the comments column takes its place beside it.
  const frame = React.useRef<View>(null);
  React.useLayoutEffect(() => {
    const measured = (frame.current as unknown as HTMLElement | null)?.getBoundingClientRect?.().width;
    if (measured) setWidth(measured);
  }, []);
  const cardViews = React.useRef(new Map<string, View>());
  const [marks, setMarks] = React.useState<
    ReadonlyMap<string, readonly Rect[]>
  >(new Map());
  const [cardHeights, setCardHeights] = React.useState<
    ReadonlyMap<string, number>
  >(new Map());
  const margin = props.margin;
  // A Doc's page takes the wide column (lab K1-A/R): the body keeps a reading measure on the left and
  // the comments column stands beside it whatever its threads' state, so nothing moves when they arrive.
  // Too narrow for both: no margin.
  const wide = margin !== undefined && width >= MARGIN_MIN_FRAME_WIDTH;
  const reportShown = margin?.reportShown;
  React.useEffect(() => {
    reportShown?.(wide);
  }, [reportShown, wide]);
  // A thread chosen from elsewhere (the comment list, a mark) is brought into view beside its passage.
  const focusedId = margin?.focusedId ?? null;
  React.useEffect(() => {
    if (!wide || focusedId === null) return;
    const node = cardViews.current.get(focusedId) as unknown as HTMLElement | undefined;
    node?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [focusedId, wide]);
  const marksRef = React.useRef(marks);
  marksRef.current = marks;
  const marginRef = React.useRef(margin);
  marginRef.current = margin;
  const wideRef = React.useRef(wide);
  wideRef.current = wide;

  React.useEffect(() => {
    const element = container.current as unknown as HTMLElement | null;
    if (!element || typeof document === 'undefined') return;
    const read = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0)
        return setSelected(null);
      const range = selection.getRangeAt(0);
      if (!element.contains(range.commonAncestorContainer))
        return setSelected(null);
      // A selection is read in the run of the Doc it lies in; a painted suggestion is not the Doc's text.
      const run = readSegmentElements(segmentsRef.current, segmentViews.current)
        .find(({ node }) => node.contains(range.commonAncestorContainer));
      if (!run || run.segment.kind !== 'prose') return setSelected(null);
      const before = document.createRange();
      before.selectNodeContents(run.node);
      before.setEnd(range.startContainer, range.startOffset);
      const start = before.toString().length;
      const local = mapRenderedSelectionToMarkdownSource({
        markdown: run.segment.markdown,
        rendered: run.node.textContent ?? '',
        start,
        end: start + range.toString().length,
      });
      if (!local) return setSelected(null);
      const source = { start: local.start + run.segment.start, end: local.end + run.segment.start };
      // The affordance belongs to where the selection starts, not the middle of a multi-line block.
      const box = range.getClientRects()[0] ?? range.getBoundingClientRect();
      const frame = element.getBoundingClientRect();
      const middle = box.left - frame.left + box.width / 2;
      setSelected({
        range: source,
        top: Math.max(0, box.top - frame.top - AFFORDANCE_LIFT),
        left: Math.min(
          Math.max(0, middle - AFFORDANCE_HALF_WIDTH),
          Math.max(0, frame.width - AFFORDANCE_HALF_WIDTH * 2),
        ),
      });
    };
    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, []);

  // Where each placed passage is drawn: the Markdown owner maps its source range to the rendered
  // text, and the browser gives that text's line boxes. Re-measured when the body reflows.
  const passages = margin?.passages;
  React.useEffect(() => {
    const element = container.current as unknown as HTMLElement | null;
    if (!element || typeof document === 'undefined' || !passages?.length) {
      setMarks(new Map());
      return;
    }
    let frameRequest = 0;
    const measure = () => {
      const frame = element.getBoundingClientRect();
      const relative = (rect: DOMRect | Rect): Rect => ({
        top: rect.top - frame.top,
        left: rect.left - frame.left,
        width: rect.width,
        height: rect.height,
      });
      const runs = readSegmentElements(segments, segmentViews.current);
      const next = new Map<string, readonly Rect[]>();
      for (const passage of passages) {
        if (passage.location.state === 'detached') continue;
        const { start, end } = passage.location.range;
        const rects: Rect[] = [];
        for (const { segment, node } of runs) {
          const segmentEnd = segment.start + segment.markdown.length;
          if (end <= segment.start || start >= segmentEnd) continue;
          // A painted suggestion stands for its passage as a whole: its thread aligns with the painted block.
          if (segment.kind === 'suggestion') {
            if (segment.id === passage.id) rects.push(relative(node.getBoundingClientRect()));
            continue;
          }
          const at = mapMarkdownSourceToRenderedRange({
            markdown: segment.markdown,
            rendered: node.textContent ?? '',
            start: Math.max(start, segment.start) - segment.start,
            end: Math.min(end, segmentEnd) - segment.start,
          });
          const range = at ? domRangeAt(node, at.start, at.end) : null;
          if (!range) continue;
          for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) rects.push(relative(rect));
        }
        if (rects.length > 0) next.set(passage.id, rects);
      }
      setMarks(next);
    };
    const schedule = () => {
      cancelAnimationFrame(frameRequest);
      frameRequest = requestAnimationFrame(measure);
    };
    schedule();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(element);
    return () => {
      cancelAnimationFrame(frameRequest);
      observer?.disconnect();
    };
  }, [passages, segments, wide]);

  // A click (not a selection) gathers every hit before the shared thread/list decision.
  React.useEffect(() => {
    const element = container.current as unknown as HTMLElement | null;
    if (!element || typeof document === 'undefined') return;
    const click = (event: MouseEvent) => {
      if (document.getSelection()?.isCollapsed === false) return;
      const frame = element.getBoundingClientRect();
      const x = event.clientX - frame.left;
      const y = event.clientY - frame.top;
      const hits: string[] = [];
      for (const [id, rects] of marksRef.current) {
        // A painted suggestion answers its own press.
        if (marginRef.current?.paint?.painted.has(id)) continue;
        if (
          rects.some(
            (rect) =>
              x >= rect.left &&
              x <= rect.left + rect.width &&
              y >= rect.top &&
              y <= rect.top + rect.height,
          )
        ) {
          hits.push(id);
        }
      }
      activatePassageThreads(hits, marginRef.current, wideRef.current);
    };
    element.addEventListener('click', click);
    return () => element.removeEventListener('click', click);
  }, []);

  const comment = React.useCallback(() => {
    if (!selected || !client || !scope) return;
    const passage = captureDocPassageV1({
      ref: {
        kind: 'doc',
        artifactId: props.artifactId,
        serverId: scope.serverId,
      },
      revision: props.revision,
      source: props.markdown,
      range: selected.range,
    });
    document.getSelection()?.removeAllRanges();
    setSelected(null);
    const attach = marginRef.current?.attach;
    const startComment = wideRef.current ? marginRef.current?.startComment : undefined;
    if (attach) attach.complete(passage);
    // Beside the body the comment opens in the margin, at its passage; without a margin it opens as a page.
    else if (startComment) startComment(passage);
    else router.push(client.beginPassageComment(passage) as Href);
  }, [
    client,
    props.artifactId,
    props.markdown,
    props.revision,
    router,
    scope,
    selected,
  ]);

  // Each thread sits level with its passage, pushed down only as far as the thread above needs;
  // threads whose passage changed follow the placed ones.
  const cards = React.useMemo(() => {
    if (!wide || !margin) return [];
    let floor = 0;
    return margin.passages.map((passage) => {
      const rects = marks.get(passage.id);
      const want = rects?.[0]?.top ?? floor;
      const top = Math.max(want, floor);
      floor = top + (cardHeights.get(passage.id) ?? 0) + theme.space.s12;
      return { id: passage.id, top };
    });
  }, [cardHeights, margin, marks, theme.space.s12, wide]);
  const marginHeight = cards.length
    ? cards.at(-1)!.top + (cardHeights.get(cards.at(-1)!.id) ?? 0)
    : 0;
  const onCardLayout = React.useCallback(
    (id: string, event: LayoutChangeEvent) => {
      const height = Math.ceil(event.nativeEvent.layout.height);
      setCardHeights((previous) =>
        previous.get(id) === height
          ? previous
          : new Map(previous).set(id, height),
      );
    },
    [],
  );

  const placed = margin?.passages ?? [];
  const affordanceLabel = t(
    margin?.attach ? 'artifacts.browser.passage.attachHere' : 'artifacts.browser.passage.comment',
  );
  return (
    <View
      style={wide ? styles.row : null}
      ref={frame}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <View ref={container} testID="artifact:passage-body" style={[styles.frame, wide ? styles.body : null]}>
        {placed.map((passage) => {
          const rects = marks.get(passage.id);
          if (!rects || passage.location.state === 'detached' || segments.some((segment) => segment.kind === 'suggestion' && segment.id === passage.id)) return null;
          const focused = margin?.focusedId === passage.id;
          const revised = passage.location.state === 'revised';
          return rects.map((rect, index) => (
            <View
              key={`${passage.id}:${index}`}
              testID={
                index === 0 ? `artifact:passage-mark:${passage.id}` : undefined
              }
              pointerEvents="none"
              style={[
                styles.mark,
                {
                  top: rect.top,
                  left: rect.left,
                  width: rect.width,
                  height: rect.height,
                },
                revised
                  ? { backgroundColor: theme.colors.diff.added.background }
                  : { borderBottomColor: theme.colors.text.tertiary },
                focused
                  ? {
                      backgroundColor: revised
                        ? theme.colors.diff.added.background
                        : theme.colors.state.active.background,
                      borderBottomColor: theme.colors.state.active.border,
                    }
                  : null,
              ]}
            />
          ));
        })}
        {segments.map((segment, index) => (
          <View
            key={`${segment.kind}:${segment.start}`}
            ref={(view) => {
              if (view) segmentViews.current.set(index, view);
              else segmentViews.current.delete(index);
            }}
          >
            {segment.kind === 'prose' ? (
              <ArtifactProseBody testID={index === 0 ? 'artifact:body' : undefined} markdown={segment.markdown} />
            ) : (
              <PaintedSuggestion
                segment={segment}
                wide={wide}
                onPress={() => activatePassageThreads([segment.id], marginRef.current, wideRef.current)}
              />
            )}
          </View>
        ))}
        {selected && client && scope ? (
          <View
            style={[styles.anchor, { top: selected.top, left: selected.left }]}
          >
            <FloatingOverlay
              scrollEnabled={false}
              surfaceChrome="theme"
            >
              <Pressable
                testID="artifact:passage-comment"
                accessibilityRole="button"
                accessibilityLabel={affordanceLabel}
                // Pressing must not clear the selection before the passage is captured.
                onPressIn={(event) =>
                  (
                    event as unknown as { preventDefault?: () => void }
                  ).preventDefault?.()
                }
                onPress={comment}
                style={({ pressed }) => [
                  styles.action,
                  pressed
                    ? { backgroundColor: theme.colors.surface.pressedOverlay }
                    : null,
                ]}
              >
                <Icon
                  name="chat-circle"
                  size={ICON_SIZE.sm}
                  color={theme.colors.text.secondary}
                />
                <Text variant="label" emphasis="medium">
                  {affordanceLabel}
                </Text>
              </Pressable>
            </FloatingOverlay>
          </View>
        ) : null}
      </View>
      {wide ? null : <ChangedPassageCards margin={margin} />}
      {wide && margin ? (
        <View
          testID="artifact:passage-margin"
          style={[styles.margin, { minHeight: marginHeight }]}
        >
          {cards.length === 0 ? margin.idle : null}
          {cards.map((card) => (
            <View
              key={card.id}
              ref={(view) => {
                if (view) cardViews.current.set(card.id, view);
                else cardViews.current.delete(card.id);
              }}
              style={[styles.card, { top: card.top }]}
              onLayout={(event) => onCardLayout(card.id, event)}
            >
              {margin.renderCard(card.id)}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The elements of the body's runs, in order, paired with the run each one draws. */
function readSegmentElements(segments: readonly DocBodySegment[], views: ReadonlyMap<number, View>) {
  return segments.flatMap((segment, index) => {
    const node = views.get(index) as unknown as HTMLElement | undefined;
    return node ? [{ segment, node }] : [];
  });
}

/**
 * A current suggestion painted where it applies (lab K1-A): its paragraph read as words, the suggested
 * words struck and inserted through the one prose diff owner, a pencil in the gutter. Pressing it shows
 * its thread. Nothing here applies anything; Accept stays on the thread's card.
 */
function PaintedSuggestion(props: Readonly<{
  segment: Extract<DocBodySegment, { kind: 'suggestion' }>;
  /** Beside a margin the pencil hangs in the gutter; without one (a phone) it stays inside the column. */
  wide: boolean;
  onPress: () => void;
}>) {
  const { theme } = useUnistyles();
  const { segment } = props;
  return (
    <Pressable
      testID={`artifact:passage-suggestion:${segment.id}`}
      accessibilityRole="button"
      accessibilityLabel={t('artifacts.browser.proposal.title')}
      onPress={props.onPress}
      style={[styles.suggestion, props.wide ? null : styles.suggestionInset]}
    >
      <View style={[styles.gutter, props.wide ? null : styles.gutterInset]} pointerEvents="none">
        <Icon name="pencil-simple" size={ICON_SIZE.sm} color={theme.colors.text.tertiary} />
      </View>
      <ProseDiffViewer
        mode="text"
        testID={`artifact:passage-suggestion:${segment.id}.diff`}
        oldText={segment.before}
        newText={segment.after}
        prose={{ oldLabel: t('artifacts.browser.proposal.before'), newLabel: t('artifacts.browser.proposal.after'), words: true, inBody: true }}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  suggestion: {
    position: 'relative',
    marginVertical: theme.space.s8,
    borderRadius: theme.borderRadius.sm,
  },
  gutter: {
    position: 'absolute',
    top: theme.space.s4,
    left: -(ICON_SIZE.sm + theme.space.s8),
  },
  suggestionInset: { paddingLeft: ICON_SIZE.sm + theme.space.s8 },
  gutterInset: { left: 0 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s32 },
  changed: { gap: theme.space.s12, marginTop: theme.space.s16 },
  frame: { position: 'relative' },
  body: { flex: 1, minWidth: 0 },
  margin: { width: DOC_PASSAGE_MARGIN_WIDTH, position: 'relative' },
  card: { position: 'absolute', left: 0, right: 0 },
  mark: {
    position: 'absolute',
    borderRadius: theme.borderRadius.sm,
    borderBottomWidth: 1.5,
    borderBottomColor: 'transparent',
  },
  anchor: { position: 'absolute', zIndex: 10 },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    paddingHorizontal: theme.space.s10,
    paddingVertical: theme.space.s6,
    borderRadius: theme.borderRadius.md,
  },
}));
