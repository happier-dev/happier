import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { BrowserDiagnosticFidelityV1 } from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    badge: {
        alignSelf: 'flex-start',
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 8,
        paddingVertical: 3,
    },
    text: {
        ...Typography.rowMeta(),
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
    },
}));

function fidelityLabel(fidelity: BrowserDiagnosticFidelityV1): string {
    switch (fidelity) {
        case 'previewProxy':
            return t('browserDiagnostics.previewProxy.fidelity.previewProxy');
        case 'unavailable':
            return t('browserDiagnostics.previewProxy.fidelity.unavailable');
        case 'cdp':
            return t('browserDiagnostics.previewProxy.fidelity.cdp');
        case 'injectedPage':
            return t('browserDiagnostics.previewProxy.fidelity.injectedPage');
        case 'nativeCallback':
            return t('browserDiagnostics.previewProxy.fidelity.nativeCallback');
        case 'streamFrame':
            return t('browserDiagnostics.previewProxy.fidelity.streamFrame');
    }
}

export function BrowserDiagnosticsFidelityBadge(props: Readonly<{
    fidelity: BrowserDiagnosticFidelityV1;
    testID?: string;
}>): React.ReactElement {
    return (
        <View testID={props.testID} style={stylesheet.badge}>
            <Text style={stylesheet.text}>{fidelityLabel(props.fidelity)}</Text>
        </View>
    );
}
