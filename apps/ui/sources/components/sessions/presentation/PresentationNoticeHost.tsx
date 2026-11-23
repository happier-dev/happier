import * as React from 'react';
import { Animated, Platform, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';

import { Text } from '@/components/ui/text/Text';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';
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
import { resolveOverlayPointerEvents } from '@/components/ui/overlays/resolveOverlayPointerEvents';
import { useAppShellContentPane } from '@/components/navigation/shell/appShellContentPane';
import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { FLOATING_OVERLAY_METRICS } from '@/components/ui/overlays/floatingOverlayMetrics';
import { tryRenderWebPortal } from '@/components/ui/popover/portal';
import { NOTICE_Z_INDEX } from '@/components/ui/overlays/overlayLayers';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useInPlaceApprovalReview } from '@/components/approvals/ApprovalReviewInPlace';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';

import {
    readPresentationNotices,
    type PresentationNotice,
    retirePresentationNotice,
    shouldSchedulePresentationNoticeRetirement,
    subscribePresentationNotices,
} from './presentationNotices';

// Keep entry and exit travel on the content side of the chrome boundary.
const NOTICE_MOTION = resolveOverlayMotionPreset({ kind: 'popover', direction: 'top' });

/** A notice is a floating surface (toast): the floating hairline and its rim, at the toast's radius. */
// A floating surface: the `lg` step of the one radius base (the floating-overlay radius).
const NOTICE_RADIUS_PX = FLOATING_OVERLAY_METRICS.radiusPx;

