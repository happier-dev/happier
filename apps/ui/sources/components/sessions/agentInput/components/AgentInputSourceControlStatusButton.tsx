import * as React from 'react';
import { Octicons } from '@expo/vector-icons';
import { Platform, Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { SourceControlStatusBadge, useHasMeaningfulScmStatus } from '@/components/sessions/sourceControl/status';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { t } from '@/text';

const SOURCE_CONTROL_BUTTON_HIT_SLOP = { top: 5, bottom: 10, left: 0, right: 0 } as const;

export const AgentInputSourceControlStatusButton = React.memo(function AgentInputSourceControlStatusButton(props: Readonly<{
    sessionId?: string;
    onPress?: () => void;
    compact?: boolean;
}>) {
    const hasMeaningfulScmStatus = useHasMeaningfulScmStatus(props.sessionId || '');
    const { theme } = useUnistyles();
    const compact = props.compact === true;
    const handlePress = React.useCallback(() => {
        hapticsLight();
        props.onPress?.();
    }, [props.onPress]);
    const pressableStyle = React.useCallback((state: { pressed: boolean }) => ({
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingHorizontal: 8,
        paddingVertical: 6,
        height: 32,
        opacity: state.pressed ? 0.7 : 1,
        flex: compact ? 0 : 1,
        overflow: 'hidden' as const,
    }), [compact]);

    if (!props.sessionId || !props.onPress) {
        return null;
    }

    return (
        <Pressable
            testID="session-open-source-control"
            accessibilityRole="button"
            accessibilityLabel={t('settings.sourceControl')}
            style={pressableStyle}
            hitSlop={SOURCE_CONTROL_BUTTON_HIT_SLOP}
            onPress={handlePress}
        >
            {hasMeaningfulScmStatus ? (
                <SourceControlStatusBadge sessionId={props.sessionId} />
            ) : (
                normalizeNodeForView(
                    <Octicons
                        name="git-branch"
                        size={16}
                        color={theme.colors.composer.chipTint}
                    />,
                )
            )}
        </Pressable>
    );
});
