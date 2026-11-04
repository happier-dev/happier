import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { DiffViewerHunks } from '@/components/ui/code/diff/diffViewerTypes';
import { DiffHunkRowRegistryContext, useDiffHunkReadingLine } from '@/components/ui/code/diff/hunks/diffHunkReadingLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { ReviewBar } from '@/components/workspaces/scm/review/hunkReview/ReviewBar';
import { ReviewStrip } from '@/components/workspaces/scm/review/hunkReview/ReviewStrip';
import { useReviewKeyboard } from '@/components/workspaces/scm/review/hunkReview/useReviewKeyboard';
import { useDeviceType } from '@/utils/platform/responsive';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { ImageCompare } from '@/components/workspaces/scm/review/imageCompare/ImageCompare';
import { useImageCompare } from '@/components/workspaces/scm/review/imageCompare/useImageCompare';
import { useMediaStage } from '@/components/ui/media/stage/useMediaStage';
import { FileReadAskControls } from '@/components/workspaces/files/file/FileReadAskControls';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { ReviewUnit } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { t } from '@/text';
import {
  type FileChangesReview,
  type FileChangesScopeKind,
} from './useFileChangesReview';

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * The review strip / Changes scope row for the File page notice slot (lab ade-shell RV2, CK1).
 * Phones keep the scope only; the review bar carries the counter and actions.
 */
export function FileChangesStrip(
  props: Readonly<{ review: FileChangesReview }>,
) {
  const { review } = props;
  const phone = useDeviceType() === 'phone';
  const strip = review.controller.strip;
  const scope = {
    tabs: review.scopeTabs,
    active: review.scopeKind,
    onSelect: review.selectScope,
  };
  const complete =
    strip.fileComplete && review.status === 'ready'
      ? {
          filesLeft: strip.filesLeft,
          nextFileName: strip.nextFile ? baseName(strip.nextFile) : null,
          onNextFile: strip.nextFile ? review.controller.nextFile : undefined,
        }
      : null;
  return (
    <ReviewStrip<FileChangesScopeKind>
      testID="file-changes-strip"
      compact={phone}
      scope={scope}
      current={strip.current}
      total={review.status === 'ready' ? strip.total : 0}
      onPrevious={strip.total > 0 ? review.controller.previous : undefined}
      onNext={strip.total > 0 ? review.controller.next : undefined}
      onKeepAll={strip.canKeepAll ? review.controller.keepAll : undefined}
      complete={complete}
    />
  );
}

export type FileChangesAsk = Readonly<{ scopeId: string; scope: WorkspaceScopeBase; filePath: string; sessionId: string | null; active: boolean;
  onCommentRange?: React.ComponentProps<typeof FileReadAskControls>['onCommentRange'];
  onPhoneBarShownChange?: React.ComponentProps<typeof FileReadAskControls>['onPhoneBarShownChange'];
}>;

export type FileChangesDiffSurface = Readonly<{
  unifiedDiff: string;
  hunks: DiffViewerHunks;
  reviewUnits: readonly ReviewUnit[];
  scrollToLineId?: string;
  /** Native phones: the page's diff scroll events, so the bar follows the reading line. */
  onScroll?: () => void;
  /** Phones: content above the diff's first line, in the diff's own scroller (an SVG's image compare), so the page has one scroll. */
  leadingContent?: React.ReactNode;
}>;

/**
 * The Changes body: the scope's diff with per-change rows, its loading / empty / error states and,
 * on phones, the review bar. The page supplies the diff surface it already owns (find, comments,
 * line selection) through `children`; this region only decides what that surface shows.
 */
