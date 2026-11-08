import * as React from 'react';

import type { BrowserAnnotationController } from '@/components/browser/annotation/useBrowserAnnotationController';
import type { BrowserRecordingControl } from '@/components/browser/recording';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import type { BrowserOpenEngineOverride } from '@/sync/domains/browser/adapters/selection';
import { resolvePluginBrowserPolicyDecision } from '@/sync/domains/plugins/browser/policy';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import {
    resolvePluginLocalizedText,
    type PluginLocalizedTextResolver,
} from '@/sync/domains/plugins/ui/i18n';
import { t } from '@/text';

import type { BrowserPluginActions } from '../useBrowserPluginActions';
import type { BrowserToolbarOverflowItem } from './BrowserToolbarOverflowMenu';

/** An engine, capture source or output this page cannot record with: the item is not offered at all. */
function recordingImpossible(unavailable: BrowserRecordingControl['unavailable']): boolean {
    return unavailable?.policyState === 'captureUnavailable' || unavailable?.policyState === 'retentionLimited';
}

/** Recordable but blocked: why, in the person's words (the reason's message is mechanism text). */
function recordingBlockedReason(unavailable: BrowserRecordingControl['unavailable']): string | null {
    if (!unavailable) return null;
    return unavailable.reasonCode === 'browser_recording_disabled'
        ? t('browserRecording.status.turnedOff')
        : t('browserRecording.status.notAllowed');
}

/**
 * The chrome's `⋯`: the rare, one-shot tools.
 *
 * What is used on most pages lives in the row itself (back, forward, reload, the address, Mark up,
 * Attach page), and live state docks there only while it is live (a running recording). Everything
 * here is a single tap that does not need to stay on screen: start a recording (or discard the one
 * running), open the page in the user's own browser, devtools, and plugin actions.
 *
 * Every disabled entry carries a reason. An affordance that is greyed out with no explanation is
 * indistinguishable from a broken one; one this page can never fulfil is not offered.
 */
