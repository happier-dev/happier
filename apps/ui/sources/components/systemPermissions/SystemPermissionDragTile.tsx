import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import {
  readAppBundleDragInfo,
  setAppBundleDragBounds,
  type NativePermissionBundleDragSubject,
} from '@/desktop/capture/nativeCapture';
import { desktopHostKind } from '@/utils/platform/desktopHost';
import { t } from '@/text';

/** The app icon as macOS draws it in Finder and the Dock. */
const ICON_SIZE = 44;

type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;

/** Whether this app has a bundle to drag (the macOS desktop app); read once while a permission surface is up. */
export function useAppBundleDragAvailable(enabled: boolean): boolean {
    const [available, setAvailable] = React.useState(false);
    React.useEffect(() => {
        if (!enabled || desktopHostKind() !== 'tauri') return;
        let active = true;
        void readAppBundleDragInfo().then((info) => { if (active) setAvailable(info !== null); }, () => undefined);
        return () => { active = false; };
    }, [enabled]);
    return enabled && available;
}

/**
 * The real Happier icon the person drags onto macOS's privacy list (owner, 2026-10-31). The icon
 * itself is a native view the desktop host lays over the slot, so it is the real bundle, draggable
 * out of the window; this tile only reserves its place and says what to do. Mount it only where
 * {@link useAppBundleDragAvailable} says there is a bundle, on a surface that does not scroll.
 *
 * `standIn` draws a picture in the slot instead of asking the host: the dev specimen only.
 */
export function SystemPermissionDragTile(props: Readonly<{
    subject: NativePermissionBundleDragSubject;
    /** Where the dropped icon lands, in the OS's own words. */
    where: string;
    standIn?: React.ReactNode;
    testID?: string;
}>): React.ReactElement {
    const slotRef = useNativeBundleSlot(props.subject, props.standIn === undefined);
    return (
        <View style={styles.tile} testID={props.testID ?? 'system-permission-drag-tile'}>
            <View ref={slotRef} collapsable={false} style={styles.slot}>{props.standIn ?? null}</View>
            <View style={styles.lines}>
                <Text variant="body" emphasis="medium" style={styles.title}>{t('screenCapture.permission.drag')}</Text>
                <Text variant="meta" style={styles.where}>{props.where}</Text>
            </View>
        </View>
    );
}

/** Hands the slot's window position to the host on every commit that moves it, and retires the native view on unmount. */
function useNativeBundleSlot(subject: NativePermissionBundleDragSubject, enabled: boolean) {
    const slotRef = React.useRef<View>(null);
    const sent = React.useRef<Rect | null>(null);
    const measure = React.useCallback(() => {
        const node = slotRef.current as unknown as HTMLElement | null;
        if (!node?.getBoundingClientRect) return;
        const box = node.getBoundingClientRect();
        const next = { x: box.left, y: box.top, width: box.width, height: box.height };
        const last = sent.current;
        if (next.width <= 0 || (last && last.x === next.x && last.y === next.y && last.width === next.width && last.height === next.height)) return;
        sent.current = next;
        void setAppBundleDragBounds(subject, next).catch(() => undefined);
    }, [subject]);
    // The tile moves when the copy above it changes (waiting → reopen), so every commit re-reads its place.
    React.useLayoutEffect(() => { if (enabled) measure(); });
    React.useEffect(() => {
        if (!enabled || typeof window === 'undefined') return;
        window.addEventListener('resize', measure);
        return () => {
            window.removeEventListener('resize', measure);
            sent.current = null;
            void setAppBundleDragBounds(subject, null).catch(() => undefined);
        };
    }, [enabled, measure, subject]);
    return slotRef;
}

const styles = StyleSheet.create((theme) => ({
  tile: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    padding: theme.space.s12,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface.inset,
  },
  slot: {
    width: ICON_SIZE,
    height: ICON_SIZE,
  },
  lines: {
    flex: 1,
    minWidth: 0,
    gap: theme.space.s2,
  },
  title: {
    color: theme.colors.text.primary,
  },
  where: {
    color: theme.colors.text.secondary,
  },
}));
