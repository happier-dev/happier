import * as React from 'react';
import { Platform, ScrollView, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { layout } from '@/components/ui/layout/layout';
import { tryRenderWebPortal } from '@/components/ui/popover/portal';
import { createBackdropNativeStyle, createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import { useModalCardDimensions } from '@/modal/components/card/useModalCardDimensions';
import { useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { shadowLevelStyle } from '@/shadowElevation';
import { preloadReactDOM } from '@/utils/web/reactDomCjs';
import { useLocalSetting } from '@/sync/store/hooks';
import { shouldUseWizardFullscreenPresentation } from './wizardPresentation';

export type WizardCardLayoutProps = Readonly<{
    children: React.ReactNode;
    testID?: string;
    presentation?: 'auto' | 'card' | 'fullscreen';
    scrollable?: boolean;
    showScrim?: boolean;
    style?: StyleProp<ViewStyle>;
}>;

type WizardCardLayoutMetrics = Readonly<{
    cardWidth: number;
    wantsFullscreen: boolean;
}>;

const WizardCardLayoutMetricsContext = React.createContext<WizardCardLayoutMetrics | null>(null);

export function useWizardCardLayoutMetrics(): WizardCardLayoutMetrics | null {
    return React.useContext(WizardCardLayoutMetricsContext);
}

const stylesheet = StyleSheet.create((theme, _runtime) => ({
    root: {
        flex: 1,
        width: '100%',
        alignSelf: 'stretch',
    },
    rootFullscreen: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
        width: '100%',
        alignSelf: 'stretch',
    },
    rootOuterScroll: {
        flex: 1,
        width: '100%',
        alignSelf: 'stretch',
    },
    rootOuterScrollFullscreen: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
        minHeight: '100%',
        width: '100%',
        alignSelf: 'stretch',
    },
    scrim: {
        ...StyleSheet.absoluteFillObject,
        position: 'absolute',
        backgroundColor: theme.colors.overlay.scrimWizard,
    },
    scroll: {
        flex: 1,
        width: '100%',
        alignSelf: 'stretch',
    },
    container: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 20,
        paddingVertical: 16,
        flexGrow: 1,
    },
    containerFullscreen: {
        alignItems: 'stretch',
        justifyContent: 'flex-start',
        paddingHorizontal: 0,
        paddingVertical: 0,
        flexGrow: 1,
    },
    outerScrollContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 20,
        paddingVertical: 16,
    },
    outerScrollContainerFullscreen: {
        alignItems: 'stretch',
        justifyContent: 'flex-start',
        paddingHorizontal: 0,
        paddingVertical: 0,
    },
    cardBase: {
        alignSelf: 'center',
        position: 'relative',
        zIndex: 1,
        overflow: 'hidden',
        flexDirection: 'column',
        flexGrow: 0,
        flexShrink: 0,
        minHeight: 0,
    },
    card: {
        borderRadius: theme.borderRadius.modalCard,
        backgroundColor: theme.colors.surface.base,
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
    },
    cardFullscreen: {
        borderRadius: 0,
        backgroundColor: theme.colors.surface.base,
    },
    cardFullscreenOuterScroll: {
        flex: 1,
        minHeight: '100%',
        alignSelf: 'stretch',
    },
}));

