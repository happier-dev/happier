import * as React from 'react';
import { Platform } from 'react-native';
import { loadExpoNotifications, type ExpoNotificationsModule } from '@/utils/platform/loadExpoNotifications';
import {
    readCurrentAppShellPluginUiProjection,
    readCurrentAppShellPluginUiTranslationRuntime,
    subscribeCommittedAppShellPluginUiProjection,
} from '@/components/appShell/plugins/committedPluginUiProjection';
import { createPluginLocalizedTextResolver, type PluginUiTranslationRuntime } from '@/sync/domains/plugins/ui/i18n';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { getPreferredLanguage, subscribePreferredLanguage } from '@/text/preferredLanguage';
import { configurePluginNotificationCategories, type PluginNativeCategory } from '../configureNotificationCategories';

/** Native categories are a projection of the shell's current admitted declarations and copy. */
export function observePluginNotificationCategories(notifications: Pick<ExpoNotificationsModule, 'setNotificationCategoryAsync'>): () => void {
    let projection: PluginUiProjectionModel | null = null;
    let runtime: PluginUiTranslationRuntime | null = null;
    let locale = getPreferredLanguage();
    let categoriesByPlugin = new Map<string, PluginNativeCategory[]>();
    let keyedPlugins = new Set<string>();
    let stopCopy: (() => void) | undefined;

    const publish = (pluginIds: Iterable<string>, removed: readonly PluginNativeCategory[] = []) => {
        const pluginCategories = [...removed, ...[...pluginIds].flatMap(id => categoriesByPlugin.get(id) ?? [])];
        if (!pluginCategories.length) return;
        void configurePluginNotificationCategories(notifications, { pluginCategories,
            resolveLabel: createPluginLocalizedTextResolver({ projection, runtime, locale }),
        }).catch(() => { console.warn('[notifications] Plugin notification category registration unavailable'); });
    };
    const refresh = () => {
        const next = readCurrentAppShellPluginUiProjection();
        const nextRuntime = readCurrentAppShellPluginUiTranslationRuntime(next);
        const nextLocale = getPreferredLanguage();
        const catalogChanged = next?.notificationCategoriesById !== projection?.notificationCategoriesById;
        const runtimeChanged = nextRuntime !== runtime;
        const localeChanged = nextLocale !== locale;
        const copySourceChanged = next?.translationsByPluginId !== projection?.translationsByPluginId
            || next?.installedPackagesById !== projection?.installedPackagesById || next?.resourcesById !== projection?.resourcesById;
        if (!catalogChanged && !runtimeChanged && !localeChanged && !copySourceChanged) return;
        const previous = projection;
        projection = next;
        runtime = nextRuntime;
        locale = nextLocale;
        const removed: PluginNativeCategory[] = [];
        if (catalogChanged) {
            for (const category of Object.values(previous?.notificationCategoriesById ?? {})) {
                if (category.definition.buttons?.length && !next?.notificationCategoriesById[category.id]?.definition.buttons?.length) {
                    removed.push({ pluginId: category.pluginId, categoryId: category.definition.id, buttons: [] });
                }
            }
            categoriesByPlugin = new Map();
            keyedPlugins = new Set();
            for (const category of Object.values(next?.notificationCategoriesById ?? {})) {
                const buttons = category.definition.buttons;
                if (!buttons?.length) continue;
                const categories = categoriesByPlugin.get(category.pluginId) ?? [];
                categories.push({ pluginId: category.pluginId, categoryId: category.definition.id, buttons });
                categoriesByPlugin.set(category.pluginId, categories);
                if (buttons.some(button => typeof button.label !== 'string')) keyedPlugins.add(category.pluginId);
            }
        }
        if (runtimeChanged) {
            stopCopy?.();
            stopCopy = runtime?.subscribe(pluginId => { if (keyedPlugins.has(pluginId)) publish([pluginId]); });
        }
        const changed = catalogChanged || runtimeChanged || localeChanged ? [...categoriesByPlugin.keys()]
            : [...keyedPlugins].filter(pluginId => previous?.translationsByPluginId[pluginId] !== next?.translationsByPluginId[pluginId]
                || (runtime && !runtime.matchesSource(previous, pluginId)));
        publish(changed, removed);
        for (const pluginId of changed) {
            if (keyedPlugins.has(pluginId) && runtime?.matchesSource(projection, pluginId)) {
                void runtime.demand(pluginId, locale).catch(() => {});
            }
        }
    };
    const stopProjection = subscribeCommittedAppShellPluginUiProjection(refresh);
    const stopLocale = subscribePreferredLanguage(refresh);
    refresh();
    return () => { stopProjection(); stopLocale(); stopCopy?.(); };
}

export function usePluginNotificationCategories(enabled: boolean): void {
    React.useEffect(() => {
        if (!enabled || Platform.OS === 'web') return;
        let cancelled = false;
        let stop: (() => void) | undefined;
        void loadExpoNotifications().then(notifications => {
            if (!cancelled) stop = observePluginNotificationCategories(notifications);
        }).catch(() => { console.warn('[notifications] Plugin notification category registration unavailable'); });
        return () => { cancelled = true; stop?.(); };
    }, [enabled]);
}
