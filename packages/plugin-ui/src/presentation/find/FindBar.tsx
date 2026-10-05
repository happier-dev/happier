import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode, type Ref } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { useHappierNativeMinimumInteractiveTargetSize } from '../../environment/interactiveTarget.js';
import { HappierSearchFieldBox } from '../form/FieldBox.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { HAPPIER_MOTION_V1 } from '../interaction/motion.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../interaction/pressFeedback.js';
import type { HappierFocusable, HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';
import type { FindCapabilities, FindOptions, FindStatus } from './findTypes.js';

/**
 * The ONE Find bar (plan §4.2, Find lab `ffind`): what every in-surface Find draws — chat, terminal,
 * review/diff and the file viewer. It owns chrome only: the field, the count slot that speaks the
 * status, ↑ ↓, the Aa and `.*` toggles, ✕ (or Done), and the one quiet note under the bar (searching
 * older with Stop, offline, the terminal's kept scrollback). It owns no matching, no corpus, no reveal
 * and no keyboard shortcuts beyond its own field (↵ / ⇧↵ / Esc): the surface's Find model owns those and
 * hands the bar a status.
 *
 * Two presentations of the same contract:
 * - `inline`: the capsule floating at the top-right of the surface it searches (desktop, web, tablet).
 * - `keyboardSeated`: the phone bar seated above the keyboard (iOS find-in-page anatomy): ↑ ↓, the field
 *   with its count, Done. The surface places it; the bar never measures the keyboard.
 *
 * The bar keeps its size in every state: only the count slot speaks, and the content beneath never
 * moves because of it.
 */

export type HappierFindBarGlyph = 'search' | 'previous' | 'next' | 'close' | 'history' | 'offline' | 'info';

/** What the embedding runtime supplies, so the bar keeps its typography, glyph set and spinner. */
export type HappierFindBarHost = Readonly<{
  Text: ComponentType<Readonly<{
    /** A string, or a string followed by a nested host `Text` (the count's quieter qualifier runs inline). */
    children: ReactNode;
    style: HappierPortableStyle;
    numberOfLines?: number;
    testID?: string;
    /** Tabular figures, so a changing count does not jitter. */
    tabularNumbers?: boolean;
    /** The runtime's monospace face (the `Aa` and `.*` toggles read as code). */
    mono?: boolean;
  }>>;
  /** The runtime's single-line text input (it owns font scaling and the platform caret). */
  TextInput: ComponentType<HappierFindBarInputProps>;
  renderGlyph: (glyph: HappierFindBarGlyph, color: string, size: number) => ReactNode;
  /** The runtime's activity spinner (it owns reduced motion and the spinner style). */
  renderSpinner: (color: string, size: number) => ReactNode;
}>;

export type HappierFindBarKeyEvent = Readonly<{
  key?: string;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  nativeEvent?: Readonly<{ key?: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }>;
  preventDefault?: () => void;
}>;

export type HappierFindBarInputProps = Readonly<{
  ref?: Ref<HappierFocusable>;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  placeholderTextColor: string;
  /** Caret and selection tint (the lab's accent caret). */
  selectionColor: string;
  accessibilityLabel: string;
  onKeyPress: (event: HappierFindBarKeyEvent) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Native return key; the web handles ↵ in `onKeyPress` so a composition never steps. */
  onSubmitEditing?: () => void;
  /** Keep the keyboard up when ↵ steps (native). */
  submitBehavior: 'submit';
  /** RNW uses the legacy trait to keep focus when a Return binding passes. */
  blurOnSubmit?: false;
  returnKeyType: 'search';
  autoFocus: boolean;
  selectTextOnFocus: boolean;
  autoCapitalize: 'none';
  autoCorrect: false;
  spellCheck: false;
  testID?: string;
  style: HappierPortableStyle;
}>;

export type HappierFindBarColors = Readonly<{
  /** The capsule (inline) or the seated bar's fill. */
  surface: string;
  /** The capsule's hairline ring and the seated bar's top edge. */
  ring: string;
  /** The seated bar's field well. */
  field: string;
  text: string;
  secondaryText: string;
  tertiaryText: string;
  divider: string;
  /** Toggle-on ink, Done, the seated arrows, Stop. */
  accent: string;
  /** Toggle-on fill. */
  accentFill: string;
  danger: string;
  hover: string;
  pressed: string;
  focus: string;
}>;

/** Every word the bar shows or speaks, translated by the host. */
export type HappierFindBarLabels = Readonly<{
  /** The field's placeholder and accessible name, naming the surface: "Find in chat". */
  field: string;
  previous: string;
  next: string;
  matchCase: string;
  regex: string;
  /** The regex switch's printed name where it is a pill (the phone's options row). */
  regexShort: string;
  /** The phone's options disclosure ("Match options"). */
  options: string;
  close: string;
  /** The seated bar's dismiss, printed. */
  done: string;
  stop: string;
  /** Searched everything there is, nothing found. */
  noMatches: string;
  /** Nothing found in what was searched, and that is not everything (loaded, kept, readable). */
  noneFound: string;
  invalidPattern: string;
  offline: string;
  unsupported: string;
  /** "3 of 8" with a current match, "8 matches" without one. */
  count: (current: number | null, total: number) => string;
  /** "3 files". */
  files: (files: number) => string;
  soFar: string;
  loaded: string;
}>;

/** The one quiet line under the bar; the surface owns its words (page progress, kept lines). */
export type HappierFindBarNote = Readonly<{
  icon: 'history' | 'offline' | 'info';
  text: string;
  /** The note's one way forward ("Search older messages"); Stop takes its place while searching. */
  action?: Readonly<{ label: string; onPress: () => void; testID?: string }>;
}>;

export type HappierFindBarProps = Readonly<{
  query: string;
  options: FindOptions;
  status: FindStatus;
  capabilities: FindCapabilities;
  onQueryChange: (query: string) => void;
  onOptionsChange: (options: FindOptions) => void;
  onStep: (direction: 1 | -1) => void;
  onStop: () => void;
  onClose: () => void;
  /** The surface tracks actual field focus for hardware keyboard ownership. */
  onInputFocus?: () => void;
  onInputBlur?: () => void;
  /** A host keyboard owner may replace field shortcuts without replacing button intents. */
  keyboardHandlers?: Readonly<{
    onKeyPress: (event: HappierFindBarKeyEvent) => void;
    onSubmitEditing: () => void;
  }>;
  presentation: 'inline' | 'keyboardSeated';
  labels: HappierFindBarLabels;
  note?: HappierFindBarNote | null;
  colors: HappierFindBarColors;
  /** The capsule's cast shadow, from the runtime's elevation owner. */
  elevation?: HappierPortableStyle;
  host: HappierFindBarHost;
  /** The runtime's touch-target floor where a finger is the pointer (44/48); pointer platforms omit it. */
  minimumTargetSize?: number;
  reducedMotion?: boolean;
  /** Focus the field on mount (default true). The surface refocuses it through `inputRef`. */
  autoFocus?: boolean;
  inputRef?: Ref<HappierFocusable>;
  testID?: string;
  style?: HappierStyleProp;
}>;

/** The capsule's measures (Find lab `.fd-bar`). */
export const HAPPIER_FIND_BAR_METRICS = Object.freeze({
  inline: Object.freeze({
    heightPx: 36,
    radiusPx: 10,
    paddingRightPx: 4,
    fieldWidthPx: 176,
    /** In a narrow pane only the field shrinks (to here); the count and controls keep their size. */
    fieldMinWidthPx: 64,
    /** The compact capsule's field floor: still a few characters of query beside the caret. */
    compactFieldMinWidthPx: 40,
    buttonPx: 28,
    buttonRadiusPx: 7,
    glyphPx: 15,
    countMinWidthPx: 54,
    gapPx: 2,
    fontSizePx: 13,
    countFontSizePx: 12,
    toggleFontSizePx: 11.5,
    noteGapPx: 6,
    /** Wide enough that the searching note and its Stop read as one line (Find lab `.fd-barnote`). */
    noteMaxWidthPx: 440,
    /**
     * Everything at its smallest: inset, glyph, the shrunken field, count, two dividers, five buttons. A
     * span narrower than this (a split terminal leaf, a slim review pane) draws the compact capsule: no
     * leading glyph or dividers, a tighter count and a narrower field floor, so it fits a ~265 px span.
     */
    compactBelowPx: 326,
  }),
  keyboardSeated: Object.freeze({
    paddingVerticalPx: 6,
    paddingHorizontalPx: 8,
    fieldHeightPx: 36,
    fieldRadiusPx: 10,
    buttonPx: 40,
    glyphPx: 20,
    /** The options disclosure inside the field, beside the count. */
    optionsButtonPx: 28,
    /** The options row (Find lab `.fd-popt`): 30 px pills with 6 px above and below. */
    optionRowHeightPx: 42,
    optionPillHeightPx: 30,
    gapPx: 4,
    fontSizePx: 15,
    countFontSizePx: 13,
  }),
  dividerHeightPx: 16,
  spinnerPx: 12,
  enterOffsetPx: 4,
});

type CountSlot = Readonly<{
  text: string;
  sub: string | null;
  tone: 'secondary' | 'tertiary' | 'danger';
  busy: boolean;
}>;

/**
 * What the count slot says for a status. Never "No matches" unless everything was searched: a loaded
 * window, the terminal's kept scrollback, unreadable pages and a search still running say what they
 * found so far, and the note under the bar says why that is not everything.
 */
export function resolveHappierFindBarCount(status: FindStatus, labels: HappierFindBarLabels): CountSlot | null {
  switch (status.kind) {
    case 'idle':
      return null;
    case 'invalidPattern':
      return { text: labels.invalidPattern, sub: null, tone: 'danger', busy: false };
    case 'unavailable':
      return { text: status.reason === 'offline' ? labels.offline : labels.unsupported, sub: null, tone: 'tertiary', busy: false };
    case 'searching':
      return {
        text: labels.count(status.current ?? null, status.total),
        sub: labels.soFar,
        tone: 'secondary',
        busy: true,
      };
    case 'results': {
      if (status.total === 0) {
        return status.coverage === 'complete'
          ? { text: labels.noMatches, sub: null, tone: 'danger', busy: false }
          : { text: labels.noneFound, sub: null, tone: 'secondary', busy: false };
      }
      const parts: string[] = [];
      if (typeof status.files === 'number' && status.files > 1) parts.push(`· ${labels.files(status.files)}`);
      if (status.coverage === 'loaded' || status.coverage === 'olderRemaining') parts.push(labels.loaded);
      return {
        text: labels.count(status.current, status.total),
        sub: parts.length > 0 ? parts.join(' ') : null,
        tone: 'secondary',
        busy: false,
      };
    }
  }
}

function canStep(status: FindStatus): boolean {
  return (status.kind === 'results' || status.kind === 'searching') && status.total > 0;
}

/** An IME composition owns ↵ and Esc until it commits; RNW reports it on the DOM event. */
function isComposing(event: HappierFindBarKeyEvent): boolean {
  return event.nativeEvent?.isComposing === true || event.nativeEvent?.keyCode === 229;
}

export function HappierFindBar(props: HappierFindBarProps) {
  const seated = props.presentation === 'keyboardSeated';
  const nativeFloor = useHappierNativeMinimumInteractiveTargetSize();
  const targetFloor = Math.max(props.minimumTargetSize ?? 0, nativeFloor ?? 0);
  const { colors, labels, host } = props;
  const count = resolveHappierFindBarCount(props.status, labels);
  const stepEnabled = canStep(props.status);
  const searching = props.status.kind === 'searching';
  const showStop = searching && props.capabilities.stop;
  // The phone's match options stay folded until asked for.
  const [optionsOpen, setOptionsOpen] = useState(false);
  // The inline span the surface gives the bar (it spans the pane, so the capsule can right-align and shrink).
  const [compact, setCompact] = useState(false);
  const onSpanLayout = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width < HAPPIER_FIND_BAR_METRICS.inline.compactBelowPx;
    setCompact((previous) => (previous === next ? previous : next));
  }, []);

  // The bar arrives rather than appearing: a short settle on the motion scale, none under reduced motion.
  const arrival = useRef(new Animated.Value(props.reducedMotion ? 1 : 0)).current;
  useEffect(() => {
    if (props.reducedMotion) {
      arrival.setValue(1);
      return;
    }
    const animation = Animated.timing(arrival, {
      toValue: 1,
      duration: HAPPIER_MOTION_V1.fastMs,
      easing: Easing.bezier(...HAPPIER_MOTION_V1.standardBezier),
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start();
    return () => animation.stop();
    // Arrival plays once per mount; a reduced-motion change mid-flight snaps it.
  }, [arrival, props.reducedMotion]);

  // iOS has no polite live region; the count is announced when it changes. Android and the web use
  // the slot's live region below.
  const spoken = count ? [count.text, count.sub].filter(Boolean).join(' ') : '';
  const lastSpokenRef = useRef(spoken);
  useEffect(() => {
    if (Platform.OS !== 'ios' || spoken === lastSpokenRef.current) return;
    lastSpokenRef.current = spoken;
    if (spoken) AccessibilityInfo.announceForAccessibility(spoken);
  }, [spoken]);

  const onKeyPress = (event: HappierFindBarKeyEvent) => {
    if (event.defaultPrevented || isComposing(event)) return;
    if (props.keyboardHandlers) {
      props.keyboardHandlers.onKeyPress(event);
      return;
    }
    const key = event.nativeEvent?.key ?? event.key;
    if (key === 'Enter') {
      // Native Return also produces submitEditing. That committed event owns stepping.
      if (Platform.OS !== 'web') return;
      event.preventDefault?.();
      if (props.query.length === 0) return;
      props.onStep(event.shiftKey ?? event.nativeEvent?.shiftKey ? -1 : 1);
      return;
    }
    if (key === 'Escape') {
      event.preventDefault?.();
      props.onClose();
    }
  };

  // The field box focuses the input on a press anywhere in it; the surface may hold the same input.
  const inputNodeRef = useRef<HappierFocusable | null>(null);
  const externalInputRef = props.inputRef;
  const setInputNode = useCallback((node: HappierFocusable | null) => {
    inputNodeRef.current = node;
    if (typeof externalInputRef === 'function') externalInputRef(node);
    else if (externalInputRef && typeof externalInputRef === 'object') (externalInputRef as { current: HappierFocusable | null }).current = node;
  }, [externalInputRef]);
  const focusInput = useCallback(() => inputNodeRef.current?.focus(), []);

  const metrics = seated ? HAPPIER_FIND_BAR_METRICS.keyboardSeated : HAPPIER_FIND_BAR_METRICS.inline;
  const input = (
    <host.TextInput
      ref={setInputNode}
      value={props.query}
      onChangeText={props.onQueryChange}
      placeholder={labels.field}
      placeholderTextColor={colors.tertiaryText}
      selectionColor={colors.accent}
      accessibilityLabel={labels.field}
      onKeyPress={onKeyPress}
      onFocus={props.onInputFocus}
      onBlur={props.onInputBlur}
      {...(Platform.OS === 'web' ? {} : { onSubmitEditing: () => {
        if (props.keyboardHandlers) props.keyboardHandlers.onSubmitEditing();
        else if (props.query.length > 0) props.onStep(1);
      } })}
      submitBehavior="submit"
      blurOnSubmit={false}
      returnKeyType="search"
      autoFocus={props.autoFocus ?? true}
      selectTextOnFocus
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      testID={props.testID ? `${props.testID}.input` : undefined}
      style={{ flex: 1, minWidth: 0, padding: 0, margin: 0, fontSize: metrics.fontSizePx, color: colors.text }}
    />
  );

  const countFontSize = seated ? HAPPIER_FIND_BAR_METRICS.keyboardSeated.countFontSizePx : HAPPIER_FIND_BAR_METRICS.inline.countFontSizePx;
  const countSlot = (
    <View
      testID={props.testID ? `${props.testID}.status` : undefined}
      accessibilityLiveRegion="polite"
      aria-live="polite"
      style={seated ? styles.seatedCount : [styles.inlineCount, compact ? styles.inlineCountCompact : { minWidth: HAPPIER_FIND_BAR_METRICS.inline.countMinWidthPx }]}
    >
      {count?.busy ? <View style={styles.spinner}>{host.renderSpinner(colors.secondaryText, HAPPIER_FIND_BAR_METRICS.spinnerPx)}</View> : null}
      {count ? (
        <host.Text
          numberOfLines={1}
          tabularNumbers
          style={{
            fontSize: countFontSize,
            color: count.tone === 'danger' ? colors.danger : seated || count.tone === 'tertiary' ? colors.tertiaryText : colors.secondaryText,
          }}
        >
          {count.text}
          {/* The qualifier ("so far", "· 3 files", "loaded") runs inline, quieter than the count it qualifies. */}
          {count.sub ? <host.Text tabularNumbers style={{ color: colors.tertiaryText }}>{` ${count.sub}`}</host.Text> : null}
        </host.Text>
      ) : null}
    </View>
  );

  const noteLink = showStop
    ? { label: labels.stop, onPress: props.onStop, testID: props.testID ? `${props.testID}.stop` : undefined }
    : props.note?.action ?? null;
  const note = props.note || showStop ? (
    <FindBarNote
      note={props.note ?? null}
      link={noteLink}
      colors={colors}
      host={host}
      seated={seated}
      elevation={props.elevation}
      testID={props.testID}
    />
  ) : null;

  // Esc from a bar button (the field handles its own, composition-aware): the bar is one dismissable
  // object on the web, where focus can rest on ↑ ↓ or a toggle.
  const barKeyHandlers = Platform.OS === 'web' ? {
    onKeyDown: (event: Readonly<{ key?: string; defaultPrevented?: boolean; nativeEvent?: Readonly<{ isComposing?: boolean }>; preventDefault?: () => void }>) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent?.isComposing) return;
      if (props.keyboardHandlers) {
        props.keyboardHandlers.onKeyPress(event);
        return;
      }
      event.preventDefault?.();
      props.onClose();
    },
  } : {};

  const arrivalStyle = {
    opacity: arrival,
    transform: [{ translateY: arrival.interpolate({ inputRange: [0, 1], outputRange: [seated ? HAPPIER_FIND_BAR_METRICS.enterOffsetPx : -HAPPIER_FIND_BAR_METRICS.enterOffsetPx, 0] }) }],
  };

  if (seated) {
    const seatedMetrics = HAPPIER_FIND_BAR_METRICS.keyboardSeated;
    const button = Math.max(seatedMetrics.buttonPx, targetFloor);
    const optionsActive = props.options.matchCase || (props.capabilities.regex && props.options.regex);
    return (
      <Animated.View
        accessibilityRole="search"
        aria-label={labels.field}
        testID={props.testID}
        {...barKeyHandlers}
        style={[{ alignSelf: 'stretch' }, arrivalStyle, props.style] as HappierStyleProp}
      >
        {note}
        {optionsOpen ? (
          // Find lab `.fd-popt`: the options as pills on their own quiet row above the bar.
          <View style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            columnGap: 8,
            paddingHorizontal: 12,
            backgroundColor: colors.surface,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.ring,
          }}>
            <FindBarOptionPill glyph="Aa" text={labels.matchCase} label={labels.matchCase} on={props.options.matchCase} minHeight={Math.max(seatedMetrics.optionRowHeightPx, targetFloor)} colors={colors} host={host}
              onPress={() => props.onOptionsChange({ ...props.options, matchCase: !props.options.matchCase })} testID={props.testID ? `${props.testID}.matchCase` : undefined} />
            {props.capabilities.regex ? (
              <FindBarOptionPill glyph=".*" text={labels.regexShort} label={labels.regex} on={props.options.regex} minHeight={Math.max(seatedMetrics.optionRowHeightPx, targetFloor)} colors={colors} host={host}
                onPress={() => props.onOptionsChange({ ...props.options, regex: !props.options.regex })} testID={props.testID ? `${props.testID}.regex` : undefined} />
            ) : null}
          </View>
        ) : null}
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: seatedMetrics.gapPx,
          paddingVertical: seatedMetrics.paddingVerticalPx,
          paddingHorizontal: seatedMetrics.paddingHorizontalPx,
          backgroundColor: colors.surface,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.ring,
        }}>
          <FindBarGlyphButton glyph="previous" label={labels.previous} size={button} glyphSize={seatedMetrics.glyphPx} color={colors.accent} disabled={!stepEnabled} onPress={() => props.onStep(-1)} colors={colors} host={host} radius={button / 2} testID={props.testID ? `${props.testID}.previous` : undefined} />
          <FindBarGlyphButton glyph="next" label={labels.next} size={button} glyphSize={seatedMetrics.glyphPx} color={colors.accent} disabled={!stepEnabled} onPress={() => props.onStep(1)} colors={colors} host={host} radius={button / 2} testID={props.testID ? `${props.testID}.next` : undefined} />
          <HappierSearchFieldBox
            testID={props.testID}
            colors={{ backgroundColor: colors.field, borderColor: 'transparent' }}
            radius={seatedMetrics.fieldRadiusPx}
            minimumTargetSize={Math.max(seatedMetrics.fieldHeightPx, targetFloor)}
            onFocusInput={focusInput}
            leading={host.renderGlyph('search', colors.tertiaryText, HAPPIER_FIND_BAR_METRICS.inline.glyphPx)}
            trailing={(
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {countSlot}
                {/* One quiet disclosure for the match options; tinted while any option is on. */}
                <HappierPressable
                  accessibilityRole="button"
                  accessibilityLabel={labels.options}
                  expanded={optionsOpen}
                  onPress={() => setOptionsOpen((open) => !open)}
                  testID={props.testID ? `${props.testID}.options` : undefined}
                  style={(state) => [buttonStyle({ size: seatedMetrics.optionsButtonPx, radius: 7, colors, on: optionsActive }, state), { marginLeft: 6 }]}
                >
                  {(state) => (
                    <>
                      <host.Text numberOfLines={1} mono style={{ fontSize: HAPPIER_FIND_BAR_METRICS.inline.toggleFontSizePx, fontWeight: '600', color: optionsActive ? colors.accent : colors.tertiaryText }}>Aa</host.Text>
                      <FocusRing visible={state.focused} color={colors.focus} radius={7} />
                    </>
                  )}
                </HappierPressable>
              </View>
            )}
            style={{ flex: 1, minWidth: 0, borderWidth: 0 }}
          >
            {input}
          </HappierSearchFieldBox>
          <HappierPressable
            accessibilityLabel={labels.close}
            onPress={props.onClose}
            testID={props.testID ? `${props.testID}.close` : undefined}
            style={({ pressed }) => ({
              minHeight: Math.max(button, targetFloor),
              paddingLeft: 2.5,
              paddingRight: 4.5,
              justifyContent: 'center',
              opacity: pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1,
            })}
          >
            {(state) => (
              <View style={[styles.doneLabel, state.focused ? { borderColor: colors.focus } : null]}>
                <host.Text numberOfLines={1} style={{ fontSize: seatedMetrics.fontSizePx, fontWeight: '600', color: colors.accent }}>{labels.done}</host.Text>
              </View>
            )}
          </HappierPressable>
        </View>
      </Animated.View>
    );
  }

  const inline = HAPPIER_FIND_BAR_METRICS.inline;
  const button = Math.max(inline.buttonPx, targetFloor);
  const barHeight = Math.max(inline.heightPx, button + 8);
  const glyphButton = (glyph: 'previous' | 'next', direction: 1 | -1, label: string) => (
    <FindBarGlyphButton glyph={glyph} label={label} size={button} glyphSize={inline.glyphPx} color={colors.secondaryText} disabled={!stepEnabled} onPress={() => props.onStep(direction)} colors={colors} host={host} radius={inline.buttonRadiusPx} testID={props.testID ? `${props.testID}.${glyph}` : undefined} />
  );
  return (
    <Animated.View
      accessibilityRole="search"
      aria-label={labels.field}
      testID={props.testID}
      {...barKeyHandlers}
      // A surface may span the bar across its width (left and right insets) so it can shrink in a narrow
      // pane; the empty span stays click-through to the content beneath.
      pointerEvents="box-none"
      onLayout={onSpanLayout}
      style={[{ alignItems: 'flex-end', gap: inline.noteGapPx }, arrivalStyle, props.style] as HappierStyleProp}
    >
      <HappierSearchFieldBox
        colors={{ backgroundColor: colors.surface, borderColor: colors.ring }}
        radius={inline.radiusPx}
        minimumTargetSize={barHeight}
        onFocusInput={focusInput}
        leading={compact ? undefined : host.renderGlyph('search', colors.tertiaryText, inline.glyphPx)}
        trailing={(
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: inline.gapPx }}>
            {countSlot}
            {compact ? null : <Divider color={colors.divider} />}
            {glyphButton('previous', -1, labels.previous)}
            {glyphButton('next', 1, labels.next)}
            {compact ? null : <Divider color={colors.divider} />}
            <FindBarToggle text="Aa" label={labels.matchCase} on={props.options.matchCase} size={button} colors={colors} host={host} onPress={() => props.onOptionsChange({ ...props.options, matchCase: !props.options.matchCase })} testID={props.testID ? `${props.testID}.matchCase` : undefined} />
            {props.capabilities.regex ? (
              <FindBarToggle text=".*" label={labels.regex} on={props.options.regex} size={button} colors={colors} host={host} onPress={() => props.onOptionsChange({ ...props.options, regex: !props.options.regex })} testID={props.testID ? `${props.testID}.regex` : undefined} />
            ) : null}
            <FindBarGlyphButton glyph="close" label={labels.close} size={button} glyphSize={inline.glyphPx} color={colors.secondaryText} onPress={props.onClose} colors={colors} host={host} radius={inline.buttonRadiusPx} testID={props.testID ? `${props.testID}.close` : undefined} />
          </View>
        )}
        // A narrow pane shrinks the field first; the count and controls never clip.
        style={[{ paddingRight: inline.paddingRightPx, borderWidth: StyleSheet.hairlineWidth, maxWidth: '100%' }, props.elevation ?? null] as HappierStyleProp}
      >
        <View style={{ width: inline.fieldWidthPx, flexShrink: 1, minWidth: compact ? inline.compactFieldMinWidthPx : inline.fieldMinWidthPx, flexDirection: 'row', alignItems: 'center' }}>{input}</View>
      </HappierSearchFieldBox>
      {note}
    </Animated.View>
  );
}

