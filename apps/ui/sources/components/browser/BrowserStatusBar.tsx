import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        minHeight: 26,
        justifyContent: 'center',
        paddingHorizontal: 12,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    text: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
}));

function statusText(view: BrowserControlViewState | null): string {
    if (!view) return t('browserShell.status.empty');
    if (view.lastError) return resolveReasonCopy({ reasonCode: view.lastError, kind: 'browserStatus' }).message;
    if (view.loadingState === 'loading') return t('browserShell.status.loading');
    if (!view.currentUrl) return t('browserShell.status.noUrl');
    return view.currentUrl;
}

export function BrowserStatusBar(props: Readonly<{
    view: BrowserControlViewState | null;
    testID?: string;
}>): React.ReactElement {
    return (
        <View testID={props.testID} style={stylesheet.root}>
            <Text numberOfLines={1} style={stylesheet.text}>{statusText(props.view)}</Text>
        </View>
    );
}
