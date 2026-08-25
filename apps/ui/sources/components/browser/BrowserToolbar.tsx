import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import type { BrowserToolbarModel } from '@/sync/domains/browser/shell';
import { t } from '@/text';

import type { BrowserKeyboardShortcutLabels } from './useBrowserKeyboardShortcuts';

/**
 * UB-6: a control that has a keyboard shortcut says so on its tooltip. The label comes from the
 * keyboard-command registry, so a rebound shortcut is never advertised with its stale default and
 * a platform without a binding simply shows the plain tooltip.
 */
function withShortcut(label: string, shortcut: string | undefined): string {
    return shortcut ? `${label} (${shortcut})` : label;
}

const stylesheet = StyleSheet.create(() => ({
    root: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
}));

export function BrowserToolbar(props: Readonly<{
    model: BrowserToolbarModel;
    shortcutLabels?: BrowserKeyboardShortcutLabels;
    onBack: () => void;
    onForward: () => void;
    onReload: () => void;
    onStop: () => void;
    testID?: string;
}>): React.ReactElement {
    const shortcutLabels = props.shortcutLabels;
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
                        tooltip={withShortcut(t('browserShell.toolbar.back'), shortcutLabels?.['browser.back'])}
                        size={34}
                        minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                        interactiveTargetGapPx={6}
                        disabled={!props.model.canGoBack}
                        onPress={props.onBack}
                    />
                    <IconButton
                        testID={`${testIDPrefix}-forward`}
                        iconName="caret-right"
                        accessibilityLabel={t('browserShell.toolbar.forward')}
                        tooltip={withShortcut(t('browserShell.toolbar.forward'), shortcutLabels?.['browser.forward'])}
                        size={34}
                        minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                        interactiveTargetGapPx={6}
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
                    tooltip={loading
                        ? t('browserShell.toolbar.stop')
                        : withShortcut(t('browserShell.toolbar.reload'), shortcutLabels?.['browser.reload'])}
                    size={34}
                    minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                    interactiveTargetGapPx={6}
                    disabled={loading ? !props.model.canStop : !props.model.canReload}
                    onPress={loading ? props.onStop : props.onReload}
                />
            ) : null}
        </View>
    );
}
