import { Fragment, type ReactNode } from 'react';
import { View } from 'react-native';

import { HappierPressable } from '../interaction/Pressable.js';
import { HAPPIER_TYPE_SCALE } from '../text/typeScale.js';
import {
  HAPPIER_STATE_LINE_METRICS,
  HAPPIER_STATE_SIZE_METRICS,
  HappierStateDetails,
  HappierStateLine,
  HappierSurfaceStateFrame,
  resolveHappierStateAnnouncement,
  type HappierStateSize,
  type HappierSurfaceStateKind,
} from './InfoState.js';

/** One way forward from a state: already-translated label, the press, and caller-owned pending work. */
export type HappierSurfaceStateAction = Readonly<{
  label: string;
  onPress: () => void | Promise<unknown>;
  testID?: string;
  disabled?: boolean;
  /** Pending work owned by the caller; a returned promise also drives the shared pending behaviour. */
  busy?: boolean;
  /**
   * The next step continues the person's work (open the page again, go where it now lives) rather
   * than retrying a failure, so as the primary action it takes the filled tone whatever the kind.
   */
  invitation?: boolean;
}>;

/** A present-tense line under the copy ("Reconnecting · next try in 8 s"); `busy` draws a working ring. */
export type HappierSurfaceStateLive = Readonly<{
  text: string;
  busy?: boolean;
}>;

/** The container step a state sits in, or `line`: one quiet sentence on a list's rows' edge. */
export type HappierSurfaceStateSize = HappierStateSize | 'line';

/** Type metrics of the quiet copy for the state's size step. */
export type HappierSurfaceStateQuietMetrics = Readonly<{
  fontSize: number;
  lineHeight: number;
}>;

/**
 * The text roles the composition draws through the host's typography:
 * `line` the sentence of a line state, `lineAction` its inline recovery, `live` the present and the
 * action caption, `quiet` the note under the actions and `quietLink` its "How it works" link.
 */
export type HappierSurfaceStateTextRole =
  | 'line'
  | 'lineAction'
  | 'live'
  | 'quiet'
  | 'quietLink'
  | 'details';

/**
 * What a host or plugin adapter supplies: its typography, button, spinner and tile, never layout.
 * The composition (what appears, in which order, with which spacing and announcement) is this owner's.
 */
export type HappierSurfaceStateBindings = Readonly<{
  renderText: (
    input: Readonly<{
      role: HappierSurfaceStateTextRole;
      metrics?: HappierSurfaceStateQuietMetrics;
      /** `start` for copy that stands on a left edge (an inline state); a centred state centres its quiet copy. */
      align?: 'start' | 'center';
      testID?: string;
      onPress?: () => void;
      children: ReactNode;
    }>,
  ) => ReactNode;
  /**
   * `emphasis: 'primary'` is the one next step; `tone` is `filled` for an invitation (empty, success)
   * and `secondary` for a recovery. `compact` is a pointer pane's mini control; `fullWidth` a phone's.
   */
  renderButton: (
    input: Readonly<{
      action: HappierSurfaceStateAction;
      emphasis: 'primary' | 'secondary';
      tone: 'filled' | 'secondary';
      compact: boolean;
      fullWidth: boolean;
      testID?: string;
    }>,
  ) => ReactNode;
  renderSpinner: (sizePx: number) => ReactNode;
  /**
   * The glyph, title and reason in the host's typography, over the shared info tile. `action` is the
   * composed slot under the copy (live, body, caption, actions); `inline` places it beside the copy.
   */
  renderTile: (
    input: Readonly<{
      layout: 'centered' | 'inline';
      size?: HappierStateSize;
      /** `null` for an inline state, which draws its glyph in a column of its own beside the whole state. */
      glyph: ReactNode;
      titleTestID?: string;
      reasonTestID?: string;
      action?: ReactNode;
    }>,
  ) => ReactNode;
  /**
   * The "Details" disclosure's compact caret for its open state; its label is the `details` text role and the
   * toggle itself is the shared `HappierDisclosureToggle`.
   */
  renderDetailsCaret: (open: boolean) => ReactNode;
  renderDetailsCode?: (details: string) => ReactNode;
  detailsLabel: string;
  /** The keyboard focus ring's ink; absent, the environment theme's. */
  focusRing?: string;
  /** Fill under a pressed or hovered inline recovery. */
  pressedFill: string;
}>;

