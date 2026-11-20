import * as React from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { usePressFeedback } from '@/components/ui/interactions/usePressFeedback';
import { useOpenExternalUrl } from '@/hooks/ui/useOpenExternalUrl';


const DOCS_URL = 'https://docs.happier.dev';
const GITHUB_URL = 'https://github.com/happier-dev/happier';
const DISCORD_URL = 'https://discord.gg/W6Pb8KuHfg';
/** The corner wells, their glyph at the ways row's glyph-to-well ratio (20 in 44). */
const FOOTER_WELL_PX = 32;
const FOOTER_GLYPH_PX = ICON_SIZE.xs;
/** The links sit about 10 px apart; each hit area reaches half of it sideways. */
const LINK_HIT_REACH = { left: 5, right: 5 } as const;

export type WelcomeFooterLinksProps = Readonly<{
    variant: 'desktop' | 'mobile';
    /** The pane's footer accessory (signed-out Updates): the help row's trailing control. */
    trailing?: React.ReactNode;
}>;

type FooterLink = Readonly<{ key: string; label: string; accessibilityLabel: string; icon: IconName; open: () => void }>;

/**
 * Welcome-step-only footer (direction A, lab `final/shots/open-*-welcome-*`): on a computer the links' marks as small
 * round wells in the bottom-left corner, each named by its tooltip (owner 2026-11-20: no captions above them); on a
 * phone one centred row of words under the column. Help and community only, so a focused Home never appears to select
 * the sign-in destination.
 */
export const WelcomeFooterLinks = React.memo(function WelcomeFooterLinks(props: WelcomeFooterLinksProps) {
    const styles = stylesheet;
    const [, openDocs] = useOpenExternalUrl(DOCS_URL);
    const [, openGithub] = useOpenExternalUrl(GITHUB_URL);
    const [, openDiscord] = useOpenExternalUrl(DISCORD_URL);
    const isMobile = props.variant === 'mobile';
    const links: readonly FooterLink[] = [
        { key: 'docs', label: t('welcome.welcomeFooterDocsAction'), accessibilityLabel: t('welcome.welcomeFooterDocsAction'), icon: 'book-open', open: openDocs },
        { key: 'github', label: t('welcome.welcomeFooterGithub'), accessibilityLabel: t('welcome.welcomeFooterGithubLabel'), icon: 'github-logo', open: openGithub },
        { key: 'discord', label: t('welcome.welcomeFooterDiscord'), accessibilityLabel: t('welcome.welcomeFooterDiscordLabel'), icon: 'discord-logo', open: openDiscord },
    ];
    const line = (
        <View style={styles.lineMobile} testID="welcome-footer-docs">
            {links.map((link) => <FooterTextLink key={link.key} link={link} />)}
            {props.trailing}
        </View>
    );
    return (
        <View style={isMobile ? styles.containerMobile : styles.containerDesktop} testID="welcome-footer-links">
            {isMobile ? line : (
                <View style={styles.rowDesktop}>
                    <View style={styles.groupDesktop}>
                        <View style={styles.wells} testID="welcome-footer-docs">
                            {links.map((link) => (
                                <IconButton key={link.key} testID={`welcome-footer-${link.key}-action`}
                                    accessibilityRole="link" accessibilityLabel={link.accessibilityLabel}
                                    tooltip={link.accessibilityLabel} iconName={link.icon} size={FOOTER_WELL_PX}
                                    iconSize={FOOTER_GLYPH_PX} variant="outlined"
                                    onPress={link.open} />
                            ))}
                        </View>
                    </View>
                    {props.trailing ? <View testID="welcome-footer-trailing" style={styles.trailingDesktop}>{props.trailing}</View> : null}
                </View>
            )}
        </View>
    );
});

function FooterTextLink({ link }: Readonly<{ link: FooterLink }>) {
    const { theme } = useUnistyles();
    const feedback = usePressFeedback({ glyph: true });
    return (
        <HappierPressable
            onPress={link.open}
            accessibilityRole="link"
            accessibilityLabel={link.accessibilityLabel}
            testID={`welcome-footer-${link.key}-link`}
            onPressIn={feedback.onPressIn}
            onPressOut={feedback.onPressOut}
            hitReach={LINK_HIT_REACH}
            style={stylesheet.textButton}
        >
            <Animated.View style={feedback.animatedStyle}>
                <Text style={[stylesheet.action, { color: theme.colors.text.primary }]}>{link.label}</Text>
            </Animated.View>
        </HappierPressable>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    containerDesktop: {
        width: '100%',
        paddingTop: theme.space.s20,
        paddingBottom: theme.space.s24,
    },
    containerMobile: {
        width: '100%',
        alignItems: 'center',
        paddingTop: theme.space.s24,
    },
    rowDesktop: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
    },
    groupDesktop: {
        alignItems: 'flex-start',
        gap: theme.space.s8,
    },
    lineMobile: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space.s16,
    },
    wells: {
        flexDirection: 'row',
        gap: theme.space.s8,
    },
    trailingDesktop: {
        alignSelf: 'flex-end',
    },
    action: {
        ...Typography.variant('body'),
    },
    textButton: {
        paddingVertical: theme.space.s4,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
