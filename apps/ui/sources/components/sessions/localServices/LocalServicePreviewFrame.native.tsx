import * as React from 'react';
import { WebView } from 'react-native-webview';

export function LocalServicePreviewFrame(props: Readonly<{
    title: string;
    url: string;
    testID: string;
}>): React.ReactElement {
    return (
        <WebView
            accessibilityLabel={props.title}
            source={{ uri: props.url }}
            testID={props.testID}
        />
    );
}
