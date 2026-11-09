import * as React from 'react';
import {
  Animated,
  PanResponder,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ImageWell } from '@/components/ui/media/ImageWell';
import { HappierImageCheckerboard } from '@happier-dev/plugin-ui/presentation';
import {
  MediaPicture,
  type MediaPictureSize,
} from '@/components/ui/media/MediaPicture';
import type { UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import { previewUnavailableCard } from '@/components/ui/media/previewUnavailable';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Slider } from '@/components/ui/forms/Slider';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';
import { formatBytesDelta, type ImageCompareSide } from './imageCompareModel';

type Mode = 'sideBySide' | 'swipe' | 'onion';

export type ImageCompareProps = Readonly<{
  filePath: string;
  kind: 'image' | 'svg';
  alphaCapable: boolean;
  before: ImageCompareSide;
  after: ImageCompareSide;
  beforePreviewInput: UseFilePreviewSourceInput;
  afterPreviewInput: UseFilePreviewSourceInput;
  /** Where each side comes from ("HEAD", "turn 4", "working tree"). */
  beforeLabel?: string;
  afterLabel?: string;
  /** Reads a side again after its read or transfer did not finish. */
  onRetry?: (side: 'before' | 'after') => void;
  /** Opens the Media stage gallery `[before, after]` at the pressed side. */
  onOpenStage?: (side: 'before' | 'after') => void;
  testID?: string;
}>;

function sideReason(side: ImageCompareSide): string | null {
  if (side.kind !== 'noPreview') return null;
  return side.reason === 'loading' ? t('hunkReview.imageLoading') : t('hunkReview.imageNoPreview');
}

/**
 * Changed images compare as images (files lab RV1): Side by side · Swipe · Onion, before / after
 * labelled, one tabular delta line. Added or deleted images are one well with a pill. Each side's
 * typed state comes from the image compare model; a missing side states its reason in its well.
 */
