import * as React from 'react';
import { Octicons } from '@expo/vector-icons';
import { Platform, Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { SourceControlStatusBadge, useHasMeaningfulScmStatus } from '@/components/sessions/sourceControl/status';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { t } from '@/text';

export function AgentInputSourceControlStatusButton(props: Readonly<{
    sessionId?: string;
    onPress?: () => void;
    compact?: boolean;
}>) {
    const hasMeaningfulScmStatus = useHasMeaningfulScmStatus(props.sessionId || '');
    const { theme } = useUnistyles();

    if (!props.sessionId || !props.onPress) {
        return null;
    }

    return (
        <Pressable
            testID="session-open-source-control"
            accessibilityRole="button"
            accessibilityLabel={t('settings.sourceControl')}
            style={(state) => ({
                flexDirection: 'row',
                alignItems: 'center',
                borderRadius: Platform.select({ default: 16, android: 20 }),
                paddingHorizontal: 8,
                paddingVertical: 6,
                height: 32,
                opacity: state.pressed ? 0.7 : 1,
                flex: props.compact ? 0 : 1,
                overflow: 'hidden',
            })}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            onPress={() => {
                hapticsLight();
                props.onPress?.();
            }}
        >
            {hasMeaningfulScmStatus ? (
                <SourceControlStatusBadge sessionId={props.sessionId} />
            ) : (
                normalizeNodeForView(
                    <Octicons
                        name="git-branch"
                        size={16}
                        color={theme.colors.button.secondary.tint}
                    />,
                )
            )}
        </Pressable>
    );
}
