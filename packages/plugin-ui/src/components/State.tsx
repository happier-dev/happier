import { useContext, useMemo, type ReactElement, type ReactNode } from 'react';
import { View } from 'react-native';
import type { ResourceContent } from '@happier-dev/plugin-sdk/ui';
import type { PluginUiResourceSnapshot } from '../hostApi/resourceStore.js';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { PluginUiSurfaceNoticeContext, useClaimedPluginUiSurfaceNotice } from '../presentationHost/surfaceNotice.js';
import { resolveHappierFreshnessText } from '../presentation/state/asOfTime.js';
import { usePluginSurfaceActivity } from '../hostApi/context.js';
import { HappierSkeletonRows } from '../presentation/feedback/Skeleton.js';
import {
  HAPPIER_EMPTY_STATE_FRAME,
  HAPPIER_FRESHNESS_LINE_METRICS,
  HAPPIER_STATE_SIZE_METRICS,
  HappierInfoState,
  HappierInfoTile,
  HappierFreshnessLine,
  HappierFreshnessClauses,
  HappierSurfaceStateFrame,
  HappierStateLine,
  resolveHappierStateAnnouncement,
  resolveHappierStateFailureGlyph,
  HAPPIER_STATE_LINE_METRICS,
  type HappierStateSize,
  type HappierSurfaceStateKind,
} from '../presentation/state/InfoState.js';
import {
  HappierSurfaceState,
  type HappierSurfaceStateAction,
  type HappierSurfaceStateBindings,
} from '../presentation/state/SurfaceState.js';
import { useHappierPageChrome } from '../presentation/layout/pageChrome.js';
import { useHappierColumnEdgeRemainder } from '../presentation/layout/columnEdge.js';
import { useHappierUiAnimationActivityInternal, useOptionalHappierUiPalette } from '../environment/context.js';
import {
  HAPPIER_SCENE_ART_METRICS,
  resolveHappierScene,
  resolveHappierSceneArtSize,
  type HappierSceneInput,
  type HappierSceneArtSize,
} from '../presentation/state/scenes.js';
import { HappierPressable } from '../presentation/interaction/Pressable.js';
import { HappierEmptySlot } from '../presentation/state/EmptySlot.js';
import { HappierText } from '../presentation/text/Text.js';
import { HappierDisclosureCaret } from './DisclosureCaret.js';
import { PluginUiIconGlyph, type IconName } from './Icon.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';
import { Spinner } from './Spinner.js';
import { Button } from './Button.js';
import { HappierSpinner } from '../presentation/feedback/Spinner.js';

const STATE_LOADING_TRANSLATION_KEY = 'happier.plugin-ui.state.loading';
const STATE_EMPTY_TRANSLATION_KEY = 'happier.plugin-ui.state.empty';
const STATE_ERROR_TRANSLATION_KEY = 'happier.plugin-ui.state.error';
const STATE_DETAILS_TRANSLATION_KEY = 'happier.plugin-ui.state.details';
const STATE_AS_OF_TRANSLATION_KEY = 'happier.plugin-ui.state.asOf';
const STATE_RETRY_TRANSLATION_KEY = 'happier.plugin-ui.state.retry';
const STATE_REFRESHING_TRANSLATION_KEY = 'happier.plugin-ui.state.refreshing';
const STATE_STALE_TRANSLATION_KEY = 'happier.plugin-ui.state.stale';

/**
 * The size a state is drawn at: the author's, else the container the host mounted the surface in
 * (a session sidebar tab is a `pane`), else the unsized centred column.
 */
function useStateSize(size: HappierStateSize | undefined): HappierStateSize | 'line' | undefined {
  const hostSize = useOptionalPluginUiPresentationHost()?.stateSize;
  return size ?? hostSize;
}

/**
 * The three resolvable presentations of a resource, rendered as real components
 * (UI-T27) rather than the inert `happier-plugin-state` marker the predecessor
 * shipped.
 *
 * All three are adapters over ONE shared implementation (`HappierInfoState`),
 * which Happier core's `EmptyState` renders too. They differ only in what goes
 * in the leading slot and which semantic tone the title carries — never in
 * layout, measure or spacing, which is exactly the drift two implementations
 * would have produced.
 */
