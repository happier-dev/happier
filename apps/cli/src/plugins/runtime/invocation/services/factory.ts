import type { CreatePluginInvocationServices, PluginInvocationServiceBinding } from './types';
import {
    createPluginInvocationServicesFromDescriptors,
    createPluginInvocationServiceBinding,
    createUnavailablePluginServices,
    type PluginInvocationServicesFactoryParams,
} from './unavailable';

export { createPluginInvocationServiceBinding } from './unavailable';

export function createUnavailablePluginInvocationServiceBinding(
    occurrenceId: string,
    id: string,
): PluginInvocationServiceBinding {
    return createPluginInvocationServiceBinding(occurrenceId, id);
}

export function createUnavailablePluginServicesFactory(): CreatePluginInvocationServices {
    return (seed, binding) => {
        if (binding.occurrenceId !== seed.occurrenceId) {
            throw new Error('Plugin invocation service binding occurrence does not match the invocation context');
        }
        return createUnavailablePluginServices();
    };
}

export function createPluginInvocationServicesFactory(
    params: PluginInvocationServicesFactoryParams,
): CreatePluginInvocationServices {
    return (seed, binding) => createPluginInvocationServicesFromDescriptors(seed, binding, params);
}
