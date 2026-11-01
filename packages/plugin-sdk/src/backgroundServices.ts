/** @moduleRealm daemon */
import type { PluginContributionLocalId } from '@happier-dev/protocol';
import type { PluginInvocationContext } from './invocation.js';
import type { PluginMachineMaterializationRefV1 } from './executionOrigin.js';

export type { BackgroundServiceContribution } from '@happier-dev/protocol';

export type BackgroundServiceDefinition = Readonly<{
    declaration: import('@happier-dev/protocol').BackgroundServiceContribution;
    runner: BackgroundServiceRunner;
}>;

export type BackgroundServiceContext =
    Omit<PluginInvocationContext, 'surface' | 'session'>
    & Readonly<{
        surface: 'background';
        session?: never;
        /** This running service's host-stamped installation; absent for source-only execution. */
        materialization?: PluginMachineMaterializationRefV1;
    }>;

export type BackgroundServiceRunner = (
    context: BackgroundServiceContext,
) => Promise<void>;

/** One caller's demand; cancelling it never cancels another caller's demand. */
export type BackgroundServiceDemandHandle = Readonly<{
    /** Joins the finite batch, invocation cleanup and, for process placement, child exit. */
    settlement: Promise<void>;
    /** Rejects only this caller's settlement; other coalesced callers keep running. */
    cancel(): void;
}>;

/** Available in daemon invocations for the declaring plugin's services. */
export interface BackgroundServicesService {
    demand(localId: PluginContributionLocalId, reason?: string): BackgroundServiceDemandHandle;
}

export interface BackgroundServicesRegistrationApi {
    register(
        localId: PluginContributionLocalId,
        runner: BackgroundServiceRunner,
    ): void;
}
