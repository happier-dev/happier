import { describe, expect, it, vi } from 'vitest';

import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol';
import type { ConnectedAccountRuntime as PluginConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { createPluginRegistrationScope } from '@/plugins/runtime/api/registrationScope';
import type { ResolvedConnectedAccountDescriptorContribution } from '@/plugins/projection/registry/types';
import type { PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';

import {
    ConnectedAccountRuntimeInvocationNotStartedError,
    createConnectedAccountContributionRegistry as createProductionConnectedAccountContributionRegistry,
    type ConnectedAccountRuntimeLease,
    type ConnectedAccountPortableRuntimeLease,
    type ConnectedAccountPluginRuntimeLease,
} from './contributionRegistry';

type RegistryParams = Parameters<typeof createProductionConnectedAccountContributionRegistry>[0];

function createConnectedAccountContributionRegistry(
    params: Omit<
        RegistryParams,
        | 'readPluginOccurrenceId'
        | 'readPluginSourceCustody'
        | 'isPluginOccurrenceCurrent'
    > & Readonly<{
        immutableGenerationIdsByPluginId?: ReadonlyMap<string, string>;
        isOccurrenceCurrent(pluginId: string): boolean;
    }>,
) {
    const immutableGenerationIdsByPluginId = params.immutableGenerationIdsByPluginId ?? new Map(
        params.descriptors.flatMap((entry) => entry.pluginId
            ? [[entry.pluginId, `immutable:${entry.pluginId}:1`] as const]
            : []),
    );
    const occurrenceIdsByPluginId = new Map(params.descriptors.flatMap((entry) => {
        if (!entry.pluginId) return [];
        const registration = params.readRegistrations().find((candidate) => (
            candidate.pluginId === entry.pluginId
        ));
        return [[
            entry.pluginId,
            (registration?.occurrenceId ?? '7') as PluginRuntimeOccurrenceId,
        ] as const];
    }));
    return createProductionConnectedAccountContributionRegistry({
        ...params,
        readPluginOccurrenceId: (pluginId) => occurrenceIdsByPluginId.get(pluginId) ?? null,
        readPluginSourceCustody: (pluginId) => {
            const immutableGenerationId = immutableGenerationIdsByPluginId.get(pluginId);
            return immutableGenerationId
                ? { kind: 'managed', immutableGenerationId, installSource: 'archive' }
                : null;
        },
        isPluginOccurrenceCurrent: (pluginId) => params.isOccurrenceCurrent(pluginId),
    });
}

async function resolveLease(
    registry: Readonly<{
        resolve(ref: Readonly<{ pluginId: string; localId: string }>):
            Promise<ConnectedAccountRuntimeLease | ConnectedAccountPortableRuntimeLease | null>;
    }>,
    ref: Readonly<{ pluginId: string; localId: string }>,
): Promise<ConnectedAccountPluginRuntimeLease> {
    const lease = await registry.resolve(ref);
    if (!lease) {
        throw new Error(`Expected a resolvable lease for '${ref.pluginId}/${ref.localId}'`);
    }
    if (lease.owner === 'host') throw new Error('Expected a plugin lease');
    if ('realm' in lease) throw new Error('Expected a native plugin lease');
    return lease;
}

function descriptor(pluginId: string, localId = 'shared'): ResolvedConnectedAccountDescriptorContribution {
    return {
        provenance: 'external' as const,
        source: { kind: 'path' as const },
        pluginId,
        definition: {
            id: localId,
            title: `${pluginId} account`,
            authentication: {
                defaultModeId: 'manual',
                modes: [{
                    id: 'manual',
                    kind: 'manual' as const,
                    outcomeReconciliation: 'none' as const,
                    fields: [{ id: 'token', title: 'Token', schema: { type: 'string' as const }, secret: true as const }],
                }],
            },
        },
    };
}

function nestedDescriptorMetadata(): Record<string, unknown> {
    let value: unknown = null;
    for (let index = 0; index < 40; index += 1) value = { next: value };
    return { nested: value };
}

function runtime(label: string) {
    return {
        authentication: {
            modes: {
                manual: {
                    kind: 'manual',
                    async complete() {
                        return { status: 'connected', accountId: label, displayName: label, scopes: [] };
                    },
                },
            },
        },
        async refresh() { return { status: 'connected' }; },
        async revoke() { return { status: 'remoteUnsupported' }; },
        async status() { return { status: 'connected', displayName: label }; },
        async materialize() { return { kind: 'environment', env: {} }; },
    } satisfies PluginConnectedAccountRuntime;
}

function manualMode(
    value: PluginConnectedAccountRuntime,
): Extract<
    PluginConnectedAccountRuntime['authentication']['modes'][string],
    { kind: 'manual' }
> {
    const mode = value.authentication.modes.manual;
    if (mode.kind !== 'manual') throw new Error('Expected manual test runtime');
    return mode;
}

describe('connected-account contribution registry', () => {
    it('admits a built-in host runtime through the same registry and retires its lease on disposal', async () => {
        const registry = createProductionConnectedAccountContributionRegistry({
            descriptors: [],
            activateOnDemand: async () => { throw new Error('Host runtime must not activate a plugin'); },
            readRegistrations: () => [],
            readPluginOccurrenceId: () => null,
            readPluginSourceCustody: () => null,
            isPluginOccurrenceCurrent: () => false,
        });
        const ref = { pluginId: 'happier', localId: 'mcp-sign-in' };
        registry.registerHostConnectedAccountRuntime({
            ref,
            descriptor: descriptor('happier', ref.localId).definition,
            runtime: runtime('host'),
        });
        const lease = await registry.resolve(ref);
        if (!lease || lease.owner !== 'host') throw new Error('Expected a host lease');
        expect(registry.describe(ref)?.ref).toEqual(ref);
        expect(lease.sourceCustody).toEqual({ kind: 'host' });
        expect(lease.isCurrent()).toBe(true);
        await expect(lease.runtime.status({} as never)).resolves.toMatchObject({ displayName: 'host' });
        registry.dispose();
        expect(lease.isCurrent()).toBe(false);
        await expect(registry.resolve(ref)).rejects.toBeInstanceOf(ConnectedAccountRuntimeInvocationNotStartedError);
    });

    it('uses committed immutable artifact identity instead of the unchanged manifest digest', async () => {
        const contribution = descriptor('acme.alpha');
        const registration = {
            pluginId: 'acme.alpha',
            occurrenceId: '7',
            localId: 'shared',
            runtime: runtime('alpha'),
        };
        const first = createConnectedAccountContributionRegistry({
                        immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'artifact-bytes-1']]),
            descriptors: [contribution],
            activateOnDemand: async () => {},
            readRegistrations: () => [registration],
            isOccurrenceCurrent: () => true,
        });
        const replacement = createConnectedAccountContributionRegistry({
                        immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'artifact-bytes-2']]),
            descriptors: [contribution],
            activateOnDemand: async () => {},
            readRegistrations: () => [registration],
            isOccurrenceCurrent: () => true,
        });

        await expect(first.resolve({ pluginId: 'acme.alpha', localId: 'shared' }))
            .resolves.toMatchObject({
                sourceCustody: {
                    kind: 'managed',
                    immutableGenerationId: 'artifact-bytes-1',
                },
            });
        await expect(replacement.resolve({ pluginId: 'acme.alpha', localId: 'shared' }))
            .resolves.toMatchObject({
                sourceCustody: {
                    kind: 'managed',
                    immutableGenerationId: 'artifact-bytes-2',
                },
            });
        // A descriptor whose plugin has no admitted generation identity is never
        // served — it is omitted rather than admitted without an identity.
        const withoutIdentity = createProductionConnectedAccountContributionRegistry({
                        readPluginOccurrenceId: () => null,
            readPluginSourceCustody: () => null,
            isPluginOccurrenceCurrent: () => false,
            descriptors: [contribution],
            activateOnDemand: async () => {},
            readRegistrations: () => [registration],
        });
        expect(withoutIdentity.list()).toEqual([]);
        await expect(withoutIdentity.resolve({ pluginId: 'acme.alpha', localId: 'shared' }))
            .resolves.toBeNull();
    });

    it('quarantines only the plugin whose generation identity is unavailable', async () => {
        const quarantined: Array<Readonly<{ pluginId: string; localId: string }>> = [];
        const healthyRegistration = {
            pluginId: 'acme.healthy',
            occurrenceId: '7',
            localId: 'shared',
            runtime: runtime('healthy'),
        };
        const registry = createConnectedAccountContributionRegistry({
                        // Only the healthy plugin's generation was admitted, exactly as a
            // stale peer's would be missing after a failed admission.
            immutableGenerationIdsByPluginId: new Map([['acme.healthy', 'artifact-bytes-1']]),
            descriptors: [descriptor('acme.stale'), descriptor('acme.healthy')],
            activateOnDemand: async () => {},
            readRegistrations: () => [healthyRegistration],
            isOccurrenceCurrent: () => true,
            onDescriptorUnavailable: (ref) => { quarantined.push(ref); },
        });

        expect(registry.list().map((entry) => entry.ref)).toEqual([
            { pluginId: 'acme.healthy', localId: 'shared' },
        ]);
        await expect(resolveLease(registry, { pluginId: 'acme.healthy', localId: 'shared' }))
            .resolves.toMatchObject({
                sourceCustody: { immutableGenerationId: 'artifact-bytes-1' },
            });
        await expect(registry.resolve({ pluginId: 'acme.stale', localId: 'shared' }))
            .resolves.toBeNull();
        expect(quarantined).toEqual([{ pluginId: 'acme.stale', localId: 'shared' }]);
    });

    it('keeps same-local-id services qualified and exact-demand activates only the requested plugin', async () => {
        const registrations: Array<Readonly<{
            pluginId: string;
            occurrenceId: string;
            localId: string;
            runtime: PluginConnectedAccountRuntime;
        }>> = [];
        const activateOnDemand = vi.fn(async (ref: Readonly<{ pluginId: string; localId: string }>) => {
            registrations.push({ pluginId: ref.pluginId, occurrenceId: '7', localId: ref.localId, runtime: runtime(ref.pluginId) });
        });
        const registry = createConnectedAccountContributionRegistry({
            descriptors: [descriptor('acme.alpha'), descriptor('acme.beta')],
            activateOnDemand, readRegistrations: () => registrations, isOccurrenceCurrent: () => true,
        });

        expect(registry.list().map((entry) => entry.ref)).toEqual([
            { pluginId: 'acme.alpha', localId: 'shared' },
            { pluginId: 'acme.beta', localId: 'shared' },
        ]);
        const resolved = await resolveLease(registry, { pluginId: 'acme.beta', localId: 'shared' });

        expect(activateOnDemand).toHaveBeenCalledTimes(1);
        expect(activateOnDemand).toHaveBeenCalledWith({ pluginId: 'acme.beta', localId: 'shared' });
        expect(resolved.ref).toEqual({ pluginId: 'acme.beta', localId: 'shared' });
        expect(await resolved.runtime.status({} as never)).toMatchObject({ displayName: 'acme.beta' });
        const listed = registry.list();
        expect(listed).toEqual(expect.arrayContaining([
            expect.objectContaining({ ref: { pluginId: 'acme.alpha', localId: 'shared' } }),
            expect.objectContaining({ ref: { pluginId: 'acme.beta', localId: 'shared' } }),
        ]));
        expect(listed.every((entry) => !Object.prototype.hasOwnProperty.call(entry, 'state'))).toBe(true);
    });

    it('re-reads the current generation and rejects duplicate publication without replacing it', async () => {
        const first = runtime('first');
        const registrations = [{ pluginId: 'acme.alpha', occurrenceId: '8', localId: 'shared', runtime: first }];
        const registry = createConnectedAccountContributionRegistry({
            descriptors: [descriptor('acme.alpha')], activateOnDemand: async () => {},
            readRegistrations: () => registrations, isOccurrenceCurrent: () => true,
        });
        expect((await resolveLease(registry, { pluginId: 'acme.alpha', localId: 'shared' })).runtime).toBeDefined();

        registrations.push({ pluginId: 'acme.alpha', occurrenceId: '8', localId: 'shared', runtime: runtime('conflict') });
        await expect(registry.resolve({ pluginId: 'acme.alpha', localId: 'shared' }))
            .rejects.toThrow(/duplicate current-generation registration/i);
        registrations.splice(1, 1);
        expect(await (await resolveLease(registry, { pluginId: 'acme.alpha', localId: 'shared' })).runtime.status({} as never))
            .toMatchObject({ displayName: 'first' });
    });

    it('marks retained leases stale after disposal without deleting another plugin identity', async () => {
        let current = true;
        const registrations = [
            { pluginId: 'acme.alpha', occurrenceId: '9', localId: 'shared', runtime: runtime('alpha') },
            { pluginId: 'acme.beta', occurrenceId: '9', localId: 'shared', runtime: runtime('beta') },
        ];
        const registry = createConnectedAccountContributionRegistry({
            descriptors: [descriptor('acme.alpha'), descriptor('acme.beta')],
            activateOnDemand: async () => {}, readRegistrations: () => registrations,
            isOccurrenceCurrent: () => current,
        });
        const alpha = await resolveLease(registry, { pluginId: 'acme.alpha', localId: 'shared' });
        const beta = await resolveLease(registry, { pluginId: 'acme.beta', localId: 'shared' });

        current = false;
        registry.dispose();
        expect(alpha.isCurrent()).toBe(false);
        expect(beta.isCurrent()).toBe(false);

        const next = createConnectedAccountContributionRegistry({
            descriptors: [descriptor('acme.beta')], activateOnDemand: async () => {},
            readRegistrations: () => [{ pluginId: 'acme.beta', occurrenceId: '10', localId: 'shared', runtime: runtime('beta-next') }],
            isOccurrenceCurrent: () => true,
        });
        expect(await (await resolveLease(next, { pluginId: 'acme.beta', localId: 'shared' })).runtime.status({} as never))
            .toMatchObject({ displayName: 'beta-next' });
    });

    it('keeps the committed account runtime as the sole callback topology and exposes lease currentness separately', async () => {
        class ManualMode {
            readonly kind = 'manual' as const;
            readonly marker = 'captured-mode';

            async complete() {
                return {
                    status: 'connected' as const,
                    accountId: this.marker,
                    displayName: this.marker,
                    scopes: [],
                };
            }
        }
        class Runtime {
            readonly marker = 'captured-runtime';
            readonly authentication = { modes: { manual: new ManualMode() } };
            readonly unrelated = true;

            async refresh() { return { status: 'connected' as const }; }
            async revoke() { return { status: 'remoteUnsupported' as const }; }
            async status() { return { status: 'connected' as const, displayName: this.marker }; }
            async materialize() { return { kind: 'environment' as const, env: {} }; }
        }

        const runtime = new Runtime();
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.alpha',
            target: { realm: 'daemon' },
            rights: derivePluginDaemonContributionRegistrationRights({
                connectedAccountDescriptors: [descriptor('acme.alpha').definition],
            }),
        });
        scope.api.connectedAccounts.register('shared', runtime as PluginConnectedAccountRuntime);
        const [registration] = scope.commit();
        if (registration?.family !== 'connectedAccountDescriptors') {
            throw new Error('Expected a committed connected-account runtime');
        }
        (runtime as unknown as { status: () => Promise<unknown> }).status = async () => ({
            status: 'connected',
            displayName: 'post-commit replacement',
        });
        runtime.authentication.modes.manual.complete = async () => ({
            status: 'connected', accountId: 'post-commit replacement',
            displayName: 'post-commit replacement', scopes: [],
        });

        let current = true;
        const registry = createConnectedAccountContributionRegistry({
                        descriptors: [descriptor('acme.alpha')],
            activateOnDemand: async () => {},
            readRegistrations: () => [{
                pluginId: 'acme.alpha',
                occurrenceId: '16',
                localId: 'shared',
                runtime: registration.value,
            }],
            isOccurrenceCurrent: () => current,
        });
        const lease = await resolveLease(registry, { pluginId: 'acme.alpha', localId: 'shared' });

        // Registration owns the committed snapshot. The lease does not add a
        // recursive proxy topology around it; typed invokers own callback
        // currentness at their public boundary.
        expect(lease.runtime).toBe(registration.value);
        await expect(lease.runtime.status({} as never)).resolves.toEqual({
            status: 'connected',
            displayName: 'captured-runtime',
        });
        await expect(manualMode(lease.runtime).complete(
            { fields: { token: 'secret' } },
            {} as never,
        )).resolves.toMatchObject({ accountId: 'captured-mode' });

        current = false;
        expect(lease.isCurrent()).toBe(false);
    });

    it('accepts schema-valid nested descriptor metadata without borrowing manifest input limits', () => {
        const base = descriptor('acme.alpha');
        const registry = createConnectedAccountContributionRegistry({
                        descriptors: [{
                ...base,
                definition: {
                    ...base.definition,
                    metadata: nestedDescriptorMetadata(),
                },
            } as ResolvedConnectedAccountDescriptorContribution],
            activateOnDemand: async () => {},
            readRegistrations: () => [],
            isOccurrenceCurrent: () => true,
        });

        expect(registry.list()).toEqual([
            expect.objectContaining({
                ref: { pluginId: 'acme.alpha', localId: 'shared' },
            }),
        ]);
    });

    it('isolates a duplicate qualified descriptor through the existing unavailable diagnostic owner', () => {
        const unavailable = vi.fn();
        const registry = createConnectedAccountContributionRegistry({
            descriptors: [
                descriptor('acme.alpha'),
                descriptor('acme.alpha'),
                descriptor('acme.healthy'),
            ],
            activateOnDemand: async () => {}, readRegistrations: () => [], isOccurrenceCurrent: () => true,
            onDescriptorUnavailable: unavailable,
        });

        expect(registry.list().map((entry) => entry.ref)).toEqual([
            { pluginId: 'acme.healthy', localId: 'shared' },
        ]);
        expect(registry.describe({ pluginId: 'acme.alpha', localId: 'shared' })).toBeNull();
        expect(unavailable).toHaveBeenCalledOnce();
        expect(unavailable).toHaveBeenCalledWith(
            { pluginId: 'acme.alpha', localId: 'shared' },
            expect.objectContaining({
                message: expect.stringMatching(/duplicate connected-account descriptor/i),
            }),
        );
    });

    it('reports an unresolvable service as a null lease instead of an untyped throw', async () => {
        const activateOnDemand = vi.fn(async () => {});
        const registry = createConnectedAccountContributionRegistry({
                        descriptors: [descriptor('acme.alpha')],
            immutableGenerationIdsByPluginId: new Map([
                ['acme.alpha', 'immutable:acme.alpha:1'],
                ['acme.beta', 'immutable:acme.beta:1'],
            ]),
            activateOnDemand,
            readRegistrations: () => [],
            isOccurrenceCurrent: () => true,
        });

        // Undeclared descriptor: nothing to resolve, and demand must not be spent.
        await expect(registry.resolve({ pluginId: 'acme.beta', localId: 'shared' }))
            .resolves.toBeNull();
        expect(activateOnDemand).not.toHaveBeenCalled();

        // Declared but the plugin never published its runtime: still unresolvable.
        await expect(registry.resolve({ pluginId: 'acme.alpha', localId: 'shared' }))
            .resolves.toBeNull();
        expect(activateOnDemand).toHaveBeenCalledExactlyOnceWith({
            pluginId: 'acme.alpha',
            localId: 'shared',
        });
    });

    it('keeps a retired generation a typed currentness outcome rather than unavailability', async () => {
        let current = true;
        const registry = createConnectedAccountContributionRegistry({
                        descriptors: [descriptor('acme.alpha')],
            activateOnDemand: async () => {},
            readRegistrations: () => [{
                pluginId: 'acme.alpha', occurrenceId: '15', localId: 'shared', runtime: runtime('alpha'),
            }],
            isOccurrenceCurrent: () => current,
        });
        expect(await registry.resolve({ pluginId: 'acme.alpha', localId: 'shared' })).not.toBeNull();

        current = false;
        const rejection = await registry
            .resolve({ pluginId: 'acme.alpha', localId: 'shared' })
            .then(() => null, (error: unknown) => error);

        expect(rejection).toBeInstanceOf(ConnectedAccountRuntimeInvocationNotStartedError);
        expect((rejection as ConnectedAccountRuntimeInvocationNotStartedError).code)
            .toBe('connected_account_runtime_generation_changed');
    });
});
