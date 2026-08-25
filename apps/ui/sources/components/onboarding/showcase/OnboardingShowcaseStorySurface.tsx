import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { OnboardingShowcaseManifest } from '@/onboarding/showcase/types';
import { t } from '@/text';
import { StoryDeckSurface, StorySheetFrame } from '@/components/ui/storyDeck';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

const stylesheet = StyleSheet.create((theme) => ({
    skip: {
        minWidth: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 8,
    },
    skipText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
}));

export type OnboardingShowcaseStorySurfaceProps = Readonly<{
    manifest: OnboardingShowcaseManifest;
    onComplete: () => void;
    onDismiss: () => void;
    testID?: string;
}>;

export function OnboardingShowcaseStorySurface(props: OnboardingShowcaseStorySurfaceProps) {
    useUnistyles();
    const styles = stylesheet;
    const testID = props.testID ?? 'onboarding-showcase-story';
    return (
        <StorySheetFrame
            testID={testID}
            onDismiss={props.onDismiss}
            topRightAction={(
                <Pressable
                    testID={`${testID}-skip`}
                    onPress={props.onDismiss}
                    style={styles.skip}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.skip')}
                >
                    <Text style={styles.skipText}>{t('common.skip')}</Text>
                </Pressable>
            )}
        >
            <StoryDeckSurface
                cards={props.manifest.cards}
                onComplete={props.onComplete}
                onDismiss={props.onDismiss}
                slideAnimation="softBlur"
                alternateWideMediaPlacement
                testID={`${testID}-deck`}
            />
        </StorySheetFrame>
    );
}
