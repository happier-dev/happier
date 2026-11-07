import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { HEADER_ACTIONS_GAP_PX } from '@/components/ui/layout/PageHeaderEntityParts';
import { RowStatusLine } from '@/components/ui/status/RowStatusLine';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * A provider API key is never shown: its selected Saved Secret name (or "Saved") and Replace, or Add when none is chosen. Either
 * opens the Saved Secret picker; the key itself stays in Saved Secrets.
 */
export function ProviderSavedSecretControl(props: Readonly<{
    testID: string;
    saved: boolean;
    selectedName?: string | null;
    disabled: boolean;
    onChoose: (event?: unknown) => void;
}>) {
    return (
        <View style={stylesheet.secretControl}>
            {props.saved ? (
                // Healthy is quiet: plain secondary meta beside Replace, never a coloured pill.
                <Text testID={`${props.testID}.saved`} numberOfLines={1} style={stylesheet.savedMeta}>
                    {props.selectedName ?? t('settingsProvidersCollection.saved')}
                </Text>
            ) : null}
            <RoundButton
                testID={`${props.testID}.choose`}
                size="small"
                display="secondary"
                title={props.saved ? t('settingsProvidersCollection.replace') : t('settingsProvidersCollection.addKey')}
                disabled={props.disabled}
                onPress={props.onChoose}
            />
        </View>
    );
}

/** The outcome of Test as the row's one status line (`RowStatusLine`): quiet when it worked, a failure reads as one. */
export function ProviderProbeResult(props: Readonly<{ testID: string; text: string; failed: boolean }>) {
    return (
        <View accessibilityLiveRegion="polite">
            <RowStatusLine testID={props.testID} text={props.text} tone={props.failed ? 'bad' : 'quiet'} numberOfLines={2} />
        </View>
    );
}

/** The row of a provider page header's actions: Test, the state control or Save, then `⋯`. */
export function ProviderHeaderActions(props: Readonly<{ children: React.ReactNode }>) {
    return <View style={stylesheet.headerActions}>{props.children}</View>;
}

const stylesheet = StyleSheet.create((theme) => ({
    secretControl: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    savedMeta: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        flexShrink: 1,
        color: theme.colors.text.secondary,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: HEADER_ACTIONS_GAP_PX,
    },
}));
