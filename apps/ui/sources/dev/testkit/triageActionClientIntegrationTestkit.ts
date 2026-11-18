import { connectUiPersonActionClient } from './actionClientIntegrationTestkit';

/** A journey's physical Account executable loader, with real Triage activation and services. */
export async function connectUiTriageActionClient(
    params: Parameters<typeof connectUiPersonActionClient>[0],
): ReturnType<typeof connectUiPersonActionClient> {
    const client = await connectUiPersonActionClient({ ...params, withAppShellActions: false, withCurrentUiActionPort: false,
        withAccountLifecycle: false });
    let disposeAccount: (() => void) | undefined;
    try {
        const [{ captureLazyActionAccountContext }, { installPortableAccountPluginReleaseForTest },
            { PLUGIN_MANIFEST }, { activate }] = await Promise.all([
            import('@/sync/ops/actions/actionAccountContext'), import('./harness/portableAccountPlugin'),
            import('../../../../../packages/plugins/triage/src/manifest'),
            import('../../../../../packages/plugins/triage/src/accountRuntime'),
        ]);
        const account = await captureLazyActionAccountContext(client.serverId);
        disposeAccount = account.dispose;
        const installed = await installPortableAccountPluginReleaseForTest({ manifest: PLUGIN_MANIFEST, activate,
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
