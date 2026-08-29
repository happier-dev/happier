import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { personalHomeCopy } from './personalHomeCopy';

const styles = StyleSheet.create((theme) => ({
    root: { gap: 14, marginTop: 20 },
    body: { ...Typography.default(), color: theme.colors.text.secondary, fontSize: 14, lineHeight: 21 },
    actions: { gap: 10 },
    button: { minHeight: 52, borderRadius: 12, paddingHorizontal: 16, justifyContent: 'center', borderWidth: 1, borderColor: theme.colors.border.default },
    title: { ...Typography.default('semiBold'), color: theme.colors.text.primary },
    subtitle: { ...Typography.default(), color: theme.colors.text.secondary, fontSize: 13, marginTop: 3 },
}));

export const PersonalHomeExistingRuntimeDecision = React.memo(function PersonalHomeExistingRuntimeDecision(props: Readonly<{
    onUseExisting: () => void;
    onUseAnotherHome: () => void;
}>) {
    const { theme } = useUnistyles();
    return (
        <View testID="personal-home-existing-runtime-decision" style={styles.root}>
            <Text style={styles.body}>{personalHomeCopy('existingRuntimeBody', 'A local Home already exists on this computer. Choose how Happier should use it.')}</Text>
            <View style={styles.actions}>
                <Pressable testID="personal-home-use-existing" accessibilityRole="button" onPress={props.onUseExisting} style={[styles.button, { backgroundColor: theme.colors.button.primary.background, borderColor: theme.colors.button.primary.background }]}>
                    <Text style={[styles.title, { color: theme.colors.button.primary.tint }]}>{personalHomeCopy('useExisting', 'Use this local Home')}</Text>
                    <Text style={[styles.subtitle, { color: theme.colors.button.primary.tint }]}>{personalHomeCopy('useExistingDetail', 'Keep its existing data and storage policy.')}</Text>
                </Pressable>
                <Pressable testID="personal-home-use-another" accessibilityRole="button" onPress={props.onUseAnotherHome} style={styles.button}>
                    <Text style={styles.title}>{personalHomeCopy('useAnother', 'Use another Home')}</Text>
                    <Text style={styles.subtitle}>{personalHomeCopy('useAnotherDetail', 'Leave this local Home untouched.')}</Text>
                </Pressable>
            </View>
            <Text accessibilityLiveRegion="polite" style={{ ...Typography.default(), color: theme.colors.text.tertiary, fontSize: 12 }}>
                {t('setupOnboarding.webDesktopOnlyBody')}
            </Text>
        </View>
    );
});
