import fastify from 'fastify';
import { expect, it } from 'vitest';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';
import { resolveExecutablePluginRuntimeRegistry, type ResolvedExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';
import { executeContributedAction } from './invocation/actions/executeContributedAction';

it('preserves missing Account execution artifacts when demand activation retires a managed contributor', async () => {
    const app = fastify();
    const endpoint = 'http://managed-account-artifact.test';
    const accountId = 'managed-account-artifact';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const pluginId = 'happier.machine.maritime';
    const authored = await registerAuthoredAccountActionRelease(app, accountId, { includeBundledPluginIds: [pluginId] });
    registerAccountHomeHttp(app, { accountId, serverId: 'srv_managed_account_artifact' });
    const declaration = loadCurrentBundledPluginLocatorResult({ pluginIds: [pluginId] }).loadedPlugins[0];
    if (!declaration) throw new Error('Missing bundled managed provisioner');
    // Reproduce the tree daemon's declaration with no dist/happier-plugin-ui graph.
    const { generatedUiArtifactsManifest: _generated, ...unpreparedDeclaration } = declaration;
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    let registry: ResolvedExecutablePluginRuntimeRegistry | undefined;
    try {
        registry = await resolveExecutablePluginRuntimeRegistry({
            contributes: createResolvedContributionRegistry(projectLoadedPluginContributes({ provenance: 'first_party',
                loadResult: { loadedPlugins: [unpreparedDeclaration], diagnosticsByPluginId: {} } })),
            accountExecution: { credentials, serverUrl: endpoint, isCurrent: () => true },
        });
        expect(await executeContributedAction({ runtimeRegistry: registry, actionId: `${authored.pluginId}/echo`,
            input: { key: 'control' }, context: { surface: 'cli' } }))
            .toMatchObject({ matched: true, result: { ok: true, result: { key: 'control' } } });
        const occurrenceId = registry.readPluginOccurrenceId(pluginId);
        if (!occurrenceId) throw new Error('Missing admitted managed contributor occurrence');
        expect(await executeContributedAction({ runtimeRegistry: registry, actionId: `${pluginId}/options`,
            input: {}, expectedContributorOccurrenceId: occurrenceId, context: { surface: 'plugin' } }))
            .toMatchObject({ matched: true, result: { ok: false,
                errorCode: 'plugin_account_execution_artifact_unavailable', actionHandlerInvocation: 'notStarted' } });
    } finally { await registry?.dispose(); restore(); await app.close(); }
});
