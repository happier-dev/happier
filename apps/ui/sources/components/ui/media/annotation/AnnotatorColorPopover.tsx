import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ImageMarkColorV1, ImageMarkSizeV1 } from '@happier-dev/protocol';
import {
  HappierPressable,
  type HappierFocusable,
} from '@happier-dev/plugin-ui/presentation';

import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { MARK_COLORS } from './markGeometry';

const SIZES: readonly ImageMarkSizeV1[] = ['s', 'm', 'l'];
/** A swatch's hit circle; the drawn dot sits inside its selection ring. */
const SWATCH_HIT = 30;
/** Picker order: warm to cool, ink last (MIS §3.3). */
const COLOR_ORDER: readonly ImageMarkColorV1[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'ink'];

/**
 * The colour and stroke panel behind the palette's swatch (MIS §3.3, lab `an · AN`). Picking does not
 * close it, because colour and stroke are usually set together; ←/→ walk the swatches and Tab reaches
 * the stroke row. Text size shows only while Text is the tool or a text mark is selected.
 */
export function AnnotatorColorPanel(
  props: Readonly<{
    color: ImageMarkColorV1;
    size: ImageMarkSizeV1;
    showTextSize: boolean;
    onColor: (color: ImageMarkColorV1) => void;
    onSize: (size: ImageMarkSizeV1) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const swatchRefs = React.useRef<Array<HappierFocusable | null>>([]);
  const { onColor } = props;
  const moveFocus = React.useCallback(
    (from: number, step: number) => {
      const next =
        (from + step + COLOR_ORDER.length) %
        COLOR_ORDER.length;
      swatchRefs.current[next]?.focus();
      onColor(COLOR_ORDER[next]!);
    },
    [onColor],
  );
  const strokeTabs = React.useMemo(
    () =>
      SIZES.map((size) => ({
        id: size,
        label: t(`files.annotate.stroke.${size}`),
        icon: (
          <View
            style={[
              styles.strokeSample,
              {
                height: STROKE_SAMPLE[size],
                backgroundColor: theme.colors.text.primary,
              },
            ]}
          />
        ),
      })),
    [theme.colors.text.primary],
  );
  const textTabs = React.useMemo(
    () =>
      SIZES.map((size) => ({
        id: size,
        label: t(`files.annotate.textSize.${size}`),
      })),
    [],
  );
  return (
    <View style={styles.root} testID="annotator-color-panel">
      <Text
        variant="micro"
        emphasis="semiBold"
        style={[styles.label, { color: theme.colors.text.tertiary }]}
      >
        {t('files.annotate.colour')}
      </Text>
      <View
        style={styles.swatches}
        accessibilityRole="radiogroup"
        accessibilityLabel={t('files.annotate.colour')}
      >
        {COLOR_ORDER.map((color, index) => {
          const selected = color === props.color;
          return (
            <HappierPressable
              key={color}
              controlRef={(node) => {
                swatchRefs.current[index] = node;
              }}
              accessibilityRole="radio"
              checked={selected}
              accessibilityLabel={t(`files.annotate.colours.${color}`)}
              tabIndex={selected ? 0 : -1}
              onKeyDown={(key) => {
                if (key === 'ArrowRight') moveFocus(index, 1);
                else if (key === 'ArrowLeft') moveFocus(index, -1);
                else return false;
                return true;
              }}
              onPress={() => props.onColor(color)}
              testID={`annotator-swatch-${color}`}
              style={styles.swatchHit}
            >
              <View
                style={[
                  styles.swatchRing,
                  selected ? { borderColor: theme.colors.text.primary } : null,
                ]}
              >
                <View
                  style={[
                    styles.swatch,
                    {
                      backgroundColor: MARK_COLORS[color],
                      borderColor: theme.colors.border.strong,
                    },
                  ]}
                />
              </View>
            </HappierPressable>
          );
        })}
      </View>
      <Text
        variant="micro"
        emphasis="semiBold"
        style={[styles.label, { color: theme.colors.text.tertiary }]}
      >
        {props.showTextSize
          ? t('files.annotate.textSize.title')
          : t('files.annotate.stroke.title')}
      </Text>
      <View style={styles.segment}>
        {props.showTextSize ? (
          <SegmentedTabBar
            tabs={textTabs}
            activeTabId={props.size}
            onSelectTab={props.onSize}
            role="radiogroup"
            accessibilityLabel={t('files.annotate.textSize.title')}
            testIDPrefix="annotator-text-size"
          />
        ) : (
          <SegmentedTabBar
            tabs={strokeTabs}
            activeTabId={props.size}
            onSelectTab={props.onSize}
            role="radiogroup"
            accessibilityLabel={t('files.annotate.stroke.title')}
            testIDPrefix="annotator-stroke"
          />
        )}
      </View>
    </View>
  );
}

/**
 * The phone's colour row (lab `ia · I2p`): the swatches and the three strokes stand in the open, by the
 * thumb, so there is nothing to open. Every swatch takes the row's height for its target.
 */
export function AnnotatorColorRow(
  props: Readonly<{
    color: ImageMarkColorV1;
    size: ImageMarkSizeV1;
    onColor: (color: ImageMarkColorV1) => void;
    onSize: (size: ImageMarkSizeV1) => void;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.phoneRow}>
      {COLOR_ORDER.map((color) => {
        const selected = color === props.color;
        return (
          <HappierPressable
            key={color}
            accessibilityRole="radio"
            checked={selected}
            accessibilityLabel={t(`files.annotate.colours.${color}`)}
            onPress={() => props.onColor(color)}
            testID={`annotator-swatch-${color}`}
            style={styles.phoneTarget}
          >
            <View style={[styles.swatchRing, selected ? { borderColor: theme.colors.text.primary } : null]}>
              <View style={[styles.swatch, { backgroundColor: MARK_COLORS[color], borderColor: theme.colors.border.strong }]} />
            </View>
          </HappierPressable>
        );
      })}
      <View style={styles.phoneDivider} />
      {SIZES.map((size) => {
        const selected = size === props.size;
        return (
          <HappierPressable
            key={size}
            accessibilityRole="radio"
            checked={selected}
            accessibilityLabel={t(`files.annotate.stroke.${size}`)}
            onPress={() => props.onSize(size)}
            testID={`annotator-stroke-${size}`}
            style={styles.phoneTarget}
          >
            <View style={[styles.phoneStroke, selected ? { backgroundColor: theme.colors.surface.selected } : null]}>
              <View style={[styles.strokeSample, styles.phoneStrokeSample, { height: STROKE_SAMPLE[size], backgroundColor: theme.colors.text.primary }]} />
            </View>
          </HappierPressable>
        );
      })}
    </View>
  );
}

