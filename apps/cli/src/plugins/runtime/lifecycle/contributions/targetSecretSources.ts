import type { CanonicalPluginManifestContributes } from '../../../manifest/types';
import type { PluginInvocationContext, PluginSecretSourceAcquisitionV1, PluginSecretSourceRuntimeV1,
    PluginSecretSourceFailureV1, PluginSecretSourceListRequestV1, PluginSecretSourceListResultV1,
    PluginSecretSourceStoreRequestV1, PluginSecretSourceStoreResultV1 } from '@happier-dev/plugin-sdk';
import { PluginSecretSourceListResultV1Schema, PluginSecretSourceStoreResultV1Schema,
    type PluginSecretSourceContributionV1 } from '@happier-dev/protocol/plugins/contributions/public-types';
import type { PluginRuntimeRegistration } from '@happier-dev/cli-common/plugins/registration';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginRuntimeOccurrenceId } from '../../runtimeSlots';

export type SecretSourceLocatorV1 = Readonly<{
    contribution: PluginContributionIdentityV1;
    account: string;
    reference: string;
}>;

export type TargetSecretSourcesV1 = Readonly<{
    list(): readonly Readonly<{ contribution: PluginContributionIdentityV1; title: string;
        capabilities?: PluginSecretSourceContributionV1['capabilities'] }>[];
    acquire(source: SecretSourceLocatorV1, options?: Readonly<{ signal?: AbortSignal }>): Promise<PluginSecretSourceAcquisitionV1>;
    listFields(contribution: PluginContributionIdentityV1, input: PluginSecretSourceListRequestV1,
        options?: Readonly<{ signal?: AbortSignal }>): Promise<PluginSecretSourceListResultV1>;
    store(contribution: PluginContributionIdentityV1, input: PluginSecretSourceStoreRequestV1,
        options?: Readonly<{ signal?: AbortSignal }>): Promise<PluginSecretSourceStoreResultV1>;
}>;

/** Executable projection of the existing manifest/activation registration owner. */
export function createTargetSecretSources(params: Readonly<{
    targets: readonly Readonly<{
        pluginId: string;
        manifest: Readonly<{ contributes: Pick<CanonicalPluginManifestContributes, 'secretSources'> }>;
    }>[];
    registry: Readonly<{
        activateContributionsOnDemand(demands: readonly Readonly<{ pluginId: string; family: 'secretSources'; localId: string }>[]): Promise<unknown>;
        readonly targetRegistrations: readonly Readonly<{ pluginId: string; occurrenceId: PluginRuntimeOccurrenceId; registration: PluginRuntimeRegistration }>[];
        isPluginOccurrenceCurrent(pluginId: string, occurrenceId: PluginRuntimeOccurrenceId): boolean;
    }>;
    createInvocationContext(reference: PluginContributionIdentityV1, occurrenceId: PluginRuntimeOccurrenceId, signal?: AbortSignal): Readonly<{
        context: PluginInvocationContext;
        complete(): void;
    }>;
}>): TargetSecretSourcesV1 {
    async function invoke<Result>(ref: PluginContributionIdentityV1, signal: AbortSignal | undefined,
        run: (runtime: PluginSecretSourceRuntimeV1, context: PluginInvocationContext) => Promise<Result>,
        retryable: boolean): Promise<Result | PluginSecretSourceFailureV1> {
        if (signal?.aborted) return { ok: false, code: 'cancelled' };
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
            const invocation = params.createInvocationContext(ref, entry.occurrenceId, signal);
            try {
                const runtime = entry.registration.value as PluginSecretSourceRuntimeV1;
                return await run(runtime, invocation.context);
            } finally {
                invocation.complete();
            }
        } catch {
            // Native/plugin errors may contain secret output; only closed reasons escape.
            return signal?.aborted
                ? { ok: false, code: 'cancelled' }
                : { ok: false, code: 'acquisition_failed', ...(retryable ? { repair: 'retry' as const } : {}) };
        }
    }
    return Object.freeze({
        list() {
            return params.targets.flatMap(target => (target.manifest.contributes.secretSources ?? []).map(declaration => ({
                contribution: { pluginId: target.pluginId, localId: declaration.id }, title: declaration.title,
                ...(declaration.capabilities ? { capabilities: declaration.capabilities } : {}),
            })));
        },
        acquire(source, options) {
            return invoke(source.contribution, options?.signal,
                (runtime, context) => runtime.acquire({ account: source.account, reference: source.reference }, context), true);
        },
        listFields(contribution, input, options) {
            return invoke(contribution, options?.signal,
                async (runtime, context): Promise<PluginSecretSourceListResultV1> => runtime.list
                    ? PluginSecretSourceListResultV1Schema.parse(await runtime.list(input, context)) : { ok: false, code: 'unsupported' }, true);
        },
        store(contribution, input, options) {
            return invoke(contribution, options?.signal,
                async (runtime, context): Promise<PluginSecretSourceStoreResultV1> => runtime.store
                    ? PluginSecretSourceStoreResultV1Schema.parse(await runtime.store(input, context)) : { ok: false, code: 'unsupported' }, false);
        },
    });
}
