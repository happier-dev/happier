import type { PluginServiceLaunchEnvironmentInputV1, PluginServiceLaunchEnvironmentResultV1 } from '@happier-dev/plugin-sdk';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ResolvedActivationTarget } from '../../../projection/registry/types';
import type { ActivatedPluginRuntimeRegistry } from '../manager';

export type ServiceLaunchEnvironmentHostInput = Omit<PluginServiceLaunchEnvironmentInputV1, 'readEnvironment'> & Readonly<{
    readEnvironment(names: readonly string[]): ReturnType<PluginServiceLaunchEnvironmentInputV1['readEnvironment']>;
}>;
export type PreparedServiceLaunchEnvironmentContribution = Readonly<{
    contribution: PluginContributionIdentityV1;
    result: PluginServiceLaunchEnvironmentResultV1;
}>;
/** Local preparation only: missing activation never blocks ordinary service startup. */
export async function prepareServiceLaunchEnvironments(params: Readonly<{
    targets: readonly ResolvedActivationTarget[];
    registry: Pick<ActivatedPluginRuntimeRegistry, 'targetRegistrations' | 'isPluginOccurrenceCurrent'>;
    input: ServiceLaunchEnvironmentHostInput;
}>): Promise<readonly PreparedServiceLaunchEnvironmentContribution[]> {
    return Promise.all(params.targets.flatMap(target => target.manifest.contributes.serviceLaunchEnvironments.map(async declaration => {
        const contribution = { pluginId: target.pluginId, localId: declaration.id };
        const entry = params.registry.targetRegistrations.find(candidate => candidate.pluginId === target.pluginId
            && candidate.registration.family === 'serviceLaunchEnvironments' && candidate.registration.localId === declaration.id);
        if (!entry || entry.registration.family !== 'serviceLaunchEnvironments'
            || !params.registry.isPluginOccurrenceCurrent(target.pluginId, entry.occurrenceId)) {
            return { contribution, result: { kind: 'unavailable', code: 'service_launch_environment_unavailable' } } as const;
        }
        try {
            const requestListenerPorts = params.input.requestListenerPorts;
            const listenerPrefix = `${target.pluginId}/${declaration.id}/`;
            const result = await entry.registration.value.prepare({ ...params.input,
                assignedPorts: Object.fromEntries(Object.entries(params.input.assignedPorts)
                    .filter(([name]) => name.startsWith(listenerPrefix))
                    .map(([name, port]) => [name.slice(listenerPrefix.length), port])),
                readEnvironment: () => params.input.readEnvironment(declaration.environmentNames),
                ...(requestListenerPorts ? { async requestListenerPorts(keys: readonly string[]) {
                    // Stable contributor-local keys prevent independent contributions from sharing a listener accidentally.
                    const names = [...new Set(keys)];
                    const qualified = names.map(name => `${listenerPrefix}${name}`);
                    const ports = await requestListenerPorts(qualified);
                    return ports.kind === 'ready' ? { ...ports, assignment: { ...ports.assignment,
                        listenerPorts: Object.fromEntries(names.map((name, index) => [name, ports.assignment.listenerPorts[qualified[index]!]!])) } } : ports;
                } } : {}),
            });
            return { contribution, result };
        } catch {
            // A plugin exception may contain an upstream URL or password.
            return { contribution, result: { kind: 'unavailable', code: 'service_launch_environment_failed' } } as const;
        }
    })));
}