/** The sample bar's thickness shows the stroke it picks (3 / 5 / 8 pt, MIS §3.3). */
const STROKE_SAMPLE: Record<ImageMarkSizeV1, number> = { s: 2, m: 4, l: 7 };

const styles = StyleSheet.create((theme) => ({
  root: {
    // As wide as the swatch row; the size control spans it (lab `an · AN`).
    width: SWATCH_HIT * 7 + theme.space.s4 * 6 + theme.space.s8 * 2,
    paddingVertical: theme.space.s6,
    paddingHorizontal: theme.space.s8,
    gap: theme.space.s4,
  },
  label: {
    paddingHorizontal: theme.space.s2,
    paddingTop: theme.space.s2,
  },
  swatches: {
    flexDirection: 'row',
    gap: theme.space.s4,
    paddingBottom: theme.space.s4,
  },
  swatchHit: {
    width: SWATCH_HIT,
    height: SWATCH_HIT,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
  },
  swatchRing: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatch: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
  },
  segment: {
    alignSelf: 'stretch',
  },
  strokeSample: {
    width: 18,
    borderRadius: 4,
  },
  phoneRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  phoneTarget: {
    flex: 1,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  phoneDivider: {
    width: theme.space.s4,
  },
  phoneStroke: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  phoneStrokeSample: {
    width: 14,
  },
}));
