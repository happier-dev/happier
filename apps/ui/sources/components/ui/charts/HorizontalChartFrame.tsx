import * as React from 'react';
import { ScrollView, View, useWindowDimensions, type ScrollViewProps, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';

import { resolveHorizontalChartInitialOffset } from './resolveHorizontalChartInitialOffset';

type HorizontalChartFrameProps = Readonly<{
    children: React.ReactNode;
    contentWidth: number;
    viewportInset?: number;
    style?: StyleProp<ViewStyle>;
    scrollViewProps?: Partial<ScrollViewProps>;
}>;

const styles = StyleSheet.create(() => ({
    frame: {
        position: 'relative',
        overflow: 'hidden',
    },
}));

export function HorizontalChartFrame(props: HorizontalChartFrameProps): React.ReactElement {
    const {
        children,
        contentWidth,
        viewportInset = 104,
        style,
        scrollViewProps,
    } = props;
    const { width } = useWindowDimensions();
    const { theme } = useUnistyles();
    const scrollRef = React.useRef<ScrollView>(null);
    const appliedInitialOffsetKeyRef = React.useRef<string | null>(null);
    const viewportWidth = Math.max(0, width - viewportInset);
    const initialOffset = resolveHorizontalChartInitialOffset({
        contentWidth,
        viewportWidth,
    });
    const initialOffsetKey = `${contentWidth}:${viewportWidth}:${initialOffset}`;
    const fades = useScrollEdgeFades({
        enabledEdges: { left: true, right: true },
        overflowThreshold: 1,
        edgeThreshold: 8,
        initialVisibility: {
            left: initialOffset > 0,
            right: false,
        },
    });

    const applyInitialOffset = React.useCallback(() => {
        if (initialOffset <= 0) {
            appliedInitialOffsetKeyRef.current = initialOffsetKey;
            return;
        }
        if (appliedInitialOffsetKeyRef.current === initialOffsetKey) {
            return;
        }

        scrollRef.current?.scrollTo({ x: initialOffset, y: 0, animated: false });
        appliedInitialOffsetKeyRef.current = initialOffsetKey;
    }, [initialOffset, initialOffsetKey]);

    React.useEffect(() => {
        applyInitialOffset();
    }, [applyInitialOffset]);

    const handleViewportLayout = React.useCallback((event: Parameters<typeof fades.onViewportLayout>[0]) => {
        fades.onViewportLayout(event);
        applyInitialOffset();
    }, [applyInitialOffset, fades]);

    const handleContentSizeChange = React.useCallback((contentWidthValue: number, contentHeightValue: number) => {
        fades.onContentSizeChange(contentWidthValue, contentHeightValue);
        applyInitialOffset();
    }, [applyInitialOffset, fades]);

    return (
        <View style={[styles.frame, style]} onLayout={handleViewportLayout}>
            <ScrollView
                ref={scrollRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                scrollEventThrottle={16}
                onContentSizeChange={handleContentSizeChange}
                onScroll={fades.onScroll}
                onMomentumScrollEnd={fades.onMomentumScrollEnd}
                {...scrollViewProps}
            >
                {children}
            </ScrollView>
            <ScrollEdgeFades color={theme.colors.surface} size={20} edges={fades.visibility} />
            <ScrollEdgeIndicators
                color={theme.colors.textSecondary}
                size={14}
                opacity={0.45}
                edges={fades.visibility}
                leftStyle={{ width: 18 }}
                rightStyle={{ width: 18 }}
            />
        </View>
    );
}
