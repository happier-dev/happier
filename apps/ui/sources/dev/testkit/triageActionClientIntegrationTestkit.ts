import { connectUiPersonActionClient } from './actionClientIntegrationTestkit';
import type { PortableAccountPluginFixture } from './harness/portableAccountPlugin';
import { installNativeRuntimeFetchBoundaryForTest } from './harness/nativeRuntimeFetch';

/** A native UI Account runtime with real Triage activation and services at physical loader/HTTP boundaries. */
export async function connectUiTriageActionClient(
    params: Parameters<typeof connectUiPersonActionClient>[0] & Readonly<{ additionalPlugins?: readonly PortableAccountPluginFixture[] }>,
): ReturnType<typeof connectUiPersonActionClient> {
    installNativeRuntimeFetchBoundaryForTest();
    const client = await connectUiPersonActionClient({ ...params, withAppShellActions: false, withCurrentUiActionPort: false,
        withAccountLifecycle: false });
    let disposeAccount: (() => void) | undefined;
    try {
        const [{ captureLazyActionAccountContext }, { installPortableAccountPluginReleasesForTest },
            { PLUGIN_MANIFEST }, { activate }] = await Promise.all([
            import('@/sync/ops/actions/actionAccountContext'), import('./harness/portableAccountPlugin'),
            import('../../../../../packages/plugins/triage/src/manifest'),
            import('../../../../../packages/plugins/triage/src/accountRuntime'),
        ]);
        const account = await captureLazyActionAccountContext(client.serverId);
        disposeAccount = account.dispose;
        const installed = await installPortableAccountPluginReleasesForTest({
            plugins: [{ manifest: PLUGIN_MANIFEST, activate }, ...(params.additionalPlugins ?? [])],
            accountLifetime: account.accountLifetime, publishProjection: true });
        return { ...client, async close() {
            try { await installed.dispose(); } finally {
                account.dispose();
                await client.close();
            }
        } };
    } catch (error) {
        disposeAccount?.();
        await client.close();
        throw error;
    }
}
