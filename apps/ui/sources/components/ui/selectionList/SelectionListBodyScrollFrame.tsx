/**
 * FR4-W2-BODY — scroll/edge-fade host extracted from `SelectionListBody.tsx`.
 *
 * RUX-5: scrolling-edge indicators for the non-virtualized body scroll
 * container. The body is wrapped in a relative-positioned host so the gradient
 * overlays anchor to the scroll viewport. Visibility is driven by
 * `useScrollEdgeFades` (it reports `top`/`bottom` based on scroll offset and
 * content-vs-viewport overflow), seeded with `bottom: true` so the trailing
 * fade renders optimistically before the first measurement. Both overlays use
 * `pointerEvents="none"` so they never block row taps. The fade uses the
 * popover/surface color from theme so the fade-to-background reads correctly.
 *
 * On the FlashList path (virtualized section owns scroll), the body skips
 * this entirely — FlashList handles its own scroll container, and the popover
 * surface (`AgentInputPopoverSurface` / `FloatingOverlay`) already paints
 * outer edge fades around its scroll viewport when it owns the scroller.
 */

import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { useScrollRectIntoViewRegistry } from '@/components/ui/scroll/useScrollRectIntoView';
import { SELECTION_LIST_KEYBOARD_SCROLL_MARGIN_PX } from './_constants';
import { SelectionListScrollIntoViewContext } from './SelectionListScrollIntoViewContext';

type ListboxAriaProps = Readonly<{ id: string; role: 'listbox' }>;

const styles = StyleSheet.create(() => ({
    body: {
        flexDirection: 'column',
        flexShrink: 1,
        flexGrow: 1,
    },
    bodyScrollHost: {
        // The fade-overlay host is a relative-positioned parent so the
        // absolute-positioned gradient overlays anchor to the scroll viewport.
        flexShrink: 1,
        flexGrow: 1,
        position: 'relative',
    },
    bodyScroll: {
        flexShrink: 1,
        flexGrow: 1,
    },
    bodyScrollContent: {
        flexDirection: 'column',
    },
    fadeOverlayWrapper: {
        position: 'absolute',
        left: 0,
        right: 0,
        zIndex: 10,
    },
    fadeOverlayWrapperTop: {
        top: 0,
        height: 28,
    },
    fadeOverlayWrapperBottom: {
        bottom: 0,
        height: 28,
    },
}));

export function SelectionListBodyScrollFrame(props: Readonly<{
    bodyTestId: string;
    scrollTestId: string;
    fadeHostTestId: string;
    fadeTopTestId: string;
    fadeBottomTestId: string;
    listboxAria: ListboxAriaProps;
    scrollTargetOptionId: string | null;
    showsVerticalScrollIndicator: boolean;
    children: React.ReactNode;
}>): React.ReactElement {
    const fades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 4,
        // Optimistically render the trailing fade so users see "more content
        // below" before the first layout/scroll measurement.
        initialVisibility: { bottom: true },
    });
    const scrollIntoView = useScrollRectIntoViewRegistry({
        activeKey: props.scrollTargetOptionId,
        padding: SELECTION_LIST_KEYBOARD_SCROLL_MARGIN_PX,
        alignment: 'nearest',
        animated: false,
    });
    const { theme } = useUnistyles();
    const fadeColor = theme.colors.surface.base;
    return (
        <View
            testID={props.bodyTestId}
            style={styles.body}
            {...(props.listboxAria as unknown as Record<string, never>)}
        >
            <View testID={props.fadeHostTestId} style={styles.bodyScrollHost}>
                <ScrollView
                    ref={scrollIntoView.scrollRef}
                    testID={props.scrollTestId}
                    style={styles.bodyScroll}
                    contentContainerStyle={styles.bodyScrollContent}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={props.showsVerticalScrollIndicator}
                    onLayout={(event) => {
                        fades.onViewportLayout(event);
                        scrollIntoView.onViewportLayout(event);
                    }}
                    onContentSizeChange={(width, height) => {
                        fades.onContentSizeChange(width, height);
                        scrollIntoView.onContentSizeChange(width, height);
                    }}
                    onScroll={(event) => {
                        fades.onScroll(event);
                        scrollIntoView.onScroll(event);
                    }}
                    onMomentumScrollEnd={(event) => {
                        fades.onMomentumScrollEnd(event);
                        scrollIntoView.onScroll(event);
                    }}
                    scrollEventThrottle={16}
                >
                    <SelectionListScrollIntoViewContext.Provider value={scrollIntoView.registerItemLayout}>
                        {props.children}
                    </SelectionListScrollIntoViewContext.Provider>
                </ScrollView>
                <View
                    testID={props.fadeTopTestId}
                    pointerEvents="none"
                    style={[
                        styles.fadeOverlayWrapper,
                        styles.fadeOverlayWrapperTop,
                        { opacity: fades.visibility.top ? 1 : 0 },
                    ]}
                >
                    <ScrollEdgeFades
                        color={fadeColor}
                        size={28}
                        edges={{ top: true }}
                    />
                </View>
                <View
                    testID={props.fadeBottomTestId}
                    pointerEvents="none"
                    style={[
                        styles.fadeOverlayWrapper,
                        styles.fadeOverlayWrapperBottom,
                        { opacity: fades.visibility.bottom ? 1 : 0 },
                    ]}
                >
                    <ScrollEdgeFades
                        color={fadeColor}
                        size={28}
                        edges={{ bottom: true }}
                    />
                </View>
            </View>
        </View>
    );
}
