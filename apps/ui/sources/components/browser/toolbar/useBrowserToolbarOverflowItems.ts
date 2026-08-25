import * as React from 'react';

import type { BrowserAnnotationController } from '@/components/browser/annotation/useBrowserAnnotationController';
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
 * The toolbar's secondary, single-shot tools.
 *
 * Live-status controls (privacy / recording / automation) are NOT here: they convey ongoing state,
 * so they stay visible. Everything in this menu is a one-tap action whose absence from the row is
 * what keeps the toolbar at four clusters and one line in a 380px pane.
 *
 * Every disabled entry carries a reason. An affordance that is greyed out with no explanation is
 * indistinguishable from a broken one.
 */
export function useBrowserToolbarOverflowItems(input: Readonly<{
    activeView: BrowserControlViewState | null;
    annotation: BrowserAnnotationController;
    /** Whether the shell was given a browser-context host at all. */
    browserContextPresent: boolean;
    desktopNativeDevtoolsAvailable: boolean;
    onOpenDesktopDevtools: () => void;
    plugins: BrowserPluginActions;
    pluginActionsEnabled: boolean;
    localizePluginText?: PluginLocalizedTextResolver;
}>): readonly BrowserToolbarOverflowItem[] {
    const {
        activeView,
        annotation,
        browserContextPresent,
        desktopNativeDevtoolsAvailable,
        onOpenDesktopDevtools,
        pluginActionsEnabled,
        localizePluginText,
        plugins,
    } = input;

    return React.useMemo<readonly BrowserToolbarOverflowItem[]>(() => {
        const items: BrowserToolbarOverflowItem[] = [];
        if (desktopNativeDevtoolsAvailable) {
            items.push({
                id: 'open-devtools',
                iconName: 'bug',
                label: t('browserShell.toolbar.openNativeDevtools'),
                onPress: onOpenDesktopDevtools,
            });
        }
        if (browserContextPresent) {
            items.push({
                id: 'attach-context',
                iconName: 'globe',
                label: t('browserContext.composer.attachPageReference'),
                onPress: annotation.attachPageReference,
                disabled: annotation.contextButtonDisabled,
                disabledReason: annotation.contextButtonDisabled ? annotation.contextDisabledReason : null,
            });
            if (annotation.supported) {
                if (annotation.active) {
                    items.push({
                        id: 'capture-annotation',
                        iconName: 'check',
                        label: t('browserContext.composer.attachAnnotation'),
                        onPress: () => { void annotation.capture(); },
                        disabled: annotation.contextButtonDisabled || !annotation.draftAvailable,
                        disabledReason: annotation.contextButtonDisabled
                            ? annotation.contextDisabledReason
                            : !annotation.draftAvailable
                                ? annotation.captureDisabledReason
                                : null,
                        tone: 'active',
                    });
                    items.push({
                        id: 'cancel-annotation',
                        iconName: 'x',
                        label: t('browserContext.composer.cancelAnnotation'),
                        onPress: annotation.cancel,
                        disabled: annotation.contextButtonDisabled,
                        disabledReason: annotation.contextButtonDisabled ? annotation.contextDisabledReason : null,
                    });
                } else {
                    items.push({
                        id: 'start-annotation',
                        iconName: 'pencil-simple',
                        label: t('browserContext.composer.startAnnotation'),
                        onPress: annotation.start,
                        disabled: annotation.contextButtonDisabled || annotation.captureProducerUnavailable,
                        disabledReason: annotation.contextButtonDisabled
                            ? annotation.contextDisabledReason
                            : annotation.captureProducerUnavailable
                                ? annotation.captureDisabledReason
                                : null,
                    });
                }
            }
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
        activeView,
        annotation,
        browserContextPresent,
        desktopNativeDevtoolsAvailable,
        onOpenDesktopDevtools,
        pluginActionsEnabled,
        localizePluginText,
        plugins,
    ]);
}