function Divider({ color }: Readonly<{ color: string }>) {
  return <View style={{ width: 1, height: HAPPIER_FIND_BAR_METRICS.dividerHeightPx, marginHorizontal: 3, backgroundColor: color }} />;
}

type ButtonChromeInput = Readonly<{ size: number; radius: number; colors: HappierFindBarColors; disabled?: boolean; on?: boolean }>;

function buttonStyle(input: ButtonChromeInput, state: Readonly<{ pressed: boolean; hovered: boolean }>): HappierPortableStyle {
  return {
    width: input.size,
    height: input.size,
    borderRadius: input.radius,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: state.pressed && !input.disabled ? input.colors.pressed
      : state.hovered && !input.disabled ? input.colors.hover
        : input.on ? input.colors.accentFill
          : 'transparent',
    opacity: input.disabled ? 0.35 : 1,
  };
}

/** The keyboard focus ring: drawn over the button so it never shifts its content. */
function FocusRing({ visible, color, radius }: Readonly<{ visible: boolean; color: string; radius: number }>) {
  if (!visible) return null;
  return <View pointerEvents="none" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: radius, borderWidth: 1.5, borderColor: color }} />;
}

function FindBarGlyphButton(props: Readonly<{
  glyph: HappierFindBarGlyph;
  label: string;
  size: number;
  glyphSize: number;
  radius: number;
  color: string;
  disabled?: boolean;
  colors: HappierFindBarColors;
  host: HappierFindBarHost;
  onPress: () => void;
  testID?: string;
}>) {
  return (
    <HappierPressable
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      testID={props.testID}
      style={(state) => buttonStyle({ size: props.size, radius: props.radius, colors: props.colors, disabled: props.disabled }, state)}
    >
      {(state) => (
        <>
          {props.host.renderGlyph(props.glyph, props.color, props.glyphSize)}
          <FocusRing visible={state.focused} color={props.colors.focus} radius={props.radius} />
        </>
      )}
    </HappierPressable>
  );
}