export function FileChangesBody(
  props: Readonly<{
    review: FileChangesReview;
    /** Front-most review surface: the one that answers J/K/R/D. */
    keyboardActive: boolean;
    containsFocus?: () => boolean;
    /** Image and SVG files compare as images instead of the text diff. */
    image?: Readonly<{ scope: WorkspaceScopeBase; filePath: string; liveChangeKind?: string | null }> | null;
    /** The shared selection toolbar over the diff (web): the pane scope and Session Ask writes to. */
    ask?: FileChangesAsk | null;
    children: (surface: FileChangesDiffSurface) => React.ReactNode;
  }>,
) {
  const { review } = props;
  const diffRootRef = React.useRef<View | null>(null);
  const phone = useDeviceType() === 'phone';
  useReviewKeyboard(review.keyboard, {
    active: props.keyboardActive && review.status === 'ready',
    containsFocus: props.containsFocus,
  });
  const strip = review.controller.strip;
  // Phones: the bar acts on the change crossing the reading line (P5 §3.11), through the one review cursor.
  const readingLine = useDiffHunkReadingLine({
    enabled: phone && review.status === 'ready' && strip.total > 0,
    rootRef: diffRootRef,
    revealKey: review.controller.revealHunk?.key ?? null,
    keys: review.reviewUnits.map((unit) => unit.key),
    onRead: review.controller.followReadingLine,
  });
  // With leading content (the compare), the page opens at its top: the arrival reveal of the first change
  // waits until the review moves (Next, Previous, Keep), so the wells are what you see first.
  // The arrival reveal is the first change (the cursor's default); any other reveal is a move.
  const revealKey = review.controller.revealHunk?.key ?? null;
  const firstKey = review.reviewUnits[0]?.key ?? null;
  const [reviewMoved, setReviewMoved] = React.useState(false);
  React.useEffect(() => {
    if (!reviewMoved && revealKey !== null && revealKey !== firstKey) setReviewMoved(true);
  }, [firstKey, revealKey, reviewMoved]);
  // The one text region: a text file's diff, or an SVG's source changes under its image compare.
  const textRegion = (unifiedDiff: string, leadingContent?: React.ReactNode) => (
    <View ref={diffRootRef} collapsable={false} style={styles.body}
      onTouchStart={phone && Platform.OS !== 'web' ? readingLine.onTouchStart : undefined}>
      <DiffHunkRowRegistryContext.Provider value={phone ? readingLine.registry : null}>
        {props.children({
          unifiedDiff,
          hunks: review.hunks,
          reviewUnits: review.reviewUnits,
          scrollToLineId: leadingContent && !reviewMoved ? undefined : review.scrollToLineId,
          ...(phone && Platform.OS !== 'web' ? { onScroll: readingLine.onScroll } : {}),
          ...(leadingContent ? { leadingContent } : {}),
        })}
      </DiffHunkRowRegistryContext.Provider>
      {Platform.OS === 'web' && props.ask ? (
        <FileReadAskControls rootRef={diffRootRef} mode="diff" scopeId={props.ask.scopeId} scope={props.ask.scope}
          filePath={props.ask.filePath} text={unifiedDiff} sessionId={props.ask.sessionId} active={props.ask.active}
          onCommentRange={props.ask.onCommentRange} onPhoneBarShownChange={props.ask.onPhoneBarShownChange} />
      ) : null}
      {phone && strip.total > 0 ? (
        <ReviewBar
          testID="file-review-bar"
          current={strip.current}
          total={strip.total}
          onPrevious={review.controller.previous}
          onNext={review.controller.next}
          onKeep={review.controller.keepCurrentAndAdvance}
          // A kept current change reads "Kept" (pressing it lets go, as on the row).
          keepLabel={review.controller.currentHunk && review.hunks.stateOf?.(review.controller.currentHunk) === 'kept'
            ? t('hunkReview.kept') : undefined}
          onDiscard={review.controller.discardCurrent}
          discardDisabledReason={review.discardDisabledReason}
          complete={
            strip.fileComplete
              ? {
                  nextFileName: strip.nextFile
                    ? baseName(strip.nextFile)
                    : null,
                  onNextFile: strip.nextFile
                    ? review.controller.nextFile
                    : undefined,
                }
              : null
          }
        />
      ) : null}
    </View>
  );
  const retainedFailure = review.error && review.status !== 'error' ? (
    <SurfaceFreshnessLine testID="file-changes-stale" reason={review.error} tone="warning"
      action={{ label: t('common.retry'), onPress: review.refresh }} />
  ) : null;
  const viewer = props.image ? resolveFileViewerKind({ path: props.image.filePath }) : null;
  if (props.image && viewer && (viewer.kind === 'image' || viewer.kind === 'svg') && review.status !== 'loading' && review.status !== 'error') {
    const imageCompare = (
      <FileChangesImageCompare review={review} scope={props.image.scope} filePath={props.image.filePath}
        liveChangeKind={props.image.liveChangeKind} />
    );
    // Phones (lab RV1vp): Before over After, then the source changes, in one scroll. The wells lead the
    // diff inside its own scroller, so they scroll away and the changes get the screen.
    if (phone && viewer.kind === 'svg' && review.status === 'ready' && review.unifiedDiff) {
      return <>{retainedFailure}{textRegion(review.unifiedDiff, imageCompare)}</>;
    }
    return (
      <View style={styles.body}>
        {retainedFailure}
        {imageCompare}
        {viewer.kind === 'svg' && review.status === 'ready' && review.unifiedDiff ? textRegion(review.unifiedDiff) : null}
      </View>
    );
  }

  if (review.status === 'loading') {
    return (
      <SurfaceStateCard
        testID="file-changes-loading"
        kind="loading"
        size="line"
        title={t('common.loading')}
      />
    );
  }
  if (review.status === 'error') {
    return (
      <SurfaceStateCard
        testID="file-changes-error"
        kind="error"
        size="line"
        title={review.error ?? t('hunkReview.noticeUnavailable')}
        action={{ label: t('common.retry'), onPress: review.refresh }}
      />
    );
  }
  if (review.status === 'empty' || !review.unifiedDiff) {
    const turnScope =
      review.scopeKind === 'turn' &&
      review.scopeTabs.some((tab) => tab.id === 'session');
    return (
      <>
      {retainedFailure}
      <SurfaceStateCard
        testID="file-changes-empty"
        kind="empty"
        size="line"
        title={
          turnScope ? t('hunkReview.noTurnChanges') : t('hunkReview.noChanges')
        }
        {...(turnScope
          ? {
              action: {
                label: t('hunkReview.showSession'),
                onPress: () => review.selectScope('session'),
              },
            }
          : {})}
      />
      </>
    );
  }
  return <>{retainedFailure}{textRegion(review.unifiedDiff)}</>;
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    minHeight: 0,
  },
});

