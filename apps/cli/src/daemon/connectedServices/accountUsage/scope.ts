import { createProviderAccountUsageStore, type ProviderAccountUsageStore } from './store';

type AccountScope = Readonly<{ serverId: string; accountId: string }>;

/** One daemon-lifetime usage authority per Home and Account, shared by its Sessions and Runs. */
export function createProviderAccountUsageStores() {
    const stores = new Map<string, ProviderAccountUsageStore>();
    return {
        forAccount(scope: AccountScope): ProviderAccountUsageStore {
            const key = JSON.stringify([scope.serverId, scope.accountId]);
            let store = stores.get(key);
            if (!store) {
                store = createProviderAccountUsageStore();
                stores.set(key, store);
            }
            return store;
        },
    };
}
