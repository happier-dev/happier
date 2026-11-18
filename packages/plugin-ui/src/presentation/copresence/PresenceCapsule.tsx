import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import type { HappierPortableStyle } from '../portableTypes.js';
import type { HappierCapsuleColors, HappierCapsuleHost } from '../status/capsuleHost.js';
import { HAPPIER_BALANCED_TEXT_WRAP } from '../text/balancedTextWrap.js';

/**
 * Who is in control of a surface an agent can drive. `controlEpoch` is the owner's counter that moves
 * every time control changes hands; the capsule uses it to tell its own pending press from the owner's
 * answer.
 *
 * - `idle`: nobody is driving; the capsule renders nothing.
 * - `agent`: the agent is driving.
 * - `stopping`: the person took control and the agent's interrupted action is still settling.
 * - `unconfirmed`: the person stopped the agent but its owner could not confirm the agent's input was
 *   released. Not human control: nothing may claim the person has the surface until a fresh look proves it.
 * - `human`: the person has control. `interruptedCompletion: 'unknown'` says the agent's last action
 *   may have landed.
 */
export type HappierPresence =
  | Readonly<{ kind: 'idle' | 'agent' | 'stopping' | 'unconfirmed'; controlEpoch: number }>
  | Readonly<{ kind: 'human'; controlEpoch: number; interruptedCompletion?: 'unknown' | null }>;

/** The capsule's words, in the host's locale and with the agent's name already in them. */
export type HappierPresenceCapsuleCopy = Readonly<{
  /** What the agent is doing, said for this surface ("Claude is browsing"). */
  agentTitle: string;
  /** Its line: what it is doing right now ("Clicking “Sign in”"), or where it is ("on MacBook Pro"). */
  agentDetail: string | null;
  /** "Stopping Claude…" and its line. */
  stopping: string;
  stoppingDetail: string;
  /** "You have control", or this surface's words for the person's control. */
  humanTitle: string;
  /** This surface's line for the person's control; absent, the hand-back line is used when it is offered. */
  humanDetail: string | null;
  /** "Claude is paused until you hand back." */
  pausedUntilHandBack: string;
  /** "Couldn't confirm the stop." */
  stopUnconfirmed: string;
  /** "Claude's last action may have landed." The one line that must be read whole. */
  lastActionMayHaveLanded: string;
  takeControl: string;
  handBack: string;
  checkAgain: string;
  watch: string;
}>;

export type HappierPresenceCapsulePlacement = 'dock' | 'inline' | 'strip';

/** A takeover command's answer, not a controller fact. Only `presence` confirms human control. */
export type HappierPresenceTakeControlResult = Readonly<{ status: 'accepted' | 'failed' | 'unknown' }>;

type TakeControlRequest = Readonly<{ controlEpoch: number; status: 'pending' | 'failed' | 'unknown' }>;

export type HappierPresenceCapsuleProps = Readonly<{
  presence: HappierPresence;
  copy: HappierPresenceCapsuleCopy;
  /** The agent's mark at the given size; omitted, a neutral sparkle stands in. */
  renderAgentMark?: (size: number) => ReactNode;
  /**
   * Absent when this surface has no route to take control. Wire it to the owner's takeover Action; the
   * capsule only says "stopping" until the owner's control epoch moves. Return a typed command result
   * for asynchronous routes so failed or unknown delivery offers retry. Synchronous owners may return
   * void and report their answer through `presence` as before; accepted never asserts human control.
   */
  onTakeControl?: () => void | HappierPresenceTakeControlResult | Promise<HappierPresenceTakeControlResult>;
  /** Absent when the owner offers no hand back from this surface. */
  onHandBack?: () => void;
  /** A fresh look at the surface, which is what confirms an unconfirmed stop. */
  onCheckAgain?: () => void;
  /** The fresh look is in flight. */
  checking?: boolean;
  /** Opens the surface this capsule narrates (a session-wide line's Watch). */
  onWatch?: () => void;
  /** Retains an unavailable Watch and explains why it cannot be pressed. */
  watchDisabledReason?: string | null;
  /** Phone and narrow panes: the capsule spans the frame in thumb reach. */
  compact?: boolean;
  /**
   * The width the capsule's container gives it. Where the words would be squeezed to a sliver in
   * that width (a floating frame shrunk to a small window), the capsule recomposes rather than clip
   * a word: the mark and the action alone, the action as its icon with its label for assistive
   * technology, the words kept as the row's accessible name. It returns to the words once the
   * container is wide enough for them again. A `strip` keeps its sentence and labelled buttons and
   * moves the buttons beneath the sentence instead. Absent, the capsule never recomposes.
   */
  availableWidth?: number;
  /**
   * `dock` (default) floats it over the bottom of the surface it narrates; `inline` sits in flow as a
   * floating capsule; `strip` is a one-line bordered strip (a session-wide line).
   */
  placement?: HappierPresenceCapsulePlacement;
  colors: HappierCapsuleColors;
  host: HappierCapsuleHost;
  testID: string;
}>;

