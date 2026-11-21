import * as React from 'react';
import {
  Platform,
  ScrollView,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { createNearViewportTracker } from '@/components/widgets/nearViewport';
import { PAGE_ROW_TOUCH_MIN_HEIGHT_PX } from '@/components/ui/lists/pageRowMetrics';
import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { MarkdownInlineReferences } from '@/components/markdown/MarkdownView';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { Modal } from '@/modal';
import { t } from '@/text';

import { ScmDiffSummaryFailureNotice } from '@/components/sessions/files/comparison/ScmDiffSummaryFailureNotice';
import {
  SCM_DIFF_SUMMARY_GENERIC_FAILURE,
  type ScmDiffSummaryFailurePresentation,
  type ScmDiffSummaryRestoreState,
  type ScmDiffSummaryViewModel,
} from '@/sync/domains/scm/diffSummary/state';
import { WalkthroughContents } from './WalkthroughContents';
import { WalkthroughEditorialHeader } from './WalkthroughEditorialHeader';
import { useReviewKeyboard } from '@/components/workspaces/scm/review/hunkReview/useReviewKeyboard';
import { isKeyboardTargetHidden } from '@/keyboard/runtime';
import {
  WalkthroughInventory,
  WalkthroughOtherChanges,
} from './WalkthroughLifecycle';
import { WalkthroughEvidencePresentation, WalkthroughStopSection, type WalkthroughFindProps } from './WalkthroughStopSection';
import { isWalkthroughOtherFindKey, useWalkthroughFind } from './walkthroughFind';
import { ChangedFilesReviewFindSurface } from '@/components/workspaces/scm/review/ChangedFilesReviewFind';
import type { ReviewFindTarget } from '@/components/workspaces/scm/review/useChangedFilesReviewFind';
import type { WalkthroughReading, WalkthroughStop } from './walkthroughReading';
import type { WalkthroughReviewedSource } from './walkthroughReviewedProjection';
import { useWalkthroughReviewedStop } from './useWalkthroughReviewed';

export type WalkthroughViewLayout = 'wide' | 'narrow' | 'phone';

/**
 * What a review adds to the reading (Walkthrough lab WT5), as slots so the review owner draws its own
 * findings: a dot per stop in the contents, chips after a stop's prose and finding cards after its
 * hunks, a review line and note in the header, the findings published first, the tail of findings no
 * stop explains, and a partial-review band. The reading itself never changes for them.
 */
export type WalkthroughReviewSlots = Readonly<{
  stopAccessory?: (stopId: string) => React.ReactNode;
  renderStopFindings?: (
    stop: WalkthroughStop,
    nav: Readonly<{
      scrollToStop: (stopId: string) => void;
      scrollToFindings: () => void;
    }>,
  ) => Readonly<{
    refs?: React.ReactNode;
    cards?: React.ReactNode;
    /** Findings the prose cites inline, drawn where the narrator placed them. */
    proseReferences?: MarkdownInlineReferences;
    /** Above the stop's code: an explanation asked for explicitly (lab WT5-R2). */
    explanation?: React.ReactNode;
  }> | null;
  headerFact?: React.ReactNode;
  headerNote?: React.ReactNode;
  beforeHeader?: React.ReactNode;
  afterStops?: React.ReactNode;
  notice?: React.ReactNode;
  /** What the eyebrow says while the walkthrough is being written ("Writing the walkthrough with the findings…"). */
  writingLabel?: string;
}>;

export type WalkthroughViewProps = Readonly<{
  reading: WalkthroughReading;
  presentFileEvidence?: (path: string) => void;
  restoreState?: ScmDiffSummaryRestoreState;
  onRetryRestore?: () => void;
  /** Unknown Start observation, separate from the still-admissible pending output. UI recovery must reread before an explicit new attempt. */
  admission?: ScmDiffSummaryViewModel['admission'];
  onCheckAdmission?: () => void | Promise<void>;
  scopeLabel: string;
  scopeDetail?: string | null;
  modelLabel?: string | null;
  /** What the Generated mark says when it is more than the model (a review's narrator, lab WT5-R9). */
  generatedLabel?: string | null;
  analysisMark?: React.ReactNode;
  /** wide: contents rail beside the stream · narrow: the drawer's single column · phone: the pushed route. */
  layout: WalkthroughViewLayout;
  /** Keys and the phone bar act only while this view is in front. */
  active?: boolean;
  initialStopId?: string | null;
  /** The overview strip starts open (it is collapsed by default). */
  initialOverviewOpen?: boolean;
  /** Explicit marks (account KV); absent hides Mark reviewed. */
  onToggleReviewed?: (stop: WalkthroughStop) => void;
  marksDisabledReason?: string | null;
  /** The matching Account record has loaded; unknown marks are not confirmed zero progress. */
  reviewedProgressAvailable?: boolean;
  /** The Account record is still being read: the header holds the reviewed fact's room. */
  reviewedProgressPending?: boolean;
  /** Discuss with the generator; absent when it cannot take a turn. */
  onAsk?: (stop: WalkthroughStop, question?: string) => void;
  /** Ask is being resolved (the generator not yet observed): the phone bar keeps its slot, disabled, so nothing shifts. */
  askPending?: boolean;
  askingStopId?: string | null;
  onOpenFile?: (path: string) => void;
  onShowFiles?: () => void;
  /** Files changed after this was written (the comparison's freshness). */
  stale?: Readonly<{ onRefresh?: () => void }> | null;
  /** The owning machine is unreachable; the last-loaded reading stays readable. */
  offline?: Readonly<{ machine: string; time: string }> | null;
  /** A visible update to the saved result (a structured refinement), with Undo when the owner offers it. */
  /** What a refinement changed: its lead ("Merged stops 2 and 3") and, when it says more, the rest of the sentence. */
  update?: Readonly<{ title: string; description?: string; onUndo?: () => void }> | null;
  onRetry?: () => void;
  onChooseModel?: () => void;
  /** The typed refusal or failure of the last generation, drawn as a notice over whatever reading is shown. */
  failure?: ScmDiffSummaryFailurePresentation | null;
  onEnableExplain?: () => void;
  /** Start, with what belongs beside it (the model it will use, why it did not start) in `options`. */
  start?: Readonly<{
    options: React.ReactNode;
    onStart: () => void | Promise<unknown>;
    busy?: boolean;
    disabled?: boolean;
  }>;
  endedConversation?: Readonly<{
    onStartNew?: () => void;
    onAskSession: () => void;
  }> | null;
  /** Revisioned result controls, supplied by the saved-result consumer. */
  savedActions?: React.ReactNode;
  /** A review's findings beside the stops; absent for a walkthrough no review produced. */
  review?: WalkthroughReviewSlots | null;
  /** The notification offer for a walkthrough still being written; shown only while it is. */
  notify?: React.ReactNode;
  /** The Find surface id the comparison bar's Find control opens; keyboard Find works without it. */
  findSurfaceId?: string;
  /**
   * Hosted by a page that already heads the comparison and states its review (a Review's Changes tab): the
   * reading starts at its first stop, without its own title, facts, overview or the review's band.
   */
  hosted?: boolean;
}>;

/**
 * The stream's column (lab WT1-A): one readable measure that starts after the contents rail at the
 * stream's gutter, so the rail and the text it lists read as one unit. A wider tab leaves its extra
 * room after the text, never between the rail and the text.
 */
const STREAM_COLUMN_MAX_WIDTH_PX = 760;
/** How far below the viewport top a stop must reach to count as the one being read. */
const CURRENT_STOP_READING_LINE_PX = 96;

/**
 * The Walkthrough view of a comparison (lab WT1-A, A3, Ap, A2p; WT2; WT3 bands). Layout A: one reading
 * scroll owner, a contents rail, B's editorial header with the optional overview strip, prose above its
 * exact hunks, and the other changes at the end. Everything it shows comes from {@link WalkthroughReading}.
 */
export const WalkthroughView = React.memo(function WalkthroughView(
  props: WalkthroughViewProps,
) {
  const { theme } = useUnistyles();
  const reviewedSource = props.reading.reviewedSource;
  const reading = reviewedSource?.base ?? props.reading;
  const phone = props.layout === 'phone';
  const reducedMotion = useReducedMotionPreference();
  const rootRef = React.useRef<View>(null);
  const scrollRef = React.useRef<ScrollView>(null);
  const hasEvidenceReader = Boolean(props.presentFileEvidence);
  const nativeViewport = React.useMemo(() => {
    if (!hasEvidenceReader || Platform.OS === 'web') return null;
    const tracker = createNearViewportTracker({ initialViewportHeight: 0, overscan: false, quantum: PAGE_ROW_TOUCH_MIN_HEIGHT_PX,
      readContentNode: () => scrollRef.current?.getInnerViewRef?.() });
    return { ...tracker, getWindow: tracker.getVisibleWindow, subscribe: (listener: () => void) => {
      const stopLayout = tracker.subscribe(listener);
      const stopScroll = tracker.subscribeVisibleWindow(listener);
      return () => { stopLayout(); stopScroll(); };
    } };
  }, [hasEvidenceReader]);
  const evidencePresentation = React.useMemo(() => props.active !== false && props.presentFileEvidence
    ? { present: props.presentFileEvidence, nativeViewport } : null,
  [nativeViewport, props.active, props.presentFileEvidence]);
  const stopOffsets = React.useRef(new Map<string, number>());
  const othersOffset = React.useRef<number | null>(null);
  const findingsOffset = React.useRef<number | null>(null);
  const streamOffset = React.useRef(0);
  const scrollTop = React.useRef(0);
  // The phone column's Find focus root; the wide root also scopes the review keys.
  const phoneRootRef = React.useRef<View>(null);
  const firstUnread =
    (reviewedSource?.getSnapshot().stops ?? reading.stops).find((stop) => !stop.reviewed) ?? reading.stops[0];
  const [currentStopId, setCurrentStopId] = React.useState<string | null>(
    props.initialStopId ?? firstUnread?.id ?? null,
  );
  const [overviewOpen, setOverviewOpen] = React.useState(
    props.initialOverviewOpen === true,
  );
  const [checkingAdmission, setCheckingAdmission] = React.useState(false);
  const onCheckAdmission = props.onCheckAdmission;
  const checkAdmission = React.useCallback(() => {
    if (!onCheckAdmission || checkingAdmission) return;
    setCheckingAdmission(true);
    void Promise.resolve(onCheckAdmission()).finally(() => setCheckingAdmission(false));
  }, [onCheckAdmission, checkingAdmission]);
  // Stops present on first paint appear as they are; only later arrivals while writing fade into their slot.
  const initialStopIds = React.useRef(
    new Set(reading.stops.map((stop) => stop.id)),
  );

  const currentStop =
    reading.stops.find((stop) => stop.id === currentStopId) ??
    firstUnread ??
    null;
  const currentIndex = currentStop ? reading.stops.indexOf(currentStop) : -1;

  // Find over every stop's code and the changes outside stops, through the Files review's Find owner. A step
  // into an other change opens its code in place of its row; those stay open until Find closes, so nothing above the
  // reader jumps as they step on.
  const [findTarget, setFindTarget] = React.useState<ReviewFindTarget | null>(null);
  const [revealedOthers, setRevealedOthers] = React.useState<ReadonlySet<string>>(EMPTY_KEYS);
  const revealFindTarget = React.useCallback((target: ReviewFindTarget | null) => {
    setFindTarget((previous) => previous?.filePath === target?.filePath && previous?.lineId === target?.lineId ? previous : target);
    if (target && isWalkthroughOtherFindKey(target.filePath))
      setRevealedOthers((previous) => previous.has(target.filePath) ? previous : new Set([...previous, target.filePath]));
  }, []);
  const find = useWalkthroughFind(reading, revealFindTarget);
  const findOpen = React.useSyncExternalStore(find.subscribe, () => find.getSnapshot().open, () => find.getSnapshot().open);
  React.useEffect(() => { if (!findOpen) setRevealedOthers(EMPTY_KEYS); }, [findOpen]);
  const fallbackFindSurfaceId = React.useId();
  const findSurfaceId = props.findSurfaceId ?? `walkthrough:${fallbackFindSurfaceId}`;
  // Native renderers report the target's window offset; the reading's one scroll owner lands it.
  const scrollToFindLine = React.useCallback((windowY: number) => {
    const scroll = scrollRef.current as unknown as { measureInWindow?: (callback: (x: number, y: number) => void) => void } | null;
    scroll?.measureInWindow?.((_x, viewportY) => {
      scrollRef.current?.scrollTo({ y: Math.max(0, scrollTop.current + windowY - viewportY - (phone ? 52 : 0) - CURRENT_STOP_READING_LINE_PX), animated: false });
    });
  }, [phone]);
  const findProps = React.useMemo<WalkthroughFindProps>(() => ({
    model: find, active: findOpen, target: findOpen ? findTarget : null, onScrollToLine: scrollToFindLine,
  }), [find, findOpen, findTarget, scrollToFindLine]);

  // An edit chosen from the comparison menu opens under the header: bring it into view, wherever the reader is.
  const headerOffset = React.useRef(0);
  const savedOffset = React.useRef<number | null>(null);
  const savedOpen = Boolean(props.savedActions);
  const savedWasOpen = React.useRef(savedOpen);
  React.useEffect(() => {
    if (savedOpen && !savedWasOpen.current && savedOffset.current !== null) {
      scrollRef.current?.scrollTo({
        y: Math.max(0, headerOffset.current + savedOffset.current),
        animated: false,
      });
    }
    savedWasOpen.current = savedOpen;
  }, [savedOpen]);
  const scrollToStop = React.useCallback(
    (stopId: string) => {
      setCurrentStopId(stopId);
      const y = stopOffsets.current.get(stopId);
      if (typeof y === 'number')
        scrollRef.current?.scrollTo({
          y: Math.max(0, y + streamOffset.current - (phone ? 52 : 0)),
          animated: false,
        });
    },
    [phone],
  );
  // A reading that begins past its first stop (the next unread one) opens on it, so the stop the bar and rail name
  // is the one on screen; once measured, and only if the reader has not scrolled first.
  const landingStopId = React.useRef(
    currentStopId !== null && currentStopId !== reading.stops[0]?.id ? currentStopId : null,
  );
  const streamMeasured = React.useRef(false);
  const land = React.useCallback(() => {
    const stopId = landingStopId.current;
    if (!stopId || !streamMeasured.current || !stopOffsets.current.has(stopId)) return;
    landingStopId.current = null;
    scrollToStop(stopId);
  }, [scrollToStop]);
  const measureStream = React.useCallback((event: LayoutChangeEvent) => {
    streamOffset.current = event.nativeEvent.layout.y;
    streamMeasured.current = true;
    land();
  }, [land]);
  const move = React.useCallback(
    (direction: 1 | -1) => {
      const next =
        reading.stops[
          Math.min(
            reading.stops.length - 1,
            Math.max(0, currentIndex + direction),
          )
        ];
      if (next) scrollToStop(next.id);
    },
    [currentIndex, reading.stops, scrollToStop],
  );
  const scrollToOthers = React.useCallback(() => {
    if (othersOffset.current !== null)
      scrollRef.current?.scrollTo({
        y: othersOffset.current + streamOffset.current,
        animated: false,
      });
  }, []);
  const scrollToFindings = React.useCallback(() => {
    if (findingsOffset.current !== null)
      scrollRef.current?.scrollTo({
        y: Math.max(
          0,
          findingsOffset.current + streamOffset.current - (phone ? 52 : 0),
        ),
        animated: false,
      });
  }, [phone]);

  const onScroll = React.useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      nativeViewport?.onScroll(event);
      scrollTop.current = event.nativeEvent.contentOffset.y;
      if (scrollTop.current > 0) landingStopId.current = null;
      const line =
        event.nativeEvent.contentOffset.y +
        CURRENT_STOP_READING_LINE_PX -
        streamOffset.current;
      let reached: string | null = null;
      for (const stop of reading.stops) {
        const y = stopOffsets.current.get(stop.id);
        if (typeof y === 'number' && y <= line) reached = stop.id;
      }
      if (reached)
        setCurrentStopId((current) =>
          current === reached ? current : reached,
        );
    },
    [nativeViewport, reading.stops],
  );

  const onToggleReviewed = props.onToggleReviewed;
  const onAsk = props.onAsk;
  const marksBlocked = Boolean(props.marksDisabledReason);
  const toggleCurrent = React.useMemo(
    () =>
      onToggleReviewed && currentStop && !marksBlocked
        ? () => onToggleReviewed(reviewedSource?.getStop(currentStop.id) ?? currentStop)
        : undefined,
    [currentStop, marksBlocked, onToggleReviewed, reviewedSource],
  );
  const askCurrent = React.useMemo(
    () =>
      onAsk && currentStop && !props.offline
        ? () => onAsk(currentStop)
        : undefined,
    [currentStop, onAsk, props.offline],
  );

  const openContentsSheet = React.useCallback(() => {
    let id: string | null = null;
    const close = () => {
      if (id) Modal.hide(id);
      id = null;
    };
    id = Modal.show({
      component: WalkthroughContentsSheet,
      props: {
        stops: reading.stops,
        reviewedSource,
        others: reading.others,
        reviewedCount:
          props.reviewedProgressAvailable === false
            ? null
            : reading.reviewedCount,
        currentStopId: currentStop?.id ?? null,
        onSelectStop: (stopId: string) => {
          close();
          scrollToStop(stopId);
        },
        onSelectOthers: () => {
          close();
          scrollToOthers();
        },
      },
      chrome: {
        kind: 'card',
        header: 'none',
        title: t('walkthrough.contents'),
        phonePresentation: 'sheet',
      },
      closeOnBackdrop: true,
      onRequestClose: close,
    });
  }, [
    currentStop?.id,
    props.reviewedProgressAvailable,
    reading.others,
    reading.reviewedCount,
    reading.stops,
    reviewedSource,
    scrollToOthers,
    scrollToStop,
  ]);

  useReviewKeyboard({
    next: () => move(1), previous: () => move(-1), keepCurrent: toggleCurrent, askCurrent,
  }, {
    active: props.active !== false && reading.stops.length > 0,
    containsFocus: () => {
      const element = rootRef.current as unknown as HTMLElement | null;
      if (typeof document === 'undefined') return true;
      if (!element?.isConnected || isKeyboardTargetHidden(element)) return false;
      if (document.activeElement && isKeyboardTargetHidden(document.activeElement)) {
        element.focus({ preventScroll: true });
        return true;
      }
      return element.contains(document.activeElement);
    },
  });

  if (reading.phase === 'none') {
    if (props.restoreState === 'restoring') {
      return (
        <SurfaceStateCard
          testID="walkthrough-restoring"
          kind="loading"
          title={t('walkthrough.restoring')}
        />
      );
    }
    if (props.restoreState === 'unavailable') {
      return (
        <SurfaceStateCard
          testID="walkthrough-unavailable"
          kind="error"
          title={t('walkthrough.restoreFailedTitle')}
          reason={t('walkthrough.restoreFailedReason')}
          action={
            props.onRetryRestore
              ? { label: t('common.retry'), onPress: props.onRetryRestore }
              : undefined
          }
        />
      );
    }
    return (
      <SurfaceStateCard
        testID="walkthrough-none"
        kind="empty"
        iconName="path"
        title={t('walkthrough.none.title')}
        reason={t('walkthrough.none.reason')}
        action={
          props.start
            ? {
                testID: 'walkthrough-start',
                label: t('walkthroughStart.start'),
                onPress: props.start.onStart,
                busy: props.start.busy,
                disabled: props.start.disabled,
              }
            : props.onShowFiles
              ? {
                  label: t('walkthrough.none.showFiles'),
                  onPress: props.onShowFiles,
                }
              : undefined
        }
        secondaryAction={
          props.start && props.onShowFiles
            ? {
                label: t('walkthrough.none.showFiles'),
                onPress: props.onShowFiles,
              }
            : undefined
        }
        actionFooter={props.start?.options}
      />
    );
  }

  // The Start may not have reached the Machine: whatever was captured stays readable, but nothing here is being written.
  const uncertainStart =
    props.admission === 'outcomeUnknown' &&
    (reading.phase === 'inventory' || reading.phase === 'arriving');
  const notices: React.ReactNode[] = [];
  if (props.review?.notice && !props.hosted)
    notices.push(
      <React.Fragment key="review">{props.review.notice}</React.Fragment>,
    );
  if (uncertainStart) {
    notices.push(
      <AttentionBanner
        key="unknown"
        placement="inline"
        announce="status"
        testID="walkthrough-notice-unknown"
        tone="warning"
        iconName="question"
        title={t('walkthrough.notice.unknownStart')}
        description={t('walkthrough.notice.unknownStartReason')}
        secondaryAction={
          props.onCheckAdmission
            ? {
                testID: 'walkthrough-check-admission',
                label: t('walkthrough.notice.checkAgain'),
                onPress: checkAdmission,
                disabled: checkingAdmission,
              }
            : null
        }
      />,
    );
  }
  if (props.endedConversation && !props.offline) {
    notices.push(
      <AttentionBanner
        key="ended"
        placement="inline"
        announce="status"
        testID="walkthrough-notice-ended"
        tone="neutral"
        iconName="chat-circle-dots"
        title={t('walkthroughStart.ended')}
        action={
          props.endedConversation.onStartNew
            ? {
                testID: 'walkthrough-start-conversation',
                label: t('walkthroughStart.newConversation'),
                onPress: props.endedConversation.onStartNew,
              }
            : null
        }
        secondaryAction={{
          testID: 'walkthrough-ask-session',
          label: t('walkthroughStart.askSession'),
          onPress: props.endedConversation.onAskSession,
        }}
      />,
    );
  }
  // Retained reading that is behind (offline, or files changed since) is the shared freshness line: the
  // same strip the Files view shows for its stale snapshot, so one fact reads the same in both views.
  if (props.offline) {
    notices.push(
      <SurfaceFreshnessLine
        key="offline"
        testID="walkthrough-notice-offline"
        reason={t('walkthrough.notice.offline', props.offline)}
      />,
    );
  }
  if (props.update) {
    notices.push(
      <AttentionBanner
        key="update"
        placement="inline"
        announce="status"
        testID="walkthrough-notice-update"
        tone="neutral"
        iconName="path"
        title={props.update.title}
        description={props.update.description}
        secondaryAction={
          props.update.onUndo
            ? {
                testID: 'walkthrough-undo',
                label: t('walkthrough.notice.undo'),
                onPress: props.update.onUndo,
              }
            : null
        }
      />,
    );
  }
  if (props.stale && !props.offline) {
    notices.push(
      <SurfaceFreshnessLine
        key="stale"
        testID="walkthrough-notice-stale"
        reason={t('walkthrough.notice.stale')}
        action={
          props.stale.onRefresh
            ? {
                testID: 'walkthrough-refresh',
                label: t('walkthrough.notice.refresh'),
                onPress: props.stale.onRefresh,
              }
            : undefined
        }
      />,
    );
  }
  // One failure presenter for every non-empty state: the store's typed failure (a refused regeneration of a kept
  // reading, an admitted failed output), or the generic one for a reading that failed with nothing recorded.
  const failure =
    props.failure ??
    (reading.phase === 'failed' ? SCM_DIFF_SUMMARY_GENERIC_FAILURE : null);
  if (failure) {
    notices.push(
      <ScmDiffSummaryFailureNotice
        key="failed"
        testID="walkthrough"
        failure={failure}
        lead={reading.phase === 'partial' && reading.stops.length > 0 ? t('walkthrough.notice.stoppedAfter', { count: reading.stops.length }) : undefined}
        onChooseModel={props.offline ? undefined : props.onChooseModel}
        onEnableExplain={props.offline ? undefined : props.onEnableExplain}
        onRetry={props.offline ? undefined : props.onRetry}
      />,
    );
  }
  // A typed cancellation already says it, with Try again, in the failure strip above.
  if (reading.phase === 'cancelled' && !failure) {
    notices.push(
      <AttentionBanner
        key="cancelled"
        placement="inline"
        announce="status"
        testID="walkthrough-notice-cancelled"
        tone="neutral"
        iconName="stop-circle"
        title={t('walkthrough.notice.cancelled')}
      />,
    );
  }
  if (reading.source.inventoryState !== 'complete') {
    notices.push(
      <AttentionBanner
        key="incomplete"
        placement="inline"
        announce="status"
        testID="walkthrough-notice-incomplete"
        tone="warning"
        title={t('walkthrough.notice.incomplete')}
      />,
    );
  }

  const header = (
    <View
      onLayout={(event) => {
        headerOffset.current = event.nativeEvent.layout.y;
      }}
    >
      {props.hosted ? null : props.review?.beforeHeader}
      {props.hosted ? null : <WalkthroughEditorialHeader
        reading={reading}
        scopeLabel={props.scopeLabel}
        scopeDetail={props.scopeDetail}
        modelLabel={props.modelLabel}
        generatedLabel={props.generatedLabel}
        analysisMark={props.analysisMark}
        reviewedProgressAvailable={props.reviewedProgressAvailable}
        reviewedProgressPending={props.reviewedProgressPending}
        phone={phone}
        narrow={props.layout === 'narrow'}
        overviewOpen={overviewOpen}
        onToggleOverview={() => setOverviewOpen((open) => !open)}
        highlightedStopId={currentStop?.id ?? null}
        onSelectStop={scrollToStop}
        writingLabel={props.review?.writingLabel}
        uncertain={uncertainStart}
        extraFact={props.review?.headerFact}
        note={props.review?.headerNote}
      />}
      <View
        style={phone ? styles.padPhone : null}
        onLayout={(event) => {
          savedOffset.current = event.nativeEvent.layout.y;
        }}
      >
        {props.savedActions}
      </View>
      {props.notify &&
      !uncertainStart &&
      (reading.phase === 'inventory' || reading.phase === 'arriving') ? (
        <View
          testID="walkthrough-notify"
          style={phone ? styles.padPhone : styles.notify}
        >
          {props.notify}
        </View>
      ) : null}
    </View>
  );
  const marksDisabled = props.marksDisabledReason ?? null;
  const renderStopFindings = props.review?.renderStopFindings;
  const stopNav = { scrollToStop, scrollToFindings };
  const stops = reading.stops.map((stop) => {
    const findings = renderStopFindings?.(stop, stopNav) ?? null;
    const section = (
      <WalkthroughStopSection
        stop={stop}
        reviewedSource={reviewedSource}
        current={stop.id === currentStop?.id}
        phone={phone}
        showKeys={!phone && stop.id === currentStop?.id}
        onToggleReviewed={props.onToggleReviewed}
        marksDisabledReason={marksDisabled}
        onAsk={props.offline ? undefined : props.onAsk}
        asking={props.askingStopId === stop.id}
        onOpenFile={props.onOpenFile}
        findingRefs={findings?.refs}
        findingCards={findings?.cards}
        proseReferences={findings?.proseReferences}
        explanation={findings?.explanation}
        find={findProps}
      />
    );
    // Only a stop written while the reader watches fades in; a restored saved reading is hydrated data and
    // appears in place (an entering fade there left the whole stream transparent until its frames ran).
    const arriving =
      reading.phase === 'arriving' &&
      !initialStopIds.current.has(stop.id) &&
      !reducedMotion;
    return (
      <Animated.View
        key={stop.id}
        entering={
          arriving ? FadeIn.duration(motionTokens.durationMs.fast) : undefined
        }
        onLayout={(event: LayoutChangeEvent) => {
          stopOffsets.current.set(stop.id, event.nativeEvent.layout.y);
          if (stop.id === landingStopId.current) land();
        }}
        style={stop !== reading.stops[0] ? styles.stopDivider : null}
      >
        {section}
      </Animated.View>
    );
  });
  const stillWriting = reading.phase === 'arriving' && !uncertainStart;
  const stoppedEarly =
    reading.phase === 'failed' ||
    reading.phase === 'partial' ||
    reading.phase === 'cancelled';
  const tail = (
    <>
      {stillWriting ? (
        <Text
          testID="walkthrough-arriving"
          style={[styles.arriving, phone ? styles.padPhone : null]}
        >
          {t('walkthrough.arriving')}
        </Text>
      ) : null}
      {stoppedEarly ? (
        <View
          testID="walkthrough-rest"
          style={[styles.rest, phone ? styles.restPhone : null]}
        >
          <Icon
            name="x-circle"
            size={ICON_SIZE.sm}
            color={theme.colors.text.tertiary}
          />
          <Text style={styles.restText}>{t('walkthrough.notice.rest')}</Text>
        </View>
      ) : null}
      <View
        onLayout={(event) => {
          othersOffset.current = event.nativeEvent.layout.y;
        }}
      >
        <WalkthroughOtherChanges
          others={reading.others}
          phone={phone}
          onOpenFile={props.onOpenFile}
          find={findProps}
          revealed={revealedOthers}
        />
      </View>
      {props.review?.afterStops ? (
        <View
          testID="walkthrough-findings-tail-anchor"
          onLayout={(event) => {
            findingsOffset.current = event.nativeEvent.layout.y;
          }}
        >
          {props.review.afterStops}
        </View>
      ) : null}
    </>
  );
  const body =
    reading.phase === 'inventory' ? (
      <WalkthroughInventory
        rows={reading.inventory}
        uncertain={uncertainStart}
        phone={phone}
        onOpenFile={props.onOpenFile}
      />
    ) : (
      <>
        {stops}
        {tail}
      </>
    );

  if (phone) {
    const sectionControl = currentStop ? (
      <HappierPressable
        testID="walkthrough-section-control"
        accessibilityRole="button"
        accessibilityLabel={`${t('walkthrough.contents')}. ${t('walkthrough.stopA11y', { number: currentStop.number, title: currentStop.title })}`}
        onPress={openContentsSheet}
        style={(state) => [
          styles.section,
          state.pressed ? styles.sectionPressed : null,
        ]}
      >
        <Text style={styles.sectionCount}>
          {t('walkthrough.stopOf', {
            number: currentStop.number,
            total: reading.stops.length,
          })}
        </Text>
        <Text style={styles.sectionTitle} numberOfLines={1}>
          {currentStop.title}
        </Text>
        {props.review?.stopAccessory?.(currentStop.id)}
        <Icon
          name="caret-down"
          size={ICON_SIZE.sm}
          color={theme.colors.text.tertiary}
        />
      </HappierPressable>
    ) : (
      <View />
    );
    return (
      <View ref={phoneRootRef} collapsable={false} testID="walkthrough-view" style={styles.root}>
        {notices}
        <ScrollView
          ref={scrollRef}
          style={styles.root}
          contentContainerStyle={styles.phoneContent}
          stickyHeaderIndices={[1]}
          onScroll={onScroll}
          onLayout={nativeViewport?.onLayout}
          onContentSizeChange={nativeViewport?.onContentSizeChange}
          scrollEventThrottle={32}
        >
          {header}
          {sectionControl}
          <View onLayout={measureStream}>
            <WalkthroughEvidencePresentation.Provider value={evidencePresentation}>{body}</WalkthroughEvidencePresentation.Provider>
          </View>
        </ScrollView>
        {currentStop && reading.phase !== 'inventory' ? (
          <PagePinnedBar testID="walkthrough-phone-bar" style={styles.phoneBar}>
            <PhoneBarButton
              testID="walkthrough-previous"
              icon="caret-up"
              label={t('walkthrough.previousStop')}
              onPress={() => move(-1)}
              disabled={currentIndex <= 0}
            />
            {props.onToggleReviewed ? (
              <WalkthroughPhoneMark stop={currentStop} source={reviewedSource} disabled={Boolean(marksDisabled)} onToggleReviewed={props.onToggleReviewed} />
            ) : (
              <View style={styles.phoneBarGrow} />
            )}
            {(props.onAsk || props.askPending) && !props.offline ? (
              <PhoneBarButton
                testID="walkthrough-phone-ask"
                icon="chat-circle-dots"
                label={t('walkthrough.askAboutStopA11y')}
                onPress={() => props.onAsk?.(currentStop)}
                disabled={!props.onAsk}
              />
            ) : null}
            <PhoneBarButton
              testID="walkthrough-next"
              icon="caret-down"
              label={t('walkthrough.nextStop')}
              onPress={() => move(1)}
              disabled={currentIndex >= reading.stops.length - 1}
            />
          </PagePinnedBar>
        ) : null}
        <ChangedFilesReviewFindSurface model={find} surfaceId={findSurfaceId} surfaceRef={phoneRootRef}
          presented={props.active !== false} />
      </View>
    );
  }

  const rail =
    props.layout === 'wide' && reading.stops.length > 0 ? (
      <WalkthroughContents
        placement="rail"
        reviewedSource={reviewedSource}
        stops={reading.stops}
        others={reading.others}
        reviewedCount={
          props.reviewedProgressAvailable === false
            ? null
            : reading.reviewedCount
        }
        currentStopId={currentStop?.id ?? null}
        onSelectStop={scrollToStop}
        onSelectOthers={scrollToOthers}
        stopAccessory={props.review?.stopAccessory}
      />
    ) : null;
  return (
    <View
      ref={rootRef}
      testID="walkthrough-view"
      tabIndex={-1}
      onPointerDown={(event) => {
        const element = rootRef.current as unknown as HTMLElement | null;
        const target = event.target as unknown as Element | null;
        if (!element || !target || typeof target.closest !== 'function') return;
        if (target.closest('button, a[href], input, textarea, [contenteditable="true"], [role="button"]')) return;
        element.focus({ preventScroll: true });
      }}
      style={styles.root}
    >
      {notices}
      <View style={styles.row}>
        {rail}
        <View style={styles.streamFrame}>
          <ScrollView
            ref={scrollRef}
            style={styles.root}
            contentContainerStyle={styles.stream}
            onScroll={onScroll}
            onLayout={nativeViewport?.onLayout}
            onContentSizeChange={nativeViewport?.onContentSizeChange}
            scrollEventThrottle={32}
          >
            <View style={styles.column}>
              {header}
              <View onLayout={measureStream}>
                <WalkthroughEvidencePresentation.Provider value={evidencePresentation}>{body}</WalkthroughEvidencePresentation.Provider>
              </View>
            </View>
          </ScrollView>
          {/* Find floats over the reading, under the comparison bar, like the Files view's. */}
          <ChangedFilesReviewFindSurface model={find} surfaceId={findSurfaceId} surfaceRef={rootRef}
            presented={props.active !== false} />
        </View>
      </View>
    </View>
  );
});

