import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ConnectedAccountServiceIdentityV1Schema, type ConnectedAccountSourceCustodyV1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { ConnectedAccountPortableRuntime, ConnectedAccountRuntime as PluginConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';

import type { ResolvedConnectedAccountDescriptorContribution } from '@/plugins/projection/registry/types';
import { createPluginRuntimeOccurrenceId, type PluginRuntimeOccurrenceId } from '../runtimeSlots';
import type { PluginSourceCustody } from '../sourceAuthority';
import type { HostConnectedAccountRuntime } from './hostRuntime';
import type { CredentialedConnectedAccountAuthenticationRuntime } from './authenticationHost';

export type ConnectedAccountRuntimeRegistration = Readonly<{
    pluginId: string;
    occurrenceId: string;
    localId: string;
}> & (Readonly<{ realm?: 'daemon'; runtime: PluginConnectedAccountRuntime }>
    | Readonly<{ realm: 'account'; runtime: ConnectedAccountPortableRuntime }>);

/**
 * The cold projection of one admitted connected-account contribution: everything a
 * descriptor, configuration, or currentness read needs, and nothing that requires the
 * plugin's executable code. `isCurrent` fences the exact process-local occurrence.
 */
export type ConnectedAccountContributionRegistryEntry = Readonly<{
    ref: PluginContributionRef;
    descriptor: ResolvedConnectedAccountDescriptorContribution['definition'];
    occurrenceId: PluginRuntimeOccurrenceId;
    sourceCustody: ConnectedAccountSourceCustodyV1;
    isCurrent(): boolean;
}>;

export type ConnectedAccountPluginRuntimeLease = Readonly<{
    owner?: 'plugin';
    realm?: 'daemon';
    ref: PluginContributionRef;
    occurrenceId: PluginRuntimeOccurrenceId;
    sourceCustody: PluginSourceCustody;
    descriptor: ResolvedConnectedAccountDescriptorContribution['definition'];
    runtime: PluginConnectedAccountRuntime;
    isCurrent(): boolean;
}>;

export type ConnectedAccountHostRuntimeLease = Readonly<{
    owner: 'host';
    ref: PluginContributionRef;
    occurrenceId: PluginRuntimeOccurrenceId;
    sourceCustody: Readonly<{ kind: 'host' }>;
    descriptor: ResolvedConnectedAccountDescriptorContribution['definition'];
    runtime: HostConnectedAccountRuntime;
    isCurrent(): boolean;
}>;
export type ConnectedAccountPortableRuntimeLease = Omit<ConnectedAccountPluginRuntimeLease, 'runtime' | 'realm'> & Readonly<{
    realm: 'account';
    runtime: ConnectedAccountPortableRuntime;
    authentication: Readonly<{
        acquire(create: () => CredentialedConnectedAccountAuthenticationRuntime): CredentialedConnectedAccountAuthenticationRuntime;
    }>;
}>;
export type ConnectedAccountRuntimeLease = ConnectedAccountPluginRuntimeLease | ConnectedAccountHostRuntimeLease;
export type HostConnectedAccountRuntimeRegistration = Readonly<{
    ref: PluginContributionRef;
    descriptor: ResolvedConnectedAccountDescriptorContribution['definition'];
    runtime: HostConnectedAccountRuntime;
}>;

export { ConnectedAccountRuntimeInvocationNotStartedError } from '@happier-dev/cli-common/connectedAccounts';
import { ConnectedAccountRuntimeInvocationNotStartedError } from '@happier-dev/cli-common/connectedAccounts';

function qualifiedKey(ref: PluginContributionRef): string {
    return buildQualifiedPluginContributionKey(ConnectedAccountServiceIdentityV1Schema.parse(ref));
}

function snapshotQualifiedRef(ref: PluginContributionRef): PluginContributionRef {
    const identity = ConnectedAccountServiceIdentityV1Schema.parse(ref);
    return Object.freeze({ pluginId: identity.pluginId, localId: identity.localId });
}

function snapshotDescriptor(
    definition: ResolvedConnectedAccountDescriptorContribution['definition'],
): ResolvedConnectedAccountDescriptorContribution['definition'] {
    const parsed = PluginConnectedAccountDescriptorContributionV2Schema.parse(definition);
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
    resolveRetirementSignal?(pluginId: string): AbortSignal;
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
    resolve(ref: PluginContributionRef): Promise<ConnectedAccountRuntimeLease | ConnectedAccountPortableRuntimeLease | null>;
    /** Portable view of the same admitted registration; never a native-runtime cast. */
    resolveAccount(ref: PluginContributionRef): Promise<ConnectedAccountPortableRuntimeLease | null>;
    registerHostConnectedAccountRuntime(input: HostConnectedAccountRuntimeRegistration): void;
    dispose(): void;
}> {
    type Declared = Readonly<{
        ref: PluginContributionRef;
        descriptor: ResolvedConnectedAccountDescriptorContribution['definition'];
        occurrenceId: PluginRuntimeOccurrenceId;
        sourceCustody: PluginSourceCustody;
        owner?: 'plugin';
        authentication: { runtime: CredentialedConnectedAccountAuthenticationRuntime | null };
    }> | ConnectedAccountHostRuntimeLease;
    const descriptorsByKey = new Map<string, Declared>();
    const duplicateKeys = new Set<string>();
    for (const contribution of params.descriptors) {
        const pluginId = contribution.pluginId?.trim();
        if (!pluginId) throw new TypeError('Connected-account descriptors require a plugin-qualified owner');
        const descriptor = snapshotDescriptor(contribution.definition);
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
            authentication: { runtime: null },
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

    function coldEntry(declared: Declared): ConnectedAccountContributionRegistryEntry {
        return Object.freeze({
            ref: declared.ref,
            descriptor: declared.descriptor,
            occurrenceId: declared.occurrenceId,
            sourceCustody: declared.sourceCustody,
            isCurrent: () => declared.owner === 'host'
                ? !disposed : isCurrentOccurrence(declared.ref.pluginId, declared.occurrenceId),
        });
    }

    async function resolvePluginRegistration(qualifiedRef: PluginContributionRef,
        declared: Exclude<Declared, ConnectedAccountHostRuntimeLease>) {
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
        return {
            ref: declared.ref, occurrenceId: declared.occurrenceId, sourceCustody: declared.sourceCustody,
            descriptor: declared.descriptor, registration,
            isCurrent: () => isCurrentOccurrence(qualifiedRef.pluginId, declared.occurrenceId),
        };
    }

    function projectPortableLease(
        resolved: NonNullable<Awaited<ReturnType<typeof resolvePluginRegistration>>>,
        declared: Exclude<Declared, ConnectedAccountHostRuntimeLease>,
        runtime: ConnectedAccountPortableRuntime,
    ): ConnectedAccountPortableRuntimeLease {
        const { registration: _registration, ...lease } = resolved;
        return Object.freeze({ ...lease, realm: 'account' as const, runtime,
            authentication: Object.freeze({ acquire(create: () => CredentialedConnectedAccountAuthenticationRuntime) {
                if (declared.authentication.runtime) return declared.authentication.runtime;
                const signal = params.resolveRetirementSignal?.(lease.ref.pluginId);
                if (disposed || !signal || signal.aborted) throw new ConnectedAccountRuntimeInvocationNotStartedError();
                const retained = create();
                declared.authentication.runtime = retained;
                signal.addEventListener('abort', () => {
                    const current = declared.authentication.runtime;
                    declared.authentication.runtime = null;
                    current?.dispose();
                }, { once: true });
                return retained;
            } }),
        });
    }

    return Object.freeze({
        registerHostConnectedAccountRuntime(input) {
            if (disposed) throw new ConnectedAccountRuntimeInvocationNotStartedError();
            const ref = snapshotQualifiedRef(input.ref);
            if (ref.pluginId !== 'happier') throw new TypeError('Host Connected Accounts require a reserved host service');
            const key = qualifiedKey(ref);
            if (descriptorsByKey.has(key)) throw new Error(`Duplicate connected-account descriptor '${key}'`);
            const descriptor = snapshotDescriptor(input.descriptor);
            if (descriptor.id !== ref.localId) throw new TypeError('Host Connected Account descriptor does not match its service');
            descriptorsByKey.set(key, Object.freeze({
                owner: 'host' as const, ref, descriptor,
                occurrenceId: createPluginRuntimeOccurrenceId(ref.pluginId),
                sourceCustody: Object.freeze({ kind: 'host' as const }),
                runtime: input.runtime,
                isCurrent: () => !disposed,
            }));
        },
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
            if (declared.owner === 'host') {
                if (!declared.isCurrent()) throw new ConnectedAccountRuntimeInvocationNotStartedError();
                return declared;
            }
            const resolved = await resolvePluginRegistration(qualifiedRef, declared);
            if (!resolved) return null;
            if (resolved.registration.realm === 'account') return projectPortableLease(resolved, declared, resolved.registration.runtime);
            const { registration, ...lease } = resolved;
            return Object.freeze({ ...lease, runtime: registration.runtime });
        },
        async resolveAccount(ref) {
            const qualifiedRef = snapshotQualifiedRef(ref);
            const declared = descriptorsByKey.get(qualifiedKey(qualifiedRef));
            if (!declared || declared.owner === 'host') return null;
            const resolved = await resolvePluginRegistration(qualifiedRef, declared);
            if (!resolved || resolved.registration.realm !== 'account') return null;
            return projectPortableLease(resolved, declared, resolved.registration.runtime);
        },
        dispose() {
            disposed = true;
            for (const declared of descriptorsByKey.values()) {
                if (declared.owner !== 'host') {
                    const runtime = declared.authentication.runtime;
                    declared.authentication.runtime = null;
                    runtime?.dispose();
                }
            }
        },
    });
}
