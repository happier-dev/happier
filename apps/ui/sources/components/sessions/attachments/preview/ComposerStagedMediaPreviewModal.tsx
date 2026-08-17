import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import type { ComposerContentHandleV1 } from '@happier-dev/protocol';
import { StyleSheet } from 'react-native-unistyles';

import { ComposerStagedMediaPreview } from '@/components/sessions/attachments/preview/ComposerStagedMediaPreview';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        flex: 1,
        backgroundColor: theme.colors.surface.inset,
    },
    mediaSurface: {
        flex: 1,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.elevated,
    },
}));

/** A presentation-only host modal for one opaque staged video. */
export const ComposerStagedMediaPreviewModal = React.memo(function ComposerStagedMediaPreviewModal(props: CustomModalInjectedProps & Readonly<{
    handle: ComposerContentHandleV1;
    title: string;
}>) {
    const styles = stylesheet;
    const { width, height } = useWindowDimensions();
    const containerWidth = Math.max(280, Math.min(width - 24, 960));
    const containerHeight = Math.max(240, Math.min(height - 24, 840));
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: props.title,
        testID: 'composer-staged-media-preview-modal',
        ...(Platform.OS === 'web' ? { scrollHost: 'body' as const } : {}),
        dimensions: {
            width: containerWidth,
            maxHeightRatio: height > 0 ? containerHeight / height : 0.92,
            size: 'lg' as const,
        },
    }), [containerHeight, containerWidth, height, props.title]);
    useModalCardChrome(props.setChrome, chrome);

    return (
        <View style={styles.body}>
            <View style={styles.mediaSurface} testID="composer-staged-media-preview-surface">
                <ComposerStagedMediaPreview
                    handle={props.handle}
                    accessibilityLabel={props.title}
                    contentFit="contain"
                />
            </View>
        </View>
    );
});