export function WizardCardLayout(props: WizardCardLayoutProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const uiBackdropBlurEnabled = useLocalSetting('uiBackdropBlurEnabled') !== false;
    const { width: windowWidth } = useWindowDimensions();
    const isFocused = useIsFocused();
    const modalPortalTarget = useModalPortalTarget();
    const [portalRetryNonce, bumpPortalRetryNonce] = React.useReducer((value: number) => value + 1, 0);
    const dimensions = useModalCardDimensions({
        size: 'md',
        width: 500,
    });
    const presentation = props.presentation ?? 'auto';
    const hasKnownWindowWidth = Number.isFinite(windowWidth) && windowWidth > 0;
    const wantsFullscreen = presentation === 'fullscreen'
        || (presentation === 'auto' && hasKnownWindowWidth && shouldUseWizardFullscreenPresentation(windowWidth));
    const cardWidth = wantsFullscreen ? windowWidth : Math.min(dimensions.width, layout.maxWidth);
    const shouldUseInternalScrollView = props.scrollable ?? true;
    const metrics: WizardCardLayoutMetrics = React.useMemo(() => ({
        cardWidth,
        wantsFullscreen,
    }), [cardWidth, wantsFullscreen]);
    // When the wizard renders as a standalone overlay, it must escape any transformed ancestors so its
    // scrim can cover the full viewport. Use `showScrim=false` as the signal that an outer BaseModal
    // owns the backdrop and fullscreen positioning.
    const shouldUseWebFixedOverlay = Platform.OS === 'web' && props.showScrim !== false && isFocused;
    const portalRetryCountRef = React.useRef(0);
    const webBackdropStyle = Platform.OS === 'web' && !wantsFullscreen && shouldUseWebFixedOverlay
        ? (createBackdropWebStyle({
            backgroundColor: theme.colors.overlay.scrimWizard,
            blurPx: 2,
            enableBlur: uiBackdropBlurEnabled,
            fallbackBackgroundColorWhenBlurDisabled: theme.colors.overlay.scrimStrong,
        }) as unknown as ViewStyle)
        : null;
    const shouldRenderScrim = !wantsFullscreen && props.showScrim !== false;

    const webFixedFillStyle =
        shouldUseWebFixedOverlay
            ? ({ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100000 } as any)
            : null;

    const webFixedScrimStyle =
        shouldUseWebFixedOverlay
            ? ({ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 } as any)
            : null;

    const rootBaseStyle = shouldUseInternalScrollView
        ? (wantsFullscreen ? styles.rootFullscreen : styles.root)
        : (wantsFullscreen ? styles.rootOuterScrollFullscreen : styles.rootOuterScroll);

    const rootStyle = [
        rootBaseStyle,
        shouldUseInternalScrollView
            ? null
            : (wantsFullscreen ? styles.outerScrollContainerFullscreen : styles.outerScrollContainer),
        webFixedFillStyle,
    ];

    const card = (
        <View
            testID={props.testID ? `${props.testID}-card` : undefined}
            {...(Platform.OS === 'web'
                ? ({ dataSet: { happyModalCardBoundary: 'true' } } as unknown as Record<string, unknown>)
                : null)}
            style={[
                styles.cardBase,
                wantsFullscreen ? styles.cardFullscreen : styles.card,
                wantsFullscreen && !shouldUseInternalScrollView ? styles.cardFullscreenOuterScroll : null,
                wantsFullscreen ? { borderRadius: 0 } : null,
                props.style,
                wantsFullscreen
                    ? { width: '100%', maxWidth: '100%' }
                    : { width: cardWidth, maxWidth: cardWidth },
            ]}
        >
            <WizardCardLayoutMetricsContext.Provider value={metrics}>
                {props.children}
            </WizardCardLayoutMetricsContext.Provider>
        </View>
    );

    const content = (
        <View style={rootStyle}>
            {shouldRenderScrim ? (
                <View
                        testID={props.testID ? `${props.testID}-scrim` : undefined}
                        style={[
                            styles.scrim,
                            webFixedScrimStyle,
                            webBackdropStyle ?? createBackdropNativeStyle({
                                backgroundColor: theme.colors.overlay.scrimWizard,
                            }),
                        ]}
                    />
            ) : null}
            {shouldUseInternalScrollView ? (
                <ScrollView
                    style={styles.scroll}
                    contentContainerStyle={wantsFullscreen ? styles.containerFullscreen : styles.container}
                    showsVerticalScrollIndicator={false}
                >
                    {card}
                </ScrollView>
            ) : (
                card
            )}
        </View>
    );

    const shouldPortalWeb = Platform.OS === 'web' && props.showScrim !== false && isFocused && portalRetryNonce >= 0;
    const webPortal = tryRenderWebPortal({
        shouldPortalWeb,
        portalTargetOnWeb: 'body',
        modalPortalTarget,
        getBoundaryDomElement: () => null,
        content,
    });

    const reactDomPreloadAttemptedRef = React.useRef(false);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (!shouldPortalWeb) return;
        if (webPortal != null) return;

        if (!reactDomPreloadAttemptedRef.current) {
            reactDomPreloadAttemptedRef.current = true;
            void preloadReactDOM()
                .then(() => bumpPortalRetryNonce())
                .catch(() => {});
        }

        // Retry a few times post-mount. Some web runtimes (SSR/hydration, early init) can render before the
        // DOM/portal target is ready, causing the first `createPortal(...)` attempt to fail.
        //
        // Schedule retries with a timer/frame to avoid tight re-render loops if portal creation keeps failing.
        const retryBudget = 8;
        if (portalRetryCountRef.current >= retryBudget) return;
        portalRetryCountRef.current += 1;

        if (typeof setTimeout === 'function') {
            const timer = setTimeout(() => bumpPortalRetryNonce(), 0);
            return () => clearTimeout(timer);
        }
    }, [shouldPortalWeb, webPortal]);

    // A blurred route can remain mounted in the web navigation stack. Its fixed, body-level
    // wizard portal must not outlive route focus or it will overlay the active route.
    if (Platform.OS === 'web' && !isFocused) return null;

    return webPortal ?? content;
}
