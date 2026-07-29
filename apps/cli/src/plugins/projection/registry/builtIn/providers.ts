import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    ProviderManagedDeploymentSecurityFactsV1Schema,
} from '@happier-dev/protocol';

import type {
    ManagedProviderRuntimeAdapterV1,
    ResolvedFirstPartyManagedProviderFacet,
} from '@/providers/managed/types';
import type { ResolvedProviderContribution } from '../types';

export type BundledProviderImplementationBinding = Readonly<{
    identity: Readonly<{ pluginId: string; localId: string }>;
    implementationOwnerId: string;
    registrationFamily: string;
    implementation: unknown;
    runtimeAdapter?: unknown;
}>;

function readManagedProviderFacet(
    binding: BundledProviderImplementationBinding,
): ResolvedFirstPartyManagedProviderFacet {
    const implementation = binding.implementation;
    const parsed = ProviderManagedDeploymentSecurityFactsV1Schema.safeParse(
        implementation && typeof implementation === 'object' && !Array.isArray(implementation)
            ? {
                ...implementation,
                implementationIdentity: binding.identity,
            }
            : implementation,
    );
    if (!parsed.success) {
        throw new Error(
            `Invalid bundled managed Provider implementation '${buildQualifiedPluginContributionKey(binding.identity)}'`,
        );
    }
    return Object.freeze({
        managedEndpoint: Object.freeze({
            localService: Object.freeze(parsed.data.managedEndpoint.localService),
            protocols: [...parsed.data.managedEndpoint.protocols],
        }),
        connectedAccounts: Object.freeze(parsed.data.connectedAccounts.map((declaration) => Object.freeze({
            ...declaration,
            service: Object.freeze(createPluginContributionIdentity(
                typeof declaration.service === 'string'
                    ? {
                        pluginId: binding.identity.pluginId,
                        localId: declaration.service,
                    }
                    : declaration.service,
            )),
        }))),
        requestAuthUses: Object.freeze(parsed.data.requestAuthUses.map((use) => Object.freeze({
            purpose: use.purpose,
            materialization: Object.freeze({
                ...use.materialization,
                headerNames: Object.freeze([...use.materialization.headerNames]),
            }),
        }))),
    });
}

function readManagedProviderRuntimeAdapter(
    binding: BundledProviderImplementationBinding,
): ManagedProviderRuntimeAdapterV1 {
    const value = binding.runtimeAdapter;
    const requiredKeys = [
        'v',
        'catalogSource',
        'prepare',
        'resolveAgentEndpoint',
    ] as const;
    const recoveryKeys = ['inspectRecovery', 'verifyRecoveryHealth'] as const;
    const allowedKeys = new Set<string>([...requiredKeys, ...recoveryKeys]);
    if (
        !value
        || typeof value !== 'object'
        || Array.isArray(value)
    ) {
        throw new Error(
            `Invalid bundled managed Provider runtime adapter '${buildQualifiedPluginContributionKey(binding.identity)}'`,
        );
    }
    const ownKeys = Reflect.ownKeys(value);
    const hasInspectRecovery = Object.hasOwn(value, 'inspectRecovery');
    const hasVerifyRecoveryHealth = Object.hasOwn(value, 'verifyRecoveryHealth');
    if (
        ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))
        || requiredKeys.some((key) => !Object.hasOwn(value, key))
        || hasInspectRecovery !== hasVerifyRecoveryHealth
        || ownKeys.length !== requiredKeys.length
            + (hasInspectRecovery ? recoveryKeys.length : 0)
    ) {
        throw new Error(
            `Invalid bundled managed Provider runtime adapter '${buildQualifiedPluginContributionKey(binding.identity)}'`,
        );
    }
    const adapter = value as Record<string, unknown>;
    const catalogSource = adapter.catalogSource;
    const catalogSourceRecord = catalogSource && typeof catalogSource === 'object'
        ? catalogSource as Record<string, unknown>
        : null;
    if (
        adapter.v !== 1
        || !catalogSourceRecord
        || Array.isArray(catalogSource)
        || Reflect.ownKeys(catalogSourceRecord).length !== 3
        || catalogSourceRecord.kind !== 'transientModelEndpoint'
        || typeof catalogSourceRecord.contractVersion !== 'string'
        || catalogSourceRecord.contractVersion === ''
        || catalogSourceRecord.contractVersion !== catalogSourceRecord.contractVersion.trim()
        || typeof catalogSourceRecord.sdkVersion !== 'string'
        || catalogSourceRecord.sdkVersion === ''
        || catalogSourceRecord.sdkVersion !== catalogSourceRecord.sdkVersion.trim()
        || typeof adapter.prepare !== 'function'
        || (
            hasInspectRecovery
            && (
                typeof adapter.inspectRecovery !== 'function'
                || typeof adapter.verifyRecoveryHealth !== 'function'
            )
        )
        || typeof adapter.resolveAgentEndpoint !== 'function'
    ) {
        throw new Error(
            `Invalid bundled managed Provider runtime adapter '${buildQualifiedPluginContributionKey(binding.identity)}'`,
        );
    }
    return value as ManagedProviderRuntimeAdapterV1;
}

export function projectBuiltInProviders(params: Readonly<{
    manifestProviders: readonly ResolvedProviderContribution[];
    implementationBindings: readonly BundledProviderImplementationBinding[];
}>): readonly ResolvedProviderContribution[] {
    const manifestByIdentity = new Map<string, ResolvedProviderContribution>();
    for (const provider of params.manifestProviders) {
        const key = buildQualifiedPluginContributionKey(provider.identity);
        if (manifestByIdentity.has(key)) {
            throw new Error(`Duplicate bundled manifest Provider '${key}'`);
        }
        manifestByIdentity.set(key, provider);
    }

    const managedByIdentity = new Map<string, Readonly<{
        facet: ResolvedFirstPartyManagedProviderFacet;
        runtimeAdapter: ManagedProviderRuntimeAdapterV1;
    }>>();
    for (const binding of params.implementationBindings) {
        if (binding.registrationFamily !== 'providers') continue;
        const key = buildQualifiedPluginContributionKey(binding.identity);
        const provider = manifestByIdentity.get(key);
        if (!provider) {
            throw new Error(`Missing bundled manifest Provider '${key}'`);
        }
        if (provider.provenance !== 'first_party' || provider.source.kind !== 'bundled') {
            throw new Error(`Managed implementation binding requires a first-party bundled Provider '${key}'`);
        }
        if (binding.implementationOwnerId !== key) {
            throw new Error(`Managed implementation binding owner mismatch for Provider '${key}'`);
        }
        if (managedByIdentity.has(key)) {
            throw new Error(`Duplicate bundled managed Provider implementation '${key}'`);
        }
        managedByIdentity.set(key, Object.freeze({
            facet: readManagedProviderFacet(binding),
            runtimeAdapter: readManagedProviderRuntimeAdapter(binding),
        }));
    }

    return Object.freeze(params.manifestProviders.map((provider) => {
        const key = buildQualifiedPluginContributionKey(provider.identity);
        const managedImplementation = managedByIdentity.get(key);
        if (!managedImplementation) return provider;
        if (provider.provenance !== 'first_party' || provider.source.kind !== 'bundled') {
            throw new Error(`Managed implementation binding requires a first-party bundled Provider '${key}'`);
        }
        return Object.freeze({
            ...provider,
            managed: managedImplementation.facet,
            managedRuntimeAdapter: managedImplementation.runtimeAdapter,
        });
    }));
}
