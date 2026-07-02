import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, useWindowDimensions, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

export type WarningActionBannerProps = Readonly<{
    actionAccessibilityLabel: string;
    actionLabel: string;
    actionTestID: string;
    body: string;
    disabled?: boolean;
    onActionPress: () => void | Promise<void>;
    secondaryActions?: ReadonlyArray<{
        key: string;
        accessibilityLabel: string;
        label: string;
        onPress: () => void | Promise<void>;
        testID: string;
        disabled?: boolean;
    }>;
    style?: StyleProp<ViewStyle>;
    testID: string;
    title: string;
}>;

const INLINE_ACTIONS_MIN_WIDTH = 720;

export function WarningActionBanner(props: WarningActionBannerProps): React.ReactElement {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const [measuredWidth, setMeasuredWidth] = React.useState<number | null>(null);
    const availableWidth = typeof measuredWidth === 'number' && measuredWidth > 0 ? measuredWidth : width;
    const inlineActions = availableWidth >= INLINE_ACTIONS_MIN_WIDTH;
    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextWidth = Math.max(0, Math.round(event.nativeEvent.layout.width));
        setMeasuredWidth((current) => current === nextWidth ? current : nextWidth);
    }, []);

    return (
        <View
            testID={props.testID}
            onLayout={handleLayout}
            style={[
                {
                    flexDirection: inlineActions ? 'row' : 'column',
                    alignItems: inlineActions ? 'center' : 'stretch',
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    backgroundColor: theme.colors.state.warning.background,
                    borderWidth: 1,
                    borderColor: theme.colors.state.warning.border,
                    borderRadius: 10,
                    gap: inlineActions ? 12 : 8,
                },
                props.style,
            ]}
        >
            <View
                testID={`${props.testID}-copy-row`}
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    flex: inlineActions ? 1 : undefined,
                    minWidth: 0,
                    width: inlineActions ? undefined : '100%',
                }}
            >
                <Ionicons name="warning-outline" size={16} color={theme.colors.state.warning.foreground} />
                <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 13, color: theme.colors.state.warning.foreground, fontWeight: '700' }}>
                        {props.title}
                    </Text>
                    <Text style={{ fontSize: 12, color: theme.colors.state.warning.foreground, lineHeight: 16 }}>
                        {props.body}
                    </Text>
                </View>
            </View>
            <View
                testID={`${props.testID}-actions-row`}
                style={{
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    flexShrink: 0,
                    gap: 6,
                    justifyContent: 'flex-end',
                    maxWidth: '100%',
                    width: inlineActions ? undefined : '100%',
                }}
            >
                {props.secondaryActions?.map((action) => (
                    <Pressable
                        key={action.key}
                        testID={action.testID}
                        accessibilityRole="button"
                        accessibilityLabel={action.accessibilityLabel}
                        disabled={action.disabled}
                        onPress={action.onPress}
                        style={({ pressed }) => ({
                            flexShrink: 0,
                            maxWidth: '100%',
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: theme.colors.state.warning.border,
                            opacity: pressed || action.disabled ? 0.7 : 1,
                        })}
                    >
                        <Text style={{ fontSize: 12, color: theme.colors.state.warning.foreground, fontWeight: '700' }}>
                            {action.label}
                        </Text>
                    </Pressable>
                ))}
                <Pressable
                    testID={props.actionTestID}
                    accessibilityRole="button"
                    accessibilityLabel={props.actionAccessibilityLabel}
                    disabled={props.disabled}
                    onPress={props.onActionPress}
                    style={({ pressed }) => ({
                        flexShrink: 0,
                        maxWidth: '100%',
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderRadius: 8,
                        backgroundColor: theme.colors.button.primary.background,
                        opacity: pressed || props.disabled ? 0.7 : 1,
                    })}
                >
                    <Text style={{ fontSize: 12, color: theme.colors.button.primary.tint, fontWeight: '700' }}>
                        {props.actionLabel}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
}
