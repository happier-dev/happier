import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { Icon } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 26,
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.state.danger.background,
    },
    text: {
        ...Typography.rowMeta(),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    icon: {
        color: theme.colors.text.primary,
    },
}));

/**
 * The transient status line under the frame.
 *
 * It used to be a PERMANENT strip that showed, in order of preference, the last error, "Loading…",
 * or the current URL. Two of those three were already owned elsewhere and better: the address field
 * above shows the URL (and shows it formatted), and {@link BrowserLoadProgressBar} shows loading as
 * motion rather than as the word. So the strip spent almost all of its life restating the address
 * bar in smaller grey text, and cost every surface 27pt of height to do it.
 *
 * What is left is the part nothing else owns: a failure that did NOT replace the page. A failed
 * sub-navigation leaves the previous document rendered, so {@link BrowserFrameError} never appears
 * and the only evidence would otherwise be that nothing happened. This renders for exactly that,
 * and returns `null` the rest of the time.
 */
export function BrowserStatusBar(props: Readonly<{
    view: BrowserControlViewState | null;
    testID?: string;
}>): React.ReactElement | null {
    const lastError = props.view?.lastError;
    if (!lastError) {
        return null;
    }
    const copy = resolveReasonCopy({ reasonCode: lastError, kind: 'browserStatus' });
    return (
        <View
            testID={props.testID}
            style={stylesheet.root}
            accessibilityLiveRegion="polite"
            role="status"
            aria-live="polite"
        >
            <Icon name="warning-circle" size={14} color={stylesheet.icon.color} />
            <Text numberOfLines={2} style={stylesheet.text}>{copy.message}</Text>
        </View>
    );
}
