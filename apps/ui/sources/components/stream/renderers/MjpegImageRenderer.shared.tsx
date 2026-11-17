import * as React from 'react';
import { Image, type ImageStyle, type StyleProp } from 'react-native';

import { t } from '@/text';

export function MjpegImageRenderer(props: Readonly<{
    frameUrl: string;
    testID: string;
    style?: StyleProp<ImageStyle>;
}>): React.ReactElement {
    return (
        <Image
            accessibilityRole="image"
            // The live picture is the content: a named image, never an unnamed one.
            accessibilityLabel={t('streamPlayer.frameAccessibilityLabel')}
            resizeMode="contain"
            source={{ uri: props.frameUrl }}
            style={props.style}
            testID={props.testID}
        />
    );
}
