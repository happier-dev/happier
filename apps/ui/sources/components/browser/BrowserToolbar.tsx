import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import type { BrowserToolbarModel } from '@/sync/domains/browser/shell';
import { t } from '@/text';

const stylesheet = StyleSheet.create(() => ({
    root: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
}));

export function BrowserToolbar(props: Readonly<{
    model: BrowserToolbarModel;
    onBack: () => void;
    onForward: () => void;
    onReload: () => void;
    onStop: () => void;
    testID?: string;
}>): React.ReactElement {
    const loading = props.model.isLoading;
    const testIDPrefix = props.testID ?? 'browser-toolbar';
    // A control the active engine can NEVER fulfil is hidden, not shipped permanently disabled:
    // the capability layer (`selectBrowserToolbarModel`) owns that per-engine decision. `disabled`
    // still expresses the transient case — history exists but there is nowhere to go back to yet.
    return (
        <View testID={`${testIDPrefix}-toolbar`} style={stylesheet.root}>
            {props.model.showBackForward ? (
                <>
                    <IconButton
                        testID={`${testIDPrefix}-back`}
                        iconName="caret-left"
                        accessibilityLabel={t('browserShell.toolbar.back')}
                        tooltip={t('browserShell.toolbar.back')}
                        size={34}
                        disabled={!props.model.canGoBack}
                        onPress={props.onBack}
                    />
                    <IconButton
                        testID={`${testIDPrefix}-forward`}
                        iconName="caret-right"
                        accessibilityLabel={t('browserShell.toolbar.forward')}
                        tooltip={t('browserShell.toolbar.forward')}
                        size={34}
                        disabled={!props.model.canGoForward}
                        onPress={props.onForward}
                    />
                </>
            ) : null}
            {props.model.showReloadStop ? (
                <IconButton
                    testID={`${testIDPrefix}-${loading ? 'stop' : 'reload'}`}
                    iconName={loading ? 'stop' : 'arrow-clockwise'}
                    accessibilityLabel={loading ? t('browserShell.toolbar.stop') : t('browserShell.toolbar.reload')}
                    tooltip={loading ? t('browserShell.toolbar.stop') : t('browserShell.toolbar.reload')}
                    size={34}
                    disabled={loading ? !props.model.canStop : !props.model.canReload}
                    onPress={loading ? props.onStop : props.onReload}
                />
            ) : null}
        </View>
    );
}
