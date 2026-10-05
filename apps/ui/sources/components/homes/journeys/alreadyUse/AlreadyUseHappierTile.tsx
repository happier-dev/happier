import { HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { HeaderLogo } from '@/components/ui/navigation/HeaderLogo';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { SetupBlockPaper } from '@/components/ui/setupBlocks/SetupBlockPaper';
import type { JourneyAccountService } from '../useJourneyAccountService';
import type { AlreadyUsePath } from './alreadyUsePaths';
import { PaneLink, PaneServiceLabel } from './journeyPaneKit';

/**
 * "Already use Happier?" at rest (lab K1): two doors with the service in view. Sign in names the
 * service beside it ("with Happier Cloud ⌄" — one press changes it); Connect to a Home… is the way in
 * for a Home run without an account service. The quiet hosted line appears only when the service's
 * deployment is also a Home. Each control opens the panel on its own path.
 */
export const AlreadyUseHappierTile = React.memo(function AlreadyUseHappierTile(props: Readonly<{
    service: JourneyAccountService;
    onOpenPath: (path: AlreadyUsePath) => void;
    onUseServiceAsHome: () => void;
    /** Present when the host lets the person put this step away (Get set up's ✕). */
    onDismiss?: () => void;
}>) {
    const { theme } = useUnistyles();
    const testID = 'already-use-happier';
    const { service, onOpenPath } = props;
    return (
        <SetupBlockPaper
            testID={testID}
            layout="card"
            accessibilityLabel={t('homesJourneys.alreadyUseTitle')}
            dismiss={props.onDismiss ? {
                label: t('homeSetup.dismiss', { title: t('homesJourneys.alreadyUseTitle') }),
                tooltip: t('homeSetup.dismissTooltip'),
                onPress: props.onDismiss,
            } : undefined}
        >
            <View style={styles.glyph}><HeaderLogo size={20} /></View>
            <View style={styles.copy}>
                <Text style={styles.title}>{t('homesJourneys.alreadyUseTitle')}</Text>
                <Text style={styles.description}>{t('homesJourneys.alreadyUseDescription')}</Text>
            </View>
            <View style={styles.actions}>
                <RoundButton
                    testID={`${testID}.sign-in`}
                    size="small"
                    display="secondary"
                    title={t('homesJourneys.signIn')}
                    accessibilityLabel={t('homesJourneys.pathServiceTitle', { service: service.name })}
                    onPress={() => onOpenPath('service')}
                />
                <HappierPressable
                    testID={`${testID}.change-service`}
                    accessibilityRole="button"
                    accessibilityLabel={t('homesJourneys.changeServiceLabel', { service: service.name })}
                    onPress={() => onOpenPath('other_service')}
                    style={styles.serviceSelector}
                >
                    <PaneServiceLabel service={service.name} style={styles.serviceSelectorText} numberOfLines={1} />
                    <Icon name="caret-down" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
                </HappierPressable>
                <View style={styles.spacer} />
                <HappierPressable
                    testID={`${testID}.connect`}
                    accessibilityRole="link"
                    accessibilityLabel={t('homesJourneys.connectToHome')}
                    style={styles.connect}
                    onPress={() => onOpenPath('direct')}
                >
                    <Text style={styles.connectText}>{t('homesJourneys.connectToHome')}</Text>
                </HappierPressable>
            </View>
            {service.hostsHome ? (
                <View style={styles.hosted}>
                    <Text style={styles.hostedText}>{t('homesJourneys.hostedPrompt')}</Text>
                    <PaneLink
                        testID={`${testID}.use-service-as-home`}
                        label={t('homesJourneys.useServiceAsAHome', { service: service.name })}
                        onPress={props.onUseServiceAsHome}
                    />
                </View>
            ) : null}
        </SetupBlockPaper>
    );
});

const styles = StyleSheet.create((theme) => ({
    glyph: {
        height: 22,
        flexDirection: 'row',
        alignItems: 'center',
    },
    copy: {
        // The title clears the ✕ in the corner.
        paddingRight: 22,
    },
    title: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowTitle'),
        letterSpacing: 0,
        color: theme.colors.text.primary,
    },
    description: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        marginTop: 2,
        color: theme.colors.text.secondary,
    },
    actions: {
        marginTop: 'auto',
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 6,
    },
    serviceSelector: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        minHeight: 28,
        paddingHorizontal: 8,
        borderRadius: 8,
        flexShrink: 1,
    },
    serviceSelectorText: {
        ...Typography.default(),
        fontSize: 12.5,
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    spacer: {
        flexGrow: 1,
    },
    connect: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 4 },
    connectText: { ...Typography.default(), fontSize: 12.5, color: theme.colors.text.secondary },
    hosted: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 4,
    },
    hostedText: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
}));