type StateCopyProps = Readonly<{
  title?: string;
  /** A key from this plugin's declared translation bundle; `title` is its fallback. */
  titleKey?: string;
  description?: string;
  descriptionKey?: string;
  /** A call to action rendered below the copy. */
  action?: ReactNode;
  /**
   * The container the state sits in — `pane` (a side pane), `details` (a details drawer), `page` (an
   * app page's content column) or `phone` — which sets its measure, glyph and type exactly like
   * Happier's own pane states. Omit it for the unsized centred column. Not used by `layout="line"`.
   */
  size?: HappierStateSize;
  /** Static states stay quiet; opt in when a lifecycle transition needs announcing. */
  accessibilitySemantics?: 'status' | 'alert';
  testID?: string;
}>;

export type LoadingStateProps = StateCopyProps & Readonly<{
  layout?: 'centered' | 'line';
  /**
   * Draw this many destination-shaped list rows instead of the centered
   * spinner. Use it when the loading content is a list whose geometry is known,
   * so the first rows replace a placeholder of their own shape rather than a
   * spinner. The title stays the one accessible name of the wait.
   */
  rows?: number;
}>;
export type EmptyStateProps = StateCopyProps & Readonly<{
  /**
   * - `centered` (default): the compact centred column for a pane or card.
   * - `page`: a whole page with nothing in it — glyph, title, one line of
   *   purpose and one action — in the page's content column with the page's
   *   spacing, exactly like Happier's own empty pages.
   * - `line`: one quiet line inside a list, rail or section, on the rows' edge
   *   (a search with no results is this, not the page state).
   */
  layout?: 'centered' | 'page' | 'line';
  /** The state's glyph (`page` and `centered`), drawn alone — never in a tile or ring. */
  icon?: IconName;
  /**
   * The Daybreak scene drawn in place of the glyph on a `page` or `centered` state: a built-in scene
   * id (`'noSearchResults'`) or the plugin's own `defineHappierScene(...)`, defined once at module
   * scope. A `line` state stays text only; a host without a scene renderer keeps `icon`.
   */
  scene?: HappierSceneInput;
  /**
   * `add` frames the state with a dashed outline: an invitation to add the
   * first item to a collection. Use it only for adding.
   */
  variant?: 'default' | 'add';
  /**
   * Why this viewer cannot take the state's action, and who can. Shown in the
   * action's place instead of leaving a dead end.
   */
  actionUnavailableReason?: string;
  actionUnavailableReasonKey?: string;
  /**
   * A quiet second way forward under the one primary `action` (a plain `Button`): "Browse PRs &
   * Issues" beside "Attach a PR or issue". Never a second primary.
   */
  secondaryAction?: ReactNode;
}>;
export type ErrorStateProps = StateCopyProps & Readonly<{
  kind?: 'error' | 'unavailable' | 'denied';
  layout?: 'centered' | 'line';
  /**
   * Diagnostic detail for a support or expert reader — a code, a diagnostic.
   * It sits behind a collapsed "Details" disclosure under the state and is
   * never the sentence: `title` and `description` say what failed in words.
   */
  details?: string;
  /**
   * The one recovery: draws a Retry button (a host-localized "Retry", or `retryLabel`) under the copy,
   * or an inline link in a `line`. A returned promise keeps it pending until the retry settles.
   * Ignored when a custom `action` is given.
   */
  onRetry?: () => unknown;
  retryLabel?: string;
}>;

function useResolvedCopy({ title, titleKey, description, descriptionKey }: StateCopyProps) {
  const translate = usePluginTranslation();
  return {
    translate,
    title: resolveAuthorText(translate, title, titleKey),
    description: resolveAuthorText(translate, description, descriptionKey),
  };
}

/**
 * Work is in progress.
 *
 * The spinner carries the title as its accessible name when there is one, so a
 * screen-reader user learns WHAT is loading rather than only that something is.
 */
export function LoadingState(props: LoadingStateProps): ReactElement {
  if (props.rows !== undefined) return <SkeletonRowsLoadingState {...props} rows={props.rows} />;
  return <SpinnerLoadingState {...props} />;
}

