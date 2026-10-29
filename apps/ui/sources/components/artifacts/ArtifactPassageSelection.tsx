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
import { MarkdownView, type MarkdownRenderedSelection, type MarkdownSelectionAction, type MarkdownSourceRangeAction } from '@/components/markdown/MarkdownView';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Text } from '@/components/ui/text/Text';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { useArtifactActionsClient } from './artifactActionsClient';
import type { DocPassageMarginLocation } from './docPassageMargin';

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
const MARGIN_WIDTH = 288;

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
    return <MarkdownView testID="artifact:body" markdown={props.markdown} />;
  if (Platform.OS !== 'web')
    return <NativePassageSelection key={JSON.stringify([props.artifactId, scope?.serverId, scope?.accountId])}
      {...props} revision={props.revision} scope={scope} />;
  return <WebPassageSelection {...props} revision={props.revision} />;
}

/**
 * Without a margin beside the body (a phone, a narrow pane) a passage that changed after its comment
 * has no place to stand in the text, so its own thread card leads the body: the same card the margin
 * draws, carrying the notice, Open version and Attach to new text. Placed threads open as pages.
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
      <ChangedPassageCards margin={margin} />
      <MarkdownView
        testID="artifact:body"
        markdown={markdown}
        selectionActions={selectionActions}
        sourceMarkKind="passage"
        findSourceRanges={marks}
        onPressSourceRange={marks ? openPassage : undefined}
        sourceRangePressable={isMarked}
      />
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
  const [selected, setSelected] = React.useState<Selected | null>(null);
  const [width, setWidth] = React.useState(0);
  const cardViews = React.useRef(new Map<string, View>());
  const [marks, setMarks] = React.useState<
    ReadonlyMap<string, readonly Rect[]>
  >(new Map());
  const [cardHeights, setCardHeights] = React.useState<
    ReadonlyMap<string, number>
  >(new Map());
  const margin = props.margin;
  // The page widens its column while a Doc has threads (lab K1-A/R): the body keeps a reading measure
  // on the left and the threads take a fixed margin beside it. Too narrow for both: no margin.
  const wide = margin !== undefined && margin.passages.length > 0 && width >= MARGIN_MIN_FRAME_WIDTH;
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
      const before = document.createRange();
      before.selectNodeContents(element);
      before.setEnd(range.startContainer, range.startOffset);
      const start = before.toString().length;
      const source = mapRenderedSelectionToMarkdownSource({
        markdown: props.markdown,
        rendered: element.textContent ?? '',
        start,
        end: start + range.toString().length,
      });
      if (!source) return setSelected(null);
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
  }, [props.markdown]);

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
      const rendered = element.textContent ?? '';
      const frame = element.getBoundingClientRect();
      const next = new Map<string, readonly Rect[]>();
      for (const passage of passages) {
        if (passage.location.state === 'detached') continue;
        const at = mapMarkdownSourceToRenderedRange({
          markdown: props.markdown,
          rendered,
          ...passage.location.range,
        });
        const range = at ? domRangeAt(element, at.start, at.end) : null;
        if (!range) continue;
        next.set(
          passage.id,
          [...range.getClientRects()]
            .filter((rect) => rect.width > 0 && rect.height > 0)
            .map((rect) => ({
              top: rect.top - frame.top,
              left: rect.left - frame.left,
              width: rect.width,
              height: rect.height,
            })),
        );
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
  }, [passages, props.markdown, wide]);

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
    if (attach) attach.complete(passage);
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
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {wide ? null : <ChangedPassageCards margin={margin} />}
      <View ref={container} style={[styles.frame, wide ? styles.body : null]}>
        {placed.map((passage) => {
          const rects = marks.get(passage.id);
          if (!rects || passage.location.state === 'detached') return null;
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
        <MarkdownView testID="artifact:body" markdown={props.markdown} />
        {selected && client && scope ? (
          <View
            style={[styles.anchor, { top: selected.top, left: selected.left }]}
          >
            <FloatingOverlay
              scrollEnabled={false}
              role="menu"
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
      {wide && margin ? (
        <View
          testID="artifact:passage-margin"
          style={[styles.margin, { minHeight: marginHeight }]}
        >
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

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s32 },
  changed: { gap: theme.space.s12, marginBottom: theme.space.s16 },
  frame: { position: 'relative' },
  body: { flex: 1, minWidth: 0 },
  margin: { width: MARGIN_WIDTH, position: 'relative' },
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
