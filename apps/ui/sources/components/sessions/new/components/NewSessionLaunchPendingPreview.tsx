import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
    isNewSessionLaunchAttemptPendingBeforeSession,
    type NewSessionLaunchAttempt,
} from '@/components/sessions/new/modules/newSessionLaunchAttempt';

export function shouldRenderNewSessionLaunchPendingPreview(
    launchAttempt: NewSessionLaunchAttempt | null | undefined,
): launchAttempt is NewSessionLaunchAttempt {
    return isNewSessionLaunchAttemptPendingBeforeSession(launchAttempt)
        && (launchAttempt.prompt.displayText.trim().length > 0 || launchAttempt.prompt.prompt.trim().length > 0);
}

export function NewSessionLaunchPendingPreview(props: Readonly<{
    launchAttempt: NewSessionLaunchAttempt | null | undefined;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    if (!shouldRenderNewSessionLaunchPendingPreview(props.launchAttempt)) {
        return null;
    }

    const promptText = props.launchAttempt.prompt.displayText.trim()
        || props.launchAttempt.prompt.prompt.trim();

    return (
        <View
            accessibilityLabel={t('newSession.startingSession')}
            accessibilityRole="progressbar"
            testID="new-session-launch-pending-preview"
            style={{
                width: '100%',
                alignSelf: 'center',
                borderWidth: 1,
                borderRadius: 8,
                borderColor: theme.colors.border.default,
                backgroundColor: theme.colors.surface.elevated,
                padding: 12,
                gap: 10,
            }}
        >
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                }}
            >
                <ActivitySpinner
                    size="small"
                    color={theme.colors.text.secondary}
                    testID="new-session-launch-pending-preview-spinner"
                />
                <Text
                    testID="new-session-launch-pending-preview-status"
                    style={{
                        color: theme.colors.text.secondary,
                    }}
                >
                    {t('newSession.startingSession')}
                </Text>
            </View>
            <View
                style={{
                    borderRadius: 8,
                    backgroundColor: theme.colors.surface.base,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                }}
            >
                <Text
                    numberOfLines={6}
                    testID="new-session-launch-pending-preview-prompt"
                    style={{
                        color: theme.colors.text.primary,
                    }}
                >
                    {promptText}
                </Text>
            </View>
        </View>
    );
}
