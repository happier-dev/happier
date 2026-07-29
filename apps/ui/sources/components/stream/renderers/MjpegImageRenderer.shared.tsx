import * as React from 'react';
import { Image, type ImageStyle, type StyleProp } from 'react-native';

export function MjpegImageRenderer(props: Readonly<{
    frameUrl: string;
    testID: string;
    style?: StyleProp<ImageStyle>;
}>): React.ReactElement {
    return (
        <Image
            accessibilityRole="image"
            resizeMode="contain"
            source={{ uri: props.frameUrl }}
            style={props.style}
            testID={props.testID}
        />
    );
}