function SkeletonRowsLoadingState(props: LoadingStateProps & Readonly<{ rows: number }>): ReactElement {
  const { translate, title } = useResolvedCopy(props);
  const theme = usePluginTheme();
  const surfaceActivity = usePluginSurfaceActivity();
  return (
    <HappierSkeletonRows
      testID={props.testID}
      rows={props.rows}
      theme={theme}
      animationEnabled={surfaceActivity.active}
      accessibilityLabel={title ?? translate(STATE_LOADING_TRANSLATION_KEY, 'Loading')}
    />
  );
}

function SpinnerLoadingState(props: LoadingStateProps): ReactElement {
  return (
    <SurfaceStateAdapter
      kind="loading"
      testID={props.testID}
      title={props.title}
      titleKey={props.titleKey}
      description={props.description}
      descriptionKey={props.descriptionKey}
      size={props.layout === 'line' ? 'line' : props.size}
      accessibilitySemantics={props.accessibilitySemantics}
      actionSlot={props.action}
    />
  );
}

/**
 * The resource resolved, and there is genuinely nothing to show.
 *
 * The same owner and frames as Happier's own `EmptyState`: a page state in the
 * content column, a centred pane state, or one quiet line among rows.
 */
export function EmptyState(props: EmptyStateProps): ReactElement {
  const { translate, title, description } = useResolvedCopy(props);
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme);
  const chrome = useHappierPageChrome();
  const resolvedSize = useStateSize(props.size);
  // A line container makes an unplaced state its one quiet line; an explicit layout or size still wins.
  const layout = props.layout ?? (resolvedSize === 'line' ? 'line' : 'centered');
  const stateSize = resolvedSize === 'line' ? undefined : resolvedSize;
  const scene = useStateScene(props.scene, layout, stateSize, props.testID);
  const pageSheetInsetPx = useHappierColumnEdgeRemainder(HAPPIER_EMPTY_STATE_FRAME.page.marginHorizontal);
  const unavailableReason = resolveAuthorText(
    translate,
    props.actionUnavailableReason,
    props.actionUnavailableReasonKey,
  );

  if (layout === 'line') {
    return (
      <HappierStateLine
        testID={props.testID}
        accessibilitySemantics={props.accessibilitySemantics}
        action={props.action ?? (unavailableReason ? (
          <HappierText variant="micro" tone="secondary">{unavailableReason}</HappierText>
        ) : undefined)}
      ><HappierText tone="secondary" style={HAPPIER_STATE_LINE_METRICS.text}>{title}{title && description ? ' · ' : null}{description}</HappierText></HappierStateLine>
    );
  }

  const primaryAction = props.action ?? (unavailableReason ? (
    <HappierText
      tone="secondary"
      style={HAPPIER_EMPTY_STATE_FRAME.unavailableReason}
    >
      {unavailableReason}
    </HappierText>
  ) : undefined);
  // The primary leads and the quiet second way follows it, in reading order.
  const action = primaryAction !== undefined && props.secondaryAction !== undefined ? (
    <View style={{ alignItems: 'center', gap: theme.spacing.xsmall }}>
      {primaryAction}
      {props.secondaryAction}
    </View>
  ) : primaryAction ?? props.secondaryAction;
  const add = props.variant === 'add';
  const page = layout === 'page';
  const size = page ? undefined : stateSize;
  const state = (
    <HappierInfoState testID={add || page ? undefined : props.testID} action={action} size={size}>
      <HappierInfoTile
        icon={scene ?? (props.icon ? (
          <View style={size ? { marginBottom: HAPPIER_STATE_SIZE_METRICS[size].glyphGapPx } : undefined}>
            <PluginUiIconGlyph name={props.icon} size={size ? HAPPIER_STATE_SIZE_METRICS[size].glyphPx : 24} tone="secondary" />
          </View>
        ) : undefined)}
        title={title}
        description={description}
        paddingVertical={page ? HAPPIER_EMPTY_STATE_FRAME.pageTilePaddingVertical : undefined}
        size={size}
      />
    </HappierInfoState>
  );
  const addFrame = add && palette
    ? { ...HAPPIER_EMPTY_STATE_FRAME.add, borderColor: palette.sheetBorder }
    : null;
  if (page) {
    return (
      <View style={{ alignItems: 'center' }}>
        <View
          testID={props.testID}
          {...resolveHappierStateAnnouncement(props.accessibilitySemantics)}
          style={[
            { width: '100%', maxWidth: chrome?.columnMaxWidthPx },
            HAPPIER_EMPTY_STATE_FRAME.page,
            // On the sheet edge, also inside a column that already draws part of it (a detail's body).
            { marginHorizontal: pageSheetInsetPx },
            add ? HAPPIER_EMPTY_STATE_FRAME.pageAdd : null,
            add && palette ? { borderColor: palette.sheetBorder } : null,
          ]}
        >
          {state}
        </View>
      </View>
    );
  }
  const framedState = stateSize
    ? <HappierSurfaceStateFrame size={stateSize} accessibilitySemantics={props.accessibilitySemantics}>{state}</HappierSurfaceStateFrame>
    : props.accessibilitySemantics
      ? <View {...resolveHappierStateAnnouncement(props.accessibilitySemantics)}>{state}</View>
      : state;
  return addFrame
    ? <View testID={props.testID} style={[HAPPIER_EMPTY_STATE_FRAME.centeredAdd, addFrame]}>{framedState}</View>
    : framedState;
}

