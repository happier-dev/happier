import * as React from 'react';
import { ScrollView, View } from 'react-native';

/** Keep decisions reachable while only the request content scrolls in bounded composers. */
export function PromptCardLayout(props: Readonly<{
    children: React.ReactNode;
    footer: React.ReactNode;
    maxHeightPx?: number;
    bodyTestID: string;
}>) {
    return (
        <View style={{ maxHeight: props.maxHeightPx, minHeight: 0 }}>
            <ScrollView
                testID={props.bodyTestID}
                style={{ flexGrow: 0, flexShrink: 1, minHeight: 0 }}
                scrollEnabled={typeof props.maxHeightPx === 'number'}
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
            >
                {props.children}
            </ScrollView>
            <View style={{ flexShrink: 0 }}>{props.footer}</View>
        </View>
    );
}
