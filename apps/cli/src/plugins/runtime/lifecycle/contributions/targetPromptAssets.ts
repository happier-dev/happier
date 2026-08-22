import { isDeepStrictEqual } from 'node:util';

import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginContributionIdentity } from '@happier-dev/protocol';
import type {
    PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type {
    PromptAssetAdapter,
} from '@happier-dev/plugin-sdk/resources';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';

type TargetRegistration = Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}>;

type PromptAssetTypeDescriptor = PromptAssetAdapter['descriptor'];

type PromptAssetAdapterDeclaration = Readonly<{
    pluginId: string;
    localId: string;
    adapterDescriptor?: PromptAssetTypeDescriptor;
}>;

type GenerationLifecycle = Readonly<{
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
}>;

function staleGenerationError(pluginId: string): PluginError {
    return new PluginError({
        code: 'plugin_generation_stale',
        message: `Plugin '${pluginId}' Prompt Asset adapter is no longer active`,
    });
}

function wrapPromptAssetAdapter(params: Readonly<{
    pluginId: string;
    adapter: PromptAssetAdapter;
    resolveGenerationLifecycle(): GenerationLifecycle;
}>): PromptAssetAdapter {
    async function invoke<TResult>(
        operation: (options: PluginCancellationOptions) => Promise<TResult>,
        options?: PluginCancellationOptions,
    ): Promise<TResult> {
        const lifecycle = params.resolveGenerationLifecycle();
        if (!lifecycle.isCurrent()) throw staleGenerationError(params.pluginId);
        const signal = options?.signal
            ? AbortSignal.any([options.signal, lifecycle.retirementSignal])
            : lifecycle.retirementSignal;
        signal.throwIfAborted();
        try {
            const result = await operation(Object.freeze({ ...options, signal }));
            signal.throwIfAborted();
            if (!lifecycle.isCurrent()) throw staleGenerationError(params.pluginId);
            return result;
        } catch (error) {
            if (signal.aborted) signal.throwIfAborted();
            if (!lifecycle.isCurrent()) throw staleGenerationError(params.pluginId);
            throw error;
        }
    }

    const wrapped: PromptAssetAdapter = {
        descriptor: params.adapter.descriptor,
        discover: (request, options) => invoke(
            (scopedOptions) => params.adapter.discover(request, scopedOptions),
            options,
        ),
        read: (request, options) => invoke(
            (scopedOptions) => params.adapter.read(request, scopedOptions),
            options,
        ),
        writeDoc: (request, options) => invoke(
            (scopedOptions) => params.adapter.writeDoc(request, scopedOptions),
            options,
        ),
        writeBundle: (request, options) => invoke(
            (scopedOptions) => params.adapter.writeBundle(request, scopedOptions),
            options,
        ),
        delete: (request, options) => invoke(
            (scopedOptions) => params.adapter.delete(request, scopedOptions),
            options,
        ),
    };
    return Object.freeze(wrapped);
}

export type TargetPromptAssetAdapterRegistry = Readonly<{
    adapters: ReadonlyMap<string, PromptAssetAdapter>;
    /**
     * Author-actionable refusals, keyed by the plugin that owns the refused
     * registration. Every correctly-authored adapter still projects.
     */
    diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;

/**
 * Joins activation-owned Prompt Asset adapters onto their manifest declarations.
 *
 * A registration that drifts from its own declaration — or a type id two plugins
 * both claim — is a defect in exactly one plugin (or an unresolvable tie between
 * two), so it fails that adapter closed with the same `plugin_activation_failed`
 * diagnostic the activation owner uses to isolate a throwing `activate()`. It
 * must never take every other plugin's Prompt Asset adapter down with it.
 */
export function createTargetPromptAssetAdapterRegistry(params: Readonly<{
    generation: number;
    promptAssets: readonly PromptAssetAdapterDeclaration[];
    targetRegistrations: readonly TargetRegistration[];
    resolveGenerationLifecycle(pluginId: string): GenerationLifecycle;
}>): TargetPromptAssetAdapterRegistry {
    const adapters = new Map<string, PromptAssetAdapter>();
    const claimantPluginIdsByAssetTypeId = new Map<string, string>();
    const refusedAssetTypeIds = new Set<string>();
    const diagnosticsByPluginId: Record<string, readonly PluginCompatibilityDiagnostic[]> = {};

    function refuse(pluginId: string, localId: string, message: string): void {
        const diagnostic: PluginCompatibilityDiagnostic = Object.freeze({
            code: 'plugin_activation_failed',
            message,
            contribution: createPluginContributionIdentity({ pluginId, localId }),
        });
        const existing = diagnosticsByPluginId[pluginId] ?? [];
        if (existing.some((entry) => (
            entry.code === diagnostic.code && entry.message === diagnostic.message
        ))) return;
        diagnosticsByPluginId[pluginId] = Object.freeze([...existing, diagnostic]);
    }

    for (const entry of params.targetRegistrations) {
        if (entry.registration.family !== 'promptAssets') continue;
        const localId = entry.registration.localId;
        if (entry.generation !== String(params.generation)) {
            refuse(
                entry.pluginId,
                localId,
                `Target Prompt Asset adapter '${entry.pluginId}/${localId}' was published for the wrong generation`,
            );
            continue;
        }
        const declarations = params.promptAssets.filter((candidate) => (
            candidate.pluginId === entry.pluginId
            && candidate.localId === localId
            && candidate.adapterDescriptor !== undefined
        ));
        if (declarations.length !== 1) {
            refuse(
                entry.pluginId,
                localId,
                `Target Prompt Asset adapter '${entry.pluginId}/${localId}' has no unique matching manifest contribution`,
            );
            continue;
        }
        const declaration = declarations[0]!;
        const adapter = entry.registration.value;
        if (!isDeepStrictEqual(declaration.adapterDescriptor, adapter.descriptor)) {
            refuse(
                entry.pluginId,
                localId,
                `Target Prompt Asset adapter '${entry.pluginId}/${localId}' descriptor mismatch: `
                + `declared type '${declaration.adapterDescriptor?.id ?? '<none>'}', `
                + `registered type '${adapter.descriptor.id}'`,
            );
            continue;
        }
        const assetTypeId = adapter.descriptor.id;
        const claimant = claimantPluginIdsByAssetTypeId.get(assetTypeId);
        if (claimant !== undefined) {
            // Two plugins claiming one Prompt Asset type is an unresolvable tie:
            // keeping whichever registered first would make the winner depend on
            // activation order, so the type fails closed for both claimants.
            const message = `Duplicate Prompt Asset adapter type '${assetTypeId}'`;
            refuse(entry.pluginId, localId, message);
            refuse(claimant, localId, message);
            refusedAssetTypeIds.add(assetTypeId);
            continue;
        }
        claimantPluginIdsByAssetTypeId.set(assetTypeId, entry.pluginId);
        adapters.set(assetTypeId, wrapPromptAssetAdapter({
            pluginId: entry.pluginId,
            adapter,
            resolveGenerationLifecycle: () => params.resolveGenerationLifecycle(entry.pluginId),
        }));
    }

    for (const assetTypeId of refusedAssetTypeIds) adapters.delete(assetTypeId);

    return Object.freeze({
        adapters,
        diagnosticsByPluginId: Object.freeze({ ...diagnosticsByPluginId }),
    });
}
