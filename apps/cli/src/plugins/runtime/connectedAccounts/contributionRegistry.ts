import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedAccountRuntime as PluginConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';

import type { ResolvedConnectedAccountDescriptorContribution } from '@/plugins/projection/registry/types';
import type { PluginRuntimeOccurrenceId } from '../runtimeSlots';
import type { PluginSourceCustody } from '../sourceAuthority';

export type ConnectedAccountRuntimeRegistration = Readonly<{
    pluginId: string;
    occurrenceId: string;
    localId: string;
    runtime: PluginConnectedAccountRuntime;
}>;

/**
 * The cold projection of one admitted connected-account contribution: everything a
 * descriptor, configuration, or currentness read needs, and nothing that requires the
 * plugin's executable code. `isCurrent` fences the exact process-local occurrence.
 */
export type ConnectedAccountContributionRegistryEntry = Readonly<{
    ref: PluginContributionRef;
    descriptor: ResolvedConnectedAccountDescriptorContribution['definition'];
    occurrenceId: PluginRuntimeOccurrenceId;
    sourceCustody: PluginSourceCustody;
    isCurrent(): boolean;
}>;

export type ConnectedAccountRuntimeLease = Readonly<{
    ref: PluginContributionRef;
    occurrenceId: PluginRuntimeOccurrenceId;
    sourceCustody: PluginSourceCustody;
    descriptor: ResolvedConnectedAccountDescriptorContribution['definition'];
    runtime: PluginConnectedAccountRuntime;
    isCurrent(): boolean;
}>;

export class ConnectedAccountRuntimeInvocationNotStartedError extends Error {
    readonly code = 'connected_account_runtime_generation_changed';

    constructor() {
        super(
            'Connected-account runtime occurrence is no longer current before provider entry',
        );
        this.name = 'ConnectedAccountRuntimeInvocationNotStartedError';
    }
}

function qualifiedKey(ref: PluginContributionRef): string {
    return buildQualifiedPluginContributionKey(createPluginContributionIdentity(ref));
}

function snapshotQualifiedRef(ref: PluginContributionRef): PluginContributionRef {
    const identity = createPluginContributionIdentity(ref);
    return Object.freeze({ pluginId: identity.pluginId, localId: identity.localId });
}

function snapshotDescriptor(
    contribution: ResolvedConnectedAccountDescriptorContribution,
): ResolvedConnectedAccountDescriptorContribution['definition'] {
    const parsed = PluginConnectedAccountDescriptorContributionV2Schema.parse(contribution.definition);
    const pending: object[] = [parsed];
    while (pending.length > 0) {
        const current = pending.pop()!;
        for (const value of Object.values(current)) {
            if (value !== null && typeof value === 'object') pending.push(value);
        }
        Object.freeze(current);
    }
    return parsed;
}

