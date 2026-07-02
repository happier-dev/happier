import * as React from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { HAPPIER_CLOUD_SERVER_URL } from '@/sync/domains/server/serverProfiles';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { t } from '@/text';

const DOCS_URL = 'https://docs.happier.dev';
const GITHUB_URL = 'https://github.com/happier-dev/happier';
const DISCORD_URL = 'https://discord.gg/W6Pb8KuHfg';

const HAPPIER_CLOUD_COMPARABLE_KEY = createServerUrlComparableKey(HAPPIER_CLOUD_SERVER_URL);

/**
 * Builds the host[:port] string we show in the footer when the user has
 * selected a custom relay. We hide the default scheme ports (443 for https,
 * 80 for http) because they're implied and only clutter the chip.
 * Returns null if the URL is unparseable — caller falls back to the raw URL.
 */
function derivePresentableRelayHost(serverUrl: string): string | null {
    try {
        const parsed = new URL(serverUrl);
        const host = parsed.hostname;
        const port = parsed.port;
        const isDefaultPort = !port
            || (parsed.protocol === 'https:' && port === '443')
            || (parsed.protocol === 'http:' && port === '80');
        return isDefaultPort ? host : `${host}:${port}`;
    } catch {
        return null;
    }
}

export type WelcomeFooterLinksProps = Readonly<{
    variant: 'desktop' | 'mobile';
    onOpenRelayCustomFlow: () => void;
}>;

/**
 * Welcome-step-only footer rendered at the bottom of the workflow pane.
 * Two stacked groups (each: label on one line, action on the next line):
 *
 *   Self-hosting?               Need help?
 *   Use your own Relay          Docs · GH · Discord
 *
 * Desktop arranges the two groups side-by-side with space-between. Mobile
 * stacks them centred. The `Docs` action is followed by GitHub and Discord
 * brand icons that link to the public repo and the community Discord.
 */
export const WelcomeFooterLinks = React.memo(function WelcomeFooterLinks(props: WelcomeFooterLinksProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const openDocs = React.useCallback(() => { void Linking.openURL(DOCS_URL); }, []);
    const openGithub = React.useCallback(() => { void Linking.openURL(GITHUB_URL); }, []);
    const openDiscord = React.useCallback(() => { void Linking.openURL(DISCORD_URL); }, []);

    const labelColor = { color: theme.colors.text.secondary };
    const actionColor = { color: theme.colors.text.primary };
    const actionPressedStyle = { opacity: 0.7 };
    const iconColor = theme.colors.text.primary;
    const isMobile = props.variant === 'mobile';
    const relayGroupStyle = isMobile ? styles.groupMobile : styles.groupDesktop;

    // The user has actively chosen a non-cloud relay when the active server's
    // canonicalised URL doesn't match the Happier Cloud key. While we have no
    // server URL yet (cold start), default to the cloud framing so the footer
    // doesn't flicker into the custom layout for a single render.
    const activeServer = useActiveServerSnapshot();
    const isCustomRelay = activeServer.serverUrl.length > 0
        && createServerUrlComparableKey(activeServer.serverUrl) !== HAPPIER_CLOUD_COMPARABLE_KEY;
    const customRelayHost = isCustomRelay
        ? (derivePresentableRelayHost(activeServer.serverUrl) ?? activeServer.serverUrl)
        : null;

    return (
        <View
            style={isMobile ? styles.containerMobile : styles.containerDesktop}
            testID="welcome-footer-links"
        >
            <View style={relayGroupStyle} testID="welcome-footer-relay">
                <Text style={[styles.label, labelColor]}>
                    {isCustomRelay ? t('welcome.welcomeFooterRelayActiveLabel') : t('welcome.welcomeFooterRelay')}
                </Text>
                <Pressable
                    onPress={props.onOpenRelayCustomFlow}
                    accessibilityRole="link"
                    accessibilityLabel={isCustomRelay ? t('welcome.welcomeFooterRelayEditAccessibility') : undefined}
                    testID="welcome-footer-relay-action"
                >
                    {({ pressed }) => (
                        isCustomRelay && customRelayHost ? (
                            <View style={isMobile ? styles.relayHostRowMobile : styles.relayHostRowDesktop}>
                                <Text
                                    style={[styles.actionBold, actionColor, styles.relayHostText, pressed ? actionPressedStyle : null]}
                                    numberOfLines={1}
                                    ellipsizeMode="tail"
                                    testID="welcome-footer-relay-host"
                                >
                                    {customRelayHost}
                                </Text>
                                <Ionicons
                                    name="pencil-outline"
                                    size={13}
                                    color={iconColor}
                                    style={pressed ? actionPressedStyle : undefined}
                                />
                            </View>
                        ) : (
                            <Text style={[styles.actionBold, actionColor, pressed ? actionPressedStyle : null]}>
                                {t('welcome.welcomeFooterRelayAction')}
                            </Text>
                        )
                    )}
                </Pressable>
            </View>

            <View style={relayGroupStyle} testID="welcome-footer-docs">
                <Text style={[styles.label, labelColor]}>
                    {t('welcome.welcomeFooterDocs')}
                </Text>
                <View style={isMobile ? styles.actionsRowCenter : styles.actionsRowStart}>
                    <Pressable
                        onPress={openGithub}
                        accessibilityRole="link"
                        accessibilityLabel={t('welcome.welcomeFooterGithubLabel')}
                        testID="welcome-footer-github-action"
                        hitSlop={6}
                        style={({ pressed }) => [styles.iconButton, pressed ? actionPressedStyle : null]}
                    >
                        <Ionicons name="logo-github" size={18} color={iconColor} />
                    </Pressable>
                    <Pressable
                        onPress={openDiscord}
                        accessibilityRole="link"
                        accessibilityLabel={t('welcome.welcomeFooterDiscordLabel')}
                        testID="welcome-footer-discord-action"
                        hitSlop={6}
                        style={({ pressed }) => [styles.iconButton, pressed ? actionPressedStyle : null]}
                    >
                        <Ionicons name="logo-discord" size={18} color={iconColor} />
                    </Pressable>
                    <Pressable
                        onPress={openDocs}
                        accessibilityRole="link"
                        testID="welcome-footer-docs-action"
                    >
                        {({ pressed }) => (
                            <Text style={[styles.action, actionColor, pressed ? actionPressedStyle : null]}>
                                {t('welcome.welcomeFooterDocsAction')}
                            </Text>
                        )}
                    </Pressable>
                </View>
            </View>
        </View>
    );
});

const stylesheet = StyleSheet.create(() => ({
    containerDesktop: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        paddingTop: 20,
        paddingBottom: 28,
        gap: 24,
    },
    containerMobile: {
        flexDirection: 'column',
        alignItems: 'center',
        gap: 18,
        paddingTop: 18,
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
    label: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
    },
    action: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        textDecorationLine: 'underline',
    },
    actionBold: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 18,
        textDecorationLine: 'underline',
    },
    relayHostRowDesktop: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        // Cap the host chip so a long hostname can't push the pencil icon
        // off the right edge or collide with the right-side Docs group.
        // Ellipsis truncation handles anything past this width.
        maxWidth: 260,
    },
    relayHostRowMobile: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        maxWidth: 280,
    },
    relayHostText: {
        // Let the Text shrink/ellipsize within the row instead of pushing the
        // pencil icon out. flexShrink:1 + minWidth:0 is the canonical recipe
        // for tail-ellipsis-inside-a-row on RN web.
        flexShrink: 1,
        minWidth: 0,
    },
    iconButton: {
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
