import { isDeepStrictEqual } from 'node:util';

import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    readContributedProviderCatalogParserIds,
    resolveProviderManagedRuntimeDeclarationV1,
    type PluginContributionIdentityV1,
} from '@happier-dev/protocol';

import type {
    ResolvedActivationTarget,
    ResolvedManagedProviderRuntime,
    ResolvedProviderCatalogParsers,
    ResolvedProviderContribution,
} from '@/plugins/projection/registry/types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type { ContributionRuntimeRegistration } from '../../api/registrationRightsHost';

type TargetRegistration = Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}>;

export type ProjectedTargetProviderRuntimes = Readonly<{
    providers: readonly ResolvedProviderContribution[];
    /**
     * Author-actionable refusals, keyed by the plugin that owns the refused
     * registration. A refused Provider contribution projects no managed runtime
     * and no catalog parsers; every other plugin's Provider still projects.
     */
    diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;

function declaredContributedCatalogParserIds(
    definition: ResolvedProviderContribution['definition'],
): readonly string[] {
    return readContributedProviderCatalogParserIds(
        definition as unknown as Readonly<Record<string, unknown>>,
    );
}

/**
 * Joins activation-owned public Provider registrations onto the canonical
 * resolved declaration. Retained registrations remain owned by their retained
 * activation lease and must never alias onto the desired/current declaration.
 *
 * A registration that does not match its own declaration is a defect in exactly
 * one plugin, so it fails that Provider contribution closed with the same
 * `plugin_activation_failed` diagnostic the activation owner uses to isolate a
 * throwing `activate()`. It must never take the whole projection — and with it
 * every correctly-authored Provider — down.
 */
export function projectTargetProviderRuntimes(input: Readonly<{
    providers: readonly ResolvedProviderContribution[];
    activationTargets?: readonly ResolvedActivationTarget[];
    targetRegistrations: readonly TargetRegistration[];
    activationGeneration: string;
    immutableGenerationIdsByPluginId: ReadonlyMap<string, string>;
    isRegistrationCurrent(registration: TargetRegistration): boolean;
}>): ProjectedTargetProviderRuntimes {
    const providersByKey = new Map(input.providers.map((provider) => [
        buildQualifiedPluginContributionKey(provider.identity),
        provider,
    ]));
    const activationTargets = input.activationTargets ?? [];
    const runtimesByKey = new Map<string, ResolvedManagedProviderRuntime>();
    const catalogParsersByKey = new Map<string, ResolvedProviderCatalogParsers>();
    const refusedKeys = new Set<string>();
    const diagnosticsByPluginId: Record<string, readonly PluginCompatibilityDiagnostic[]> = {};

    /**
     * Fails one Provider contribution closed. The key is retired for the whole
     * projection so an earlier-accepted arm of the same contribution — or a
     * duplicate registration — can never leave a half-projected Provider.
     */
    function refuse(
        key: string,
        identity: PluginContributionIdentityV1,
        message: string,
    ): void {
        refusedKeys.add(key);
        const diagnostic: PluginCompatibilityDiagnostic = Object.freeze({
            code: 'plugin_activation_failed',
            message,
            contribution: identity,
        });
        const existing = diagnosticsByPluginId[identity.pluginId] ?? [];
        if (existing.some((entry) => (
            entry.code === diagnostic.code && entry.message === diagnostic.message
        ))) return;
        diagnosticsByPluginId[identity.pluginId] = Object.freeze([...existing, diagnostic]);
    }

    for (const entry of input.targetRegistrations) {
        if (
            entry.generation !== input.activationGeneration
            || entry.registration.family !== 'providers'
        ) {
            continue;
        }
        const identity = createPluginContributionIdentity({
            pluginId: entry.pluginId,
            localId: entry.registration.localId,
        });
        const key = buildQualifiedPluginContributionKey(identity);
        const provider = providersByKey.get(key);
        if (!provider) {
            refuse(key, identity, `Provider runtime registration '${key}' has no matching Provider declaration`);
            continue;
        }
        const targets = activationTargets.filter((target) => (
            target.pluginId === entry.pluginId
        ));
        if (targets.length !== 1) {
            refuse(key, identity, `Provider runtime registration '${key}' has no exact current activation target`);
            continue;
        }
        const target = targets[0]!;
        const targetProvider = target.manifest.contributes.providers.find(
            (candidate) => candidate.id === entry.registration.localId,
        );
        if (!targetProvider) {
            refuse(key, identity, `Provider runtime registration '${key}' has no matching current activation target declaration`);
            continue;
        }
        const immutableGenerationId = input.immutableGenerationIdsByPluginId.get(entry.pluginId);
        if (!immutableGenerationId) {
            refuse(key, identity, `Provider runtime registration '${key}' has no immutable generation identity`);
            continue;
        }
        const registered = entry.registration.value;

        if (registered.managedRuntime !== undefined) {
            if (provider.definition.managedRuntime?.kind !== 'managed') {
                refuse(key, identity, `Managed Provider runtime registration '${key}' has no matching managed declaration`);
                continue;
            }
            if (targetProvider.managedRuntime?.kind !== 'managed') {
                refuse(key, identity, `Managed Provider runtime registration '${key}' has no matching current activation target declaration`);
                continue;
            }
            const declaration = resolveProviderManagedRuntimeDeclarationV1({
                implementationIdentity: provider.identity,
                managedRuntime: provider.definition.managedRuntime,
            });
            const targetDeclaration = resolveProviderManagedRuntimeDeclarationV1({
                implementationIdentity: provider.identity,
                managedRuntime: targetProvider.managedRuntime,
            });
            if (!isDeepStrictEqual(declaration, targetDeclaration)) {
                refuse(key, identity, `Managed Provider runtime registration '${key}' does not match the current activation target declaration`);
                continue;
            }
            if (runtimesByKey.has(key)) {
                refuse(key, identity, `Duplicate managed Provider runtime registration '${key}'`);
                continue;
            }
            runtimesByKey.set(key, Object.freeze({
                runtime: registered.managedRuntime,
                activationGeneration: entry.generation,
                immutableGenerationId,
                isCurrent: () => input.isRegistrationCurrent(entry),
            }));
        }

        const registeredFormats = Object.keys(registered.catalogParsers ?? {}).sort();
        if (registeredFormats.length > 0) {
            const declaredFormats = declaredContributedCatalogParserIds(provider.definition);
            const targetFormats = declaredContributedCatalogParserIds(
                targetProvider as unknown as ResolvedProviderContribution['definition'],
            );
            if (!isDeepStrictEqual(declaredFormats, targetFormats)) {
                refuse(key, identity, `Provider catalog format registration '${key}' does not match the current activation target declaration`);
                continue;
            }
            if (!isDeepStrictEqual(registeredFormats, [...declaredFormats])) {
                refuse(
                    key,
                    identity,
                    `Provider catalog format registration '${key}' does not implement its declared catalog formats: `
                    + `declared [${declaredFormats.join(', ')}], registered [${registeredFormats.join(', ')}]`,
                );
                continue;
            }
            if (catalogParsersByKey.has(key)) {
                refuse(key, identity, `Duplicate Provider catalog format registration '${key}'`);
                continue;
            }
            catalogParsersByKey.set(key, Object.freeze({
                parsersByFormat: registered.catalogParsers!,
                activationGeneration: entry.generation,
                immutableGenerationId,
                isCurrent: () => input.isRegistrationCurrent(entry),
            }));
        }
    }

    for (const key of refusedKeys) {
        runtimesByKey.delete(key);
        catalogParsersByKey.delete(key);
    }

    const diagnostics = Object.freeze({ ...diagnosticsByPluginId });
    if (runtimesByKey.size === 0 && catalogParsersByKey.size === 0) {
        return Object.freeze({ providers: input.providers, diagnosticsByPluginId: diagnostics });
    }

    return Object.freeze({
        providers: Object.freeze(input.providers.map((provider) => {
            const key = buildQualifiedPluginContributionKey(provider.identity);
            const managedRuntime = runtimesByKey.get(key);
            const catalogParsers = catalogParsersByKey.get(key);
            if (!managedRuntime && !catalogParsers) return provider;
            return Object.freeze({
                ...provider,
                ...(managedRuntime ? { managedRuntime } : {}),
                ...(catalogParsers ? { catalogParsers } : {}),
            });
        })),
        diagnosticsByPluginId: diagnostics,
    });
}