function FindBarToggle(props: Readonly<{
  text: string;
  label: string;
  on: boolean;
  size: number;
  colors: HappierFindBarColors;
  host: HappierFindBarHost;
  onPress: () => void;
  testID?: string;
}>) {
  const radius = HAPPIER_FIND_BAR_METRICS.inline.buttonRadiusPx;
  return (
    <HappierPressable
      accessibilityRole="switch"
      accessibilityLabel={props.label}
      checked={props.on}
      onPress={props.onPress}
      testID={props.testID}
      style={(state) => buttonStyle({ size: props.size, radius, colors: props.colors, on: props.on }, state)}
    >
      {(state) => (
        <>
          <props.host.Text
            numberOfLines={1}
            mono
            style={{
              fontSize: HAPPIER_FIND_BAR_METRICS.inline.toggleFontSizePx,
              fontWeight: '600',
              color: props.on ? props.colors.accent : props.colors.secondaryText,
            }}
          >{props.text}</props.host.Text>
          <FocusRing visible={state.focused} color={props.colors.focus} radius={radius} />
        </>
      )}
    </HappierPressable>
  );
}

/** A phone option pill (Find lab `.fd-popt span`): the glyph and its name, a switch within the touch floor. */
function FindBarOptionPill(props: Readonly<{
  glyph: string;
  text: string;
  label: string;
  on: boolean;
  minHeight: number;
  colors: HappierFindBarColors;
  host: HappierFindBarHost;
  onPress: () => void;
  testID?: string;
}>) {
  const { colors, host } = props;
  const pill = HAPPIER_FIND_BAR_METRICS.keyboardSeated.optionPillHeightPx;
  return (
    <HappierPressable
      accessibilityRole="switch"
      accessibilityLabel={props.label}
      checked={props.on}
      onPress={props.onPress}
      testID={props.testID}
      style={{ minHeight: props.minHeight, justifyContent: 'center', flexShrink: 1 }}
    >
      {(state) => (
        <View style={{
          height: pill,
          borderRadius: pill / 2,
          paddingHorizontal: 11,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
          backgroundColor: props.on ? colors.accentFill : colors.field,
        }}>
          <host.Text numberOfLines={1} mono style={{ fontSize: HAPPIER_FIND_BAR_METRICS.inline.toggleFontSizePx, fontWeight: '600', color: props.on ? colors.accent : colors.secondaryText }}>{props.glyph}</host.Text>
          <host.Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, color: props.on ? colors.accent : colors.secondaryText }}>{props.text}</host.Text>
          <FocusRing visible={state.focused} color={colors.focus} radius={pill / 2} />
        </View>
      )}
    </HappierPressable>
  );
}