/**
 * The whole Changes region as the File page places it in its body slot: the review strip under the
 * page's notices, then the scope's diff (supplied by the page through `children`) and, on phones,
 * the review bar. The page owns the one `useFileChangesReview` (its menu reads the same review).
 */
export function FileChangesSection(props: Readonly<{
    review: FileChangesReview;
    scope: WorkspaceScopeBase;
    filePath: string;
    keyboardActive: boolean;
    containsFocus?: () => boolean;
    liveChangeKind?: string | null;
    /** Mounts the shared selection toolbar (Ask · Comment · Copy) over the diff; the page's pane scope and Session. */
    ask?: Pick<FileChangesAsk, 'scopeId' | 'sessionId' | 'active' | 'onCommentRange' | 'onPhoneBarShownChange'>;
    children: (surface: FileChangesDiffSurface) => React.ReactNode;
}>) {
    const { review, keyboardActive, containsFocus, children, liveChangeKind } = props;
    const { theme } = useUnistyles();
    return (
        <View testID="file-changes-section" style={sectionStyles.section}>
            <View style={[sectionStyles.stripRow, { borderBottomColor: theme.colors.border.subtle }]}>
                <FileChangesStrip review={review} />
            </View>
            <FileChangesBody review={review} keyboardActive={keyboardActive} containsFocus={containsFocus}
        image={{ scope: props.scope, filePath: props.filePath, liveChangeKind }}
        ask={props.ask ? { ...props.ask, scope: props.scope, filePath: props.filePath } : null}>
                {children}
            </FileChangesBody>
        </View>
    );
}

const sectionStyles = StyleSheet.create({
    section: {
        flex: 1,
        minHeight: 0,
    },
    stripRow: {
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
});


/** Changes of an image or SVG file: the visual compare (files lab RV1), bytes from the pinned revisions. */
function FileChangesImageCompare(props: Readonly<{ review: FileChangesReview; scope: WorkspaceScopeBase; filePath: string;
    liveChangeKind?: string | null; }>) {
    const { review } = props;
    const viewer = resolveFileViewerKind({ path: props.filePath });
    const captured = review.capturedFile && review.comparison
        ? { kind: 'captured' as const, file: review.capturedFile, comparisonId: review.comparison.id } : null;
    const compare = useImageCompare({
        enabled: review.live || captured !== null,
        scope: props.scope,
        filePath: props.filePath,
        source: captured ?? { kind: 'workingTree', changeKind: props.liveChangeKind ?? 'modified', area: 'both' },
    });
    const stage = useMediaStage();
    const openStage = (side: 'before' | 'after') => {
      const index = side === 'before' ? compare.beforeGalleryIndex : compare.afterGalleryIndex;
      if (index !== null) stage.open(compare.gallery, index);
    };
    const turn = review.turnNumber !== null ? t('hunkReview.turn', { turn: review.turnNumber }) : null;
    return (
        <ImageCompare
            testID="file-changes-image-compare"
            filePath={props.filePath}
            kind={viewer.kind === 'svg' ? 'svg' : 'image'}
            alphaCapable={viewer.alphaCapable}
            before={compare.before}
            after={compare.after}
            beforePreviewInput={compare.beforePreviewInput}
            afterPreviewInput={compare.afterPreviewInput}
            onRetry={compare.retry}
            onOpenStage={compare.gallery.length > 0 ? openStage : undefined}
            beforeLabel={review.live ? 'HEAD' : review.scopeKind === 'turn' && turn ? turn : undefined}
                    />
    );
}
