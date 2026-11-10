import * as React from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { usePressFeedback } from '@/components/ui/interactions/usePressFeedback';
import { useOpenExternalUrl } from '@/hooks/ui/useOpenExternalUrl';

import { RelayRetentionDisclosure, type RelayRetentionDisclosureState } from './RelayRetentionDisclosure';

const DOCS_URL = 'https://docs.happier.dev';
const GITHUB_URL = 'https://github.com/happier-dev/happier';
const DISCORD_URL = 'https://discord.gg/W6Pb8KuHfg';
/** The links sit 10px apart (`actionsRow*` gap); each hit area reaches half of it sideways. */
const LINK_HIT_REACH = { left: 5, right: 5 } as const;

export type WelcomeFooterLinksProps = Readonly<{
    variant: 'desktop' | 'mobile';
    retentionDisclosure?: RelayRetentionDisclosureState | null;
    /** The pane's footer accessory (signed-out Updates): the help row's trailing control. */
    trailing?: React.ReactNode;
}>;

/**
 * Welcome-step-only footer rendered at the bottom of the workflow pane.
 * The sign-in/Home authority controls live in the Welcome decision panel. This footer is limited
 * to help/community links so a focused Home cannot appear to select the sign-in destination.
 */
export const WelcomeFooterLinks = React.memo(function WelcomeFooterLinks(props: WelcomeFooterLinksProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const [, openDocs] = useOpenExternalUrl(DOCS_URL);
    const [, openGithub] = useOpenExternalUrl(GITHUB_URL);
    const [, openDiscord] = useOpenExternalUrl(DISCORD_URL);

    const labelColor = { color: theme.colors.text.secondary };
    const actionColor = { color: theme.colors.text.primary };
    const githubFeedback = usePressFeedback({ glyph: true });
    const discordFeedback = usePressFeedback({ glyph: true });
    const docsFeedback = usePressFeedback({ glyph: true });
    const iconColor = theme.colors.text.primary;
    const isMobile = props.variant === 'mobile';
    const footerGroupStyle = isMobile ? styles.groupMobile : styles.groupDesktop;

    return (
        <View
            style={isMobile ? styles.containerMobile : styles.containerDesktop}
            testID="welcome-footer-links"
        >
            {props.retentionDisclosure ? (
                <RelayRetentionDisclosure
                    testID="welcome-footer-retention"
                    disclosure={props.retentionDisclosure}
                />
            ) : null}
            <View style={isMobile ? styles.linksMobile : styles.linksDesktop}>
                <View style={footerGroupStyle} testID="welcome-footer-docs">
                    <Text style={[styles.label, labelColor]}>
                        {t('welcome.welcomeFooterDocs')}
                    </Text>
                    <View style={isMobile ? styles.actionsRowCenter : styles.actionsRowStart}>
                        <HappierPressable
                            onPress={openGithub}
                            accessibilityRole="link"
                            accessibilityLabel={t('welcome.welcomeFooterGithubLabel')}
                            testID="welcome-footer-github-action"
                            onPressIn={githubFeedback.onPressIn}
                            onPressOut={githubFeedback.onPressOut}
                            hitReach={LINK_HIT_REACH}
                            style={styles.iconButton}
                        >
                            <Animated.View style={githubFeedback.animatedStyle}>
                                <Icon name="github-logo" size={16} color={iconColor} />
                            </Animated.View>
                        </HappierPressable>
                        <HappierPressable
                            onPress={openDiscord}
                            accessibilityRole="link"
                            accessibilityLabel={t('welcome.welcomeFooterDiscordLabel')}
                            testID="welcome-footer-discord-action"
                            onPressIn={discordFeedback.onPressIn}
                            onPressOut={discordFeedback.onPressOut}
                            hitReach={LINK_HIT_REACH}
                            style={styles.iconButton}
                        >
                            <Animated.View style={discordFeedback.animatedStyle}>
                                <Icon name="discord-logo" size={16} color={iconColor} />
                            </Animated.View>
                        </HappierPressable>
                        <HappierPressable
                            onPress={openDocs}
                            accessibilityRole="link"
                            accessibilityLabel={t('welcome.welcomeFooterDocsAction')}
                            testID="welcome-footer-docs-action"
                            onPressIn={docsFeedback.onPressIn}
                            onPressOut={docsFeedback.onPressOut}
                            hitReach={LINK_HIT_REACH}
                            style={styles.textButton}
                        >
                            <Animated.View style={docsFeedback.animatedStyle}>
                                <Text style={[styles.action, actionColor]}>{t('welcome.welcomeFooterDocsAction')}</Text>
                            </Animated.View>
                        </HappierPressable>
                        {isMobile ? props.trailing : null}
                    </View>
                </View>
                {/* Desktop: the far end of the row, level with the icons rather than the label above them. */}
                {!isMobile && props.trailing ? <View testID="welcome-footer-trailing" style={styles.trailingDesktop}>{props.trailing}</View> : null}
            </View>
        </View>
    );
});

const stylesheet = StyleSheet.create(() => ({
    containerDesktop: {
        width: '100%',
        flexDirection: 'column',
        alignItems: 'stretch',
        paddingTop: 20,
        paddingBottom: 28,
        gap: 14,
    },
    containerMobile: {
        width: '100%',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 14,
        paddingTop: 18,
    },
    linksDesktop: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 24,
    },
    linksMobile: {
        width: '100%',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 18,
    },
    groupDesktop: {
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 4,
    },
    groupMobile: {
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
    },
    actionsRowStart: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    actionsRowCenter: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
    },
    trailingDesktop: {
        alignSelf: 'flex-end',
    },
    label: {
        ...Typography.variant('body'),
    },
    action: {
        ...Typography.variant('body'),
        textDecorationLine: 'underline',
    },
    iconButton: {
        width: 28,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    textButton: {
        paddingVertical: 4,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
