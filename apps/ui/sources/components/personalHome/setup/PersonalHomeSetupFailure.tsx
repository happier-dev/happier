import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
    root: { gap: theme.space.s12, alignItems: 'center', alignSelf: 'stretch' },
    message: {  color: theme.colors.text.secondary, ...Typography.variant('reading'),  textAlign: 'center' },
    actions: { flexDirection: 'row', gap: theme.space.s10, flexWrap: 'wrap', justifyContent: 'center' },
}));

export const PersonalHomeSetupFailure = React.memo(function PersonalHomeSetupFailure(props: Readonly<{
    retryControlRef?: React.ComponentProps<typeof RoundButton>['controlRef'];
    detailsControlRef?: React.ComponentProps<typeof RoundButton>['controlRef'];
    /**
     * The state-specific body. The generic fallback promises the user's completed
     * setup work is safe, which is false after an erase, so a state that knows
     * better supplies its own sentence; `null` when the status line above already says it all.
     */
    body?: string | null;
    /** The quiet way out sits with the other actions: one row, so Retry stays the one thing that leads. */
    children?: React.ReactNode;
    onRetry?: () => void;
    onOpenDetails?: () => void;
}>) {
    return (
        <View
            testID="personal-home-bootstrap-failure"
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
            style={styles.root}
        >
            {props.body === null ? null : <Text style={styles.message}>{props.body?.trim() || t('personalHome.bootstrap.failureBody')}</Text>}
            <View style={styles.actions}>
                {props.onRetry ? (
                    <RoundButton
                        size="normal"
                        controlRef={props.retryControlRef}
                        testID="personal-home-bootstrap-retry"
                        accessibilityLabel={t('common.retry')}
                        onPress={props.onRetry}
                        title={t('common.retry')}
                    />
                ) : null}
                {props.onOpenDetails ? (
                    <RoundButton
                        size="normal"
                        display="inverted"
                        controlRef={props.detailsControlRef}
                        testID="personal-home-bootstrap-details"
                        accessibilityLabel={t('common.details')}
                        onPress={props.onOpenDetails}
                        title={t('common.details')}
                    />
                ) : null}
                {props.children}
            </View>
        </View>
    );
});