/** The presence capsule's own geometry: a 44 px capsule, a 30 px mark. */
/** The capsule's row height; a frame that stands it below its body reserves exactly this. */
export const HAPPIER_PRESENCE_CAPSULE_HEIGHT = 44;
const CAPSULE_MIN_HEIGHT = HAPPIER_PRESENCE_CAPSULE_HEIGHT;
const MARK_SIZE = 30;
const MARK_GLYPH_SIZE = 16;
const LEADING_GLYPH_SIZE = 14;
/** The narrowest the words may be squeezed to before they give way: a short word per line. */
const MIN_WORDS_WIDTH = 96;

const DOCK_STYLE: HappierPortableStyle = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 16,
  alignItems: 'center',
  zIndex: 4,
  pointerEvents: 'box-none',
};

const DOCK_COMPACT_STYLE: HappierPortableStyle = {
  ...DOCK_STYLE,
  left: 12,
  right: 12,
  bottom: 12,
  alignItems: 'stretch',
};

const STRIP_TEXT_STYLE: HappierPortableStyle = { minWidth: 0, flex: 1 };
/** A two-line title splits evenly on the web rather than leaving one word alone (the shared rule). */
const TITLE_WRAP: HappierPortableStyle | undefined = HAPPIER_BALANCED_TEXT_WRAP ?? undefined;

const styles = StyleSheet.create({
  inline: {
    alignItems: 'stretch',
  },
  stripOuter: {
    borderRadius: 10,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
  },
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 36,
    paddingVertical: 3,
    paddingLeft: 10,
    paddingRight: 4,
  },
  stripText: {
    flex: 1,
    minWidth: 0,
  },
  stripStacked: {
    flexWrap: 'wrap',
    rowGap: 4,
    paddingVertical: 6,
  },
  markStrip: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: CAPSULE_MIN_HEIGHT,
    paddingVertical: 5,
    paddingLeft: 8,
    paddingRight: 5,
  },
  mark: {
    width: MARK_SIZE,
    height: MARK_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flexShrink: 1,
    minWidth: 0,
    paddingRight: 4,
  },
  textCompact: {
    flex: 1,
  },
  spinner: {
    marginHorizontal: 12,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  capsuleStacked: {
    flexWrap: 'wrap',
    // Clear the capsule's round ends so the buttons sit inside its curve.
    paddingVertical: 10,
    paddingLeft: 14,
    paddingRight: 18,
  },
  actionsStacked: {
    flexBasis: '100%',
    justifyContent: 'flex-end',
  },
});

type Shown = Readonly<{ presence: HappierPresence; copy: HappierPresenceCapsuleCopy }>;

