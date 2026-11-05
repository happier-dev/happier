import * as React from 'react';

import type { BrowserAnnotationController } from '@/components/browser/annotation/useBrowserAnnotationController';
import type { BrowserRecordingControl } from '@/components/browser/recording';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { resolvePluginBrowserPolicyDecision } from '@/sync/domains/plugins/browser/policy';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import {
    resolvePluginLocalizedText,
    type PluginLocalizedTextResolver,
} from '@/sync/domains/plugins/ui/i18n';
import { t } from '@/text';

import type { BrowserPluginActions } from '../useBrowserPluginActions';
import type { BrowserToolbarOverflowItem } from './BrowserToolbarOverflowMenu';

/**
 * The chrome's `⋯`: the rare, one-shot tools.
 *
 * What is used on most pages lives in the row itself (back, forward, reload, the address, Mark up,
 * Attach page), and live state docks there only while it is live (a running recording). Everything
 * here is a single tap that does not need to stay on screen: start a recording (or discard the one
 * running), open the page in the user's own browser, devtools, and plugin actions.
 *
 * Every disabled entry carries a reason. An affordance that is greyed out with no explanation is
 * indistinguishable from a broken one.
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
    /** Idle Diagnostics live here rather than as a bar under the page (lab Q). */
    onOpenDiagnostics?: (() => void) | null;
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
        onOpenDiagnostics,
        onImportLogins,
        desktopNativeDevtoolsAvailable,
        onOpenDesktopDevtools,
        pluginActionsEnabled,
        localizePluginText,
        plugins,
    } = input;

    return React.useMemo<readonly BrowserToolbarOverflowItem[]>(() => {
        const items: BrowserToolbarOverflowItem[] = [];
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
            } else {
                items.push({
                    id: 'start-recording',
                    iconName: 'circle',
                    label: t('browserRecording.actions.start'),
                    onPress: () => onStartRecording?.(),
                    disabled: !recording.startRequest || !onStartRecording,
                    disabledReason: recording.unavailable?.message ?? null,
                });
            }
        }
        if (onImportLogins) {
            items.push({ id: 'import-logins', iconName: 'sign-in', label: t('browserShell.loginImport.menu'), onPress: onImportLogins });
        }
        if (onOpenInYourBrowser) {
            items.push({
                id: 'open-in-your-browser',
                iconName: 'arrow-square-out',
                label: t('browserPresence.openInYourBrowser'),
                onPress: onOpenInYourBrowser,
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
        return items;
    }, [
        onImportLogins,
        activeView,
        annotation,
        recording,
        onStartRecording,
        onDiscardRecording,
        onOpenInYourBrowser,
        onOpenDiagnostics,
        desktopNativeDevtoolsAvailable,
        onOpenDesktopDevtools,
        pluginActionsEnabled,
        localizePluginText,
        plugins,
    ]);
}
