/** @moduleRealm daemon */
import type { PluginContributionLocalId } from '@happier-dev/protocol';
import type { PluginInvocationContext } from './invocation.js';

export type { BackgroundServiceContribution } from '@happier-dev/protocol';

export type BackgroundServiceDefinition = Readonly<{
    declaration: import('@happier-dev/protocol').BackgroundServiceContribution;
    runner: BackgroundServiceRunner;
}>;

export type BackgroundServiceContext =
    Omit<PluginInvocationContext, 'surface' | 'session'>
    & Readonly<{
        surface: 'background';
        session?: undefined;
    }>;

export type BackgroundServiceRunner = (
    context: BackgroundServiceContext,
) => Promise<void>;

export interface BackgroundServicesRegistrationApi {
    register(
        localId: PluginContributionLocalId,
        runner: BackgroundServiceRunner,
    ): void;
}
