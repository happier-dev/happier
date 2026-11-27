import * as React from 'react';
import { Animated, Easing, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  HappierPressable,
  readHappierPointerModifiers,
  resolveHappierListMultiSelectionKeyboardIntent,
  resolveHappierListMultiSelectionPointerAction,
  resolveHappierPointerPlatform,
} from '@happier-dev/plugin-ui/presentation';
import { Platform } from 'react-native';
import type { StorageReasonV1 } from '@happier-dev/protocol/storage/storageV1';

import { useMotionPreferences } from '@/components/instrument/motion/useMotionPreferences';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { Modal } from '@/modal';
import type { MachineStorageResult } from '@/sync/domains/machines/storage/machineRpc';
import { useMachineStoragePile } from '@/sync/domains/machines/storage/useMachineStoragePile';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { describeStorageLosses } from './storageReasonPresentation';
import {
  describeStorageCollect,
  describeStorageGroupCollect,
  resolveStorageCollectAll,
  resolveStorageCollectRange,
  resolveStorageCollectToggle,
  type StorageCollectable,
  type StorageCollectState,
  type StoragePileDelta,
} from './storagePileModel';
import { describeStorageFailure } from './storageViewModel';

const BOX_PX = 22;

/**
 * The tick of a storage row (lab `rs` PM): `SelectionCheckGlyph` as the row's collect control, bound to
 * the pile. Pointer down presses it in (.94, 120 ms); the tick is the pile's answer. A row without a box
 * keeps the slot so every row's name starts at the same place; a row inside a collected folder reads as
 * collected and cannot be ticked on its own.
 */
