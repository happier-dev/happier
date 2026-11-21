import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import type { SettingsBreadcrumb } from './settingsRouteRegistry';

/**
 * Settings header title shown as a breadcrumb trail ("Settings < Connected services < Provider state sharing").
 * Every level above the current screen that has a route is pressable and opens that level.
 */
export const SettingsBreadcrumbHeaderTitle = React.memo((props: Readonly<{
    breadcrumbs: readonly SettingsBreadcrumb[];
    tintColor?: string;
}>) => {
    const styles = stylesheet;
    const router = useRouter();
    const { theme } = useUnistyles();
    const tintColor = props.tintColor ?? theme.colors.chrome.header.foreground;

    return (
        <View style={styles.container} accessibilityRole="header">
            {props.breadcrumbs.map((crumb, index) => {
                const isLast = index === props.breadcrumbs.length - 1;
                const href = crumb.href;
                return (
                    <React.Fragment key={`${index}:${crumb.title}`}>
                        {href ? (
                            <Pressable
                                testID={`settings-breadcrumb-${index}`}
                                accessibilityRole="link"
                                accessibilityLabel={crumb.title}
                                onPress={() => router.navigate(href as never)}
                                hitSlop={8}
                                style={({ pressed }) => [styles.crumb, pressed && styles.crumbPressed]}
                            >
                                <Text style={[styles.text, { color: tintColor }]} numberOfLines={1}>{crumb.title}</Text>
                            </Pressable>
                        ) : (
                            <Text
                                testID={`settings-breadcrumb-${index}`}
                                style={[styles.text, styles.crumb, { color: tintColor }, isLast ? styles.current : styles.plain]}
                                numberOfLines={1}
                            >
                                {crumb.title}
                            </Text>
                        )}
                        {isLast ? null : <Text style={[styles.text, styles.separator, { color: tintColor }]}>{'<'}</Text>}
                    </React.Fragment>
                );
            })}
        </View>
    );
});

const stylesheet = StyleSheet.create(() => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
        gap: 6,
    },
    crumb: {
        flexShrink: 1,
        minWidth: 0,
    },
    crumbPressed: {
        opacity: 0.6,
    },
    text: {
        fontSize: 16,
        ...Typography.default('semiBold'),
    },
    plain: {
        opacity: 0.8,
    },
    current: {},
    separator: {
        opacity: 0.6,
        flexShrink: 0,
    },
}));
