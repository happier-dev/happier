import { type ReactElement, type ReactNode } from 'react';
import { View } from 'react-native';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
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
  HappierSurfaceStateFrame,
  HappierStateLine,
  HappierStateDetails,
  resolveHappierStateAnnouncement,
  resolveHappierStateFailureGlyph,
  HAPPIER_STATE_LINE_METRICS,
  type HappierStateSize,
} from '../presentation/state/InfoState.js';
import { useHappierPageChrome } from '../presentation/layout/pageChrome.js';
import { useOptionalHappierUiPalette } from '../environment/context.js';
import { HappierPressable } from '../presentation/interaction/Pressable.js';
import { HappierText } from '../presentation/text/Text.js';
import { PluginUiIconGlyph, type IconName } from './Icon.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';
import { Spinner } from './Spinner.js';
import { HappierSpinner } from '../presentation/feedback/Spinner.js';

const STATE_LOADING_TRANSLATION_KEY = 'happier.plugin-ui.state.loading';
const STATE_EMPTY_TRANSLATION_KEY = 'happier.plugin-ui.state.empty';
const STATE_ERROR_TRANSLATION_KEY = 'happier.plugin-ui.state.error';
const STATE_DETAILS_TRANSLATION_KEY = 'happier.plugin-ui.state.details';
const STATE_AS_OF_TRANSLATION_KEY = 'happier.plugin-ui.state.asOf';

/**
 * The size a state is drawn at: the author's, else the container the host mounted the surface in
 * (a session sidebar tab is a `pane`), else the unsized centred column.
 */
function useStateSize(size: HappierStateSize | undefined): HappierStateSize | undefined {
  const hostSize = useOptionalPluginUiPresentationHost()?.stateSize;
  return size ?? hostSize;
}

