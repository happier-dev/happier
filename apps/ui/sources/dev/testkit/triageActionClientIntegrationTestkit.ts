import { connectUiPersonActionClient } from './actionClientIntegrationTestkit';
import type { SourceDeclaredAccountPluginFixture } from './harness/portableAccountPlugin';
import { installNativeRuntimeFetchBoundaryForTest } from './harness/nativeRuntimeFetch';

/** A native UI Account runtime with real Triage activation and services at physical loader/HTTP boundaries. */
export async function connectUiTriageActionClient(
    params: Parameters<typeof connectUiPersonActionClient>[0] & Readonly<{ additionalPlugins?: readonly SourceDeclaredAccountPluginFixture[] }>,
): ReturnType<typeof connectUiPersonActionClient> {
    installNativeRuntimeFetchBoundaryForTest();
    const install = await prepareUiTriageAccountRuntime(params.additionalPlugins);
    const client = await connectUiPersonActionClient({ ...params, withAppShellActions: false, withCurrentUiActionPort: false,
        withAccountLifecycle: false });
    let disposeAccount: (() => void) | undefined;
    try {
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(client.serverId);
        disposeAccount = account.dispose;
        const installed = await install({ accountLifetime: account.accountLifetime, publishProjection: true });
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
