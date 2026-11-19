import { PluginError, type DatabaseEnginesServiceV1 } from '@happier-dev/plugin-sdk';
import { DatabaseCapabilityV1Schema } from '@happier-dev/plugin-sdk/database';
import type { ResolvedActivationTarget } from '../../../projection/registry/types';
import type { ActivatedPluginRuntimeRegistry } from '../manager';

/** Uses the generic catalogue and activation owner, with no separate engine lifetime. */
export function createDatabaseEnginesService(input: Readonly<{
    targets: readonly ResolvedActivationTarget[];
    registry: Pick<ActivatedPluginRuntimeRegistry, 'targetRegistrations' | 'activateContributionsOnDemand'>;
}>): DatabaseEnginesServiceV1 {
    const declarations = input.targets.flatMap(target => (target.manifest.contributes.databaseEngines ?? []).map(declaration => ({
        pluginId: target.pluginId,
        declaration: { ...declaration, capabilities: declaration.capabilities.flatMap(capability => {
            const parsed = DatabaseCapabilityV1Schema.safeParse(capability);
            return parsed.success ? [parsed.data] : [];
        }) },
    })));
    return {
        list: () => declarations.map(entry => entry.declaration),
        async open(engineId, request) {
            request.signal?.throwIfAborted();
            const matches = declarations.filter(entry => entry.declaration.engineId === engineId);
            // Ambiguous engine ids cannot silently select a different plugin's transport.
            if (matches.length !== 1) throw new PluginError({ code: 'plugin_service_unavailable' });
            const selected = matches[0]!;
            await input.registry.activateContributionsOnDemand([{ pluginId: selected.pluginId, family: 'databaseEngines', localId: selected.declaration.id }]);
            const registration = input.registry.targetRegistrations.find(entry => entry.pluginId === selected.pluginId
                && entry.registration.family === 'databaseEngines' && entry.registration.localId === selected.declaration.id)?.registration;
            if (!registration || registration.family !== 'databaseEngines') throw new PluginError({ code: 'plugin_service_unavailable' });
            request.signal?.throwIfAborted();
            const runtime = registration.value;
            const connection = await runtime.open(request);
            return {
                engine: engineId,
                execute: (operation, signal) => runtime.execute(connection, operation, signal),
                close: () => runtime.close(connection),
            };
        },
    };
}
