import { describe, expect, it, vi } from 'vitest';

import type { PluginConnectedAccountRuntime } from '@happier-dev/plugin-sdk/runtime';
import type { ResolvedConnectedAccountDescriptorContribution } from '@/plugins/projection/registry/types';

import {
    ConnectedAccountRuntimeInvocationNotStartedError,
    createConnectedAccountContributionRegistry as createProductionConnectedAccountContributionRegistry,
} from './contributionRegistry';

type RegistryParams = Parameters<typeof createProductionConnectedAccountContributionRegistry>[0];

function createConnectedAccountContributionRegistry(
    params: Omit<RegistryParams, 'immutableGenerationIdsByPluginId'> & Readonly<{
        immutableGenerationIdsByPluginId?: ReadonlyMap<string, string>;
    }>,
) {
    return createProductionConnectedAccountContributionRegistry({
        ...params,
        immutableGenerationIdsByPluginId: params.immutableGenerationIdsByPluginId ?? new Map(
            params.descriptors.flatMap((entry) => entry.pluginId
                ? [[entry.pluginId, `immutable:${entry.pluginId}:1`] as const]
                : []),
        ),
    });
}

function descriptor(pluginId: string, localId = 'shared'): ResolvedConnectedAccountDescriptorContribution {
    return {
        provenance: 'external' as const,
        source: { kind: 'path' as const },
        pluginId,
        manifestDigest: `artifact:${pluginId}:1`,
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

function oauthDescriptor(
    outcomeReconciliation: 'providerCheck' | 'lateEvidence' | 'none',
): ResolvedConnectedAccountDescriptorContribution {
    return {
        ...descriptor('acme.alpha'),
        definition: {
            id: 'shared',
            title: 'OAuth account',
            authentication: {
                defaultModeId: 'oauth',
                modes: [{
                    id: 'oauth',
                    kind: 'oauthAuthorizationCode',
                    pkce: 'required',
                    outcomeReconciliation,
                }],
            },
        },
    };
}

function oauthRuntime(withReconcile: boolean): PluginConnectedAccountRuntime {
    return {
        ...runtime('oauth'),
        authentication: {
            modes: {
                oauth: {
                    kind: 'oauthAuthorizationCode',
                    async begin() {
                        return {
                            status: 'awaitingOAuthRedirect',
                            authorizationUrl: 'https://provider.example/authorize',
                        };
                    },
                    async complete() {
                        return {
                            status: 'connected',
                            accountId: 'account-a',
                            displayName: 'Account A',
                            scopes: [],
                        };
                    },
                    async cancel() {},
                    ...(withReconcile
                        ? {
                            async reconcile() {
                                return {
                                    status: 'connected' as const,
                                    accountId: 'account-a',
                                    displayName: 'Account A',
                                    scopes: [],
                                };
                            },
                        }
                        : {}),
                },
            },
        },
    };
}

function runtime(label: string): PluginConnectedAccountRuntime {
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
    };
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
    it('uses committed immutable artifact identity instead of the unchanged manifest digest', async () => {
        const contribution = descriptor('acme.alpha');
        const registration = {
            pluginId: 'acme.alpha',
            generation: '7',
            localId: 'shared',
            runtime: runtime('alpha'),
        };
        const first = createConnectedAccountContributionRegistry({
            generation: '7',
            immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'artifact-bytes-1']]),
            descriptors: [contribution],
            activateOnDemand: async () => {},
            readRegistrations: () => [registration],
            isGenerationCurrent: () => true,
        });
        const replacement = createConnectedAccountContributionRegistry({
            generation: '7',
            immutableGenerationIdsByPluginId: new Map([['acme.alpha', 'artifact-bytes-2']]),
            descriptors: [contribution],
            activateOnDemand: async () => {},
            readRegistrations: () => [registration],
            isGenerationCurrent: () => true,
        });

        await expect(first.resolve({ pluginId: 'acme.alpha', localId: 'shared' }))
            .resolves.toMatchObject({ immutableGenerationId: 'artifact-bytes-1' });
        await expect(replacement.resolve({ pluginId: 'acme.alpha', localId: 'shared' }))
            .resolves.toMatchObject({ immutableGenerationId: 'artifact-bytes-2' });
        expect(() => createProductionConnectedAccountContributionRegistry({
            generation: '7',
            immutableGenerationIdsByPluginId: new Map(),
            descriptors: [contribution],
            activateOnDemand: async () => {},
            readRegistrations: () => [registration],
            isGenerationCurrent: () => true,
        })).toThrow(/immutable plugin generation identity/i);
    });

    it('keeps same-local-id services qualified and exact-demand activates only the requested plugin', async () => {
        const registrations: Array<Readonly<{
            pluginId: string;
            generation: string;
            localId: string;
            runtime: PluginConnectedAccountRuntime;
        }>> = [];
        const activateOnDemand = vi.fn(async (ref: Readonly<{ pluginId: string; localId: string }>) => {
            registrations.push({ pluginId: ref.pluginId, generation: '7', localId: ref.localId, runtime: runtime(ref.pluginId) });
        });
        const registry = createConnectedAccountContributionRegistry({
            generation: '7', descriptors: [descriptor('acme.alpha'), descriptor('acme.beta')],
            activateOnDemand, readRegistrations: () => registrations, isGenerationCurrent: () => true,
        });

        expect(registry.list().map((entry) => entry.ref)).toEqual([
            { pluginId: 'acme.alpha', localId: 'shared' },
            { pluginId: 'acme.beta', localId: 'shared' },
        ]);
        const resolved = await registry.resolve({ pluginId: 'acme.beta', localId: 'shared' });

        expect(activateOnDemand).toHaveBeenCalledTimes(1);
        expect(activateOnDemand).toHaveBeenCalledWith({ pluginId: 'acme.beta', localId: 'shared' });
        expect(resolved.ref).toEqual({ pluginId: 'acme.beta', localId: 'shared' });
        expect(await resolved.runtime.status({} as never)).toMatchObject({ displayName: 'acme.beta' });
        const listed = registry.list();
        expect(listed).toEqual(expect.arrayContaining([
            expect.objectContaining({ ref: { pluginId: 'acme.alpha', localId: 'shared' }, generation: '7' }),
            expect.objectContaining({ ref: { pluginId: 'acme.beta', localId: 'shared' }, generation: '7' }),
        ]));
        expect(listed.every((entry) => !Object.prototype.hasOwnProperty.call(entry, 'state'))).toBe(true);
    });

    it('re-reads the current generation and rejects duplicate publication without replacing it', async () => {
        const first = runtime('first');
        const registrations = [{ pluginId: 'acme.alpha', generation: '8', localId: 'shared', runtime: first }];
        const registry = createConnectedAccountContributionRegistry({
            generation: '8', descriptors: [descriptor('acme.alpha')], activateOnDemand: async () => {},
            readRegistrations: () => registrations, isGenerationCurrent: () => true,
        });
        expect((await registry.resolve({ pluginId: 'acme.alpha', localId: 'shared' })).runtime).toBeDefined();

        registrations.push({ pluginId: 'acme.alpha', generation: '8', localId: 'shared', runtime: runtime('conflict') });
        await expect(registry.resolve({ pluginId: 'acme.alpha', localId: 'shared' }))
            .rejects.toThrow(/duplicate current-generation registration/i);
        registrations.splice(1, 1);
        expect(await (await registry.resolve({ pluginId: 'acme.alpha', localId: 'shared' })).runtime.status({} as never))
            .toMatchObject({ displayName: 'first' });
    });

    it('fences retained leases after disposal without deleting another plugin identity', async () => {
        let current = true;
        const registrations = [
            { pluginId: 'acme.alpha', generation: '9', localId: 'shared', runtime: runtime('alpha') },
            { pluginId: 'acme.beta', generation: '9', localId: 'shared', runtime: runtime('beta') },
        ];
        const registry = createConnectedAccountContributionRegistry({
            generation: '9', descriptors: [descriptor('acme.alpha'), descriptor('acme.beta')],
            activateOnDemand: async () => {}, readRegistrations: () => registrations,
            isGenerationCurrent: () => current,
        });
        const alpha = await registry.resolve({ pluginId: 'acme.alpha', localId: 'shared' });
        const beta = await registry.resolve({ pluginId: 'acme.beta', localId: 'shared' });

        current = false;
        registry.dispose();
        await expect(alpha.runtime.status({} as never)).rejects.toThrow(/no longer current/i);
        await expect(beta.runtime.status({} as never)).rejects.toThrow(/no longer current/i);

        const next = createConnectedAccountContributionRegistry({
            generation: '10', descriptors: [descriptor('acme.beta')], activateOnDemand: async () => {},
            readRegistrations: () => [{ pluginId: 'acme.beta', generation: '10', localId: 'shared', runtime: runtime('beta-next') }],
            isGenerationCurrent: () => true,
        });
        expect(await (await next.resolve({ pluginId: 'acme.beta', localId: 'shared' })).runtime.status({} as never))
            .toMatchObject({ displayName: 'beta-next' });
    });

    it('fences a rejected awaited call when its generation retires while preserving current-generation throws', async () => {
        let current = true;
        let rejectStatus!: (error: Error) => void;
        const pendingStatus = new Promise<never>((_resolve, reject) => {
            rejectStatus = reject;
        });
        const retiringRuntime = {
            ...runtime('retiring'),
            status() { return pendingStatus; },
        } satisfies PluginConnectedAccountRuntime;
        const registry = createConnectedAccountContributionRegistry({
            generation: '9', descriptors: [descriptor('acme.alpha')], activateOnDemand: async () => {},
            readRegistrations: () => [{
                pluginId: 'acme.alpha', generation: '9', localId: 'shared', runtime: retiringRuntime,
            }],
            isGenerationCurrent: () => current,
        });
        const lease = await registry.resolve({ pluginId: 'acme.alpha', localId: 'shared' });
        const rejectedAfterRetirement = expect(lease.runtime.status({} as never))
            .rejects.toThrow(/no longer current/i);

        current = false;
        rejectStatus(new Error('stale author failure'));
        await rejectedAfterRetirement;

        const currentRegistry = createConnectedAccountContributionRegistry({
            generation: '10', descriptors: [descriptor('acme.alpha')], activateOnDemand: async () => {},
            readRegistrations: () => [{
                pluginId: 'acme.alpha', generation: '10', localId: 'shared',
                runtime: {
                    ...runtime('current'),
                    status() { throw new Error('current author failure'); },
                },
            }],
            isGenerationCurrent: () => true,
        });
        const currentLease = await currentRegistry.resolve({ pluginId: 'acme.alpha', localId: 'shared' });
        await expect(currentLease.runtime.status({} as never)).rejects.toThrow('current author failure');
    });

    it('fences retained nested authentication-mode leaves before and after provider awaits', async () => {
        let current = true;
        let rejectComplete!: (error: Error) => void;
        const pendingComplete = new Promise<never>((_resolve, reject) => {
            rejectComplete = reject;
        });
        const retiringRuntime = {
            ...runtime('retiring'),
            authentication: {
                modes: {
                    manual: {
                        kind: 'manual' as const,
                        complete: () => pendingComplete,
                    },
                },
            },
        } satisfies PluginConnectedAccountRuntime;
        const registry = createConnectedAccountContributionRegistry({
            generation: '10',
            descriptors: [descriptor('acme.alpha')],
            activateOnDemand: async () => {},
            readRegistrations: () => [{
                pluginId: 'acme.alpha',
                generation: '10',
                localId: 'shared',
                runtime: retiringRuntime,
            }],
            isGenerationCurrent: () => current,
        });
        const lease = await registry.resolve({ pluginId: 'acme.alpha', localId: 'shared' });
        const completion = manualMode(lease.runtime).complete(
            { fields: { token: 'secret' } },
            {} as never,
        );

        current = false;
        rejectComplete(new Error('stale nested author failure'));
        const postEntryError = await completion.catch((error: unknown) => error);
        expect(postEntryError).toBeInstanceOf(Error);
        expect(postEntryError).not.toBeInstanceOf(
            ConnectedAccountRuntimeInvocationNotStartedError,
        );
        expect(postEntryError).toMatchObject({
            message: expect.stringMatching(/no longer current/i),
        });
        await expect(manualMode(lease.runtime).complete(
            { fields: { token: 'secret' } },
            {} as never,
        )).rejects.toBeInstanceOf(
            ConnectedAccountRuntimeInvocationNotStartedError,
        );
    });

    it.each([
        ['accessor', () => Object.defineProperty({}, 'id', { enumerable: true, get: () => 'shared' })],
        ['prototype', () => Object.assign(Object.create({ inherited: true }), { id: 'shared' })],
        ['cyclic', () => { const value: Record<string, unknown> = { id: 'shared' }; value.self = value; return value; }],
        ['unbounded', () => {
            const root: Record<string, unknown> = { id: 'shared' };
            let cursor = root;
            for (let index = 0; index < 40; index += 1) {
                const next: Record<string, unknown> = {};
                cursor.next = next;
                cursor = next;
            }
            return root;
        }],
    ])('rejects malformed descriptors before publishing any registry entry (%s)', (_label, buildDefinition) => {
        const readRegistrations = vi.fn(() => []);
        expect(() => createConnectedAccountContributionRegistry({
            generation: '11', descriptors: [{ ...descriptor('acme.alpha'), definition: buildDefinition() } as never],
            activateOnDemand: async () => {}, readRegistrations, isGenerationCurrent: () => true,
        })).toThrow();
        expect(readRegistrations).not.toHaveBeenCalled();
    });

    it('rejects duplicate qualified descriptors and descriptor/runtime auth conflicts', async () => {
        expect(() => createConnectedAccountContributionRegistry({
            generation: '12', descriptors: [descriptor('acme.alpha'), descriptor('acme.alpha')],
            activateOnDemand: async () => {}, readRegistrations: () => [], isGenerationCurrent: () => true,
        })).toThrow(/duplicate connected-account descriptor/i);

        const registry = createConnectedAccountContributionRegistry({
            generation: '12', descriptors: [descriptor('acme.alpha')], activateOnDemand: async () => {},
            readRegistrations: () => [{
                pluginId: 'acme.alpha', generation: '12', localId: 'shared',
                runtime: { ...runtime('alpha'), authentication: {
                    modes: {
                        manual: {
                            kind: 'oauthDeviceCode', async begin() { throw new Error('not invoked'); },
                            async poll() { throw new Error('not invoked'); }, async cancel() {},
                        },
                    },
                } },
            }],
            isGenerationCurrent: () => true,
        });
        await expect(registry.resolve({ pluginId: 'acme.alpha', localId: 'shared' }))
            .rejects.toThrow(/do not match its descriptor/i);
    });

    it.each([
        ['providerCheck', false],
        ['lateEvidence', true],
        ['none', true],
    ] as const)(
        'enforces declared reconciliation reachability (%s, runtime reconcile=%s)',
        async (outcomeReconciliation, withReconcile) => {
            const registry = createConnectedAccountContributionRegistry({
                generation: '12',
                descriptors: [oauthDescriptor(outcomeReconciliation)],
                activateOnDemand: async () => {},
                readRegistrations: () => [{
                    pluginId: 'acme.alpha',
                    generation: '12',
                    localId: 'shared',
                    runtime: oauthRuntime(withReconcile),
                }],
                isGenerationCurrent: () => true,
            });

            await expect(registry.resolve({ pluginId: 'acme.alpha', localId: 'shared' }))
                .rejects.toThrow(/reconciliation.*does not match/i);
        },
    );

    it.each([
        ['accessor', Object.defineProperty({}, 'pluginId', { enumerable: true, get: () => 'acme.alpha' })],
        ['prototype', Object.assign(Object.create({ pluginId: 'acme.alpha' }), { localId: 'shared' })],
        ['extra', { pluginId: 'acme.alpha', localId: 'shared', extra: true }],
    ])('rejects a malformed qualified lookup before demand (%s)', async (_label, ref) => {
        const activateOnDemand = vi.fn(async () => {});
        const registry = createConnectedAccountContributionRegistry({
            generation: '13', descriptors: [descriptor('acme.alpha')], activateOnDemand,
            readRegistrations: () => [], isGenerationCurrent: () => true,
        });

        await expect(registry.resolve(ref as never)).rejects.toThrow(/qualified connected-account reference/i);
        expect(activateOnDemand).not.toHaveBeenCalled();
    });
});
