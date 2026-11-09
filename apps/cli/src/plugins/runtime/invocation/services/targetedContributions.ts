import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { TargetedContributionSnapshot, TargetedContributionsService } from '@happier-dev/plugin-sdk';
import { createTargetedContributionsService, projectAdmittedTargetedContributionSnapshot } from '@happier-dev/cli-common/plugins/registration';
import type { StableTargetedContributionsOwner, TargetedContributionsAdmissionSource } from '@happier-dev/cli-common/plugins/registration';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
export { createTargetedContributionsService } from '@happier-dev/cli-common/plugins/registration';
export type { StableTargetedContributionsOwner, TargetedContributionsAdmissionSource } from '@happier-dev/cli-common/plugins/registration';
export type ReloadControllerTargetedContributionsHost = Readonly<{ reloadController: PluginReloadController }>;

function operationAborted(): PluginError {
    return new PluginError({ code: 'plugin_targeted_contributions_aborted', message: 'Targeted contribution observation was aborted' });
}
function targetedContributionsUnavailable(): PluginError {
    return new PluginError({ code: 'plugin_targeted_contributions_unavailable', message: 'Targeted contribution snapshot is unavailable' });
}

/**
 * Adapts the stable daemon reload snapshot to target-local observations.  A
 * contributor replacement invalidates the target's view; only replacement of
 * the target itself retires its observation.  In particular, this never binds
 * to occurrenceId-local `retireLiveSubscriptionConsumers`.
 */
export function createReloadControllerTargetedContributionsService(
    host: ReloadControllerTargetedContributionsHost,
): StableTargetedContributionsOwner {
    return Object.freeze({
        bind(
            binding: Parameters<StableTargetedContributionsOwner['bind']>[0],
        ): TargetedContributionsService {
            return createTargetedContributionsService({
                subscribeToCatalogChanges(listener: () => void): () => void {
                    return host.reloadController.subscribe((result) => {
                        if (!result.ok || result.changedPluginIds.length === 0) return;
                        // `retirePluginConsumers` synchronously retires the
                        // target occurrenceId before the controller publishes
                        // this result. The common invalidation path observes
                        // that canonical signal/currentness and disposes.
                        listener();
                    });
                },
                async readAdmittedSnapshot(
                    params: Parameters<
                        TargetedContributionsAdmissionSource['readAdmittedSnapshot']
                    >[0],
                ): Promise<TargetedContributionSnapshot<unknown>> {
                    const lease = await host.reloadController.acquireRuntimeRegistry();
                    try {
                        if (params.signal?.aborted) throw operationAborted();
                        const snapshot = lease.registry.readAdmittedTargetedContributions?.({
                            targetPluginId: params.pluginId,
                            pointId: params.point.id,
                            protocol: params.point.protocol,
                        });
                        if (!snapshot) throw targetedContributionsUnavailable();
                        const readPluginSourceCustody = lease.registry.readPluginSourceCustody;
                        if (!readPluginSourceCustody) throw targetedContributionsUnavailable();
                        return projectAdmittedTargetedContributionSnapshot(
                            params.point,
                            snapshot,
                            readPluginSourceCustody,
                        );
                    } finally {
                        await lease.release();
                    }
                },
            }).bind(binding);
        },
    });
}
