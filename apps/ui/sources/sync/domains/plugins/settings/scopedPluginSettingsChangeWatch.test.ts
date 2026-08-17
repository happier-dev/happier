import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

async function loadWatchOwner() {
    vi.resetModules();
    let current = true;
    const retireCallbacks = new Set<() => void>();
    const lifetime = {
        scope: { serverId: 'server-a', accountId: 'account-a' },
        isCurrent: () => current,
        onRetire(callback: () => void) {
            retireCallbacks.add(callback);
            return {
                dispose: () => retireCallbacks.delete(callback),
            };
        },
    };
    const owner = await import('./scopedPluginSettingsChangeWatch');
    return {
        ...owner,
        lifetime,
        retire: () => {
            current = false;
            for (const callback of [...retireCallbacks]) callback();
        },
    };
}

describe('scoped plugin Settings AccountChange watch', () => {
    it('wakes only the exact active plugin Settings record and retires with its Account lifetime', async () => {
        const owner = await loadWatchOwner();
        const onSettingsInvalidated = vi.fn();
        const onOtherPluginInvalidated = vi.fn();
        owner.watchActiveScopedPluginSettingsChanges({
            pluginId: 'example.settings',
            target: { kind: 'account', serverIdentityId: 'server-identity-a' },
            lifetime: owner.lifetime,
            onInvalidated: onSettingsInvalidated,
        });
        owner.watchActiveScopedPluginSettingsChanges({
            pluginId: 'example.other',
            target: { kind: 'account', serverIdentityId: 'server-identity-a' },
            lifetime: owner.lifetime,
            onInvalidated: onOtherPluginInvalidated,
        });

        owner.publishActiveScopedPluginSettingsChanges([
            {
                cursor: 7,
                kind: 'pluginDomain',
                entityId: 'pluginDomain/example.settings/settings',
                changedAt: 7,
                hint: {
                    pluginDomain: 'settings',
                    pluginId: 'example.settings',
                    scope: 'account',
                    revision: 4,
                },
            },
            {
                cursor: 8,
                kind: 'pluginDomain',
                entityId: 'pluginDomain/example.other/availability',
                changedAt: 8,
                hint: {
                    pluginDomain: 'availability',
                    pluginId: 'example.other',
                },
            },
        ]);

        expect(onSettingsInvalidated).toHaveBeenCalledOnce();
        expect(onOtherPluginInvalidated).not.toHaveBeenCalled();

        owner.resetActiveScopedPluginSettingsChangeWatches();
        expect(onSettingsInvalidated).toHaveBeenCalledTimes(2);
        expect(onOtherPluginInvalidated).toHaveBeenCalledOnce();

        owner.retire();
        owner.publishActiveScopedPluginSettingsChanges([{
            cursor: 9,
            kind: 'pluginDomain',
            entityId: 'pluginDomain/example.settings/settings',
            changedAt: 9,
            hint: {
                pluginDomain: 'settings',
                pluginId: 'example.settings',
                scope: 'account',
                revision: 5,
            },
        }]);
        expect(onSettingsInvalidated).toHaveBeenCalledTimes(2);
    });
});
