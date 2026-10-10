import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/custom-acp/src/manifest';
import { createAdmittedPluginRuntimeFixture } from './admittedRuntime';

/** Admit the current bundled declaration once, through its real source owner. */
export async function createCustomAcpAdmittedRuntimeFixture(
    params: NonNullable<Parameters<typeof createAdmittedPluginRuntimeFixture>[0]> = {},
) {
    const fixture = await createAdmittedPluginRuntimeFixture({
        ...params,
        runtimeOptions: {
            ...params.runtimeOptions,
            pluginIds: [PLUGIN_MANIFEST.id],
        },
    });
    const activation = await fixture.registry.activateContributionsOnDemand([
        { pluginId: PLUGIN_MANIFEST.id, family: 'agents', localId: 'custom-acp' },
    ]);
    const agent = [...fixture.registry.contributes.agentDefinitionsById.values()]
        .find(value => value.identity?.pluginId === PLUGIN_MANIFEST.id);
    if (!agent || !fixture.registry.agentRuntimesByAgentId.get(agent.id)?.hasPrimaryRuntime) {
        await fixture.dispose();
        throw new Error(`Custom ACP bundled source admission failed: ${JSON.stringify(activation)}`);
    }
    return fixture;
}