const stylesheet = StyleSheet.create((theme) => ({
    stack: {
        position: 'absolute',
        alignItems: 'center',
        gap: theme.space.s8,
        zIndex: NOTICE_Z_INDEX,
    },
    notice: {
        maxWidth: 560,
        borderRadius: NOTICE_RADIUS_PX,
        ...resolveThemeSurfaceBorderStyle({
            borderColor: theme.colors.border.modal,
            edge: resolveThemeRaisedEdge(theme, 'modal'),
            rim: surfaceUsesRim('floating', theme.dark),
        }),
        paddingHorizontal: 14,
        paddingVertical: theme.space.s10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        ...shadowLevelStyle(theme.colors.shadowLevels[3]),
    },
    noticeText: {
        // The row title's size and rhythm, in the body's regular weight: the message is read, not scanned.
        ...Typography.variant('label', 'semiBold'),
        ...Typography.default('regular'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    noticeEmphasis: {
        ...Typography.default('semiBold'),
    },
    // The mark is decoration beside words that already name the subject.
    noticeLeading: {
        flexShrink: 0,
    },
    // The one interactive element in an otherwise passive notice: drawn as a label, reached by its hit area.
    undoControl: {
        justifyContent: 'center',
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s4,
        borderRadius: 8,
    },
    undoControlActive: {
        backgroundColor: theme.colors.surface.pressed,
    },
    undoLabel: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.link,
    },
    // A sticky notice stays until it is dismissed (RU-22): the × sits after Undo, quieter than it.
    dismissControl: {
        marginLeft: -theme.space.s8,
    },
}));

/** The message with its subject in the stronger weight, wherever the language puts the name. */
function renderNoticeMessage(message: string, emphasis: string | undefined, emphasisStyle: object): React.ReactNode {
    const at = emphasis ? message.indexOf(emphasis) : -1;
    if (!emphasis || at < 0) return message;
    return (
        <>
            {message.slice(0, at)}
            <Text style={emphasisStyle}>{emphasis}</Text>
            {message.slice(at + emphasis.length)}
        </>
    );
}

function NoticeApproval({ registration }: Readonly<{ registration: ActionApprovalContinuation }>) {
    const approval = useActionApprovalContinuation({ scopeKey: registration.artifactId,
        serverId: registration.scope?.serverId ?? '', onExecuted: () => {} });
    React.useEffect(() => { approval.requestApproval(registration); }, [approval.requestApproval, registration]);
    const review = useInPlaceApprovalReview({ ...approval, serverId: registration.scope?.serverId ?? null });
    return <ActionApprovalPendingNotice message={t('approvals.waitingForYou')} presentation="inline" summary={approval.approvalSummary}
        onOpenApproval={review.reopen} testID="presentation-notice-approval" />;
}

type SheetBounds = Readonly<{ top: number; left: number; width: number }>;

export const PresentationNoticeHost = React.memo(function PresentationNoticeHost() {
    const notices = React.useSyncExternalStore(
        subscribePresentationNotices,
        readPresentationNotices,
        readPresentationNotices,
    );
    const visible = notices.length > 0;
    const lastShown = React.useRef(notices);
    if (visible) lastShown.current = notices;

    const reducedMotion = useReducedMotionPreference();
    const { present } = useOverlayPresence(visible, reducedMotion ? NOTICE_MOTION.reducedMotionFadeMs : NOTICE_MOTION.exitMs);
    return present ? <PositionedNoticeStack notices={lastShown.current} visible={visible} /> : null;
});

type StackProps = Readonly<{ notices: readonly PresentationNotice[]; visible: boolean }>;

function PositionedNoticeStack(props: StackProps) {
    const { theme } = useUnistyles();
    const column = useAppShellColumn();
    const pane = useAppShellContentPane();
    const safeArea = useChromeSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const web = Platform.OS === 'web';
    const desktopPane = web && column.present ? pane : null;
    const [sheetBounds, setSheetBounds] = React.useState<SheetBounds | null>(null);

    React.useLayoutEffect(() => {
        if (!desktopPane) {
            setSheetBounds(null);
            return;
        }
        const measure = () => {
            const element = desktopPane.ref.current;
            if (!(element instanceof HTMLElement)) return;
            const { top, left, width } = element.getBoundingClientRect();
            if (width <= 0) return;
            setSheetBounds((previous) => previous?.top === top && previous.left === left && previous.width === width
                ? previous : { top, left, width });
        };
        measure();
        return desktopPane.subscribeLayout(measure);
    }, [desktopPane]);

    if (desktopPane && !sheetBounds) return null;
    const horizontalGutter = theme.space.s16;
    const position: ViewStyle = sheetBounds && desktopPane
        ? {
            top: sheetBounds.top + theme.space.s12,
            left: sheetBounds.left + horizontalGutter,
            width: Math.max(0, sheetBounds.width - 2 * horizontalGutter),
        }
        : {
            top: (column.present ? 0 : safeArea.top + headerHeight) + theme.space.s12,
            left: safeArea.left + horizontalGutter,
            right: safeArea.right + horizontalGutter,
        };

    const content = <NoticeStack {...props} position={position} web={web} />;
    // Keep the shell's overlay reachable above dialogs and outside its hidden retained navigator.
    return tryRenderWebPortal({
        shouldPortalWeb: web,
        portalTargetOnWeb: 'body',
        modalPortalTarget: null,
        getBoundaryDomElement: () => null,
        content,
    }) ?? content;
}

function NoticeStack({ notices, visible, position, web }: StackProps & Readonly<{ position: ViewStyle; web: boolean }>) {
    const frameRef = React.useRef<React.ComponentRef<typeof Animated.View>>(null);
    const motion = useOverlayMotionAnimation({ visible, preset: NOTICE_MOTION, elementRef: frameRef });
    const pointer = resolveOverlayPointerEvents('box-none');
    return (
        <Animated.View
            ref={frameRef}
            style={[
                stylesheet.stack,
                web && { position: 'fixed' as ViewStyle['position'] },
                position,
                motion.style,
                pointer.webStyle,
            ]}
            pointerEvents={pointer.nativePointerEvents}
            testID="presentation-notice-stack"
        >
            {notices.map((notice) => <NoticeCard key={notice.key} notice={notice} leaving={!visible} />)}
        </Animated.View>
    );
}

function NoticeCard({ notice, leaving }: Readonly<{ notice: PresentationNotice; leaving: boolean }>) {
    const styles = stylesheet;
    // Holding the existing lifetime open while the Undo control is focused or
    // hovered keeps it from disappearing mid-use. This is the same one host
    // lifecycle, not a second scheduler.
    const [controlEngaged, setControlEngaged] = React.useState(false);
    const control = notice.undo ?? notice.action ?? null;
    React.useEffect(() => {
        if (!control) setControlEngaged(false);
    }, [control]);

    React.useEffect(() => {
        if (leaving || !shouldSchedulePresentationNoticeRetirement(notice, controlEngaged)) return;
        const timeout = setTimeout(() => retirePresentationNotice(notice.key), 4_000);
        return () => clearTimeout(timeout);
    }, [notice, controlEngaged, leaving]);

    const onControlPress = React.useCallback(() => {
        if (leaving || !control) return;
        control.run();
        retirePresentationNotice(notice.key);
    }, [notice, control, leaving]);

    const hostPointerEvents = resolveOverlayPointerEvents('box-none');
    const noticePointerEvents = resolveOverlayPointerEvents((control || notice.sticky) && !leaving ? 'auto' : 'none');

    return (
        <View
            style={hostPointerEvents.webStyle}
            pointerEvents={hostPointerEvents.nativePointerEvents}
            testID={leaving ? 'current-session-presentation-notice-leaving' : 'current-session-presentation-notice'}
            aria-hidden={leaving ? true : undefined}
            accessibilityElementsHidden={leaving}
            importantForAccessibility={leaving ? 'no-hide-descendants' : 'auto'}
        >
            <View
                style={[styles.notice, noticePointerEvents.webStyle]}
                pointerEvents={noticePointerEvents.nativePointerEvents}
                accessibilityRole={notice.severity === 'error' ? 'alert' : 'text'}
                accessibilityLiveRegion={leaving ? 'none' : notice.severity === 'error' ? 'assertive' : 'polite'}
            >
                <GlassSurface surfaceGroup="floating" style={[StyleSheet.absoluteFillObject, { borderRadius: NOTICE_RADIUS_PX }]}>{null}</GlassSurface>
                {notice.leading ? <View style={styles.noticeLeading}>{notice.leading}</View> : null}
                {notice.approval && !leaving ? <NoticeApproval key={notice.approval.artifactId} registration={notice.approval} />
                    : <Text style={styles.noticeText}>{renderNoticeMessage(notice.message, notice.emphasis, styles.noticeEmphasis)}</Text>}
                {control ? (
                    <HappierPressable
                        testID={leaving ? undefined : notice.undo
                            ? 'current-session-presentation-notice-undo' : 'current-session-presentation-notice-action'}
                        accessibilityRole="button"
                        accessibilityLabel={control.label}
                        onPress={onControlPress}
                        onFocusChange={setControlEngaged}
                        onHoverChange={setControlEngaged}
                        style={({ pressed }) => [styles.undoControl, pressed && styles.undoControlActive]}
                    >
                        <Text style={styles.undoLabel}>{control.label}</Text>
                    </HappierPressable>
                ) : null}
                {notice.sticky ? (
                    <View style={styles.dismissControl}>
                        <IconButton
                            testID={leaving ? undefined : 'current-session-presentation-notice-dismiss'}
                            iconName="x"
                            iconSize={14}
                            variant="plain"
                            accessibilityLabel={t('common.close')}
                            onPress={() => retirePresentationNotice(notice.key)}
                        />
                    </View>
                ) : null}
                <SurfaceRim role="floating" radius={NOTICE_RADIUS_PX} border="modal" />
            </View>
        </View>
    );
}
