import type { PluginInvocationContext, PluginSecretSourceAcquisitionV1, PluginSecretSourceRuntimeV1 } from '@happier-dev/plugin-sdk';
import type { PluginRuntimeRegistration } from '@happier-dev/cli-common/plugins/registration';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginRuntimeOccurrenceId } from '../../runtimeSlots';

export type SecretSourceLocatorV1 = Readonly<{
    contribution: PluginContributionIdentityV1;
    account: string;
    reference: string;
}>;

export type TargetSecretSourcesV1 = Readonly<{
    list(): readonly Readonly<{ contribution: PluginContributionIdentityV1; title: string }>[];
    acquire(source: SecretSourceLocatorV1, options?: Readonly<{ signal?: AbortSignal }>): Promise<PluginSecretSourceAcquisitionV1>;
}>;

/** Executable projection of the existing manifest/activation registration owner. */
export function createTargetSecretSources(params: Readonly<{
    targets: readonly Readonly<{
        pluginId: string;
        manifest: Readonly<{ contributes: Readonly<{ secretSources?: readonly Readonly<{ id: string; title: string }>[] }> }>;
    }>[];
    registry: Readonly<{
        activateContributionsOnDemand(demands: readonly Readonly<{ pluginId: string; family: 'secretSources'; localId: string }>[]): Promise<void>;
        readonly targetRegistrations: readonly Readonly<{ pluginId: string; occurrenceId: PluginRuntimeOccurrenceId; registration: PluginRuntimeRegistration }>[];
        isPluginOccurrenceCurrent(pluginId: string, occurrenceId: PluginRuntimeOccurrenceId): boolean;
    }>;
    createInvocationContext(reference: PluginContributionIdentityV1, occurrenceId: PluginRuntimeOccurrenceId, signal?: AbortSignal): Readonly<{
        context: PluginInvocationContext;
        complete(): void;
    }>;
}>): TargetSecretSourcesV1 {
    return Object.freeze({
        list() {
            return params.targets.flatMap(target => (target.manifest.contributes.secretSources ?? []).map(declaration => ({
                contribution: { pluginId: target.pluginId, localId: declaration.id }, title: declaration.title,
            })));
        },
        async acquire(source, options) {
            if (options?.signal?.aborted) return { ok: false, code: 'cancelled' };
            const ref = source.contribution;
            if (!params.targets.some(target => target.pluginId === ref.pluginId
                && target.manifest.contributes.secretSources?.some(declaration => declaration.id === ref.localId))) {
                return { ok: false, code: 'source_unavailable', repair: 'configure' };
            }
            try {
                await params.registry.activateContributionsOnDemand([{ ...ref, family: 'secretSources' }]);
                const entry = params.registry.targetRegistrations.find(candidate => candidate.pluginId === ref.pluginId
                    && candidate.registration.family === 'secretSources' && candidate.registration.localId === ref.localId);
                if (!entry || !params.registry.isPluginOccurrenceCurrent(ref.pluginId, entry.occurrenceId)) {
                    return { ok: false, code: 'source_unavailable', repair: 'configure' };
                }
                const invocation = params.createInvocationContext(ref, entry.occurrenceId, options?.signal);
                try {
                    const runtime = entry.registration.value as PluginSecretSourceRuntimeV1;
                    return await runtime.acquire({ account: source.account, reference: source.reference }, invocation.context);
                } finally {
                    invocation.complete();
                }
            } catch {
                // Native/plugin errors may contain secret output; only closed reasons escape.
                return options?.signal?.aborted
                    ? { ok: false, code: 'cancelled' }
                    : { ok: false, code: 'acquisition_failed', repair: 'retry' };
            }
        },
    });
}
