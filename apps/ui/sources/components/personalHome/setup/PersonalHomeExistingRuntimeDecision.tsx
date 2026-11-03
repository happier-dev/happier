import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
    root: { gap: theme.space.s12, alignSelf: 'stretch' },
    body: {  color: theme.colors.text.secondary, ...Typography.variant('reading'),  flexShrink: 1, textAlign: 'center' },
    actions: { gap: theme.space.s10 },
}));

/**
 * "I already have a Home" — the one escape from automatic provisioning. It is the
 * decision block's secondary action and is also offered on its own during first run,
 * so a second computer is not given a new empty Home before the user can say no.
 */
export const PersonalHomeUseAnotherHomeAction = React.memo(function PersonalHomeUseAnotherHomeAction(props: Readonly<{
    /** Beside setup's progress or failure it is a way out, not a competing choice. */
    quiet?: boolean;
    onUseAnotherHome: () => void;
}>) {
    if (props.quiet) {
        return (
            <RoundButton
                size="normal"
                display="inverted"
                testID="personal-home-use-another"
                accessibilityLabel={t('personalHome.bootstrap.useAnother')}
                accessibilityHint={t('personalHome.bootstrap.useAnotherDetail')}
                onPress={props.onUseAnotherHome}
                title={t('personalHome.bootstrap.useAnother')}
            />
        );
    }
    return (
        <WelcomeActionCard
            testID="personal-home-use-another"
            onPress={props.onUseAnotherHome}
            title={t('personalHome.bootstrap.useAnother')}
            subtitle={t('personalHome.bootstrap.useAnotherDetail')}
            iconName="link"
        />
    );
});

export const PersonalHomeExistingRuntimeDecision = React.memo(function PersonalHomeExistingRuntimeDecision(props: Readonly<{
    primaryActionControlRef?: React.ComponentProps<typeof RoundButton>['controlRef'];
    /** S18: the Home's credentials live with another Happier app, so the way in is its recovery key. */
    needsRecoveryKey?: boolean;
    onUseExisting: () => void;
    onUseAnotherHome: () => void;
    details?: React.ReactNode;
}>) {
    return (
        <View testID="personal-home-existing-runtime-decision" style={styles.root}>
            <Text style={styles.body}>
                {props.needsRecoveryKey
                    ? t('personalHome.bootstrap.existingRuntimeCredentials.body')
                    : t('personalHome.bootstrap.existingRuntimeBody')}
            </Text>
            <View style={styles.actions}>
                <WelcomeActionCard
                    controlRef={props.primaryActionControlRef}
                    testID="personal-home-use-existing"
                    onPress={props.onUseExisting}
                    title={props.needsRecoveryKey
                        ? t('personalHome.bootstrap.existingRuntimeCredentials.signIn')
                        : t('personalHome.bootstrap.useExisting')}
                    subtitle={props.needsRecoveryKey
                        ? t('personalHome.bootstrap.existingRuntimeCredentials.signInDetail')
                        : t('personalHome.bootstrap.useExistingDetail')}
                    iconName="house"
                    primary
                />
                <PersonalHomeUseAnotherHomeAction onUseAnotherHome={props.onUseAnotherHome} />
            </View>
            {props.details}
        </View>
    );
});

/**
 * R10 D4: asked once, before a Personal Home is created, of a user already signed in to another
 * Home. Keeping that Home is the primary answer — it is what they were using.
 */
export const PersonalHomeSignedInHomeDecision = React.memo(function PersonalHomeSignedInHomeDecision(props: Readonly<{
    homeLabel: string;
    primaryActionControlRef?: React.ComponentProps<typeof RoundButton>['controlRef'];
    onKeepSignedInHome: () => void;
    onCreatePersonalHome: () => void;
}>) {
    return (
        <View testID="personal-home-signed-in-home-decision" style={styles.root}>
            <Text style={styles.body}>{t('personalHome.bootstrap.signedInHome.body', { home: props.homeLabel })}</Text>
            <View style={styles.actions}>
                <WelcomeActionCard
                    controlRef={props.primaryActionControlRef}
                    testID="personal-home-keep-signed-in-home"
                    onPress={props.onKeepSignedInHome}
                    title={t('personalHome.bootstrap.signedInHome.keep', { home: props.homeLabel })}
                    subtitle={t('personalHome.bootstrap.signedInHome.keepDetail')}
                    iconName="house"
                    primary
                />
                <WelcomeActionCard
                    testID="personal-home-create-personal-home"
                    onPress={props.onCreatePersonalHome}
                    title={t('personalHome.bootstrap.signedInHome.create')}
                    subtitle={t('personalHome.bootstrap.signedInHome.createDetail')}
                    iconName="house"
                />
            </View>
        </View>
    );
});
