import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        minHeight: 34,
        maxWidth: 240,
        justifyContent: 'center',
        paddingHorizontal: 4,
    },
    text: {
        color: theme.colors.text.primary,
        fontSize: 13,
        fontWeight: '500',
    },
}));

/**
 * In-toolbar page title (Lunel-parity gap #52). The view already TRACKS `title`; this surfaces it
 * as a compact, single-line label beside the address field. Renders nothing when no title and no
 * navigated URL exist (a blank new tab), so the toolbar stays clean.
 */
export function BrowserToolbarTitle(props: Readonly<{
    view: BrowserControlViewState | null;
    testID?: string;
}>): React.ReactElement | null {
    const view = props.view;
    if (!view) {
        return null;
    }
    const title = view.title?.trim();
    if (!title && !view.currentUrl) {
        return null;
    }

    return (
        <View testID={props.testID} style={stylesheet.container}>
            <Text numberOfLines={1} style={stylesheet.text}>
                {title && title.length > 0 ? title : t('browserShell.title.untitled')}
            </Text>
        </View>
    );
}
