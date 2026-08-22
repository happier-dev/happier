import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol';

/**
 * Test-only host materialization fixture for Action caller provenance.
 *
 * Production code obtains this value from the resolved runtime registry at
 * dispatch time. Tests use the paired resolver to model that same boundary
 * instead of capturing a materialization on an invocation seed.
 */
export function createPluginActionCallerMaterializationFixture(
    pluginId: string,
    options: Readonly<{
        machineId?: string;
        materializationId?: string;
    }> = {},
): Readonly<{
    materialization: PluginMachineMaterializationRefV1;
    resolveCurrentPluginMaterializationRef(): PluginMachineMaterializationRefV1;
}> {
    const materialization = Object.freeze({
        pluginId,
        machineId: options.machineId ?? 'machine-1',
        materializationId: options.materializationId
            ?? `materialization-${pluginId.replaceAll('.', '-')}-current`,
    }) satisfies PluginMachineMaterializationRefV1;

    return Object.freeze({
        materialization,
        resolveCurrentPluginMaterializationRef: () => materialization,
    });
}