export type HappierSurfaceStateProps = Readonly<{
  testID?: string;
  kind: HappierSurfaceStateKind;
  size?: HappierSurfaceStateSize;
  /** `inline` is the state inside a sheet among other content; whole-pane states stay centred. */
  layout?: 'centered' | 'inline';
  /** The line's sentence (title · reason), already composed by the adapter. */
  lineText?: ReactNode;
  /** The glyph for this size step (a spinner while loading), already themed by the adapter. */
  glyph?: ReactNode;
  /** A line that replaces a body sits in the middle of the room it holds. */
  fillsContainer?: boolean;
  /** The present; a caller-owned node (a ticking "Still waiting") replaces the model. */
  live?: HappierSurfaceStateLive | ReactNode;
  /** Caller-owned domain summary, after copy and live, before the actions. Lines omit it. */
  body?: ReactNode;
  /** Quiet context for the next action, after the body. */
  actionCaption?: string;
  action?: HappierSurfaceStateAction;
  secondaryAction?: HappierSurfaceStateAction;
  /** A custom action node for adapters whose way forward is not one button. */
  actionSlot?: ReactNode;
  /** A quiet line under the actions: a prerequisite or a reassurance. */
  note?: string;
  /** Caller-owned controls that belong with the action: a choice it affects, or why it cannot proceed. Lines omit it. */
  actionFooter?: ReactNode;
  learnMore?: HappierSurfaceStateAction;
  /** Raw machine code: a collapsed disclosure on a failure, a testID marker otherwise. Never the sentence. */
  diagnosticCode?: string | null;
  accessibilitySemantics?: 'status' | 'alert';
  bindings: HappierSurfaceStateBindings;
}>;

const UNSIZED_QUIET: HappierSurfaceStateQuietMetrics = Object.freeze({
  fontSize: 12,
  lineHeight: 17,
});
const UNSIZED_QUIET_GAP_PX = 12;
const ACTION_GAP_PX = 12;
const STACK_GAP_PX = 16;
const LINE_ACTION_RADIUS_PX = 6;
const LINE_ACTION_PADDING_PX = 6;

