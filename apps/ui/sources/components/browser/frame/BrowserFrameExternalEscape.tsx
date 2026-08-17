import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create((theme) => ({
    escape: {
        position: 'absolute',
        top: 12,
        right: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    label: {
        color: theme.colors.text.secondary,
        fontWeight: '600',
    },
}));

/**
 * The always-present "open in your browser" escape rendered OVER the web iframe surface.
 *
 * Cross-origin framability is not reliably detectable from the parent document: a site that
 * refuses embedding via `X-Frame-Options`/CSP `frame-ancestors` can still fire the iframe's
 * `onLoad` against a blank document, so the load-vs-timeout heuristic
 * ({@link useWebIframeFramability}) can land on a false `framable` verdict and show a blank frame.
 * This escape is therefore ALWAYS present — never gated on the verdict — so the user can ALWAYS
 * open the page in their system browser. The full {@link BrowserFrameNonFramable} fallback still
 * owns the definitively-detected `onError`/timeout case. Native and desktop-Wry surfaces do not
 * embed via an iframe (no `X-Frame-Options` restriction) and never render this escape.
 */
export function BrowserFrameExternalEscape(props: Readonly<{
    testID: string;
    onOpenInSystemBrowser: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <Pressable
            testID={`${props.testID}-external-escape`}
            accessibilityRole="button"
            accessibilityLabel={t('browserShell.nonFramable.openInSystemBrowser')}
            onPress={props.onOpenInSystemBrowser}
            style={stylesheet.escape}
        >
            <Icon name="arrow-square-out" size={14} color={theme.colors.text.secondary} />
            <Text style={stylesheet.label}>{t('browserShell.nonFramable.openInSystemBrowser')}</Text>
        </Pressable>
    );
}
