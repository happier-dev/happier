import * as React from 'react';
import { Animated, Platform, Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
    resolveOverlayMotionPreset,
    useOverlayMotionAnimation,
    useOverlayPresence,
} from '@/components/ui/overlays/motion/overlayMotion';
import { shadowLevelStyle } from '@/shadowElevation';
import { resolveThemeSurfaceBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { resolveThemeRaisedEdge } from '@/components/ui/surfaces/themeRaisedEdge';
import { SurfaceRim } from '@/components/ui/surfaces/SurfaceRim';
import { surfaceUsesRim } from '@/components/ui/surfaces/surfaceEdgeTreatment';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { resolveOverlayPointerEvents } from '@/components/ui/overlays/resolveOverlayPointerEvents';
import { useOptionalSafeAreaInsets } from '@/hooks/ui/useOptionalSafeAreaInsets';
import { FLOATING_OVERLAY_METRICS } from '@/components/ui/overlays/floatingOverlayMetrics';

import {
    readPresentationNotice,
    retirePresentationNotice,
    subscribePresentationNotices,
} from './presentationNotices';

/**
 * The app's ONE transient presentation notice, drawn.
 *
 * Every producer — the daemon presentation stream, mounted plugin `notify`, and
 * Board/Companion feedback — publishes to `presentationNotices`; this is the only
 * place that reads it. It lives beside its runtime rather than inside it so the
 * chrome that matters to a person (does it clear the notch, can a thumb hit
 * Undo) can be exercised on its own, without standing up a daemon binding.
 *
 * It performs no domain mutation: `undo` is a caller-owned local inverse that the
 * publisher bound to its own exact target.
 */

/** Distance from the top of the usable window; the notch is added on top of it. */
const NOTICE_TOP_MARGIN_PX = 12;
/** It hangs from the top of the window: it drops in from that edge and lifts back into it. */
const NOTICE_MOTION = resolveOverlayMotionPreset({ kind: 'popover', direction: 'bottom' });

/** A notice is a floating surface (toast): the floating hairline and its rim, at the toast's radius. */
// A floating surface: the `lg` step of the one radius base (the floating-overlay radius).
const NOTICE_RADIUS_PX = FLOATING_OVERLAY_METRICS.radiusPx;

const stylesheet = StyleSheet.create((theme) => ({
    noticeHost: {
        position: 'absolute',
        left: 16,
        right: 16,
        alignItems: 'center',
        zIndex: 200,
    },
    notice: {
        maxWidth: 560,
        borderRadius: NOTICE_RADIUS_PX,
        ...resolveThemeSurfaceBorderStyle({
            borderColor: theme.colors.border.modal,
            edge: resolveThemeRaisedEdge(theme, 'modal'),
            rim: surfaceUsesRim('floating', theme.dark),
        }),
        backgroundColor: theme.colors.edge.floatingFill,
        paddingHorizontal: 14,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        ...shadowLevelStyle(theme.colors.shadowLevels[3]),
    },
    noticeText: {
        // The row title's size and rhythm, in the body's regular weight: the message is read, not scanned.
        ...Typography.rowTitle(),
        ...Typography.default('regular'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    undoControl: {
        // The one interactive element in an otherwise passive notice, so it keeps
        // the platform's own accessible target rather than a copied constant.
        minHeight: resolveMinimumInteractiveTargetSize(Platform.OS),
        justifyContent: 'center',
        paddingHorizontal: 8,
        borderRadius: 8,
    },
    undoControlActive: {
        backgroundColor: theme.colors.surface.pressed,
    },
    undoLabel: {
        ...Typography.rowTitle(),
        color: theme.colors.text.link,
    },
}));

export const PresentationNoticeHost = React.memo(function PresentationNoticeHost() {
    const styles = stylesheet;
    const notice = React.useSyncExternalStore(
        subscribePresentationNotices,
        readPresentationNotice,
        readPresentationNotice,
    );
    // A retired notice leaves the way it came, still saying what it said, and takes no presses while
    // it goes; a newer notice replaces the words in place.
    const lastShownRef = React.useRef(notice);
    if (notice) lastShownRef.current = notice;
    const motion = useOverlayMotionAnimation({ visible: notice !== null, preset: NOTICE_MOTION });
    const { present } = useOverlayPresence(notice !== null, motion.exitMs);
    // The notice floats over whatever the app is showing, so it consumes the
    // window's own safe region. Without it the card sits under the notch, the
    // status bar or a rounded corner on the exact devices that have one.
    const safeAreaInsets = useOptionalSafeAreaInsets();

    // Holding the existing lifetime open while the Undo control is focused or
    // hovered keeps it from disappearing mid-use. This is the same one host
    // lifecycle, not a second scheduler.
    const [undoControlEngaged, setUndoControlEngaged] = React.useState(false);
    const undo = notice?.undo ?? null;
    React.useEffect(() => {
        if (!undo) setUndoControlEngaged(false);
    }, [undo]);

    React.useEffect(() => {
        if (!notice || undoControlEngaged) return;
        const timeout = setTimeout(() => retirePresentationNotice(notice.key), 4_000);
        return () => clearTimeout(timeout);
    }, [notice, undoControlEngaged]);

    const onUndoPress = React.useCallback(() => {
        if (!notice?.undo) return;
        notice.undo.run();
        retirePresentationNotice(notice.key);
    }, [notice]);

    // The empty space beside the card must keep passing touches through to the
    // app underneath, while the card's own Undo stays hit-testable. React Native
    // removes a `pointerEvents="none"` view AND its whole subtree from hit
    // testing, so only `box-none` expresses that; the platform seam itself lives
    // in the overlay owner every other host here already consumes.
    const hostPointerEvents = resolveOverlayPointerEvents('box-none');
    const shown = notice ?? lastShownRef.current;
    const leaving = notice === null;
    const noticePointerEvents = resolveOverlayPointerEvents(undo && !leaving ? 'auto' : 'none');

    if (!present || !shown) return null;
    const shownUndo = leaving ? shown.undo ?? null : undo;
    return (
        <View
            style={[
                styles.noticeHost,
                { top: NOTICE_TOP_MARGIN_PX + safeAreaInsets.top },
                hostPointerEvents.webStyle,
            ]}
            pointerEvents={hostPointerEvents.nativePointerEvents}
            testID={leaving ? 'current-session-presentation-notice-leaving' : 'current-session-presentation-notice'}
            aria-hidden={leaving ? true : undefined}
            accessibilityElementsHidden={leaving}
            importantForAccessibility={leaving ? 'no-hide-descendants' : 'auto'}
        >
            <Animated.View
                style={[styles.notice, motion.style, noticePointerEvents.webStyle]}
                pointerEvents={noticePointerEvents.nativePointerEvents}
                accessibilityRole={shown.severity === 'error' ? 'alert' : 'text'}
                accessibilityLiveRegion={leaving ? 'none' : shown.severity === 'error' ? 'assertive' : 'polite'}
            >
                <Text style={styles.noticeText}>{shown.message}</Text>
                {shownUndo ? (
                    <Pressable
                        testID={leaving ? undefined : 'current-session-presentation-notice-undo'}
                        accessibilityRole="button"
                        accessibilityLabel={shownUndo.label}
                        hitSlop={8}
                        onPress={onUndoPress}
                        onFocus={() => setUndoControlEngaged(true)}
                        onBlur={() => setUndoControlEngaged(false)}
                        onHoverIn={() => setUndoControlEngaged(true)}
                        onHoverOut={() => setUndoControlEngaged(false)}
                        style={({ pressed }) => [styles.undoControl, pressed && styles.undoControlActive]}
                    >
                        <Text style={styles.undoLabel}>{shownUndo.label}</Text>
                    </Pressable>
                ) : null}
                <SurfaceRim role="floating" radius={NOTICE_RADIUS_PX} border="modal" />
            </Animated.View>
        </View>
    );
});
