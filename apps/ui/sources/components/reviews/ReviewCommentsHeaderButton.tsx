import React from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';

export type ReviewCommentsHeaderButtonProps = Readonly<{
    labels: Readonly<{
        title: string;
        count: (params: Readonly<{ count: number }>) => string;
    }>;
    unresolvedCount: number;
    onPress?: () => void;
    testID?: string;
}>;

export function ReviewCommentsHeaderButton(props: ReviewCommentsHeaderButtonProps) {
    return (
        <Pressable onPress={props.onPress} testID={props.testID}>
            <View>
                <Text>{props.labels.title}</Text>
                <Text>{props.labels.count({ count: props.unresolvedCount })}</Text>
            </View>
        </Pressable>
    );
}
