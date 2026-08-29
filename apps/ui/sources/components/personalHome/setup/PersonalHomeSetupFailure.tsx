import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { NormalizedSetupDetail } from '../bootstrap/personalHomeBootstrapTypes';

const styles = StyleSheet.create((theme) => ({
    root: { gap: 14, marginTop: 20 },
    message: { ...Typography.default(), color: theme.colors.text.secondary, fontSize: 14, lineHeight: 21 },
    actions: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
    button: { minHeight: 44, borderRadius: 12, paddingHorizontal: 16, justifyContent: 'center', borderWidth: 1, borderColor: theme.colors.border.default },
    primary: { backgroundColor: theme.colors.button.primary.background, borderColor: theme.colors.button.primary.background },
    buttonText: { ...Typography.default('semiBold'), color: theme.colors.text.primary },
    primaryText: { color: theme.colors.button.primary.tint },
}));

export const PersonalHomeSetupFailure = React.memo(function PersonalHomeSetupFailure(props: Readonly<{
    detail?: NormalizedSetupDetail;
    onRetry?: () => void;
    onOpenDetails?: () => void;
}>) {
    const { theme } = useUnistyles();
    const message = props.detail?.message ?? t('common.error');
    return (
        <View
            testID="personal-home-bootstrap-failure"
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
            style={styles.root}
        >
            <Text style={styles.message}>{message}</Text>
            <View style={styles.actions}>
                {props.onRetry ? (
                    <Pressable
                        testID="personal-home-bootstrap-retry"
                        accessibilityRole="button"
                        accessibilityLabel={t('common.retry')}
                        onPress={props.onRetry}
                        style={[styles.button, styles.primary]}
                    >
                        <Text style={[styles.buttonText, styles.primaryText]}>{t('common.retry')}</Text>
                    </Pressable>
                ) : null}
                {props.onOpenDetails ? (
                    <Pressable
                        testID="personal-home-bootstrap-details"
                        accessibilityRole="button"
                        accessibilityLabel={t('common.details')}
                        onPress={props.onOpenDetails}
                        style={styles.button}
                    >
                        <Text style={[styles.buttonText, { color: theme.colors.text.primary }]}>{t('common.details')}</Text>
                    </Pressable>
                ) : null}
            </View>
        </View>
    );
});
