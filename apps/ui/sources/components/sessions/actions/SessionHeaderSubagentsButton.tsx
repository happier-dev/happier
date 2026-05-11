import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DependabotIcon } from '@/components/ui/icons/DependabotIcon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useOptionalSessionScreenTestId } from '../shell/sessionScreenTestIds';

export const SessionHeaderSubagentsButton = React.memo((props: Readonly<{
    scopeId: string;
    activeCount: number;
    hasAnySubagents: boolean;
}>) => {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const testId = useOptionalSessionScreenTestId('session-header-subagents-button');

    const onPress = React.useCallback(() => {
        pane.openRight({ tabId: 'agents' });
        pane.setRightTab('agents');
    }, [pane]);

    if (!props.hasAnySubagents) return null;

    return (
        <Pressable
            testID={testId}
            onPress={onPress}
            hitSlop={15}
            style={({ pressed }) => ({
                minWidth: 44,
                height: 44,
                paddingHorizontal: props.activeCount > 0 ? 10 : 0,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.7 : 1,
            })}
            accessibilityRole="button"
            accessibilityLabel={t('session.openSubagents', { count: props.activeCount })}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: props.activeCount > 0 ? 6 : 0 }}>
                <DependabotIcon size={21} color={theme.colors.chrome.header.foreground} />
                {props.activeCount > 0 ? (
                    <View
                        style={{
                            minWidth: 18,
                            height: 18,
                            paddingHorizontal: 5,
                            borderRadius: 999,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: theme.colors.accent.blue,
                        }}
                    >
                        <Text
                            style={{
                                color: theme.colors.surface.base,
                                fontSize: 11,
                                fontWeight: '700',
                            }}
                        >
                            {props.activeCount}
                        </Text>
                    </View>
                ) : null}
            </View>
        </Pressable>
    );
});
