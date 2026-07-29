import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    chip: {
        minHeight: 34,
        maxWidth: 180,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 10,
        justifyContent: 'center',
    },
    text: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
}));

function labelForView(view: BrowserControlViewState | null): string {
    if (!view) return t('browserShell.origin.newTab');
    if (view.target.kind === 'localServicePreview') return t('browserShell.origin.localPreview');
    if (view.target.kind === 'hostedPluginWeb') return t('browserShell.origin.hostedPlugin');
    if (view.target.kind === 'externalUrl') return t('browserShell.origin.external');
    if (view.target.kind === 'streamedBrowser') return t('browserShell.origin.streamed');
    return t('browserShell.origin.simulator');
}

export function BrowserOriginChip(props: Readonly<{
    view: BrowserControlViewState | null;
    testID?: string;
}>): React.ReactElement {
    return (
        <View testID={props.testID} style={stylesheet.chip}>
            <Text numberOfLines={1} style={stylesheet.text}>{labelForView(props.view)}</Text>
        </View>
    );
}