export type PluginUiResourceState<Value = unknown> =
  | Readonly<{ status: 'idle' | 'loading' }>
  | Readonly<{ status: 'ready'; value: Value }>
  | Readonly<{ status: 'empty' }>
  | Readonly<{ status: 'unavailable' | 'stale' | 'complete'; diagnostics?: readonly string[] }>
  | Readonly<{ status: 'error'; code?: string; message?: string; diagnostics?: readonly string[] }>;

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
  const { translate, title, description } = useResolvedCopy(props);
  const size = useStateSize(props.size);
  if (props.layout === 'line') return <HappierStateLine testID={props.testID} accessibilitySemantics={props.accessibilitySemantics} icon={<Spinner size={HAPPIER_STATE_LINE_METRICS.glyphPx - 2} accessibilityLabel={title ?? translate(STATE_LOADING_TRANSLATION_KEY, 'Loading')} />} action={props.action}>
    <HappierText tone="secondary" style={HAPPIER_STATE_LINE_METRICS.text}>{title}{title && description ? ' · ' : null}{description}</HappierText>
  </HappierStateLine>;
  return (
    <HappierSurfaceStateFrame testID={props.testID} size={size} accessibilitySemantics={props.accessibilitySemantics}>
    <HappierInfoState action={props.action} size={size}>
      <HappierInfoTile
        icon={<View style={{ marginBottom: size ? HAPPIER_STATE_SIZE_METRICS[size].glyphGapPx : 0 }}><Spinner size={size ? HAPPIER_STATE_SIZE_METRICS[size].glyphPx - 4 : 28} accessibilityLabel={title ?? translate(STATE_LOADING_TRANSLATION_KEY, 'Loading')} /></View>}
        title={title}
        description={description}
        size={size}
      />
    </HappierInfoState>
    </HappierSurfaceStateFrame>
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
  const stateSize = useStateSize(props.size);
  const unavailableReason = resolveAuthorText(
    translate,
    props.actionUnavailableReason,
    props.actionUnavailableReasonKey,
  );

  if (props.layout === 'line') {
    return (
      <HappierStateLine
        testID={props.testID}
        accessibilitySemantics={props.accessibilitySemantics}
        action={props.action ?? (unavailableReason ? (
          <HappierText variant="caption" tone="secondary">{unavailableReason}</HappierText>
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
  const page = props.layout === 'page';
  const size = page ? undefined : stateSize;
  const state = (
    <HappierInfoState testID={add || page ? undefined : props.testID} action={action} size={size}>
      <HappierInfoTile
        icon={props.icon ? (
          <View style={size ? { marginBottom: HAPPIER_STATE_SIZE_METRICS[size].glyphGapPx } : undefined}>
            <PluginUiIconGlyph name={props.icon} size={size ? HAPPIER_STATE_SIZE_METRICS[size].glyphPx : 24} tone="secondary" />
          </View>
        ) : undefined}
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
  const { translate, title, description } = useResolvedCopy(props);
  const size = useStateSize(props.size);
  const glyph = resolveHappierStateFailureGlyph(props.kind ?? 'error', props.layout === 'line')!;
  if (props.layout === 'line') return <HappierStateLine testID={props.testID} accessibilitySemantics={props.accessibilitySemantics} icon={<PluginUiIconGlyph name={glyph} size={HAPPIER_STATE_LINE_METRICS.glyphPx} tone={glyph === 'warning' ? 'warning' : 'muted'} />} action={props.action}>
    <HappierText tone="secondary" style={HAPPIER_STATE_LINE_METRICS.text}>{title}{title && description ? ' · ' : null}{description}</HappierText>
  </HappierStateLine>;
  const state = (
    <HappierInfoState
      action={props.action}
      size={size}
    >
      <HappierInfoTile
        size={size}
        icon={(
          <View style={{ marginBottom: size ? HAPPIER_STATE_SIZE_METRICS[size].glyphGapPx : ERROR_STATE_GLYPH_GAP }}>
            <PluginUiIconGlyph name={glyph} size={size ? HAPPIER_STATE_SIZE_METRICS[size].glyphPx : 32} tone="secondary" />
          </View>
        )}
        title={title}
        description={description}
      />
    </HappierInfoState>
  );
  return (
    <HappierSurfaceStateFrame testID={props.testID} size={size}>
      <View {...resolveHappierStateAnnouncement(props.accessibilitySemantics)} style={{ width: '100%' }}>
      {state}
      </View>
      {props.details ? <HappierStateDetails testID={props.testID} label={translate(STATE_DETAILS_TRANSLATION_KEY, 'Details')} details={props.details} /> : null}
    </HappierSurfaceStateFrame>
  );
}

const ERROR_STATE_GLYPH_GAP = 8;

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
  const text = resolveHappierFreshnessText({
    asOf: props.asOf,
    now: props.now,
    reason: resolveAuthorText(translate, props.reason, props.reasonKey) ?? '',
    formatAsOf: (time) => translate(STATE_AS_OF_TRANSLATION_KEY, 'As of {time}').replace('{time}', time),
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
      <HappierText tone="secondary" numberOfLines={2} tabularNumbers style={metrics.text}>{text}</HappierText>
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

export type StateProps<Value> = Readonly<{
  resource?: PluginUiResourceState<Value>;
  /** Replaces the default {@link LoadingState}. */
  loading?: ReactNode;
  /** Replaces the default {@link EmptyState}. */
  empty?: ReactNode;
  /** Replaces the default {@link ErrorState}. */
  error?: ReactNode | ((state: Extract<PluginUiResourceState<Value>, { status: 'error' }>) => ReactNode);
  children?: ReactNode | ((value: Value) => ReactNode);
}>;

/**
 * Render exactly one presentation for a resource snapshot.
 *
 * Every non-ready status resolves to a real component. The predecessor wrapped
 * whatever the author supplied in an inert marker element and rendered NOTHING
 * when a slot was omitted, so a surface waiting on a resource showed a blank
 * area. Framework-owned defaults resolve through the host's translation
 * projection; their English fallbacks keep isolated and older hosts readable.
 */
export function State<Value>({
  resource,
  loading,
  empty,
  error,
  children,
}: StateProps<Value>): ReactElement | null {
  const translate = usePluginTranslation();
  if (!resource || resource.status === 'idle' || resource.status === 'loading') {
    return <>{loading ?? <LoadingState />}</>;
  }
  if (resource.status === 'empty') {
    return <>{empty ?? <EmptyState title={translate(STATE_EMPTY_TRANSLATION_KEY, 'Nothing to show')} />}</>;
  }
  if (resource.status === 'error') {
    if (error !== undefined) {
      return <>{typeof error === 'function' ? error(resource) : error}</>;
    }
    return <ErrorState title={translate(STATE_ERROR_TRANSLATION_KEY, 'Something went wrong')} />;
  }
  if (resource.status === 'ready') {
    return <>{typeof children === 'function' ? children(resource.value) : children}</>;
  }
  // `unavailable` / `stale` / `complete` carry no value, so a render-prop child
  // has nothing to receive; a static child still describes the surface.
  return <>{typeof children === 'function' ? null : children}</>;
}
