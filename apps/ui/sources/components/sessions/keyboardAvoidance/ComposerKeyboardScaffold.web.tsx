import * as React from 'react';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { Dimensions, View, useWindowDimensions, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import { useOptionalModal } from '@/modal';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';
import { useReportSessionCockpitComposerChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { ComposerKeyboardProvider } from './ComposerKeyboardContext';
import type { ComposerKeyboardScaffoldProps } from './ComposerKeyboardScaffoldTypes';
import { useComposerKeyboardLayout } from './useComposerKeyboardLayout.web';
import { PaneMainBody } from '@/components/ui/panels/paneMainComposerAnchor';
import { resolveOverlayPointerEvents } from '@/components/ui/overlays/resolveOverlayPointerEvents';

function normalizeScaffoldHeight(height: number): number | undefined {
    if (!Number.isFinite(height) || height <= 0) return undefined;
    return Math.round(height);
}

// In a content-sized host, the scaffold's own height is only what the composer already occupies.
// Include the room its nearest capped scrolling host can still grow into to avoid granting the
// composer a few more pixels on every layout pass. The uncapped modal body is skipped.
function readScrollingHostGrowthRoom(element: unknown): number {
    if (typeof HTMLElement === 'undefined' || !(element instanceof HTMLElement)) return 0;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;
        if (!style.maxHeight.endsWith('px')) continue;
        const maxHeight = Number.parseFloat(style.maxHeight);
        if (!Number.isFinite(maxHeight)) continue;
        // offsetHeight is the layout box, unaffected by the drawer's enter/exit transforms.
        return Math.max(0, maxHeight - ancestor.offsetHeight);
    }
    return 0;
}

function flattenStyleItems(style: StyleProp<ViewStyle>): Array<StyleProp<ViewStyle>> {
    if (Array.isArray(style)) {
        return style.flatMap((item) => flattenStyleItems(item as StyleProp<ViewStyle>));
    }
    return style ? [style] : [];
}

export function ComposerKeyboardScaffold(props: ComposerKeyboardScaffoldProps): React.ReactElement {
    const rootPointer = resolveOverlayPointerEvents(props.pointerEvents ?? 'auto');
    const composerPointer = resolveOverlayPointerEvents(props.composerPointerEvents ?? 'auto');
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const [availablePanelMaxHeight, setAvailablePanelMaxHeight] = React.useState<number | undefined>(undefined);
    const modal = useOptionalModal();
    const isInsideModalBoundary = useIsInsideModalBoundary();
    const modalKeyboardLiftSuppressed = modal?.isKeyboardLiftSuppressedByModal === true;
    const keyboardLiftSuppressed = props.keyboardLiftSuppressed === true
        || (!isInsideModalBoundary && modalKeyboardLiftSuppressed);
    const layout = useComposerKeyboardLayout({
        availablePanelMaxHeight,
        headerHeight: props.headerHeight,
        keyboardLiftSuppressed,
        layoutBottomInset: props.layoutBottomInset,
        safeAreaBottom: props.safeAreaBottom,
    });
    // A worklet captures only what it reads: the whole `props` carries React elements, which the
    // web mapper walks as inputs and overflows on.
    const safeAreaBottom = props.safeAreaBottom ?? 0;
    // The composer floats above the bottom chrome, so it is an obstacle for app-shell overlays that
    // sit outside the session screen (the Voice orb). Publish it there; a modal-hosted composer is
    // already covered by its modal and stays out of the shell's obstacle set.
    const reportComposerChromeHeight = useReportSessionCockpitComposerChromeHeight(!isInsideModalBoundary);
    // Window-space overlays also need where the band starts: on desktop the workspace frame lifts
    // it off the window edge. Measured at rest — the keyboard lift is the keyboard owner's fact.
    const composerRef = React.useRef<View | null>(null);
    const composerHeightRef = React.useRef<number | null>(null);
    const publishComposerBand = React.useCallback(() => {
        const height = composerHeightRef.current;
        if (height === null) return;
        const node = composerRef.current;
        if (!node || typeof node.measureInWindow !== 'function') {
            reportComposerChromeHeight(height);
            return;
        }
        node.measureInWindow((_x, y, width, measuredHeight) => {
            if (composerHeightRef.current !== height) return;
            // A composer in a display:none screen measures 0×0 at the window origin: it is not on
            // screen, so it is no obstacle. Publishing its "top" (the whole window) would lift every
            // shell overlay placed above composers onto the title strip.
            if (!(width > 0 && measuredHeight > 0)) {
                reportComposerChromeHeight(null);
                return;
            }
            const lift = Math.max(0, layout.bottomInset.value - safeAreaBottom);
            const top = Dimensions.get('window').height - y - lift;
            reportComposerChromeHeight(height, Number.isFinite(top) ? top : 0);
        });
    }, [layout, reportComposerChromeHeight, safeAreaBottom]);
    const { height: windowHeight } = useWindowDimensions();
    const scaffoldLayoutRef = React.useRef<Readonly<{ height: number; element: unknown }> | null>(null);
    const publishAvailablePanelMaxHeight = React.useCallback(() => {
        const scaffoldLayout = scaffoldLayoutRef.current;
        if (!scaffoldLayout) return;
        const nextHeight = normalizeScaffoldHeight(
            scaffoldLayout.height + readScrollingHostGrowthRoom(scaffoldLayout.element),
        );
        setAvailablePanelMaxHeight((current) => (current === nextHeight ? current : nextHeight));
    }, []);
    const handleScaffoldLayout = React.useCallback((event: LayoutChangeEvent) => {
        // react-native-web exposes the measured DOM node as `nativeEvent.target`.
        const { target } = event.nativeEvent as LayoutChangeEvent['nativeEvent'] & { target?: unknown };
        scaffoldLayoutRef.current = { height: event.nativeEvent.layout.height, element: target };
        publishAvailablePanelMaxHeight();
        // A window resize moves the band without resizing it.
        publishComposerBand();
    }, [publishAvailablePanelMaxHeight, publishComposerBand]);
    // A viewport-derived host cap can move without resizing the scaffold itself.
    React.useEffect(() => {
        publishAvailablePanelMaxHeight();
    }, [publishAvailablePanelMaxHeight, windowHeight]);
    const handleComposerLayout = React.useCallback((event: LayoutChangeEvent) => {
        layout.setComposerMeasuredHeight(event.nativeEvent.layout.height);
        composerHeightRef.current = event.nativeEvent.layout.height;
        publishComposerBand();
    }, [layout, publishComposerBand]);
    const liftPaddingStyle = useAnimatedStyle(() => ({
        paddingBottom: Math.max(0, layout.bottomInset.value - safeAreaBottom),
    }));

    const { style: contentPropsStyle, ...contentProps } = props.contentProps ?? {};
    // Same contract as the native scaffold: a transparent scaffold paints no ground of its own and
    // lets the caller supply a `backdrop` sibling instead. The prop is declared on the shared type,
    // so honouring it on both implementations keeps it from becoming a native-only promise.
    const surfaceBackgroundColor = props.surface === 'transparent' ? undefined : materialColor(theme.colors.surface.base, 'transparent');

    return (
        <ComposerKeyboardProvider layout={layout}>
            <Animated.View
                accessibilityLabel={props.accessibilityLabel}
                accessibilityRole={props.accessibilityRole}
                pointerEvents={rootPointer.nativePointerEvents}
                testID={props.testID}
                onLayout={handleScaffoldLayout}
                style={[
                    { flexBasis: 0, flexGrow: 1, minHeight: 0, minWidth: 0, backgroundColor: surfaceBackgroundColor },
                    rootPointer.webStyle,
                    liftPaddingStyle,
                    ...flattenStyleItems(props.style),
                ]}
            >
                {/* Sibling of the content, never a wrapper — see the native scaffold. */}
                <PaneMainBody
                    {...contentProps}
                    testID={props.contentTestID}
                    style={[{ flexBasis: 0, flexGrow: 1, minHeight: 0, minWidth: 0 }, contentPropsStyle, props.contentStyle]}
                >
                    {props.children}
                </PaneMainBody>
                <View
                    ref={composerRef}
                    testID={props.composerTestID}
                    onLayout={handleComposerLayout}
                    pointerEvents={composerPointer.nativePointerEvents}
                    style={[{ backgroundColor: surfaceBackgroundColor }, composerPointer.webStyle]}
                >
                    {props.composer}
                </View>
            </Animated.View>
        </ComposerKeyboardProvider>
    );
}
