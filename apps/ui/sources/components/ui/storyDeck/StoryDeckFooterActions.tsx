import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';

export type StoryDeckFooterActionsProps = Readonly<{
    isLastSlide: boolean;
    onPrimary: () => void;
    onSecondary?: () => void;
    onSkip?: () => void;
    primaryLabel?: string;
    secondaryLabel?: string;
    skipLabel?: string;
    primaryDisabled?: boolean;
    testID?: string;
}>;

const stylesheet = StyleSheet.create({
    container: {
        gap: 10,
    },
});

export function StoryDeckFooterActions(props: StoryDeckFooterActionsProps) {
    const styles = stylesheet;

    const primaryLabel = props.primaryLabel
        ?? (props.isLastSlide ? t('releaseNotes.storyDeck.letsGo') : t('common.next'));

    return (
        <View style={styles.container} testID={props.testID}>
            <RoundButton
                testID={`${props.testID ?? 'story-deck'}-primary`}
                title={primaryLabel}
                size="large"
                onPress={props.onPrimary}
                disabled={props.primaryDisabled}
            />
            {props.isLastSlide && props.onSecondary ? (
                <RoundButton
                    testID={`${props.testID ?? 'story-deck'}-secondary`}
                    title={props.secondaryLabel ?? t('releaseNotes.viewFullChangelog')}
                    size="normal"
                    display="inverted"
                    onPress={props.onSecondary}
                />
            ) : null}
            {props.onSkip ? (
                <RoundButton
                    testID={`${props.testID ?? 'story-deck'}-skip`}
                    title={props.skipLabel ?? t('common.skip')}
                    size="normal"
                    display="inverted"
                    onPress={props.onSkip}
                />
            ) : null}
        </View>
    );
}