export function ImageCompare(props: ImageCompareProps) {
  const { theme } = useUnistyles();
  const phone = useDeviceType() === 'phone';
  const [mode, setMode] = React.useState<Mode>('sideBySide');
  const [beforeSize, setBeforeSize] = React.useState<MediaPictureSize | null>(
    null,
  );
  const [afterSize, setAfterSize] = React.useState<MediaPictureSize | null>(
    null,
  );
  const onBeforeSize = React.useCallback((size: MediaPictureSize) => {
    setBeforeSize(current => current?.width === size.width && current.height === size.height
      ? current : { width: size.width, height: size.height });
  }, []);
  const onAfterSize = React.useCallback((size: MediaPictureSize) => {
    setAfterSize(current => current?.width === size.width && current.height === size.height
      ? current : { width: size.width, height: size.height });
  }, []);
  const both =
    props.before.kind === 'present' && props.after.kind === 'present';
  const single =
    props.before.kind === 'added'
      ? ('after' as const)
      : props.after.kind === 'deleted'
        ? ('before' as const)
        : null;
  const dims = (size: MediaPictureSize | null) =>
    size ? `${size.width} × ${size.height}` : null;
  const bytes = formatBytesDelta(
    props.before.kind === 'present' ? props.before.sizeBytes : null,
    props.after.kind === 'present' ? props.after.sizeBytes : null,
  );
  const meta = [
    beforeSize && afterSize
      ? `${dims(beforeSize)} → ${dims(afterSize)}`
      : dims(afterSize ?? beforeSize),
    bytes,
  ]
    .filter(Boolean)
    .join(' · ');

  const well = (side: 'before' | 'after') => {
    const state = side === 'before' ? props.before : props.after;
    if (state.kind === 'unavailable') {
      // The same reason and copy the image body and stage show. A read that did not finish is the
      // only one with Retry (and its cause behind Details); the others are one quiet line.
      const card = previewUnavailableCard(state.reason, props.filePath.split('/').pop() || props.filePath);
      return (
        <SurfaceStateCard
          testID={`image-compare-${side}-state`}
          kind={card.kind}
          size={card.retryable ? 'details' : 'line'}
          title={card.title}
          {...(card.reason ? { reason: card.reason } : {})}
          {...(card.diagnosticCode ? { diagnosticCode: card.diagnosticCode } : {})}
          {...(card.retryable && props.onRetry
            ? { action: { label: t('common.retry'), onPress: () => props.onRetry?.(side), testID: `image-compare-${side}-retry` } }
            : {})}
        />
      );
    }
    const reason = sideReason(state);
    if (reason) {
      return (
        <SurfaceStateCard
          testID={`image-compare-${side}-state`}
          kind="empty"
          size="line"
          title={reason}
        />
      );
    }
    return (
      <ImageWell
        testID={`image-compare-${side}`}
        kind={props.kind}
        title={`${side === 'before' ? t('hunkReview.imageBefore') : t('hunkReview.imageAfter')} · ${props.filePath}`}
        source={
          side === 'before' ? props.beforePreviewInput : props.afterPreviewInput
        }
        alphaCapable={props.alphaCapable}
        layout="inline"
        onImageInfo={side === 'before' ? onBeforeSize : onAfterSize}
        {...(props.onOpenStage
          ? { onOpenStage: () => props.onOpenStage?.(side) }
          : {})}
      />
    );
  };
  const label = (side: 'before' | 'after') => (
    <Text
      variant="meta"
      numberOfLines={1}
      style={{ color: theme.colors.text.tertiary }}
    >
      <Text
        variant="meta"
        emphasis="semiBold"
        style={{ color: theme.colors.text.secondary }}
      >
        {side === 'before'
          ? t('hunkReview.imageBefore')
          : t('hunkReview.imageAfter')}
      </Text>
      {(side === 'before' ? props.beforeLabel : props.afterLabel)
        ? ` · ${side === 'before' ? props.beforeLabel : props.afterLabel}`
        : ''}
    </Text>
  );

  if (single) {
    return (
      <View testID={props.testID} style={styles.root}>
        <View style={styles.modes}>
          <StatusPill
            variant="neutral"
            label={
              single === 'after'
                ? t('hunkReview.imageAdded')
                : t('hunkReview.imageDeleted')
            }
          />
          <View style={styles.grow} />
          {meta ? (
            <Text
              variant="meta"
              style={[styles.tabular, { color: theme.colors.text.tertiary }]}
            >
              {meta}
            </Text>
          ) : null}
        </View>
        <View
          style={[
            styles.wellFrame,
            { backgroundColor: theme.colors.surface.inset },
          ]}
        >
          {well(single)}
        </View>
      </View>
    );
  }

  return (
    <View testID={props.testID} style={styles.root}>
      <View style={styles.modes}>
        <SegmentedTabBar<Mode>
          tabs={[
            { id: 'sideBySide', label: t('hunkReview.imageSideBySide') },
            { id: 'swipe', label: t('hunkReview.imageSwipe'), disabled: !both },
            { id: 'onion', label: t('hunkReview.imageOnion'), disabled: !both },
          ]}
          activeTabId={both ? mode : 'sideBySide'}
          onSelectTab={setMode}
          compact
          segmentSizing="content"
          role="radiogroup"
          accessibilityLabel={t('hunkReview.imageModeA11y')}
          testIDPrefix="image-compare-mode"
        />
        <View style={styles.grow} />
        {meta && !phone ? (
          <Text
            variant="meta"
            numberOfLines={1}
            style={[styles.tabular, { color: theme.colors.text.tertiary }]}
          >
            {meta}
          </Text>
        ) : null}
      </View>
      {meta && phone ? (
        <Text
          variant="meta"
          style={[styles.tabular, { color: theme.colors.text.tertiary }]}
        >
          {meta}
        </Text>
      ) : null}
      {mode === 'sideBySide' || !both ? (
        <View style={[styles.sides, phone ? styles.sidesStacked : null]}>
          {(['before', 'after'] as const).map((side) => (
            <View key={side} style={[styles.side, phone ? null : styles.sideInRow]}>
              {label(side)}
              <View
                style={[
                  styles.wellFrame,
                  { backgroundColor: theme.colors.surface.inset },
                ]}
              >
                {well(side)}
              </View>
            </View>
          ))}
        </View>
      ) : (
        <LayeredCompare
          mode={mode}
          kind={props.kind}
          alphaCapable={props.alphaCapable}
          beforeUri={props.before.kind === 'present' ? props.before.uri : ''}
          afterUri={props.after.kind === 'present' ? props.after.uri : ''}
          size={beforeSize ?? afterSize}
          onBeforeSize={onBeforeSize}
          onAfterSize={onAfterSize}
        />
      )}
    </View>
  );
}