function isLiveModel(value: unknown): value is HappierSurfaceStateLive {
  return (
    typeof value === 'object' &&
    value !== null &&
    !('$$typeof' in value) &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}

/** Kinds whose diagnostic is a support detail behind a disclosure, not just a QA marker. */
function disclosesDiagnostic(kind: HappierSurfaceStateKind) {
  return kind === 'error' || kind === 'unavailable' || kind === 'warning';
}

/** The present: a working ring (when busy) and one tabular line. */
export function HappierSurfaceStateLiveLine(
  props: Readonly<{
    testID?: string;
    live: HappierSurfaceStateLive;
    metrics: HappierSurfaceStateQuietMetrics;
    bindings: HappierSurfaceStateBindings;
  }>,
) {
  return (
    <View
      testID={props.testID ? `${props.testID}-live` : undefined}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      {props.live.busy
        ? props.bindings.renderSpinner(props.metrics.fontSize)
        : null}
      {props.bindings.renderText({
        role: 'live',
        metrics: props.metrics,
        children: props.live.text,
      })}
    </View>
  );
}

/** The quiet metrics and gap for a size step, shared by the composition and a caller's live leaf. */
export function resolveHappierSurfaceStateQuiet(
  size: HappierStateSize | undefined,
) {
  const metrics = size ? HAPPIER_STATE_SIZE_METRICS[size] : null;
  return {
    metrics: metrics ? metrics.quiet : UNSIZED_QUIET,
    gapPx: metrics?.quietGapPx ?? UNSIZED_QUIET_GAP_PX,
  };
}

/**
 * The ONE full state composition (pane-states lab 0): empty that invites, loading, unavailable,
 * error with cause and recovery, permission denied, success, and the compact in-list line.
 *
 * Happier core's `SurfaceStateCard` and the public plugin `SurfaceState` / `ErrorState` are adapters
 * over it: they bind typography, buttons, glyphs and translation, and keep lifetimes (announcers,
 * timers) of their own. Reading order is fixed here: title · reason · live · body · caption ·
 * actions · note · details. One message per state; the container never resizes around it.
 */
export function HappierSurfaceState(props: HappierSurfaceStateProps) {
  const { bindings } = props;
  const liveRegionProps = resolveHappierStateAnnouncement(
    props.accessibilitySemantics,
  );
  const actions = [props.action, props.secondaryAction] as const;
  const diagnosticMarker = props.diagnosticCode ? (
    <View
      testID={
        props.testID
          ? `${props.testID}-diagnostic-${props.diagnosticCode}`
          : undefined
      }
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: 0, height: 0 }}
    />
  ) : null;
  const diagnosticDetails = props.diagnosticCode && disclosesDiagnostic(props.kind) ? (
    <HappierStateDetails
      testID={props.testID}
      markerTestID={props.testID ? `${props.testID}-diagnostic-${props.diagnosticCode}` : undefined}
      label={bindings.detailsLabel}
      align={props.layout === 'inline' ? 'start' : 'center'}
      details={props.diagnosticCode}
      renderCaret={bindings.renderDetailsCaret}
      renderLabel={(label) => bindings.renderText({ role: 'details', children: label })}
      focusColor={bindings.focusRing}
      renderDetails={bindings.renderDetailsCode}
    />
  ) : diagnosticMarker;

  if (props.size === 'line') {
    // One block (final-acceptance 10): the cause on the leading edge and its recovery at the trailing
    // end. A line is not a card: it never grows a Details disclosure under it (the raw code stays on
    // the QA marker), so a narrow card never stacks three alignments.
    const lineActions = actions.some(Boolean) ? (
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: HAPPIER_STATE_LINE_METRICS.gapPx }}
      >
        {actions.map((action, index) =>
          action ? (
            <HappierPressable
              key={index}
              testID={
                action.testID ??
                (props.testID
                  ? `${props.testID}-${index === 0 ? 'action' : 'secondary-action'}`
                  : undefined)
              }
              accessibilityRole="button"
              accessibilityLabel={action.label}
              disabled={action.disabled}
              busy={action.busy}
              onPress={action.onPress}
              style={({ hovered, pressed }) => ({
                minHeight: HAPPIER_STATE_LINE_METRICS.minHeightPx,
                justifyContent: 'center',
                paddingHorizontal: LINE_ACTION_PADDING_PX,
                borderRadius: LINE_ACTION_RADIUS_PX,
                backgroundColor:
                  hovered || pressed ? bindings.pressedFill : undefined,
              })}
            >
              {bindings.renderText({
                role: 'lineAction',
                metrics: HAPPIER_STATE_LINE_METRICS.text,
                children: action.label,
              })}
            </HappierPressable>
          ) : null,
        )}
      </View>
    ) : (
      props.actionSlot
    );
    return (
      <View
        style={
          props.fillsContainer
            ? { flexGrow: 1, justifyContent: 'center' }
            : undefined
        }
      >
        <View {...liveRegionProps}>
          <HappierStateLine
            testID={props.testID}
            icon={props.glyph}
            action={lineActions}
          >
            {bindings.renderText({
              role: 'line',
              metrics: HAPPIER_STATE_LINE_METRICS.text,
              children: props.lineText,
            })}
          </HappierStateLine>
        </View>
        {diagnosticMarker}
      </View>
    );
  }

  const size = props.size;
  const metrics = size ? HAPPIER_STATE_SIZE_METRICS[size] : null;
  const fullWidth = metrics?.fullWidthActions === true;
  const quiet = resolveHappierSurfaceStateQuiet(size);
  const live = isLiveModel(props.live) ? (
    <HappierSurfaceStateLiveLine
      testID={props.testID}
      live={props.live}
      metrics={quiet.metrics}
      bindings={bindings}
    />
  ) : (
    (props.live ?? null)
  );

  const tone =
    props.kind === 'empty' || props.kind === 'success' ? 'filled' : 'secondary';
  const compact = size === 'pane' || size === 'details' || size === 'page';
  const buttons = actions.some(Boolean) ? (
    <View
      style={[
        {
          flexDirection: 'row',
          gap: ACTION_GAP_PX,
          alignItems: 'center',
          flexWrap: 'wrap',
          justifyContent: 'center',
        },
        fullWidth
          ? {
              flexDirection: 'column',
              alignItems: 'stretch',
              alignSelf: 'stretch',
            }
          : null,
      ]}
    >
      {actions.map((action, index) =>
        action ? (
          <Fragment key={index}>
            {bindings.renderButton({
              action,
              emphasis: index === 0 ? 'primary' : 'secondary',
              tone: index === 0 ? (action.invitation ? 'filled' : tone) : 'secondary',
              compact,
              fullWidth,
              testID:
                action.testID ??
                (props.testID
                  ? `${props.testID}-${index === 0 ? 'action' : 'secondary-action'}`
                  : undefined),
            })}
          </Fragment>
        ) : null,
      )}
    </View>
  ) : (
    (props.actionSlot ?? null)
  );
  const caption =
    props.actionCaption && buttons
      ? bindings.renderText({
          role: 'live',
          metrics: quiet.metrics,
          children: props.actionCaption,
        })
      : null;

  const quietLine =
    props.note || props.learnMore ? (
      <View style={{ marginTop: quiet.gapPx }}>
        {bindings.renderText({
          role: 'quiet',
          metrics: quiet.metrics,
          align: props.layout === 'inline' ? 'start' : 'center',
          testID: props.testID ? `${props.testID}-note` : undefined,
          children: (
            <>
              {props.note ?? null}
              {props.note && props.learnMore ? ' ' : null}
              {props.learnMore
                ? bindings.renderText({
                    role: 'quietLink',
                    testID: props.testID
                      ? `${props.testID}-learn-more`
                      : undefined,
                    onPress: () => {
                      void props.learnMore!.onPress();
                    },
                    children: props.learnMore.label,
                  })
                : null}
            </>
          ),
        })}
      </View>
    ) : null;
  const supplemental = (
    <>
      {props.actionFooter}
      {quietLine}
      {diagnosticDetails}
    </>
  );
  // The live region holds the state's sentence; a diagnostic disclosure stays outside it, so expanding
  // Details announces nothing new.
  const disclosure = Boolean(props.diagnosticCode) && disclosesDiagnostic(props.kind);
  const announceSentence = (content: ReactNode, centered = true) => disclosure && props.accessibilitySemantics
    ? <View {...liveRegionProps} style={centered ? { width: '100%', alignItems: 'center' } : undefined}>{content}</View>
    : content;
  const iconSlot = props.glyph ? (
    <View
      testID={props.testID ? `${props.testID}-icon` : undefined}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ alignItems: 'center', justifyContent: 'center' }}
    >
      {props.glyph}
    </View>
  ) : null;
  const titleTestID = props.testID ? `${props.testID}-title` : undefined;
  const reasonTestID = props.testID ? `${props.testID}-reason` : undefined;

  if (props.layout === 'inline') {
    // The glyph owns a leading column and everything the state says or offers — copy, present, body,
    // actions, the note — stands on the one edge to its right, so the actions line up under the
    // sentence they answer instead of under the glyph. The tile draws the copy only.
    return (
      <View
        testID={props.testID}
        {...(disclosure ? {} : liveRegionProps)}
        style={{ alignSelf: 'stretch', flexDirection: 'row', alignItems: 'flex-start', columnGap: STACK_GAP_PX }}
      >
        {iconSlot ? (
          <View style={{ height: HAPPIER_TYPE_SCALE.label.lineHeight, justifyContent: 'center' }}>{iconSlot}</View>
        ) : null}
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          {announceSentence(bindings.renderTile({
            layout: 'inline',
            size,
            glyph: null,
            titleTestID,
            reasonTestID,
          }), false)}
          {live ? <View style={{ alignItems: 'flex-start' }}>{live}</View> : null}
          {props.body}
          {buttons ? (
            <View
              style={[
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                },
                fullWidth
                  ? { flexDirection: 'column', alignItems: 'stretch' }
                  : null,
              ]}
            >
              {caption}
              {buttons}
            </View>
          ) : null}
          {supplemental}
        </View>
      </View>
    );
  }

  // The present reads with the copy, before the way forward (lab 0: title · copy · live · action).
  const actionSlot = props.body ? (
    <View
      style={{
        alignItems: 'center',
        gap: STACK_GAP_PX,
        alignSelf: 'stretch',
        width: '100%',
      }}
    >
      {live}
      <View style={{ alignSelf: 'stretch', width: '100%' }}>{props.body}</View>
      {caption}
      {buttons}
    </View>
  ) : live && buttons ? (
    <View
      style={[
        { alignItems: 'center', gap: STACK_GAP_PX },
        fullWidth ? { alignSelf: 'stretch', width: '100%' } : null,
      ]}
    >
      {live}
      {buttons}
    </View>
  ) : (
    (live ?? buttons ?? undefined)
  );

  return (
    <HappierSurfaceStateFrame
      testID={props.testID}
      size={size}
      accessibilitySemantics={disclosure ? undefined : props.accessibilitySemantics}
    >
      {announceSentence(
        bindings.renderTile({
          layout: 'centered',
          size,
          glyph: iconSlot,
          titleTestID,
          reasonTestID,
          action: actionSlot,
        }),
      )}
      {supplemental}
    </HappierSurfaceStateFrame>
  );
}
