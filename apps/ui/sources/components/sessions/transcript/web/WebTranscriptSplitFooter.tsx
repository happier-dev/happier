import * as React from 'react';
import { View } from 'react-native';

function WebTranscriptSplitFooterInner<T extends { id: string }>(props: {
    hotItems: readonly T[];
    startIndex: number;
    renderItemAtIndex: (item: T, index: number) => React.ReactNode;
    footer: React.ReactNode;
}) {
    if (props.hotItems.length === 0) {
        return props.footer;
    }

    return (
        <View testID="transcript-web-hot-tail">
            {props.hotItems.map((item, index) => (
                <View key={item.id} testID={`transcript-web-hot-tail-item-${item.id}`}>
                    {props.renderItemAtIndex(item, props.startIndex + index)}
                </View>
            ))}
            {props.footer}
        </View>
    );
}

export const WebTranscriptSplitFooter = React.memo(WebTranscriptSplitFooterInner) as typeof WebTranscriptSplitFooterInner;
