import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { renderHook } from '@/dev/testkit';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { normalizePluginUiProjection, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { createPluginUiTranslationRuntime } from '@/sync/domains/plugins/ui/i18n';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { commitPreferredLanguage } from '@/text/preferredLanguage';
import type { ExpoNotificationsModule } from '@/utils/platform/loadExpoNotifications';
import { observePluginNotificationCategories, usePluginNotificationCategories } from './usePluginNotificationCategories';

const expo = vi.hoisted(() => ({ loads: 0, setCategory: vi.fn() }));
// Native category writes and loading are the Expo SDK boundary.
vi.mock('expo-notifications', () => {
    expo.loads++;
    return { setNotificationHandler: () => {}, setNotificationCategoryAsync: expo.setCategory };
});

const pluginId = 'acme.external';
const stops: Array<() => void> = [];
function projection(): PluginUiProjectionModel {
    return normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'External', enabled: true, source: { kind: 'path', locator: '/fixture' } } },
        familiesById: { notificationCategories: { family: 'notificationCategories', entriesById: {
            [`${pluginId}/review`]: { id: `${pluginId}/review`, pluginId, pluginVersion: '1.0.0', occurrenceId: 'fixture-occurrence',
                definition: { id: 'review', title: 'Review', kind: 'plugin', eventIds: [], buttons: [
                    { id: 'See #42 ✨', label: { key: 'review.open', fallback: 'Author fallback' }, effect: { kind: 'open' } },
                ] } },
        } } },
    }), 'ios');
}
function nativeBoundary() {
    return { setNotificationCategoryAsync: vi.fn<ExpoNotificationsModule['setNotificationCategoryAsync']>(async (identifier, actions) => ({ identifier, actions })) };
}

afterEach(() => { for (const stop of stops.splice(0).reverse()) stop(); commitPreferredLanguage('en'); });

describe('committed plugin notification categories', () => {
    it('starts only for authenticated native routing and stops when routing is disabled', async () => {
        const originalPlatform = Platform.OS;
        stops.push(() => { Platform.OS = originalPlatform; });
        stops.push(publishCommittedAppShellPluginUiProjection(() => projection()));
        Platform.OS = 'web';
        const web = await renderHook(() => usePluginNotificationCategories(true));
        expect(expo.loads).toBe(0);
        await web.unmount();
        Platform.OS = 'ios';
        const native = await renderHook((enabled: boolean) => usePluginNotificationCategories(enabled), { initialProps: false });
        expect(expo.loads).toBe(0);
        expo.setCategory.mockImplementation(async (identifier, actions) => ({ identifier, actions }));
        await native.rerender(true);
        await vi.waitFor(() => expect(expo.setCategory).toHaveBeenCalledTimes(1));
        await native.rerender(false);
        expo.setCategory.mockClear();
        commitPreferredLanguage('fr');
        await Promise.resolve();
        expect(expo.setCategory).not.toHaveBeenCalled();
        await native.unmount();
    });

    it('registers current localized declarations, ignores unrelated arrivals, and detaches on cleanup', async () => {
        commitPreferredLanguage('en');
        const base = projection();
        let scans = 0;
        const categories = new Proxy(base.notificationCategoriesById, { ownKeys(target) { scans++; return Reflect.ownKeys(target); } });
        const model: PluginUiProjectionModel = { ...base, notificationCategoriesById: categories,
            translationsByPluginId: { [pluginId]: { id: `translations:${pluginId}`, pluginId, contributionKind: 'translations', locales: ['en', 'fr'],
                bundles: { en: { 'review.open': 'Review' }, fr: { 'review.open': 'Vérifier' } } } } };
        stops.push(publishCommittedAppShellPluginUiProjection(() => model));
        const native = nativeBoundary();
        const stop = observePluginNotificationCategories(native);
        stops.push(stop);
        await vi.waitFor(() => expect(native.setNotificationCategoryAsync).toHaveBeenCalledWith('happier.pluginNotification.v1/acme.external/review', [
            { identifier: 'happier.pluginNotification.v1/acme.external/review/See%20%2342%20%E2%9C%A8', buttonTitle: 'Review', options: { opensAppToForeground: true } },
        ]));
        scans = 0;
        native.setNotificationCategoryAsync.mockClear();
        for (let generation = 2; generation < 102; generation++) {
            stops.push(publishCommittedAppShellPluginUiProjection(() => ({ ...model, generation })));
        }
        await Promise.resolve();
        expect(scans).toBe(0);
        expect(native.setNotificationCategoryAsync).not.toHaveBeenCalled();
        commitPreferredLanguage('fr');
        await vi.waitFor(() => expect(native.setNotificationCategoryAsync.mock.calls.at(-1)?.[1][0]?.buttonTitle).toBe('Vérifier'));
        const category = model.notificationCategoriesById[`${pluginId}/review`]!;
        stops.push(publishCommittedAppShellPluginUiProjection(() => ({ ...model, notificationCategoriesById: {
            [category.id]: { ...category, definition: { ...category.definition, buttons: [] } },
        } })));
        await vi.waitFor(() => expect(native.setNotificationCategoryAsync.mock.calls.at(-1)?.[1]).toEqual([]));
        stop();
        native.setNotificationCategoryAsync.mockClear();
        commitPreferredLanguage('en');
        stops.push(publishCommittedAppShellPluginUiProjection(() => projection()));
        await Promise.resolve();
        expect(native.setNotificationCategoryAsync).not.toHaveBeenCalled();
    });

    it('demands only keyed category copy and reacts to the current translation runtime', async () => {
        commitPreferredLanguage('en');
        const base = projection();
        const model: PluginUiProjectionModel = { ...base, translationsByPluginId: {
            [pluginId]: { id: `translations:${pluginId}`, pluginId, contributionKind: 'translations', locales: ['en', 'fr'], resourceIdsByLocale: { en: 'copy-en', fr: 'copy-fr' } },
            'acme.unused': { id: 'translations:acme.unused', pluginId: 'acme.unused', contributionKind: 'translations', locales: ['en'], resourceIdsByLocale: { en: 'unused' } },
        } };
        const reads: string[] = [];
        const runtime = createPluginUiTranslationRuntime({ projection: model, readResourceBytes: async (_projection, id, resourceId) => {
            reads.push(`${id}/${resourceId}`);
            return new TextEncoder().encode(JSON.stringify({ 'review.open': resourceId === 'copy-fr' ? 'Ouvrir' : 'Read review' }));
        } });
        stops.push(runtime.dispose);
        stops.push(publishCommittedAppShellPluginUiProjection(() => model, undefined, undefined, runtime));
        const native = nativeBoundary();
        stops.push(observePluginNotificationCategories(native));
        await vi.waitFor(() => expect(native.setNotificationCategoryAsync.mock.calls.at(-1)?.[1][0]?.buttonTitle).toBe('Read review'));
        expect(reads).toEqual([`${pluginId}/copy-en`]);
        commitPreferredLanguage('fr');
        await vi.waitFor(() => expect(native.setNotificationCategoryAsync.mock.calls.at(-1)?.[1][0]?.buttonTitle).toBe('Ouvrir'));
        expect(reads).toEqual([`${pluginId}/copy-en`, `${pluginId}/copy-fr`]);
    });
});