/**
 * Who is driving a surface an agent can act on, docked at its bottom edge.
 *
 * One object is the controller chip AND the narration AND the one control: the agent's mark with
 * "Claude is browsing · Clicking on the page" and **Take control**; after the press it morphs in place to
 * "Stopping Claude…" until the controller owner reports the takeover landed (a new control epoch and the
 * interrupted action settled); then "You have control" with **Hand back**, saying once that the agent's
 * last action may have landed when the owner could not confirm its effect. An unconfirmed stop never
 * reads "You have control": it offers the fresh look that confirms it. Idle renders nothing; a docked
 * capsule keeps its last words while it settles back into the frame's edge.
 *
 * It holds no authority. The controller lives with its owner; the stopping state is local only because
 * it is the gap between a press and the owner's answer. It never depends on the surface's pixels, so
 * Take control stays reachable while a stream is connecting, stalled or unavailable. Extracted from
 * Happier's browser presence capsule with its geometry, states and motion intact.
 */
export function HappierPresenceCapsule(props: HappierPresenceCapsuleProps): ReactElement | null {
  const { host, colors } = props;
  const [request, setRequest] = useState<TakeControlRequest | null>(null);
  // The words' laid-out width, and (while they are given way) the container width that gives them
  // back their minimum, as measured when they gave way.
  const [wordsWidth, setWordsWidth] = useState<number | null>(null);
  const [restoreAt, setRestoreAt] = useState<number | null>(null);
  const availableWidth = props.availableWidth;
  const onWordsLayout = useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
    setWordsWidth(event.nativeEvent.layout.width);
  }, []);
  useEffect(() => {
    if (availableWidth === undefined) return;
    if (restoreAt === null) {
      if (wordsWidth !== null && wordsWidth < MIN_WORDS_WIDTH) setRestoreAt(availableWidth - wordsWidth + MIN_WORDS_WIDTH);
    } else if (availableWidth >= restoreAt) {
      setRestoreAt(null);
      setWordsWidth(null);
    }
  }, [availableWidth, restoreAt, wordsWidth]);
  // Squeezed words give way: a floating capsule to its mark and icon-only action; a strip (a column's
  // full-width line) keeps them and moves its buttons beneath.
  const squeezed = restoreAt !== null;
  const narrow = squeezed && props.placement !== 'strip';
  const stacked = squeezed && props.placement === 'strip';
  const requestRef = useRef<TakeControlRequest | null>(null);
  const docked = props.placement === undefined || props.placement === 'dock';
  const visible = props.presence.kind !== 'idle';
  // A docked capsule leaves as part of its motion: it keeps saying the last state it said while it
  // settles out, then the dock unmounts it.
  const lastShownRef = useRef<Shown>({ presence: props.presence, copy: props.copy });
  if (visible) lastShownRef.current = { presence: props.presence, copy: props.copy };

  useEffect(() => {
    // The takeover landed (or the agent stopped on its own): the pending press is answered.
    const current = props.presence;
    if (request !== null && (current.controlEpoch !== request.controlEpoch
      || (current.kind !== 'agent' && current.kind !== 'stopping'))) {
      requestRef.current = null;
      setRequest(null);
    }
  }, [props.presence, request]);
  useEffect(() => () => { requestRef.current = null; }, []);

  const onTakeControl = props.onTakeControl;
  const presenceForPress = props.presence;
  const takeControl = useCallback(() => {
    if (presenceForPress.kind !== 'agent' || !onTakeControl) return;
    const pending: TakeControlRequest = { controlEpoch: presenceForPress.controlEpoch, status: 'pending' };
    requestRef.current = pending;
    setRequest(pending);
    const settle = (result: HappierPresenceTakeControlResult) => {
      // A newer press or an authoritative answer wins over a delayed command result.
      if (requestRef.current !== pending || result.status === 'accepted') return;
      const answered: TakeControlRequest = { controlEpoch: pending.controlEpoch, status: result.status };
      requestRef.current = answered;
      setRequest(answered);
    };
    try {
      const result = onTakeControl();
      if (result !== undefined) void Promise.resolve(result).then(settle, () => settle({ status: 'unknown' }));
    } catch {
      settle({ status: 'unknown' });
    }
  }, [onTakeControl, presenceForPress]);

  const renderCapsule = (leaving: boolean): ReactNode => {
    const { presence, copy } = lastShownRef.current;
    const testID = leaving ? `${props.testID}-leaving` : props.testID;
    // Stopping is the owner's fact (an interrupted action still settling) or, for the instant between
    // the press and the owner's first answer, the press itself.
    const stopping = presence.kind === 'stopping' || (presence.kind === 'agent'
      && request?.status === 'pending'
      && request.controlEpoch === presence.controlEpoch);
    const recovery = presence.kind === 'agent' && request !== null
      && request.controlEpoch === presence.controlEpoch && request.status !== 'pending';
    const human = presence.kind === 'human';
    const unconfirmed = presence.kind === 'unconfirmed';
    const strip = props.placement === 'strip';
    const compact = props.compact === true;
    const title = human
      ? copy.humanTitle
      : unconfirmed || recovery
        ? copy.stopUnconfirmed
        : stopping
          ? copy.stopping
          : copy.agentTitle;
    const mayHaveLanded = unconfirmed || (recovery && request.status === 'unknown')
      || (presence.kind === 'human' && presence.interruptedCompletion === 'unknown');
    const observationRecovery = unconfirmed || (human && mayHaveLanded && Boolean(props.onCheckAgain));
    const detail = human
      ? mayHaveLanded
        ? copy.lastActionMayHaveLanded
        : copy.humanDetail ?? (props.onHandBack ? copy.pausedUntilHandBack : null)
      : unconfirmed || (recovery && mayHaveLanded)
        ? copy.lastActionMayHaveLanded
        : stopping
          ? copy.stoppingDetail
          : presence.kind === 'agent' ? copy.agentDetail : null;
    const detailColor = mayHaveLanded ? colors.warningText ?? colors.warning : colors.secondaryText;
    const stateKey = human ? 'human' : unconfirmed ? 'unconfirmed' : recovery ? 'recovery' : stopping ? 'stopping' : 'agent';

    const trailingControls = (
      <>
        {props.onWatch && !(compact && unconfirmed) ? (
          <host.Button emphasis="plain" title={copy.watch} onPress={props.onWatch}
            iconOnly={narrow} leading={narrow ? host.renderGlyph('pointer', colors.text, LEADING_GLYPH_SIZE) : undefined}
            disabled={Boolean(props.watchDisabledReason)} accessibilityHint={props.watchDisabledReason ?? undefined}
            testID={`${testID}-watch`} />
        ) : null}
        {human && !observationRecovery && props.onHandBack ? (
          <host.Button emphasis="primary" title={copy.handBack} onPress={props.onHandBack} testID={`${testID}-hand-back`}
            iconOnly={narrow} leading={narrow ? host.renderGlyph('pointer', colors.text, LEADING_GLYPH_SIZE) : undefined} />
        ) : observationRecovery ? (
          // A fresh look by the person confirms the release; handing back is also safe, because the
          // owner makes the agent look again before its next action.
          <View style={[styles.actions, compact ? styles.actionsStacked : null]}>
            {props.onCheckAgain ? (
              <host.Button
                emphasis="secondary"
                title={copy.checkAgain}
                loading={props.checking}
                iconOnly={narrow}
                leading={narrow ? host.renderGlyph('warning', colors.text, LEADING_GLYPH_SIZE) : undefined}
                onPress={props.onCheckAgain}
                testID={`${testID}-check-again`}
              />
            ) : null}
            {props.onHandBack ? (
              <host.Button emphasis="primary" title={copy.handBack} onPress={props.onHandBack} testID={`${testID}-hand-back`}
                iconOnly={narrow} leading={narrow ? host.renderGlyph('pointer', colors.text, LEADING_GLYPH_SIZE) : undefined} />
            ) : null}
          </View>
        ) : stopping ? (
          <View style={styles.spinner}>
            <host.Spinner color={colors.secondaryText} />
          </View>
        ) : human || !props.onTakeControl ? null : (
          <host.Button
            emphasis="secondary"
            title={copy.takeControl}
            leading={strip ? undefined : host.renderGlyph('hand', colors.text, LEADING_GLYPH_SIZE)}
            iconOnly={narrow}
            onPress={takeControl}
            testID={`${testID}-take-control`}
          />
        )}
      </>
    );
    const row = (
      <View
        // On a phone the unconfirmed stop needs its line whole and two buttons: they move beneath.
        style={[strip ? styles.strip : styles.capsule, compact && observationRecovery ? styles.capsuleStacked : null,
          stacked ? styles.stripStacked : null]}
        accessibilityRole="summary"
        // On the web a polite live sentence is a status; RNW would draw `summary` as an unnamed region.
        role={Platform.OS === 'web' ? 'status' : undefined}
        accessibilityLiveRegion="polite"
        aria-live="polite"
        // Recomposed to the mark and its action, the row still says what the words said.
        accessibilityLabel={narrow ? (detail ? `${title}. ${detail}` : title) : undefined}
        testID={`${testID}-${stateKey}`}
      >
        <View style={strip ? styles.markStrip : styles.mark}>
          {human
            ? host.renderGlyph('hand', colors.text, MARK_GLYPH_SIZE)
            : unconfirmed || recovery
              ? host.renderGlyph('warning', colors.warning, MARK_GLYPH_SIZE)
              : props.renderAgentMark
                ? props.renderAgentMark(MARK_GLYPH_SIZE)
                : host.renderGlyph('sparkle', colors.secondaryText, MARK_GLYPH_SIZE)}
        </View>
        {strip && !(compact && observationRecovery) ? (
          // One line: what, then where or what it is doing (never balanced across lines: it ellipsizes).
          <View style={styles.stripText} onLayout={availableWidth === undefined ? undefined : onWordsLayout} testID={`${testID}-text`}>
            <host.Text numberOfLines={1} style={STRIP_TEXT_STYLE}>
              <host.Text role="title" color={colors.text}>{title}</host.Text>
              {detail ? <host.Text role="meta" color={detailColor}>{`  ${detail}`}</host.Text> : null}
            </host.Text>
          </View>
        ) : narrow ? null : (
          <View
            style={[styles.text, compact || props.placement !== 'dock' ? styles.textCompact : null]}
            onLayout={availableWidth === undefined ? undefined : onWordsLayout}
            testID={`${testID}-text`}
          >
            {/* A narrow capsule wraps the sentence rather than clip the Machine or window it names. */}
            <host.Text role="title" color={colors.text} numberOfLines={2} style={TITLE_WRAP}>{title}</host.Text>
            {detail ? (
              // The warning is the one line that must be read whole, so it may wrap.
              // At the compact width the detail may wrap to a second line rather than clip its sentence.
              <host.Text role="meta" color={detailColor} numberOfLines={mayHaveLanded || compact ? 2 : 1}>{detail}</host.Text>
            ) : null}
          </View>
        )}
        {stacked ? (
          <View style={[styles.actions, styles.actionsStacked]} testID={`${testID}-actions-beneath`}>
            {trailingControls}
          </View>
        ) : trailingControls}
      </View>
    );
    // The capsule morphs in place between who-is-in-control states; the host's step transition owns
    // the motion and its reduced-motion fallback.
    const morphing = host.Morph ? <host.Morph stateKey={stateKey}>{row}</host.Morph> : row;
    if (strip) {
      return (
        <View
          style={[styles.stripOuter, { borderColor: colors.stripBorder, backgroundColor: colors.stripBackground }]}
          testID={testID}
        >
          {morphing}
        </View>
      );
    }
    if (!docked) {
      return (
        <View style={styles.inline}>
          <host.Surface elevation="high" testID={testID}>{morphing}</host.Surface>
        </View>
      );
    }
    // Docked over the surface it narrates, the material reshapes between states: it travels to the new
    // row's size while the row cross-fades.
    return <host.Surface elevation="high" reshape testID={testID}>{morphing}</host.Surface>;
  };

  if (docked && host.Dock) {
    return (
      <host.Dock visible={visible} edge="bottom" style={props.compact ? DOCK_COMPACT_STYLE : DOCK_STYLE}>
        {renderCapsule}
      </host.Dock>
    );
  }
  if (!visible) return null;
  if (docked) return <View style={props.compact ? DOCK_COMPACT_STYLE : DOCK_STYLE}>{renderCapsule(false)}</View>;
  return <>{renderCapsule(false)}</>;
}
