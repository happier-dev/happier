import { useFloatingChromeClearance } from '@/components/ui/layout/useFloatingChromeClearance';
import * as React from 'react';
import { Animated, Easing, Platform, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { useMotionPreferences } from '@/components/instrument/motion/useMotionPreferences';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';
import { t } from '@/text';

import { describeStoragePileReceiptNote, type StoragePileBar } from './storagePileModel';

export type PileBarActions = Readonly<{
  onClear?: () => void;
  onReview?: () => void;
  onUndo?: () => unknown;
  onEmptyNow?: () => unknown;
  onDone?: () => void;
}>;

/**
 * The pile (plan 40 §7(g), lab `rs` PM, `RS.basket`): absent until it holds something, then the count
 * and what clearing frees, "Checking N items again" while the review re-checks, "N items in Trash" with
 * Empty now and Undo after a move (never "freed": the space is not back yet), and "freed" only when it
 * is. Presentational: it takes the pile's state and the words for its note; the Storage tab mounts it
 * docked through `StoragePileDock`, and an agent's proposal card can mount the same bar.
 * On a phone it is one line and one button (PM 8).
 */
export const PileBar = React.memo(function PileBar(
  props: Readonly<
    PileBarActions & {
      bar: StoragePileBar;
      /** The line under the count: what is in it, what was skipped, when the space returns. */
      note: string | null;
      compact: boolean;
      /** `card`: docked as the last row of an agent's proposal card instead of floating over the page. */
      placement?: 'page' | 'card';
      /** Storage is decimal; process proposals free binary memory. */
      quantityKind?: Parameters<typeof formatMachineBytes>[1];
      testID?: string;
      /**
       * What needs the person under the bar's line (a refused Put back and its recovery). It keeps the bar
       * on screen even when the line itself has nothing left to say.
       */
      recovery?: React.ReactNode;
    }
  >,
) {
  const { theme } = useUnistyles();
  // Docked on a phone page, the pile stands above the floating tab bar, as every pinned page bar does.
  const chromeClearance = useFloatingChromeClearance();
  const motion = useMotionPreferences();
  const visible = props.bar.kind !== 'hidden' || props.recovery != null;
  // The first item rises from the bottom edge (12 px + opacity, 240 ms); the last leaves faster (160 ms).
  const rise = React.useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [mounted, setMounted] = React.useState(visible);
  React.useEffect(() => {
    if (visible) setMounted(true);
    if (motion.reduceMotion) {
      rise.setValue(visible ? 1 : 0);
      if (!visible) setMounted(false);
      return;
    }
    const animation = Animated.timing(rise, {
      toValue: visible ? 1 : 0,
      duration: visible ? 240 : 160,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => animation.stop();
  }, [motion.reduceMotion, rise, visible]);
  const last = React.useRef(props.bar);
  if (visible) last.current = props.bar;
  if (!mounted) return null;
  const bar = visible ? props.bar : last.current;
  const amount = (bytes: number) => formatMachineBytes(bytes, props.quantityKind ?? 'storage');
  // A partial Empty is said by the receipt itself, on every surface that docks this bar; what stayed and why
  // gets its second line even on a phone, where the bar is otherwise one line.
  const receiptNote = describeStoragePileReceiptNote(bar);
  const note = receiptNote ?? props.note;
  const icon =
    bar.kind === 'held'
      ? 'trash'
      : bar.kind === 'freed'
        ? 'check-circle'
        : 'tray';
  const title =
    bar.kind === 'held'
      ? t('machineStorage.pile.inTrash', { count: bar.count })
      : bar.kind === 'freed'
        ? t('machineStorage.pile.freed', { amount: amount(bar.freedBytes) })
        : bar.kind === 'checking'
          ? t('machineStorage.pile.checking', { count: bar.count })
          : bar.kind === 'ready'
            ? t('machineStorage.pile.items', { count: bar.count })
            : bar.kind === 'dropped'
              ? t('machineStorage.pile.items', { count: 0 })
              : '';
  const total =
    bar.kind === 'held'
      ? bar.inTrashBytes === null ? t('machineStorage.pile.sizeUnknown') : amount(bar.inTrashBytes)
      : bar.kind === 'checking'
        ? amount(bar.freesBytes)
        : bar.kind === 'ready'
          ? bar.freesBytes === null ? t('machineStorage.sizing') : t('machineStorage.pile.frees', { amount: amount(bar.freesBytes) })
          : bar.kind === 'freed'
            ? t('machineStorage.pile.goneForGood', { count: bar.count })
            : '';
  const actions = (
    <View style={styles.actions}>
      {bar.kind === 'ready' && props.onClear && !props.compact ? (
        <RoundButton
          testID="machine-storage-pile-clear"
          size="small"
          display="inverted"
          title={t('machineStorage.pile.clear')}
          onPress={props.onClear}
        />
      ) : null}
      {bar.kind === 'ready' && props.onReview ? (
        <RoundButton
          testID="machine-storage-pile-review"
          size="small"
          display="default"
          title={t('machineStorage.pile.review', { count: bar.count })}
          onPress={props.onReview}
        />
      ) : null}
      {bar.kind === 'held' && props.onEmptyNow && !props.compact ? (
        <RoundButton
          testID="machine-storage-pile-empty"
          size="small"
          display="inverted"
          title={t('machineStorage.pile.emptyNow')}
          action={async () => {
            await props.onEmptyNow?.();
          }}
        />
      ) : null}
      {bar.kind === 'held' && props.onUndo ? (
        <RoundButton
          testID="machine-storage-pile-undo"
          size="small"
          display="secondary"
          title={t('machineStorage.pile.undo')}
          leading={
            <Icon
              name="arrow-arc-left"
              size={14}
              color={theme.colors.text.primary}
            />
          }
          action={async () => {
            await props.onUndo?.();
          }}
        />
      ) : null}
      {(bar.kind === 'freed' || bar.kind === 'dropped') && props.onDone ? (
        <RoundButton
          testID="machine-storage-pile-done"
          size="small"
          display="inverted"
          title={t('machineStorage.pile.done')}
          onPress={props.onDone}
        />
      ) : null}
    </View>
  );
  const card = props.placement === 'card';
  const motionStyle = [
    {
      opacity: rise,
      transform: [
        {
          translateY: rise.interpolate({
            inputRange: [0, 1],
            outputRange: [12, 0],
          }),
        },
      ],
    },
  ];
  const a11y = {
    accessibilityRole: bar.kind === 'ready' ? undefined : ('summary' as const),
    accessibilityLiveRegion: 'polite' as const,
    accessibilityLabel: [title, total, note].filter(Boolean).join(', '),
  };
  const content = bar.kind === 'hidden' ? null : (
    <View style={styles.row}>
      <View style={styles.glyph}>
        {bar.kind === 'checking' ? (
          <ActivitySpinner size="small" color={theme.colors.text.secondary} />
        ) : (
          <Icon
            name={icon}
            size={18}
            color={
              bar.kind === 'freed'
                ? theme.colors.state.success.textForeground
                : theme.colors.text.secondary
            }
          />
        )}
      </View>
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
          {total ? <Text style={styles.total}>{`  ${total}`}</Text> : null}
        </Text>
        {note ? (
          <Text style={styles.note} numberOfLines={props.compact && !card && !receiptNote ? 1 : 2}>
            {note}
          </Text>
        ) : null}
      </View>
      {actions}
    </View>
  );
  const body = (
    <>
      {content}
      {props.recovery ? <View style={content ? styles.recovery : null}>{props.recovery}</View> : null}
    </>
  );
  if (card) {
    return (
      <Animated.View testID={props.testID ?? 'machine-storage-pile'} style={[styles.bar, props.compact ? styles.compact : null, styles.inCard, motionStyle]} {...a11y}>
        {body}
      </Animated.View>
    );
  }
  // Docked, the bar is the page column's width (lab `rs` dock): the sticky layer spans the pane, the bar sits
  // in the column like every section above it.
  return (
    <Animated.View style={[dockStyle, Platform.OS === 'web' ? { bottom: theme.space.s12 + chromeClearance } : null, motionStyle]}>
      <ItemGroup surface="none" header="none">
        <View testID={props.testID ?? 'machine-storage-pile'} style={[styles.bar, props.compact ? styles.compact : null]} {...a11y}>
          {body}
        </View>
      </ItemGroup>
    </Animated.View>
  );
});

/** The pile docks at the bottom of the page on the web, over the rows (the list keeps room for it). */
const dockStyle: ViewStyle =
  Platform.OS === 'web'
    ? { position: 'sticky' as 'relative', zIndex: 3 }
    : {};

const styles = StyleSheet.create((theme) => ({
  bar: {
    gap: theme.space.s12,
    marginTop: theme.space.s16,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.surface,
    backgroundColor: theme.colors.edge.cardFill,
    ...shadowLevelStyle(theme.colors.shadowLevels[2]),
  },
  inCard: {
    marginTop: 0,
    borderRadius: 0,
    borderWidth: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0,
    elevation: 0,
  },
  compact: {
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
  },
  recovery: {
    paddingTop: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.surface,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
  },
  glyph: {
    width: 20,
    alignItems: 'center',
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: theme.space.s2,
  },
  title: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  total: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
  },
  note: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
}));
