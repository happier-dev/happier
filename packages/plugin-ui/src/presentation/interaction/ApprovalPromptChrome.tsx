import { Children, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';

import { useOptionalHappierUiTypography } from '../../environment/context.js';
import type { HappierUiTypography } from '../../environment/types.js';
import { resolveHappierTextStepStyle } from '../layout/pageText.js';
import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { resolveHappierWorkStatusSurfaceStyle, type HappierWorkStatusColors, type HappierWorkStatusTone } from '../work/workStatus.js';
import { resolveHappierWorkTextStep } from '../work/workTheme.js';
import { HappierApprovalFirstFactContext } from './approvalFirstFact.js';
import { HappierApprovalFactsRevealContext, resolveHappierFactsRevealOffset, type HappierFactsRevealTarget } from './approvalFactsReveal.js';

export type HappierApprovalPromptTextRender = (input: Readonly<{
  role: 'eyebrow' | 'title' | 'subtitle';
  text: string;
  style: HappierStyleProp;
  numberOfLines?: number;
}>) => ReactNode;

export type HappierApprovalPromptChromeProps = Readonly<{
  title: string;
  subtitle?: string | null;
  titleNumberOfLines?: number;
  subtitleNumberOfLines?: number;
  icon?: ReactNode;
  headerAccessory?: ReactNode;
  /**
   * `card` (default): the anatomy Session chat draws. `inline`: a settled prompt with no card. `compact`: where the
   * request has little room (the notch's island, a popover row): a small card with no ring, filled by `surfaceStyle`,
   * with a mark sized by itself and the facts and decision on the head's own edge.
   */
  chrome?: 'card' | 'inline' | 'compact';
  /** The source line above the title ("Bash"): who asks, when the title doesn't already say. */
  eyebrow?: string | null;
  /** `compact`: the host's own fill for the small card (the notch's whisper tint), over the elevated surface default. */
  surfaceStyle?: HappierStyleProp;
  /**
   * `attention` is a request that needs the person: the card wears the shared needs-you ring and tint
   * (`resolveHappierWorkStatusSurfaceStyle`), the same as a Work card that needs you. `danger` is an approved
   * request whose effect failed, in the same ring and tint as a Work card in trouble. Neither grants anything.
   */
  tone?: HappierWorkStatusTone;
  /** Portable form of the incumbent host View's role vocabulary. */
  accessibilityRole?: 'none' | 'button' | 'togglebutton' | 'link' | 'search' | 'image' | 'keyboardkey'
    | 'text' | 'adjustable' | 'imagebutton' | 'header' | 'summary' | 'alert' | 'checkbox' | 'combobox'
    | 'menu' | 'menubar' | 'menuitem' | 'progressbar' | 'radio' | 'radiogroup' | 'scrollbar' | 'spinbutton'
    | 'switch' | 'tab' | 'tabbar' | 'tablist' | 'timer' | 'list' | 'toolbar';
  children?: ReactNode;
  footer?: ReactNode;
  testID?: string;
  /** The adapter's themed approval-card radius. */
  cardRadius: number;
  /**
   * The most height the card may take (a composer attention tray). Bounded, the facts scroll inside the card
   * and the decision stays pinned beneath them, so it is always visible without scrolling.
   */
  maxHeight?: number;
  /**
   * Bounded: the height the card would take unbounded (head, all facts, decision) and the least it can take
   * (head and decision), for a host sharing its room between cards. A card with no decision to pin is never
   * cut (its least is its whole height), so the host scrolls between whole cards.
   */
  onMeasure?: (heights: Readonly<{ natural: number; minimum: number }>) => void;
  /** Host bodies that already carry their own trailing space can keep their established inset. */
  bodyBottomInset?: number;
  /** `status`: the host's Work status colours, which the attention ring and tint are drawn from. */
  colors: Readonly<{ border: string; surface: string; title: string; subtitle: string; status: HappierWorkStatusColors }>;
  /** The host's spacing steps: `medium` insets the card, `small` separates its header, facts and decision. */
  spacing: Readonly<{ small: number; medium: number }>;
  /** The host's type faces; omitted, the mounted environment's (a numeric weight without either). */
  typography?: HappierUiTypography | null;
  renderText?: HappierApprovalPromptTextRender;
  /**
   * Bounded facts that do not fit fade at the edge that hides more (the host's own scroll-edge fade), drawn over
   * the facts, instead of the hard cut a hairline over the decision marks. Omitted, the hairline stays. `fill` is
   * the card's own fill (its tone wash included) so the fade melts into the card in every theme; `null` for an
   * inline or compact prompt, whose fill is its host's. `depth` is how deep the fade reaches: the card's inset,
   * less than a fact line, so it softens the cut line and says "more this way" without washing out a line.
   */
  renderFactsEdgeFade?: (edges: HappierApprovalFactsEdges, fill: string | null, depth: number) => ReactNode;
}>;

export type HappierApprovalFactsEdges = Readonly<{ top: boolean; bottom: boolean }>;

/** Which edges of bounded facts hide more: a few pixels of the body's own inset (`threshold`) never count as hidden. */
export function resolveHappierApprovalFactsEdges(input: Readonly<{
  viewport: number; content: number; offset: number; threshold: number;
}>): HappierApprovalFactsEdges {
  const hidden = input.content - input.viewport;
  if (hidden <= input.threshold) return NO_FACTS_EDGES;
  return { top: input.offset > 1, bottom: input.offset < hidden - 1 };
}

const NO_FACTS_EDGES: HappierApprovalFactsEdges = Object.freeze({ top: false, bottom: false });

// The mark's slot and its gap to the words: with the card inset they set the column the facts and the
// decision start on, so everything under the title lines up with it.
const ICON_SIZE = 18;
const ICON_TEXT_GAP = 6;
// A compact card's own rhythm: its head, facts and decision stand this far apart, and its mark this far from the words.
const COMPACT_PART_GAP = 6;
const COMPACT_MARK_GAP = 8;

const renderDefaultText: HappierApprovalPromptTextRender = (input) => (
  <HappierText style={input.style} numberOfLines={input.numberOfLines}>{input.text}</HappierText>
);

/** One decision-request anatomy. Facts, consent and the decision lifecycle belong to the caller. */
export function HappierApprovalPromptChrome(props: HappierApprovalPromptChromeProps) {
  const renderText = props.renderText ?? renderDefaultText;
  const inline = props.chrome === 'inline';
  const compact = props.chrome === 'compact';
  const hasBody = Children.toArray(props.children).length > 0;
  const environmentTypography = useOptionalHappierUiTypography();
  const typography = props.typography === undefined ? environmentTypography : props.typography;
  const inset = props.spacing.medium;
  const step = props.spacing.small;
  // A card's facts sit on the card inset beside its decision (lab mbAppr), so a full-width band (a diff) is
  // inset the same on both sides; a settled inline prompt keeps them under its title's text column.
  const factsStart = inline ? inset + ICON_SIZE + ICON_TEXT_GAP : inset;
  const hasFooter = Boolean(props.footer);
  const bounded = typeof props.maxHeight === 'number';
  // Only a card with a decision to keep in view scrolls its facts under a bound. A failed or settled card
  // closes from its head, so cutting its facts would only slice a line in half: it keeps its whole height and
  // the room it shares scrolls between whole cards instead.
  const pinned = bounded && Boolean(props.footer);
  // Bounded facts that do not fit show a hairline over the pinned decision: there is more above it.
  const [factsViewport, setFactsViewport] = useState(0);
  const [factsContent, setFactsContent] = useState(0);
  const [factsEdges, setFactsEdges] = useState(NO_FACTS_EDGES);
  // A fold opened inside the facts (Technical details) asks to be seen: the window and offset it is measured
  // against are read when it asks, so they live in refs rather than re-rendering the card on every scroll.
  const factsScrollRef = useRef<ScrollView>(null);
  const factsWindow = useRef({ viewport: 0, content: 0, offset: 0 });
  const publishedFactsEdges = useRef(NO_FACTS_EDGES);
  const renderFade = props.renderFactsEdgeFade;
  const updateFactsEdges = useCallback(() => {
    const next = resolveHappierApprovalFactsEdges({ ...factsWindow.current, threshold: step });
    const current = publishedFactsEdges.current;
    if (current.top === next.top && current.bottom === next.bottom) return;
    publishedFactsEdges.current = next;
    setFactsEdges(next);
  }, [step]);
  useEffect(() => { if (renderFade) updateFactsEdges(); }, [renderFade, updateFactsEdges]);
  // The fade reaches the card's inset into the facts: never a whole fact line (K05, cut 52: a row-deep fade washed
  // out the first and last lines at rest). A revealed body rests clear of it.
  const fadeDepth = inset;
  const revealClearance = renderFade ? fadeDepth : 0;
  const revealFact = useCallback((target: HappierFactsRevealTarget | null) => {
    const scroll = factsScrollRef.current;
    const content = scroll?.getInnerViewNode?.();
    if (!scroll || !content || !target?.measureLayout) return;
    target.measureLayout(content, (_x, top, _width, height) => {
      const next = resolveHappierFactsRevealOffset({ top, height, ...factsWindow.current, clearance: revealClearance });
      if (next !== null) scroll.scrollTo({ y: next, animated: true });
    }, () => {});
  }, [revealClearance]);
  // Only real facts count as hidden; a few pixels of the body's own bottom inset do not.
  const factsClipped = pinned && factsContent - factsViewport > step;
  // With a fade the hidden facts say so themselves; the hairline marks the cut only when there is none.
  const factsRuled = factsClipped && !renderFade;
  // A bounded card never gets shorter than its head and its decision: when the bound is tighter (several
  // requests share a tray), the card keeps both whole and its host scrolls between cards instead.
  const [headHeight, setHeadHeight] = useState(0);
  // The decision's own content is what gets measured: a host reports a layout only when an element's content
  // changes, so measuring the padded, hairlined wrapper would miss the pad and rule the clipped state adds
  // and leave the facts one line short of the room they were counted for.
  const [decisionContent, setDecisionContent] = useState(0);
  const decisionHeight = decisionContent > 0 ? decisionContent + inset + (factsRuled ? step + 1 : 0) : 0;
  // The deciding fact (the facts' first row, as the shared fields table reports it) is never cut: the least the
  // card takes keeps it in view between its head and its decision. Further facts scroll beneath it.
  const [firstFactBottom, setFirstFactBottom] = useState(0);
  const reportFirstFact = useCallback((bottomPx: number) => setFirstFactBottom((current) => current === bottomPx ? current : bottomPx), []);
  const firstFactHeight = firstFactBottom > 0 && factsContent > 0 ? Math.min(firstFactBottom, factsContent) : firstFactBottom;
  const boundedMinHeight = headHeight + firstFactHeight + decisionHeight;
  const onMeasure = props.onMeasure;
  const naturalHeight = bounded && headHeight > 0 ? headHeight + decisionHeight + factsContent : 0;
  useEffect(() => {
    if (naturalHeight > 0) onMeasure?.({ natural: naturalHeight, minimum: pinned ? boundedMinHeight : naturalHeight });
  }, [boundedMinHeight, naturalHeight, onMeasure, pinned]);
  const surface: HappierPortableStyle = compact ? { overflow: 'hidden', borderRadius: props.cardRadius, backgroundColor: props.colors.surface } : {
    borderRadius: inline ? 0 : props.cardRadius,
    borderWidth: inline ? 0 : 1,
    borderColor: inline ? 'transparent' : props.colors.border,
    backgroundColor: inline ? 'transparent' : props.colors.surface,
    overflow: 'hidden',
  };
  // A settled (inline) prompt has no card to tint; only a card asks.
  const bodyStyle: HappierPortableStyle = compact
    ? { paddingHorizontal: inset, paddingBottom: hasFooter ? COMPACT_PART_GAP : step, gap: COMPACT_PART_GAP }
    : { paddingLeft: factsStart, paddingRight: inset, paddingBottom: props.bodyBottomInset ?? step, gap: step };
  // A compact card's fill is the host's; its mark already says it waits on the person.
  const toneSurface = !inline && !compact && props.tone ? resolveHappierWorkStatusSurfaceStyle(props.tone, props.colors.status) : null;
  return (
    <View testID={props.testID} accessibilityRole={props.accessibilityRole}
      style={[surface, toneSurface, compact ? props.surfaceStyle : null, pinned ? { maxHeight: props.maxHeight,
        ...(boundedMinHeight > 0 ? { minHeight: boundedMinHeight } : null) } : null]}>
      <View testID={props.testID ? `${props.testID}-head` : undefined}
        onLayout={bounded ? (event) => setHeadHeight(event.nativeEvent.layout.height) : undefined}
        style={{ flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: compact ? COMPACT_MARK_GAP : ICON_TEXT_GAP,
        paddingHorizontal: inset, paddingTop: compact ? step : inset, paddingBottom: compact ? (hasBody || hasFooter ? COMPACT_PART_GAP : step) : step }}>
        {compact ? props.icon : <View style={{ width: ICON_SIZE, height: ICON_SIZE, alignItems: 'center', justifyContent: 'center' }}>{props.icon}</View>}
        <View style={{ flex: 1, minWidth: 0 }}>
          {props.eyebrow ? renderText({ role: 'eyebrow', text: props.eyebrow, numberOfLines: 1,
            style: { ...resolveHappierTextStepStyle(resolveHappierWorkTextStep('cardWord'), typography), color: props.colors.subtitle } }) : null}
          {/* The Work card's head steps: an approval card and a Work card that needs you read as one family. */}
          {renderText({ role: 'title', text: props.title, numberOfLines: props.titleNumberOfLines,
            style: { ...resolveHappierTextStepStyle(resolveHappierWorkTextStep('cardTitle'), typography), color: props.colors.title } })}
          {props.subtitle ? renderText({ role: 'subtitle', text: props.subtitle, numberOfLines: props.subtitleNumberOfLines,
            style: { ...resolveHappierTextStepStyle(resolveHappierWorkTextStep('cardWord'), typography), color: props.colors.subtitle } }) : null}
        </View>
        {props.headerAccessory}
      </View>
      {!hasBody ? null : pinned ? (
        <View style={{ flexShrink: 1, minHeight: 0 }}>
          <ScrollView testID={props.testID ? `${props.testID}-facts` : undefined} style={{ flexShrink: 1, minHeight: 0 }}
            contentContainerStyle={bodyStyle} nestedScrollEnabled
            // Facts that fit draw no track: a few pixels of inset past the bound are not hidden facts.
            showsVerticalScrollIndicator={factsClipped}
            scrollEventThrottle={renderFade ? 16 : undefined}
            ref={factsScrollRef}
            onScroll={(event) => {
              factsWindow.current.offset = event.nativeEvent.contentOffset.y;
              if (renderFade) updateFactsEdges();
            }}
            onLayout={(event) => {
              factsWindow.current.viewport = event.nativeEvent.layout.height;
              setFactsViewport(event.nativeEvent.layout.height);
              if (renderFade) updateFactsEdges();
            }}
            onContentSizeChange={(_width, height) => {
              factsWindow.current.content = height;
              setFactsContent(height);
              if (renderFade) updateFactsEdges();
            }}>
            <HappierApprovalFirstFactContext.Provider value={reportFirstFact}>
              <HappierApprovalFactsRevealContext.Provider value={revealFact}>{props.children}</HappierApprovalFactsRevealContext.Provider>
            </HappierApprovalFirstFactContext.Provider>
          </ScrollView>
          {renderFade ? renderFade(factsClipped ? factsEdges : NO_FACTS_EDGES,
            inline || compact ? null : toneSurface?.backgroundColor ?? props.colors.surface, fadeDepth) : null}
        </View>
      ) : <View style={bodyStyle} onLayout={bounded ? (event) => setFactsContent(event.nativeEvent.layout.height) : undefined}>{props.children}</View>}
      {/* A card's decisions span it from its edge (lab mb B): a phone's stacked choices are full width. An inline
          prompt's decisions start on its facts' column under the title, so the two read as one column. */}
      {props.footer ? <View style={{ flexShrink: 0, paddingLeft: inline ? factsStart : inset, paddingRight: inset, paddingBottom: compact ? step : inset,
        ...(factsRuled ? { borderTopWidth: 1, borderTopColor: props.colors.border, paddingTop: step } : null) }}>
        <View testID={props.testID ? `${props.testID}-decision` : undefined}
          onLayout={bounded ? (event) => setDecisionContent(event.nativeEvent.layout.height) : undefined}>{props.footer}</View>
      </View> : null}
    </View>
  );
}
