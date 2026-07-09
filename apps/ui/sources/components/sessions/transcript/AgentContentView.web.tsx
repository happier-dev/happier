import { useHeaderHeight } from '@/utils/platform/responsive';
import { ComposerKeyboardScaffold } from '@/components/sessions/keyboardAvoidance';
import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import * as React from 'react';
import { View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { useUnistyles } from 'react-native-unistyles';
import { useKeyboardDismissOnTap } from './useKeyboardDismissOnTap';

interface AgentContentViewProps {
    input?: React.ReactNode | null;
    content?: React.ReactNode | null;
    placeholder?: React.ReactNode | null;
}

export const AgentContentView: React.FC<AgentContentViewProps> = React.memo(({ input, content, placeholder }) => {
    const safeArea = useChromeSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const keyboardDismissOnTapHandlers = useKeyboardDismissOnTap();
    const { theme } = useUnistyles();
    // Reserve the floating bar's height inside the session screen (see the native
    // controller for the rationale): the bar overlays content, so the composer is
    // lifted above it here rather than by an in-flow chrome-host reservation.
    return (
        <View style={{ flex: 1, minHeight: 0, paddingBottom: bottomChromeHeight, backgroundColor: theme.colors.surface.base }}>
        <ComposerKeyboardScaffold
            testID="agent-content-keyboard-host"
            mode="session"
            contentTestID="agent-content-scroll-region"
            composerTestID="agent-content-input-footer"
            layoutBottomInset={bottomChromeHeight}
            safeAreaBottom={safeArea.bottom}
            headerHeight={headerHeight}
            contentProps={keyboardDismissOnTapHandlers}
            composer={input}
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
                        top: safeArea.top + headerHeight,
                    }}
                    contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}
                    keyboardShouldPersistTaps="handled"
                    alwaysBounceVertical={false}
                >
                    {placeholder}
                </ScrollView>
            ) : null}
        </ComposerKeyboardScaffold>
        </View>
    );
});
