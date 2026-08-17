import * as React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { useUnistyles } from 'react-native-unistyles';
import type { ComposerContentHandleV1 } from '@happier-dev/protocol';

import { useSessionImagePreview } from '@/components/sessions/files/content/imagePreview/useSessionImagePreview';
import { SessionMediaVideoPreview } from '@/components/sessions/media/SessionMediaVideoPreview';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';

const fill = {
    width: '100%',
    height: '100%',
} as const;

/**
 * The host-only visual adapter for one opaque draft stage. It deliberately
 * owns neither transfer bytes nor a URI contract: temporary sources stay
 * inside the incumbent preview hook/cache.
 */
export const ComposerStagedMediaPreview = React.memo(function ComposerStagedMediaPreview(props: Readonly<{
    handle: ComposerContentHandleV1;
    accessibilityLabel: string;
    testID?: string;
    contentFit?: 'contain' | 'cover';
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const preview = useSessionImagePreview({
        sessionId: '',
        filePath: props.handle.name,
        enabled: true,
        cacheKey: props.handle.sha256,
        mimeType: props.handle.mimeType,
        sizeBytes: props.handle.sizeBytes,
        composerStagedMedia: props.handle,
    });

    if (preview.status === 'loaded') {
        if (props.handle.mediaKind === 'video') {
            return (
                <SessionMediaVideoPreview
                    uri={preview.uri}
                    accessibilityLabel={props.accessibilityLabel}
                />
            );
        }
        return (
            <Image
                accessibilityRole="image"
                accessibilityLabel={props.accessibilityLabel}
                source={{ uri: preview.uri }}
                style={fill}
                contentFit={props.contentFit ?? 'cover'}
                testID={props.testID}
            />
        );
    }

    return (
        <View
            accessibilityRole="image"
            accessibilityLabel={props.accessibilityLabel}
            testID={props.testID}
            style={[fill, { alignItems: 'center', justifyContent: 'center' }]}
        >
            {preview.status === 'loading' ? (
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            ) : (
                <Icon
                    name={preview.status === 'error' ? 'warning-circle' : props.handle.mediaKind === 'video' ? 'video-camera' : 'image'}
                    size={20}
                    color={theme.colors.text.secondary}
                />
            )}
        </View>
    );
});