export type EmptySlotProps = Readonly<{
  /** What belongs here ("Drop a card here"). */
  text?: string;
  /** A key from this plugin's declared translation bundle; `text` is its fallback. */
  textKey?: string;
  icon?: IconName;
  /** One inline action that finishes the sentence (a text `Button`). */
  action?: ReactNode;
  /** Makes the whole slot the control (an "Add …" line). Omit it when the slot only marks a place. */
  onPress?: () => void;
  accessibilityLabel?: string;
  minHeight?: number;
  testID?: string;
}>;

/**
 * A place something can go: the dashed outline Happier uses for a hole in a widget group, an area's
 * "Add widget" line and a "new row" drop target. Dashed always means "add something here".
 */
export function EmptySlot(props: EmptySlotProps): ReactElement {
  const translate = usePluginTranslation();
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme);
  const text = resolveAuthorText(translate, props.text, props.textKey);
  return (
    <HappierEmptySlot
      testID={props.testID}
      colors={{ border: palette?.sheetBorder ?? theme.colors.secondaryText, activeFill: theme.colors.control, focusRing: theme.colors.focus }}
      glyph={props.icon ? <PluginUiIconGlyph name={props.icon} size={14} tone="secondary" /> : undefined}
      label={<HappierText variant="micro" tone="secondary">{text}</HappierText>}
      action={props.action}
      onPress={props.onPress}
      accessibilityLabel={props.accessibilityLabel ?? text}
      minHeight={props.minHeight}
    />
  );
}

export type SceneArtProps = Readonly<{
  scene: HappierSceneInput;
  size?: HappierSceneArtSize;
  still?: boolean;
  testID?: string;
}>;

/** Standalone scene art uses the same registry and mounted renderer as empty states. */
export function SceneArt(props: SceneArtProps): ReactNode {
  return useRenderedScene(props.scene, props.size ?? 'pane', props.testID, props.still);
}

function useRenderedScene(
  input: HappierSceneInput | undefined,
  size: HappierSceneArtSize | null,
  testID: string | undefined,
  still?: boolean,
): ReactNode {
  const host = useOptionalPluginUiPresentationHost();
  const presented = useHappierUiAnimationActivityInternal();
  const scene = useMemo(() => input && size && host?.renderScene ? resolveHappierScene(input, size) : null, [input, size, host]);
  return scene && size && host?.renderScene
    ? host.renderScene({ scene, size, still: still === true || !presented, testID })
    : null;
}

/** The state's scene mark, or null when the host or container cannot render it. */
function useStateScene(
  input: HappierSceneInput | undefined,
  layout: 'centered' | 'page' | 'line',
  stateSize: HappierStateSize | undefined,
  testID: string | undefined,
): ReactNode {
  const artSize = input ? resolveHappierSceneArtSize({ size: stateSize, layout }) : null;
  const art = useRenderedScene(input, artSize, testID ? `${testID}-scene` : undefined);
  if (!art || !artSize) return null;
  return (
    <View style={{ marginBottom: HAPPIER_SCENE_ART_METRICS[artSize].gapPx }}>
      {art}
    </View>
  );
}

