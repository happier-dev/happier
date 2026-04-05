import * as React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

export function DesktopActivityOverlaySessionRow(props: Readonly<{
    title: string;
    subtitle: string | null;
    statusText: string | null;
    onPress: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();

    return (
        <Pressable
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.container,
                {
                    borderColor: theme.colors.divider,
                    backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHigh,
                },
            ]}
        >
            <View style={styles.textWrap}>
                <Text style={[styles.title, { color: theme.colors.text }]}>
                    {props.title}
                </Text>
                {props.subtitle ? (
                    <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
                        {props.subtitle}
                    </Text>
                ) : null}
                {props.statusText ? (
                    <Text style={[styles.status, { color: theme.colors.textSecondary }]}>
                        {props.statusText}
                    </Text>
                ) : null}
            </View>
        </Pressable>
    );
}

const styles = StyleSheet.create({
    container: {
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    textWrap: {
        gap: 2,
    },
    title: {
        fontSize: 13,
        fontWeight: '700',
    },
    subtitle: {
        fontSize: 12,
    },
    status: {
        fontSize: 12,
    },
});
