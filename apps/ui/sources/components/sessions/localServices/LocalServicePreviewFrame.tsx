import * as React from 'react';
import { View } from 'react-native';

export function LocalServicePreviewFrame(props: Readonly<{
    title: string;
    url: string;
    testID: string;
}>): React.ReactElement {
    return (
        <View
            accessibilityLabel={props.title}
            testID={props.testID}
            style={{ flex: 1 }}
        />
    );
}