/**
 * The resource could not be resolved.
 *
 * Calm, like the host's own surface state card: a warning glyph carries the
 * tone and the title stays in ordinary text, because a failure the reader can
 * recover from is not an alarm. The diagnostic, when there is one, is a quiet
 * disclosure beside — not inside — the alert, so expanding it announces
 * nothing new.
 */
export function ErrorState(props: ErrorStateProps): ReactElement {
  const translate = usePluginTranslation();
  const retry = props.onRetry && props.action === undefined ? {
    label: props.retryLabel ?? translate(STATE_RETRY_TRANSLATION_KEY, 'Retry'),
    onPress: props.onRetry,
  } : undefined;
  return (
    <SurfaceStateAdapter
      kind={props.kind ?? 'error'}
      testID={props.testID}
      title={props.title}
      titleKey={props.titleKey}
      description={props.description}
      descriptionKey={props.descriptionKey}
      size={props.layout === 'line' ? 'line' : props.size}
      accessibilitySemantics={props.accessibilitySemantics}
      details={props.details}
      action={retry}
      actionSlot={props.action}
    />
  );
}

/** One way forward from a {@link SurfaceState}. */
export type SurfaceStateAction = Readonly<{
  /** Literal label; it is also the control's accessible name. */
  label?: string;
  /** A key from this plugin's declared translation bundle; `label` is its fallback. */
  labelKey?: string;
  /** A returned promise keeps the control pending until it settles. */
  onPress: () => unknown;
  disabled?: boolean;
  /** Pending work this control did not start. */
  busy?: boolean;
  testID?: string;
}>;

export type SurfaceStateProps = Readonly<{
  /** What the state is: drives the glyph and whether the one action is filled (empty, success) or quiet. */
  kind: HappierSurfaceStateKind;
  title?: string;
  titleKey?: string;
  /** The promise, or the cause, in the reader's words. Never a machine code. */
  description?: string;
  descriptionKey?: string;
  /**
   * The container: `pane`, `details`, `page` or `phone` (Happier's own pane state steps), or `line` for
   * one quiet sentence among a list's rows. Omit it to use the container the host mounted the surface in.
   */
  size?: HappierStateSize | 'line';
  /** Overrides the kind's glyph. */
  icon?: IconName;
  /** The present, under the copy ("Reconnecting · next try in 8 s"); `busy` draws a working ring. */
  live?: Readonly<{ text: string; busy?: boolean }>;
  /** A domain summary between the copy and the actions. Never drawn in a `line`. */
  body?: ReactNode;
  /** Quiet context for the next action, after the body. */
  actionCaption?: string;
  /** The one next step: Retry, Connect, Create the first item. */
  action?: SurfaceStateAction;
  /** A quiet second way forward beside it. Never a second primary. */
  secondaryAction?: SurfaceStateAction;
  /** A quiet line under the actions: a prerequisite or a reassurance ("Nothing is lost."). */
  note?: string;
  noteKey?: string;
  /** A quiet "How it works" link after the note. */
  learnMore?: SurfaceStateAction;
  /** Diagnostic detail behind a collapsed "Details" disclosure on a failure. Never the sentence. */
  details?: string;
  /** Static states stay quiet; opt in when a lifecycle transition needs announcing. */
  accessibilitySemantics?: 'status' | 'alert';
  testID?: string;
}>;

/**
 * The full state composition Happier's own panes use: a calm glyph, the title, the promise or cause, the
 * present, a domain summary, the one recovery and a quiet second way, a note and the collapsed diagnostic,
 * in that order — or, as a `line`, one sentence with an inline recovery. `LoadingState` and `ErrorState`
 * are this component with fewer parts.
 */
export function SurfaceState(props: SurfaceStateProps): ReactElement {
  return <SurfaceStateAdapter {...props} />;
}

const STATE_DEFAULT_GLYPH: Partial<Record<HappierSurfaceStateKind, IconName>> = {
  success: 'check',
  warning: 'warning',
};
const UNSIZED_STATE_GLYPH_PX = 32;
const UNSIZED_STATE_GLYPH_GAP_PX = 8;

