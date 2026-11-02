import { withShortcut } from '@/keyboard/withShortcut';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import type { BrowserToolbarModel } from '@/sync/domains/browser/shell';
import { t } from '@/text';

import type { BrowserKeyboardShortcutLabels } from './useBrowserKeyboardShortcuts';

const stylesheet = StyleSheet.create(() => ({
    root: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    // The phone's bottom bar: every control is one evenly spaced thumb target across the bar.
    spread: {
        flex: 1,
        justifyContent: 'space-between',
    },
}));

export function BrowserToolbar(props: Readonly<{
    model: BrowserToolbarModel;
    shortcutLabels?: BrowserKeyboardShortcutLabels;
    onBack: () => void;
    onForward: () => void;
    onReload: () => void;
    onStop: () => void;
    /** Visible control size and glyph (`resolveBrowserChromeControlMetrics`); the dense row by default. */
    controlSize?: number;
    iconSize?: number;
    /** The press target the controls grow to; none under a precise pointer. */
    touchTargetFloorPx?: number | null;
    /** Spread the controls (and `children`, the bar's other controls) evenly across the row. */
    spread?: boolean;
    children?: React.ReactNode;
    testID?: string;
}>): React.ReactElement {
    const controlSize = props.controlSize ?? 34;
    const iconSize = props.iconSize ?? ICON_SIZE.sm;
    const touchTargetFloorPx = props.touchTargetFloorPx === undefined
        ? resolveMinimumInteractiveTargetSize(Platform.OS)
        : props.touchTargetFloorPx ?? undefined;
    const shortcutLabels = props.shortcutLabels;
    const loading = props.model.isLoading;
    const testIDPrefix = props.testID ?? 'browser-toolbar';
    // AMD-8: a page that keeps its history to itself shows these controls unavailable, with the reason
    // on hover, focus and press (IconButton's disabled reason), rather than hiding them.
    const historyReason = props.model.historyUnavailableReason === 'page_history_uncontrollable'
        ? t('browserShell.toolbar.historyUncontrollable')
        : undefined;
    const stopReason = props.model.historyUnavailableReason === 'page_history_uncontrollable'
        ? t('browserShell.toolbar.stopUncontrollable')
        : undefined;
    // A control the active engine can NEVER fulfil is hidden, not shipped permanently disabled:
    // the capability layer (`selectBrowserToolbarModel`) owns that per-engine decision. `disabled`
    // still expresses the transient case — history exists but there is nowhere to go back to yet.
    return (
        <View testID={`${testIDPrefix}-toolbar`} style={[stylesheet.root, props.spread ? stylesheet.spread : null]}>
            {props.model.showBackForward ? (
                <>
                    <IconButton
                        testID={`${testIDPrefix}-back`}
                        iconName="caret-left"
                        accessibilityLabel={t('browserShell.toolbar.back')}
                        tooltip={withShortcut(t('browserShell.toolbar.back'), shortcutLabels?.['browser.back'])}
                        variant="plain"
                        iconSize={iconSize}
                        size={controlSize}
                        minimumInteractiveTargetSize={touchTargetFloorPx}
                        interactiveTargetGapPx={2}
                        disabled={!props.model.canGoBack}
                        disabledReason={historyReason}
                        onPress={props.onBack}
                    />
                    <IconButton
                        testID={`${testIDPrefix}-forward`}
                        iconName="caret-right"
                        accessibilityLabel={t('browserShell.toolbar.forward')}
                        tooltip={withShortcut(t('browserShell.toolbar.forward'), shortcutLabels?.['browser.forward'])}
                        variant="plain"
                        iconSize={iconSize}
                        size={controlSize}
                        minimumInteractiveTargetSize={touchTargetFloorPx}
                        interactiveTargetGapPx={2}
                        disabled={!props.model.canGoForward}
                        disabledReason={historyReason}
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
                    variant="plain"
                    iconSize={iconSize}
                    size={controlSize}
                    minimumInteractiveTargetSize={touchTargetFloorPx}
                    interactiveTargetGapPx={2}
                    disabled={loading ? !props.model.canStop : !props.model.canReload}
                    disabledReason={loading ? stopReason : undefined}
                    onPress={loading ? props.onStop : props.onReload}
                />
            ) : null}
            {props.children}
        </View>
    );
}