export function createConnectedAccountContributionRegistry(params: Readonly<{
    descriptors: readonly ResolvedConnectedAccountDescriptorContribution[];
    activateOnDemand(ref: PluginContributionRef): Promise<void>;
    readRegistrations(): readonly ConnectedAccountRuntimeRegistration[];
    readPluginOccurrenceId(pluginId: string): PluginRuntimeOccurrenceId | null;
    readPluginSourceCustody(pluginId: string): PluginSourceCustody | null;
    isPluginOccurrenceCurrent(pluginId: string, occurrenceId: PluginRuntimeOccurrenceId): boolean;
    /**
     * Reports a descriptor this generation could not admit, so the host can tell
     * the operator which plugin lost its Connected Accounts. The registry itself
     * owns no logging channel.
     */
    onDescriptorUnavailable?(ref: PluginContributionRef, error?: Error): void;
}>): Readonly<{
    list(): readonly ConnectedAccountContributionRegistryEntry[];
    /**
     * Cold lookup of one declared contribution. Answers descriptor, runtime identity
     * and currentness without activating the owning plugin, so Settings, discovery and
     * offline inspection do not boot executable plugin code. Returns `null` for a service
     * this generation does not declare or could not admit — the same caller-visible fact
     * `resolve` reports for those cases.
     */
    describe(ref: PluginContributionRef): ConnectedAccountContributionRegistryEntry | null;
    /**
     * Resolves the qualified service's runtime lease for this registry generation.
     *
     * Returns `null` when the service is not resolvable here — no declared
     * descriptor, a descriptor quarantined because its plugin has no admitted
     * runtime identity, or an owning plugin that did not publish its runtime
     * after on-demand activation. All are the same caller-visible fact: this
     * generation has no usable runtime for the service.
     *
     * Throws `ConnectedAccountRuntimeInvocationNotStartedError` when the
     * occurrence is retired or disposed. That is a currentness fact, not
     * unavailability: the caller must reload rather than conclude the service
     * does not exist. Genuine faults (activation failure, duplicate
     * registration, descriptor/runtime mismatch) keep throwing as themselves.
     */
    resolve(ref: PluginContributionRef): Promise<ConnectedAccountRuntimeLease | null>;
    dispose(): void;
}> {
    const descriptorsByKey = new Map<string, Readonly<{
        ref: PluginContributionRef;
        descriptor: ResolvedConnectedAccountDescriptorContribution['definition'];
        occurrenceId: PluginRuntimeOccurrenceId;
        sourceCustody: PluginSourceCustody;
    }>>();
    const duplicateKeys = new Set<string>();
    for (const contribution of params.descriptors) {
        const pluginId = contribution.pluginId?.trim();
        if (!pluginId) throw new TypeError('Connected-account descriptors require a plugin-qualified owner');
        const descriptor = snapshotDescriptor(contribution);
        const ref = Object.freeze({ pluginId, localId: descriptor.id });
        const occurrenceId = params.readPluginOccurrenceId(pluginId);
        const sourceCustody = params.readPluginSourceCustody(pluginId);
        if (!occurrenceId || !sourceCustody) {
            // One plugin whose runtime identity the host could not admit must not deny
            // every other plugin its Connected Accounts. Omitting the descriptor
            // is strictly more closed than admitting it without a verified
            // identity: `resolve` reports this service as unresolvable and the
            // per-invocation identity fence downstream is unchanged.
            params.onDescriptorUnavailable?.(ref);
            continue;
        }
        const key = qualifiedKey(ref);
        if (duplicateKeys.has(key)) continue;
        if (descriptorsByKey.has(key)) {
            // Neither duplicate is authoritative. Keeping the first would still
            // publish one arbitrarily selected descriptor for an ambiguous
            // qualified service; isolate only that service and keep unrelated
            // contributions available through the existing diagnostic owner.
            descriptorsByKey.delete(key);
            duplicateKeys.add(key);
            params.onDescriptorUnavailable?.(
                ref,
                new Error(`Duplicate connected-account descriptor '${key}'`),
            );
            continue;
        }
        descriptorsByKey.set(key, Object.freeze({
            ref,
            descriptor,
            occurrenceId,
            sourceCustody,
        }));
    }
    let disposed = false;

    function isCurrentOccurrence(pluginId: string, occurrenceId: PluginRuntimeOccurrenceId): boolean {
        return !disposed && params.isPluginOccurrenceCurrent(pluginId, occurrenceId);
    }

    function readRegistration(ref: PluginContributionRef): ConnectedAccountRuntimeRegistration | null {
        // Registration-scope commit already validated this runtime against the
        // canonical descriptor declaration before the target became current.
        const matches = params.readRegistrations().filter((registration) => (
            registration.pluginId === ref.pluginId
            && registration.localId === ref.localId
            && registration.occurrenceId === params.readPluginOccurrenceId(ref.pluginId)
        ));
        if (matches.length > 1) {
            throw new Error(`Duplicate current-generation registration '${qualifiedKey(ref)}'`);
        }
        return matches[0] ?? null;
    }

    function coldEntry(declared: Readonly<{
        ref: PluginContributionRef;
        descriptor: ResolvedConnectedAccountDescriptorContribution['definition'];
        occurrenceId: PluginRuntimeOccurrenceId;
        sourceCustody: PluginSourceCustody;
    }>): ConnectedAccountContributionRegistryEntry {
        return Object.freeze({
            ref: declared.ref,
            descriptor: declared.descriptor,
            occurrenceId: declared.occurrenceId,
            sourceCustody: declared.sourceCustody,
            isCurrent: () => isCurrentOccurrence(declared.ref.pluginId, declared.occurrenceId),
        });
    }

    return Object.freeze({
        list() {
            return Object.freeze([...descriptorsByKey.values()].map(coldEntry));
        },
        describe(ref) {
            const declared = descriptorsByKey.get(qualifiedKey(snapshotQualifiedRef(ref)));
            return declared ? coldEntry(declared) : null;
        },
        async resolve(ref) {
            const qualifiedRef = snapshotQualifiedRef(ref);
            const declared = descriptorsByKey.get(qualifiedKey(qualifiedRef));
            if (!declared) return null;
            if (!isCurrentOccurrence(qualifiedRef.pluginId, declared.occurrenceId)) {
                throw new ConnectedAccountRuntimeInvocationNotStartedError();
            }
            let registration = readRegistration(qualifiedRef);
            if (!registration) {
                await params.activateOnDemand(qualifiedRef);
                if (!isCurrentOccurrence(qualifiedRef.pluginId, declared.occurrenceId)) {
                    throw new ConnectedAccountRuntimeInvocationNotStartedError();
                }
                registration = readRegistration(qualifiedRef);
            }
            if (!registration) return null;
            return Object.freeze({
                ref: declared.ref,
                occurrenceId: declared.occurrenceId,
                sourceCustody: declared.sourceCustody,
                descriptor: declared.descriptor,
                runtime: registration.runtime,
                isCurrent: () => isCurrentOccurrence(qualifiedRef.pluginId, declared.occurrenceId),
            });
        },
        dispose() { disposed = true; },
    });
}