const EMPTY_KEYS: ReadonlySet<string> = new Set();

function PhoneBarButton(
  props: Readonly<{
    testID: string;
    icon: 'caret-up' | 'caret-down' | 'chat-circle-dots';
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={(state) => [
        styles.phoneBarButton,
        styles.phoneBarIcon,
        state.pressed ? styles.sectionPressed : null,
        props.disabled ? styles.disabled : null,
      ]}
    >
      <Icon
        name={props.icon}
        size={ICON_SIZE.md}
        color={theme.colors.text.primary}
      />
    </HappierPressable>
  );
}

function WalkthroughPhoneMark(props: Readonly<{
  stop: WalkthroughStop; source?: WalkthroughReviewedSource; disabled: boolean;
  onToggleReviewed: NonNullable<WalkthroughViewProps['onToggleReviewed']>;
}>) {
  const { theme } = useUnistyles();
  const stop = useWalkthroughReviewedStop(props.source, props.stop);
  return <HappierPressable
    testID="walkthrough-phone-mark"
    accessibilityRole="button"
    accessibilityLabel={stop.reviewed ? t('walkthrough.unmarkReviewedA11y') : t('walkthrough.markReviewedA11y')}
    checked={stop.reviewed}
    disabled={props.disabled}
    onPress={() => props.onToggleReviewed(stop)}
    style={(state) => [styles.phoneBarButton, styles.phoneBarGrow, state.pressed ? styles.sectionPressed : null,
      focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
  >
    <Icon name={stop.reviewed ? 'check-circle' : 'circle'} size={ICON_SIZE.md}
      color={stop.reviewed ? theme.colors.state.success.foreground : theme.colors.text.primary} />
    <Text style={[styles.phoneBarLabel, stop.reviewed ? styles.phoneBarLabelDone : null]}>
      {stop.reviewed ? t('walkthrough.reviewed') : t('walkthrough.markReviewed')}
    </Text>
  </HappierPressable>;
}

/** The phone contents sheet (lab WT1-A2p): the rail's rows, in thumb reach. */
function WalkthroughContentsSheet(
  props: Readonly<{
    onClose: () => void;
    stops: WalkthroughReading['stops'];
    reviewedSource?: WalkthroughReviewedSource;
    others: WalkthroughReading['others'];
    reviewedCount: number | null;
    currentStopId: string | null;
    onSelectStop: (stopId: string) => void;
    onSelectOthers: () => void;
  }>,
) {
  return (
    <WalkthroughContents
      placement="sheet"
      stops={props.stops}
      reviewedSource={props.reviewedSource}
      others={props.others}
      reviewedCount={props.reviewedCount}
      currentStopId={props.currentStopId}
      onSelectStop={props.onSelectStop}
      onSelectOthers={props.onSelectOthers}
      onDone={props.onClose}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  row: { flex: 1, minHeight: 0, flexDirection: 'row' },
  streamFrame: { flex: 1, minWidth: 0, position: 'relative' },
  stream: {
    paddingLeft: 36,
    paddingRight: theme.space.s40,
    paddingBottom: 140,
  },
  // The reading measure stays fixed; on a wide pane the column sits centred in it rather than leaving
  // the whole right side empty (≥1920 and ultra-wide).
  column: {
    width: '100%',
    maxWidth: STREAM_COLUMN_MAX_WIDTH_PX,
    alignSelf: 'center',
  },
  stopDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  arriving: {
    paddingVertical: theme.space.s24,
    ...Typography.variant('body'),
    color: theme.colors.text.tertiary,
  },
  padPhone: { paddingHorizontal: theme.space.s16 },
  notify: { paddingVertical: theme.space.s8 },
  rest: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    marginTop: 18,
    marginLeft: theme.space.s32,
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
  },
  restPhone: { marginHorizontal: theme.space.s16 },
  restText: {
    flex: 1,
    ...Typography.variant('body'),
    color: theme.colors.text.secondary,
  },
  phoneContent: { paddingBottom: theme.space.s24 },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    minHeight: 52,
    paddingHorizontal: theme.space.s16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
  },
  sectionPressed: { backgroundColor: theme.colors.surface.pressed },
  sectionCount: {
    fontSize: 15,
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
    ...Typography.default('medium'),
  },
  sectionTitle: {
    flex: 1,
    ...Typography.variant('heading'),
    color: theme.colors.text.primary,
  },
  // A sibling under the reading, cleared of the floating tab bar and the safe area by its owner.
  phoneBar: {
    flexDirection: 'row',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
    paddingTop: theme.space.s8,
  },
  phoneBarButton: {
    height: 44,
    borderRadius: 12,
    backgroundColor: theme.colors.surface.inset,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: theme.space.s8,
  },
  phoneBarIcon: { width: 44 },
  phoneBarGrow: { flex: 1 },
  phoneBarLabel: {
    ...Typography.variant('heading'),
    color: theme.colors.text.primary,
  },
  phoneBarLabelDone: { color: theme.colors.state.success.textForeground },
  disabled: { opacity: 0.4 },
}));