function LayeredCompare(
  props: Readonly<{
    mode: 'swipe' | 'onion';
    kind: 'image' | 'svg';
    alphaCapable: boolean;
    beforeUri: string;
    afterUri: string;
    size: MediaPictureSize | null;
    onBeforeSize: (size: MediaPictureSize) => void;
    onAfterSize: (size: MediaPictureSize) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [width, setWidth] = React.useState(0);
  const [opacity, setOpacity] = React.useState(50);
  const aspect = props.size
    ? props.size.height / Math.max(1, props.size.width)
    : 1;
  const box = width > 0 ? { width, height: Math.round(width * aspect) } : null;
  const x = React.useRef(new Animated.Value(0)).current;
  const position = React.useRef(0.5);
  const start = React.useRef(0);
  React.useEffect(() => {
    if (box) x.setValue(box.width * position.current);
  }, [box?.width]);
  const pan = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          start.current = position.current;
        },
        onPanResponderMove: (_event, gesture) => {
          if (!box) return;
          position.current = Math.min(
            1,
            Math.max(0, start.current + gesture.dx / box.width),
          );
          x.setValue(position.current * box.width);
        },
      }),
    [box?.width],
  );
  const nudge = (delta: number) => {
    if (!box) return;
    position.current = Math.min(1, Math.max(0, position.current + delta));
    x.setValue(position.current * box.width);
  };
  const picture = (uri: string, onSize: (size: MediaPictureSize) => void) => (
    <MediaPicture
      kind={props.kind}
      uri={uri}
      size={box}
      onIntrinsicSize={onSize}
    />
  );
  return (
    <View style={styles.layered}>
      <View
        onLayout={(event: LayoutChangeEvent) =>
          setWidth(Math.round(event.nativeEvent.layout.width))
        }
        style={[
          styles.wellFrame,
          { backgroundColor: theme.colors.surface.inset },
        ]}
      >
        {box ? (
          <View style={[box, styles.stack]}>
            {props.alphaCapable ? (
              <HappierImageCheckerboard color={theme.colors.text.primary} />
            ) : null}
            <View style={StyleSheet.absoluteFill}>
              {picture(props.beforeUri, props.onBeforeSize)}
            </View>
            {props.mode === 'onion' ? (
              <View
                style={[StyleSheet.absoluteFill, { opacity: opacity / 100 }]}
              >
                {picture(props.afterUri, props.onAfterSize)}
              </View>
            ) : (
              <>
                {/* After is revealed by a translated clip, never by resizing: compositor-only, 1:1 with the finger. */}
                <Animated.View
                  style={[
                    styles.clip,
                    { width: box.width, transform: [{ translateX: x }] },
                  ]}
                >
                  <Animated.View
                    style={{
                      width: box.width,
                      height: box.height,
                      transform: [{ translateX: Animated.multiply(x, -1) }],
                    }}
                  >
                    {picture(props.afterUri, props.onAfterSize)}
                  </Animated.View>
                </Animated.View>
                <Animated.View
                  {...pan.panHandlers}
                  accessible
                  accessibilityRole="adjustable"
                  accessibilityLabel={t('hunkReview.imageSwipe')}
                  accessibilityActions={[
                    { name: 'increment' },
                    { name: 'decrement' },
                  ]}
                  onAccessibilityAction={(event) =>
                    nudge(
                      event.nativeEvent.actionName === 'increment'
                        ? 0.05
                        : -0.05,
                    )
                  }
                  style={[styles.divider, { transform: [{ translateX: x }] }]}
                >
                  <View
                    style={[
                      styles.dividerLine,
                      { backgroundColor: theme.colors.text.primary },
                    ]}
                  />
                </Animated.View>
              </>
            )}
          </View>
        ) : (
          <View style={styles.placeholder} />
        )}
      </View>
      {props.mode === 'onion' ? (
        <Slider
          value={opacity}
          min={0}
          max={100}
          step={1}
          onValueChange={setOpacity}
          onValuePreview={(next) => { if (next !== undefined) setOpacity(next); }}
          accessibilityLabel={t('hunkReview.imageBlend')}
          formatValueText={(value) => `${Math.round(value)}%`}
          leading={
            <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
              {t('hunkReview.imageBefore')}
            </Text>
          }
          trailing={
            <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
              {t('hunkReview.imageAfter')}
            </Text>
          }
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
  },
  modes: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  grow: {
    flex: 1,
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
  sides: {
    flexDirection: 'row',
    gap: theme.space.s12,
  },
  sidesStacked: {
    flexDirection: 'column',
  },
  side: {
    minWidth: 0,
    gap: theme.space.s6,
  },
  // Stacked on a phone, each side keeps its own height; only a row shares the width.
  sideInRow: {
    flex: 1,
  },
  wellFrame: {
    borderRadius: theme.borderRadius.md,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 120,
  },
  layered: {
    gap: theme.space.s12,
  },
  stack: {
    overflow: 'hidden',
  },
  clip: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    overflow: 'hidden',
  },
  divider: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: -22,
    width: 44,
    alignItems: 'center',
  },
  dividerLine: {
    width: 2,
    flex: 1,
    opacity: 0.6,
  },
  placeholder: {
    height: 240,
  },
}));