function SurfaceStateAdapter(authored: SurfaceStateProps & Readonly<{ actionSlot?: ReactNode }>): ReactElement {
  // While the host has one sentence about a part that cannot run now (its Machine cannot be reached), a
  // failure state says that sentence in its own place, with its own action, instead of its own copy:
  // the cause is said once, where it failed, and the host draws nothing of its own beside it.
  const hostSentence = useClaimedPluginUiSurfaceNotice(authored.kind === 'error' || authored.kind === 'unavailable');
  const hostAction = useContext(PluginUiSurfaceNoticeContext)?.action;
  const props = hostSentence === null ? authored : {
    ...authored, kind: 'warning' as const, title: hostSentence, titleKey: undefined,
    ...(hostAction ? { action: { label: hostAction.label, onPress: hostAction.onPress }, actionSlot: undefined } : {}),
    description: undefined, descriptionKey: undefined, note: undefined, noteKey: undefined, details: undefined, icon: undefined,
    body: undefined, live: undefined, actionCaption: undefined, secondaryAction: undefined, learnMore: undefined,
  };
  const translate = usePluginTranslation();
  const theme = usePluginTheme();
  const surfaceActivity = usePluginSurfaceActivity();
  const hostSize = useStateSize(undefined);
  const size = props.size ?? hostSize;
  const title = resolveAuthorText(translate, props.title, props.titleKey);
  const description = resolveAuthorText(translate, props.description, props.descriptionKey);
  const note = resolveAuthorText(translate, props.note, props.noteKey);
  const resolveAction = (action: SurfaceStateAction | undefined): HappierSurfaceStateAction | undefined => {
    if (!action) return undefined;
    const label = resolveAuthorText(translate, action.label, action.labelKey) ?? '';
    return { label, onPress: () => action.onPress() as void | Promise<unknown>, disabled: action.disabled, busy: action.busy, testID: action.testID };
  };
  const line = size === 'line';
  const metrics = size && size !== 'line' ? HAPPIER_STATE_SIZE_METRICS[size] : null;
  const loadingLabel = title ?? translate(STATE_LOADING_TRANSLATION_KEY, 'Loading');
  const iconName = props.icon ?? resolveHappierStateFailureGlyph(props.kind, line) ?? STATE_DEFAULT_GLYPH[props.kind];
  const glyph = props.kind === 'loading'
    ? <Spinner size={line ? HAPPIER_STATE_LINE_METRICS.glyphPx - 2 : metrics ? metrics.glyphPx - 4 : 28} accessibilityLabel={loadingLabel} />
    : iconName
      ? <PluginUiIconGlyph
          name={iconName}
          size={line ? HAPPIER_STATE_LINE_METRICS.glyphPx : metrics?.glyphPx ?? UNSIZED_STATE_GLYPH_PX}
          tone={line ? (props.kind === 'error' || props.kind === 'warning' ? 'warning' : 'muted') : 'secondary'}
        />
      : undefined;
  const bindings: HappierSurfaceStateBindings = {
    renderText: ({ role, metrics: textMetrics, align, testID, onPress, children }) => {
      if (role === 'quietLink') {
        return <HappierText testID={testID} accessibilityRole="link" onPress={onPress} tone="secondary" style={{ textDecorationLine: 'underline' }}>{children}</HappierText>;
      }
      if (role === 'details') return <HappierText accessible={false} variant="meta" tone="secondary">{children}</HappierText>;
      if (role === 'lineAction') return <HappierText tone="neutral" style={{ ...textMetrics, fontWeight: '600' }}>{children}</HappierText>;
      if (role === 'quiet') return <HappierText testID={testID} tone="muted" style={{ ...textMetrics, textAlign: align === 'start' ? 'auto' : 'center' }}>{children}</HappierText>;
      return <HappierText testID={testID} tone="secondary" tabularNumbers={role === 'live'} style={textMetrics}>{children}</HappierText>;
    },
    renderButton: ({ action, emphasis, tone, testID }) => (
      <Button
        testID={testID}
        title={action.label}
        variant={emphasis === 'secondary' ? 'plain' : tone === 'filled' ? 'primary' : 'secondary'}
        size="small"
        disabled={action.disabled}
        busy={action.busy}
        onPress={action.onPress}
      />
    ),
    renderSpinner: (sizePx) => (
      <HappierSpinner size={sizePx} color={theme.colors.mutedText} animationEnabled={surfaceActivity.active} />
    ),
    renderTile: (tile) => (
      <HappierInfoState action={tile.action} size={tile.size}>
        <HappierInfoTile
          size={tile.size}
          icon={tile.glyph ? (
            <View style={{ marginBottom: tile.size ? HAPPIER_STATE_SIZE_METRICS[tile.size].glyphGapPx : UNSIZED_STATE_GLYPH_GAP_PX }}>{tile.glyph}</View>
          ) : undefined}
          title={title}
          description={description}
        />
      </HappierInfoState>
    ),
    detailsLabel: translate(STATE_DETAILS_TRANSLATION_KEY, 'Details'),
    renderDetailsCaret: (open) => <HappierDisclosureCaret expanded={open} density="compact" />,
    focusRing: theme.colors.focus,
    pressedFill: theme.colors.control,
  };
  return (
    <HappierSurfaceState
      testID={props.testID}
      kind={props.kind}
      size={size}
      glyph={glyph}
      lineText={<>{title}{title && description ? ' · ' : null}{description}</>}
      live={props.live}
      body={line ? undefined : props.body}
      actionCaption={props.actionCaption}
      action={resolveAction(props.action)}
      secondaryAction={resolveAction(props.secondaryAction)}
      actionSlot={props.actionSlot}
      note={note}
      learnMore={resolveAction(props.learnMore)}
      diagnosticCode={props.details}
      accessibilitySemantics={props.accessibilitySemantics}
      bindings={bindings}
    />
  );
}