export function useBrowserToolbarOverflowItems(input: Readonly<{
    activeView: BrowserControlViewState | null;
    /** While the page is being marked up, the whole-page capture stays one tap away here. */
    annotation: BrowserAnnotationController | null;
    recording: BrowserRecordingControl | null;
    onStartRecording?: () => void;
    onDiscardRecording?: () => void;
    /** Present when the active page has an address the user's own browser can open. */
    onOpenInYourBrowser?: (() => void) | null;
    engineSwitch?: Readonly<{ destination: BrowserOpenEngineOverride; onPress: () => void }> | null;
    openInYourBrowserDisabledReason?: string | null;
    /** Idle Diagnostics live here rather than as a bar under the page (lab Q). */
    onOpenDiagnostics?: (() => void) | null;
    /** Only without a tab strip (a phone page, lab Qp): the strip's + and × move here, so × needs + to appear. */
    onOpenNewTab?: () => void;
    onCloseTab?: () => void;
    /** A Session viewer docked in this pane floats again (as the Computer pane's menu offers). */
    onFloatView?: () => void;
    /** Present for a managed profile on a Machine: bring cookies or passkeys into it. */
    onImportLogins?: (() => void) | null;
    desktopNativeDevtoolsAvailable: boolean;
    onOpenDesktopDevtools: () => void;
    plugins: BrowserPluginActions;
    pluginActionsEnabled: boolean;
    localizePluginText?: PluginLocalizedTextResolver;
}>): readonly BrowserToolbarOverflowItem[] {
    const {
        activeView,
        annotation,
        recording,
        onStartRecording,
        onDiscardRecording,
        onOpenInYourBrowser,
        engineSwitch,
        openInYourBrowserDisabledReason,
        onOpenDiagnostics,
        onOpenNewTab,
        onCloseTab,
        onFloatView,
        onImportLogins,
        desktopNativeDevtoolsAvailable,
        onOpenDesktopDevtools,
        pluginActionsEnabled,
        localizePluginText,
        plugins,
    } = input;

    return React.useMemo<readonly BrowserToolbarOverflowItem[]>(() => {
        const items: BrowserToolbarOverflowItem[] = [];
        if (onFloatView) {
            items.push({ id: 'float-view', iconName: 'stack', label: t('presentation.floatView'), onPress: onFloatView });
        }
        if (onOpenNewTab) {
            items.push({ id: 'new-tab', iconName: 'plus', label: t('browserShell.tabs.newTab'), onPress: onOpenNewTab });
        }
        if (annotation?.active) {
            items.push({
                id: 'capture-annotation',
                iconName: 'check',
                label: t('browserContext.composer.attachAnnotation'),
                onPress: () => { void annotation.attachDraft(); },
                disabled: annotation.contextButtonDisabled || !annotation.draftAvailable,
                disabledReason: annotation.contextButtonDisabled
                    ? annotation.contextDisabledReason
                    : !annotation.draftAvailable
                        ? annotation.captureDisabledReason
                        : null,
            });
        }
        if (recording && activeView) {
            if (recording.activeRecording) {
                items.push({
                    id: 'discard-recording',
                    iconName: 'trash',
                    label: t('browserPresence.recording.discard'),
                    onPress: () => onDiscardRecording?.(),
                    disabled: !onDiscardRecording,
                    destructive: true,
                });
            } else if (!recordingImpossible(recording.unavailable)) {
                items.push({
                    id: 'start-recording',
                    iconName: 'circle',
                    label: t('browserRecording.actions.start'),
                    onPress: () => onStartRecording?.(),
                    disabled: !recording.startRequest || !onStartRecording,
                    disabledReason: recordingBlockedReason(recording.unavailable),
                });
            }
        }
        if (onImportLogins) {
            items.push({ id: 'import-logins', iconName: 'sign-in', label: t('browserShell.loginImport.menu'), onPress: onImportLogins });
        }
        if (engineSwitch) {
            items.push({
                id: engineSwitch.destination === 'managed' ? 'open-in-managed-browser' : 'open-here',
                // The page stays in Happier, only its engine changes; `arrow-square-out` means leaving the app.
                iconName: 'arrows-left-right',
                label: engineSwitch.destination === 'managed'
                    ? t('browserShell.engineSwitch.managed') : t('browserShell.engineSwitch.embedded'),
                subtitle: t('browserShell.engineSwitch.signInAgain'),
                onPress: engineSwitch.onPress,
            });
        }
        if (onOpenInYourBrowser) {
            items.push({
                id: 'open-in-your-browser',
                iconName: 'arrow-square-out',
                label: t('browserPresence.openInYourBrowser'),
                onPress: onOpenInYourBrowser,
                disabled: Boolean(openInYourBrowserDisabledReason),
                disabledReason: openInYourBrowserDisabledReason,
            });
        }
        if (onOpenDiagnostics) {
            items.push({
                id: 'open-diagnostics',
                iconName: 'bug',
                label: t('browserShell.devtools.title'),
                onPress: onOpenDiagnostics,
            });
        }
        if (desktopNativeDevtoolsAvailable) {
            items.push({
                id: 'open-devtools',
                iconName: 'bug',
                label: t('browserShell.toolbar.openNativeDevtools'),
                onPress: onOpenDesktopDevtools,
            });
        }
        if (activeView && pluginActionsEnabled) {
            for (const action of plugins.toolbarActions) {
                const policyDecision = resolvePluginBrowserPolicyDecision(
                    action,
                    plugins.policyContext,
                    localizePluginText,
                );
                items.push({
                    id: action.id,
                    iconName: resolvePluginUiIconName(action.display.iconToken),
                    label: localizePluginText?.(action.pluginId, action.display.title)
                        ?? resolvePluginLocalizedText({
                            projection: null,
                            pluginId: action.pluginId,
                            value: action.display.title,
                        }),
                    onPress: () => plugins.invokeAction(action),
                    disabled: !policyDecision.enabled,
                    disabledReason: policyDecision.unavailableReason,
                });
            }
        }
        if (onOpenNewTab && onCloseTab) {
            items.push({ id: 'close-tab', iconName: 'x', label: t('browserShell.unavailable.closeTab'), onPress: onCloseTab });
        }
        return items;
    }, [
        onFloatView,
        onImportLogins,
        onOpenNewTab,
        onCloseTab,
        activeView,
        annotation,
        recording,
        onStartRecording,
        onDiscardRecording,
        onOpenInYourBrowser,
        engineSwitch,
        openInYourBrowserDisabledReason,
        onOpenDiagnostics,
        desktopNativeDevtoolsAvailable,
        onOpenDesktopDevtools,
        pluginActionsEnabled,
        localizePluginText,
        plugins,
    ]);
}
