import { useHeaderHeight } from '@/utils/platform/responsive';
import { ComposerKeyboardScaffold } from '@/components/sessions/keyboardAvoidance';
import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import * as React from 'react';
import { View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { resolveWebScaffoldSafeAreaBottom } from './resolveWebSessionContentBottomReservation';
import { useKeyboardDismissOnTap } from './useKeyboardDismissOnTap';

interface AgentContentViewProps {
    input?: React.ReactNode | null;
    content?: React.ReactNode | null;
    placeholder?: React.ReactNode | null;
    safeAreaBottom?: number;
}

export const AgentContentView: React.FC<AgentContentViewProps> = React.memo(({
    input,
    content,
    placeholder,
    safeAreaBottom,
}) => {
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const keyboardDismissOnTapHandlers = useKeyboardDismissOnTap();
    const { theme } = useUnistyles();
    // Reserve the floating bar's height inside the session screen (see the native
    // controller for the rationale): the bar overlays content, so the composer is
    // lifted above it here rather than by an in-flow chrome-host reservation.
    //
    // On web the safe area is already handled by the visual viewport; adding it to the
    // scaffold's geometry creates a persistent oversized gap (and a doubled offset when
    // the software keyboard raises). Only the keyboard inset should lift the composer here.
    const scaffoldSafeAreaBottom = resolveWebScaffoldSafeAreaBottom({
        layoutBottomInset: bottomChromeHeight,
        safeAreaBottom: safeAreaBottom ?? safeArea.bottom,
    });
    return (
        <View style={{ flex: 1, minHeight: 0, paddingBottom: bottomChromeHeight, backgroundColor: theme.colors.surface.base }}>
            <ComposerKeyboardScaffold
                testID="agent-content-keyboard-host"
                mode="session"
                contentTestID="agent-content-scroll-region"
                composerTestID="agent-content-input-footer"
                layoutBottomInset={bottomChromeHeight}
                safeAreaBottom={scaffoldSafeAreaBottom}
                headerHeight={headerHeight}
                contentProps={keyboardDismissOnTapHandlers}
                composer={input}
            >
                {content ? (
                    <View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }]}>
                        {content}
                    </View>
                ) : null}
                {placeholder ? (
                    <ScrollView
                        style={[{ position: 'absolute', top: safeArea.top + headerHeight, left: 0, right: 0, bottom: 0 }]}
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