export type FreshnessLineProps = Readonly<{
  /** When the content still shown was last read. Omit when the reason alone says it ("Reconnecting…"). */
  asOf?: number | null;
  /** The clock `asOf` is told against; defaults to now. */
  now?: number;
  /** Why the content is behind, in the reader's words ("Channels isn't reachable on MacBook Pro"). */
  reason?: string;
  reasonKey?: string;
  /** A reconnect or refresh is in flight: a small ring replaces the glyph and the line is busy. */
  busy?: boolean;
  /** `warning` when the refresh failed rather than is merely pending. */
  tone?: 'neutral' | 'warning';
  /** The one recovery (Retry). */
  action?: Readonly<{ label: string; onPress: () => void }>;
  testID?: string;
}>;

/**
 * Stale content, told honestly (Happier's pane states, "Stale"): the rows a surface still has stay at
 * full strength and this one quiet line sits under its header — as of when, why, and one Retry. It is
 * the same line Happier's own panes draw (`HAPPIER_FRESHNESS_LINE_METRICS`, the one "as of" wording),
 * so a plugin tab that fell behind reads exactly like a host pane that did.
 *
 * Never over an empty body: a surface with nothing retained shows `LoadingState` or `ErrorState`.
 */
export function FreshnessLine(props: FreshnessLineProps): ReactElement {
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  const surfaceActivity = usePluginSurfaceActivity();
  const palette = useOptionalHappierUiPalette(theme);
  const parts = resolveHappierFreshnessText({
    asOf: props.asOf,
    now: props.now,
    reason: resolveAuthorText(translate, props.reason, props.reasonKey) ?? '',
    formatAsOf: (time) => translate(STATE_AS_OF_TRANSLATION_KEY, 'As of {time}').replace('{time}', time),
    parts: true,
  });
  const metrics = HAPPIER_FRESHNESS_LINE_METRICS;
  const glyphColor = props.tone === 'warning' ? theme.colors.warning : theme.colors.mutedText;
  return (
    <HappierFreshnessLine
      testID={props.testID}
      busy={props.busy}
      colors={{ background: palette?.inset ?? theme.colors.surface, border: palette?.sheetBorder ?? theme.colors.border }}
      icon={props.busy ? (
        <HappierSpinnerGlyph color={glyphColor} animationEnabled={surfaceActivity.active} />
      ) : (
        <PluginUiIconGlyph name={props.tone === 'warning' ? 'warning' : 'refresh'} size={metrics.glyphPx} tone={props.tone === 'warning' ? 'warning' : 'muted'} />
      )}
      action={props.action ? (
        <HappierPressable
          testID={props.testID ? `${props.testID}-action` : undefined}
          accessibilityRole="button"
          accessibilityLabel={props.action.label}
          hitSlop={6}
          onPress={props.action.onPress}
          style={{ minHeight: metrics.minHeightPx, justifyContent: 'center', paddingHorizontal: 4 }}
        >
          <HappierText tone="secondary" style={{ ...metrics.text, fontWeight: '600', textDecorationLine: 'underline' }}>
            {props.action.label}
          </HappierText>
        </HappierPressable>
      ) : null}
    >
      <View accessible accessibilityLabel={parts.text}>
        <HappierFreshnessClauses
          asOf={parts.asOf === null ? null : <HappierText tone="secondary" numberOfLines={1} tabularNumbers style={metrics.text}>{parts.asOf}</HappierText>}
          reason={parts.reason ? <HappierText tone="secondary" numberOfLines={2} tabularNumbers style={metrics.text}>{parts.reason}</HappierText> : null}
          separator={(hidden) => (
            <HappierText tone="secondary" accessible={false} tabularNumbers style={[metrics.text, hidden ? { opacity: 0 } : null]}>{' · '}</HappierText>
          )}
        />
      </View>
    </HappierFreshnessLine>
  );
}