export const StorageCollectToggle = React.memo(function StorageCollectToggle(
  props: Readonly<{
    state:
      | StorageCollectState
      | 'group-checked'
      | 'group-mixed'
      | 'group-unchecked'
      | null;
    label: string;
    onPress?: (event?: unknown) => void;
    /** Shift+Arrow and Space over the rows (the Collection keyboard rule); true when handled. */
    onKeyDown?: (key: string, event: unknown) => boolean;
    testID?: string;
  }>,
) {
  const motion = useMotionPreferences();
  const press = React.useRef(new Animated.Value(1)).current;
  const animate = (to: number) => {
    if (motion.reduceMotion) return;
    Animated.timing(press, {
      toValue: to,
      duration: 120,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  };
  if (props.state === null || props.state === 'none')
    return (
      <View
        style={styles.slot}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
    );
  const glyph =
    props.state === 'collected' ||
    props.state === 'inside' ||
    props.state === 'group-checked'
      ? 'checked'
      : props.state === 'group-mixed'
        ? 'mixed'
        : 'unchecked';
  const disabled = props.state === 'inside' || !props.onPress;
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="checkbox"
      checked={glyph === 'mixed' ? 'mixed' : glyph === 'checked'}
      accessibilityLabel={props.label}
      disabled={disabled}
      onPressIn={() => animate(0.94)}
      onPressOut={() => animate(1)}
      onPress={props.onPress ?? noop}
      {...(props.onKeyDown ? { onKeyDown: props.onKeyDown } : {})}
      style={styles.slot}
    >
      <Animated.View
        style={[
          styles.box,
          disabled && props.state === 'inside' ? styles.inside : null,
          { transform: [{ scale: press }] },
        ]}
      >
        <SelectionCheckGlyph state={glyph} />
      </Animated.View>
    </HappierPressable>
  );
});

function noop() {}

/** Ask before a Keep item goes in the pile, naming what is lost (R42.1). */
export async function confirmStorageKeep(
  input: Readonly<{
    title: string;
    reason: StorageReasonV1;
    loses?: readonly StorageReasonV1[];
    file?: true;
  }>,
): Promise<boolean> {
  const lost = describeStorageLosses(
    input.loses?.length ? input.loses : [input.reason],
    { file: input.file === true },
  );
  return Modal.confirm(
    t('machineStorage.keep.title', { name: input.title }),
    lost,
    {
      confirmText:
        input.reason.code === 'in_use'
          ? t('machineStorage.keep.confirmInUse')
          : t('machineStorage.keep.confirm'),
      cancelText: t('machineStorage.keep.cancel'),
      destructive: true,
    },
  );
}

export type StorageCollectRowInput = StorageCollectable &
  Readonly<{
    title: string;
    reason: StorageReasonV1;
    loses?: readonly StorageReasonV1[];
    /** The item is one file (a whole-disk row), so what it loses names the file. */
    file?: true;
  }>;

export function showStoragePileWriteFailure(result: MachineStorageResult<unknown>): void {
  if (result.ok) return;
  const { reason } = describeStorageFailure(result, { closedCopyOnly: true });
  Modal.alert(t('machineStorage.pile.collectFailedTitle'), reason ?? t('machineStorage.pile.collectFailed'));
}

/**
 * The pile, as rows see it: each row's box state and the one delta its tick sends. The pile hook is the
 * data owner (optimistic, rolled back to the machine's truth); this only maps rows onto it.
 */
export function useStorageCollect(
  input: Readonly<{ serverId: string; machineId: string; readOnly?: boolean }>,
) {
  const pile = useMachineStoragePile({
    machineId: input.machineId,
    serverId: input.serverId,
  });
  const { items, set } = pile;
  const send = React.useCallback(
    (delta: (StoragePileDelta & Readonly<{ clear?: true }>) | null) => {
      if (!delta) return;
      fireAndForget(
        set(delta).then(showStoragePileWriteFailure),
        { tag: 'StorageCollect.set' },
      );
    },
    [set],
  );
  // The last row ticked (the range anchor) and the keyboard cursor: presentation of the pile only, never membership.
  const anchor = React.useRef<string | null>(null);
  const cursor = React.useRef<string | null>(null);
  const sendRange = React.useCallback((rows: readonly StorageCollectable[], targetKey: string) => {
    send(resolveStorageCollectRange({ rows, pile: items, anchorKey: anchor.current, targetKey }));
  }, [items, send]);
  const toggle = React.useCallback(
    (row: StorageCollectRowInput, context?: Readonly<{ rows: readonly StorageCollectable[]; event?: unknown }>) => {
      const modifiers = readHappierPointerModifiers(context?.event);
      const action = resolveHappierListMultiSelectionPointerAction({ isSelectionMode: true,
        platform: resolveHappierPointerPlatform(Platform.OS), ...modifiers });
      if (context && action === 'selectRange' && anchor.current) {
        sendRange(context.rows, row.itemId);
        cursor.current = row.itemId;
        return;
      }
      anchor.current = row.itemId;
      cursor.current = row.itemId;
      const state = describeStorageCollect(row, items);
      const delta = resolveStorageCollectToggle(row, items);
      if (state !== 'confirm') {
        send(delta);
        return;
      }
      fireAndForget(
        confirmStorageKeep(row).then((ok) => {
          if (ok) send(delta);
        }),
        { tag: 'StorageCollect.keep' },
      );
    },
    [items, send, sendRange],
  );
  const keyDown = React.useCallback(
    (row: StorageCollectRowInput, rows: readonly StorageCollectRowInput[], key: string, event: unknown): boolean => {
      const modifiers = readHappierPointerModifiers(event);
      const from = rows.findIndex((entry) => entry.itemId === (cursor.current ?? row.itemId));
      const intent = resolveHappierListMultiSelectionKeyboardIntent({ key, ...modifiers, platform: resolveHappierPointerPlatform(Platform.OS),
        entries: rows.map((entry) => ({ disabled: describeStorageCollect(entry, items) === 'none' })),
        currentIndex: from >= 0 ? from : rows.findIndex((entry) => entry.itemId === row.itemId), rtl: false });
      if (intent?.kind === 'toggleFocused') { toggle(row); return true; }
      if (intent?.kind === 'extendRange') {
        const target = rows[intent.toIndex];
        if (!target) return false;
        if (!anchor.current) anchor.current = row.itemId;
        sendRange(rows, target.itemId);
        cursor.current = target.itemId;
        return true;
      }
      return false;
    },
    [items, sendRange, toggle],
  );
  /** A row's box: its state, its press (Shift extends the range) and its keys. */
  const rowProps = React.useCallback(
    (row: StorageCollectRowInput, rows: readonly StorageCollectRowInput[]) => ({
      state: input.readOnly ? ('none' as const) : describeStorageCollect(row, items),
      onToggle: (event?: unknown) => toggle(row, { rows, event }),
      onKeyDown: (key: string, event: unknown) => keyDown(row, rows, key, event),
    }),
    [input.readOnly, items, keyDown, toggle],
  );
  const collectAll = React.useCallback(
    (rows: readonly StorageCollectable[]) => {
      send(resolveStorageCollectAll(rows, items));
    },
    [items, send],
  );
  const stateOf = React.useCallback(
    (row: StorageCollectable): StorageCollectState =>
      input.readOnly ? 'none' : describeStorageCollect(row, items),
    [input.readOnly, items],
  );
  const groupOf = React.useCallback(
    (rows: readonly StorageCollectable[]) =>
      input.readOnly ? null : describeStorageGroupCollect(rows, items),
    [input.readOnly, items],
  );
  return React.useMemo(
    () => ({
      pile,
      items,
      toggle,
      rowProps,
      collectAll,
      stateOf,
      groupOf,
      clear: () => send({ clear: true }),
    }),
    [pile, items, toggle, rowProps, collectAll, stateOf, groupOf, send],
  );
}
export type StorageCollectController = ReturnType<typeof useStorageCollect>;

const styles = StyleSheet.create(() => ({
  slot: {
    width: BOX_PX,
    height: BOX_PX,
    alignItems: 'center',
    justifyContent: 'center',
  },
  box: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  inside: {
    opacity: 0.45,
  },
}));
