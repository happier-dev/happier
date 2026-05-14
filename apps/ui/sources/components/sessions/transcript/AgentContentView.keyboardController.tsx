import { useHeaderHeight } from '@/utils/platform/responsive';
import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useUnistyles } from 'react-native-unistyles';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useKeyboardDismissOnTap } from './useKeyboardDismissOnTap';

interface AgentContentViewProps {
    input?: React.ReactNode | null;
    content?: React.ReactNode | null;
    placeholder?: React.ReactNode | null;
}

export const AgentContentView: React.FC<AgentContentViewProps> = React.memo(({ input, content, placeholder }) => {
    const { theme } = useUnistyles();
    const safeArea = useChromeSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const keyboardDismissOnTapHandlers = useKeyboardDismissOnTap();

    return (
        <KeyboardAvoidingView
            testID="agent-content-keyboard-host"
            behavior="padding"
            keyboardVerticalOffset={0}
            style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface.base }}
        >
            <View
                testID="agent-content-scroll-region"
                style={{ flex: 1, minHeight: 0, minWidth: 0 }}
                {...keyboardDismissOnTapHandlers}
            >
                {content ? (
                    <View
                        testID="agent-content-layer"
                        style={{
                            bottom: 0,
                            left: 0,
                            minWidth: 0,
                            overflow: 'hidden',
                            position: 'absolute',
                            right: 0,
                            top: 0,
                        }}
                    >
                        {content}
                    </View>
                ) : null}
                {placeholder ? (
                    <ScrollView
                        testID="agent-content-placeholder-layer"
                        style={{
                            bottom: 0,
                            left: 0,
                            minWidth: 0,
                            position: 'absolute',
                            right: 0,
                            top: 0,
                        }}
                        contentContainerStyle={{
                            alignItems: 'center',
                            flexGrow: 1,
                            justifyContent: 'center',
                            paddingTop: safeArea.top + headerHeight,
                        }}
                        keyboardShouldPersistTaps="handled"
                        alwaysBounceVertical={false}
                    >
                        {placeholder}
                    </ScrollView>
                ) : null}
            </View>
            <View
                testID="agent-content-input-footer"
                style={{ minWidth: 0, backgroundColor: theme.colors.surface.base }}
            >
                {input}
            </View>
        </KeyboardAvoidingView>
    );
});