function HappierSpinnerGlyph(props: Readonly<{ color: string; animationEnabled: boolean }>): ReactElement {
  return (
    <HappierSpinner
      size={HAPPIER_FRESHNESS_LINE_METRICS.glyphPx - 1}
      color={props.color}
      animationEnabled={props.animationEnabled}
    />
  );
}

export type StateProps = Readonly<{
  resource?: PluginUiResourceSnapshot;
  /** The consumer knows whether the admitted Resource content is empty. */
  isEmpty?: boolean;
  onRetry?: () => unknown;
  /** Replaces the default {@link LoadingState}. */
  loading?: ReactNode;
  /** Replaces the default {@link EmptyState}. */
  empty?: ReactNode;
  /** Replaces the default {@link ErrorState}. */
  error?: ReactNode | ((state: PluginUiResourceSnapshot) => ReactNode);
  children?: ReactNode | ((value: ResourceContent) => ReactNode);
}>;

/**
 * Present the Resource owner's independent value, pending and error facts.
 * Retain admitted children while refreshing or reporting a failed refresh;
 * before admission, render the shared loading, failure or empty presentation.
 * Framework defaults resolve through the mounted host's translation projection.
 */
export function State({
  resource,
  isEmpty,
  onRetry,
  loading,
  empty,
  error,
  children,
}: StateProps): ReactElement | null {
  const translate = usePluginTranslation();
  if (resource?.value !== undefined) {
    const retained = isEmpty
      ? empty ?? <EmptyState title={translate(STATE_EMPTY_TRANSLATION_KEY, 'Nothing to show')} />
      : typeof children === 'function' ? children(resource.value) : children;
    const refreshing = resource.pending === 'refresh';
    return <>
      {retained}
      {refreshing || resource.error || resource.freshness === 'stale' ? (
        <FreshnessLine
          busy={refreshing}
          reason={resource.error?.message ?? (refreshing
            ? translate(STATE_REFRESHING_TRANSLATION_KEY, 'Refreshing plugin content')
            : translate(STATE_STALE_TRANSLATION_KEY, 'Plugin content may be out of date'))}
          tone={resource.error ? 'warning' : 'neutral'}
          action={onRetry ? { label: translate(STATE_RETRY_TRANSLATION_KEY, 'Retry'), onPress: () => { void onRetry(); } } : undefined}
        />
      ) : null}
    </>;
  }
  if (!resource || resource.pending === 'initial') {
    return <>{loading ?? <LoadingState />}</>;
  }
  if (resource.error) {
    if (error !== undefined) {
      return <>{typeof error === 'function' ? error(resource) : error}</>;
    }
    return <ErrorState title={translate(STATE_ERROR_TRANSLATION_KEY, 'Something went wrong')} onRetry={onRetry} />;
  }
  return <>{empty ?? <EmptyState title={translate(STATE_EMPTY_TRANSLATION_KEY, 'Nothing to show')} />}</>;
}