function FindBarNote(props: Readonly<{
  note: HappierFindBarNote | null;
  link: Readonly<{ label: string; onPress: () => void; testID?: string }> | null;
  colors: HappierFindBarColors;
  host: HappierFindBarHost;
  seated: boolean;
  elevation?: HappierPortableStyle;
  testID?: string;
}>) {
  const { colors, host } = props;
  const icon = props.note?.icon ?? 'history';
  return (
    <View
      testID={props.testID ? `${props.testID}.note` : undefined}
      style={props.seated ? {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: colors.surface,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.ring,
      } : {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 7,
        maxWidth: HAPPIER_FIND_BAR_METRICS.inline.noteMaxWidthPx,
        paddingVertical: 7,
        paddingHorizontal: 10,
        borderRadius: 9,
        backgroundColor: colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.ring,
        ...props.elevation,
      }}
    >
      <View style={{ marginTop: 1 }}>{host.renderGlyph(icon, colors.tertiaryText, 14)}</View>
      {/* The link (Stop, Search older) closes the note's last line rather than wrapping onto a line of its own. */}
      <View style={{ flexShrink: 1, flexDirection: 'row', alignItems: 'flex-end', columnGap: 4 }}>
        {props.note ? <View style={{ flexShrink: 1 }}><host.Text style={{ fontSize: 12, lineHeight: 16, color: colors.secondaryText }}>{props.link ? `${props.note.text} ·` : props.note.text}</host.Text></View> : null}
        {props.link ? (
          <HappierPressable
            accessibilityLabel={props.link.label}
            onPress={props.link.onPress}
            testID={props.link.testID}
            style={({ pressed }) => ({ borderRadius: 4, opacity: pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1 })}
          >
            {(state) => (
              <>
                <host.Text style={{ fontSize: 12, lineHeight: 16, color: colors.accent }}>{props.link!.label}</host.Text>
                <FocusRing visible={state.focused} color={colors.focus} radius={4} />
              </>
            )}
          </HappierPressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  inlineCount: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingLeft: 6,
    paddingRight: 8,
  },
  inlineCountCompact: {
    paddingLeft: 4,
    paddingRight: 4,
  },
  seatedCount: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8,
  },
  spinner: {
    marginRight: 4,
  },
  // The ring's stroke is the label's only inset, so Done keeps the lab's 4 / 6 spacing.
  doneLabel: {
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
});
