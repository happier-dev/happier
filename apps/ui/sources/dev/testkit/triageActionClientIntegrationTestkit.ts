import { vi } from 'vitest';
import { sameQualifiedConnectedAccountRef, type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';

import {
    isQualifiedConnectedAccountProfileActiveV4,
    sameQualifiedConnectedAccountGroupRef,
    type QualifiedConnectedAccountGroupRef,
} from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import type { NormalizedPluginAccountCollectionContractV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';

import { connectUiPersonActionClient } from './actionClientIntegrationTestkit';
import type { SourceDeclaredAccountPluginFixture } from './harness/portableAccountPlugin';
import { installNativeRuntimeFetchBoundaryForTest } from './harness/nativeRuntimeFetch';
import { waitForTestEvent } from './hooks/waitForTestEvent';

/** A native UI Account runtime with real Triage activation and services at physical loader/HTTP boundaries. */
export async function connectUiTriageActionClient(
    params: Parameters<typeof connectUiPersonActionClient>[0] & Readonly<{ additionalPlugins?: readonly SourceDeclaredAccountPluginFixture[] }>,
) {
    installNativeRuntimeFetchBoundaryForTest();
    const install = await prepareUiTriageAccountRuntime(params.additionalPlugins);
    const client = await connectUiPersonActionClient({ ...params, withAppShellActions: false, withCurrentUiActionPort: false,
        withAccountLifecycle: false });
    let disposeAccount: (() => void) | undefined;
    try {
        const [{ captureLazyActionAccountContext }, { storage }] = await Promise.all([
            import('@/sync/ops/actions/actionAccountContext'),
            import('@/sync/domains/state/storage'),
        ]);
        const account = await captureLazyActionAccountContext(client.serverId);
        disposeAccount = account.dispose;
        const installed = await install({ accountLifetime: account.accountLifetime, publishProjection: true });
        return {
            ...client,
            async collectionClients(contracts: readonly NormalizedPluginAccountCollectionContractV1[]) {
                const { createActivePluginCollectionClient } = await import('@/sync/api/plugins/data/activePluginCollectionClient');
                return contracts.map(contract => createActivePluginCollectionClient({ contract, accountLifetime: account.accountLifetime }));
            },
            readConnectedAccountPoolActiveMember(group: QualifiedConnectedAccountGroupRef): string | null {
                account.assertCurrent();
                const profile = storage.getState().profile;
                if (profile.id !== account.accountId) return null;
                return profile.connectedAccountGroupsV4.find(({ ref }) =>
                    sameQualifiedConnectedAccountGroupRef(ref, group))?.activeConnectedAccountId ?? null;
            },
            async waitForConnectedAccountProfile(ref: QualifiedConnectedAccountRef): Promise<void> {
                await waitForTestEvent(storage.subscribe, () => {
                    account.assertCurrent();
                    const profile = storage.getState().profile;
                    return profile.id === account.accountId && profile.connectedAccountsV4.some(connected =>
                        sameQualifiedConnectedAccountRef(connected.ref, ref)
                        && isQualifiedConnectedAccountProfileActiveV4(connected, Date.now()));
                }, ready => ready);
            },
            async observeMachineTransport() {
                const [{ apiSocket }, scopedTransport] = await Promise.all([
                    import('@/sync/api/session/apiSocket'),
                    import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc'),
                ]);
                const active = vi.spyOn(apiSocket, 'machineRPC');
                const scoped = vi.spyOn(scopedTransport, 'machineRpcWithServerScope');
                return {
                    counts: () => ({ active: active.mock.calls.length, scoped: scoped.mock.calls.length }),
                    reset() {
                        active.mockClear();
                        scoped.mockClear();
                    },
                    dispose() {
                        scoped.mockRestore();
                        active.mockRestore();
                    },
                };
            },
            async close() {
                try { await installed.dispose(); } finally {
                    account.dispose();
                    await client.close();
                }
            },
        };
    } catch (error) {
        disposeAccount?.();
        await client.close();
        throw error;
    }
}

/** A journey that signs in generically first prepares its app package before that first restore. */
export async function prepareUiTriageActionPluginsForTest(additionalPlugins?: readonly SourceDeclaredAccountPluginFixture[]): Promise<void> {
    await prepareUiTriageAccountRuntime(additionalPlugins);
}

async function prepareUiTriageAccountRuntime(additionalPlugins?: readonly SourceDeclaredAccountPluginFixture[]) {
    const [{ prepareSourceDeclaredAccountPluginsForTest }, { PLUGIN_MANIFEST }, { activate }, { default: triagePackage }] = await Promise.all([
        import('./harness/portableAccountPlugin'), import('../../../../../packages/plugins/triage/src/manifest'),
        import('../../../../../packages/plugins/triage/src/accountRuntime'), import('../../../../../packages/plugins/triage/package.json'),
    ]);
    return await prepareSourceDeclaredAccountPluginsForTest([
        { packageName: triagePackage.name, manifest: PLUGIN_MANIFEST, activate }, ...(additionalPlugins ?? []),
    ]);
}
