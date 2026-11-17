import { createThemeRegistryLifecycle, type BoundThemeRegistryLifecycle, type ThemeRegistryOperationOptions } from '@/registries/themeRegistryInstall';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { readSystemTheme, resolveThemeRuntimeVisualTheme } from './themeProfileRuntime';
import { createThemeTryOnOwner } from './themeTryOn';

const registry = createThemeRegistryLifecycle({
    withThemeProfileContext: (operation, options) => getSyncSingleton().withThemeProfileContext(operation,
        options),
    acquire: async (listing, options) => {
        const [{ captureLazyActionAccountContext }, { createUiPromptLibraryArtifactStore }, { createUiRegistryHostV1 }] = await Promise.all([
            import('@/sync/ops/actions/actionAccountContext'),
            import('@/sync/ops/promptLibrary/promptLibraryArtifactStore'),
            import('@/registries/registryHostDeps'),
        ]);
        const account = await captureLazyActionAccountContext(options.expectedScope?.serverId ?? '', options.signal, undefined, options.expectedScope);
        try {
            const store = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account);
            const host = await createUiRegistryHostV1(account, store.organization,
                { serverId: account.serverId, expectedAccountId: account.accountId, signal: options.signal, surface: 'ui' });
            return await host.readRegistryTheme(listing);
        } finally { account.dispose(); }
    },
    readMode: () => resolveThemeRuntimeVisualTheme(getStorage().getState().localSettings.themePreference, readSystemTheme()),
    revertStorePreview: listing => {
        const current = preview.read();
        if (current?.origin.kind === 'store' && current.origin.listing.sourceId === listing.sourceId
            && current.origin.listing.itemId === listing.itemId) preview.revert(current.previewRef);
    },
});

const preview = createThemeTryOnOwner({
    captureScope: () => getStorage().getState().settingsScope,
    keep: (input, expectedScope) => getSyncSingleton().withThemeProfileLibrary(library => library.keep(input), { expectedScope }),
    select: (input, expectedScope) => getSyncSingleton().withThemeProfileLibrary(library => library.select(input), { expectedScope }),
    installStore: (snapshot, expectedScope) => registry.keepStore(snapshot, { expectedScope }),
});

/** One device overlay; its owner retains the captured Account and decides visibility. */
export function getThemeTryOnOwner() { return preview; }
export function getThemeRegistryLifecycle() { return registry; }

/** Bind only this operation's authority; the lifecycle and its selected acquisition stay shared. */
export function bindThemeRegistryLifecycle(options: ThemeRegistryOperationOptions): BoundThemeRegistryLifecycle {
    return {
        acquirePreview: input => registry.acquirePreview(input, options),
        get: input => registry.get(input, options),
        releaseOpened: input => registry.releaseOpened(input, options),
        prepareStorePreview: input => registry.prepareStorePreview(input, options),
        install: input => registry.install(input, options),
        uninstall: input => registry.uninstall(input, options),
        keepStore: input => registry.keepStore(input, options),
    };
}
