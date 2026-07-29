import { describe, expect, it, vi } from 'vitest';

import {
    PluginConnectedAccountAuthenticationModeV2Schema,
    PluginConnectedAccountDescriptorContributionV2Schema,
    PluginHostAccessRequestV2Schema,
} from '@happier-dev/protocol';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginConnectedAccountRuntime } from '@happier-dev/plugin-sdk/runtime';

import type {
    ResolvedConnectedAccountDescriptorContribution,
} from '@/plugins/projection/registry/types';
import {
    createLoggerAndEventsAvailablePluginInvocationServiceBinding,
} from '@/plugins/runtime/invocation/services/factory';
import {
    createConnectedAccountAuthenticationAttemptOwner,
    type ConnectedAccountOAuthCallbackCompletion,
} from './authenticationAttemptOwner';
import {
    createConnectedAccountContributionRegistry,
} from './contributionRegistry';
import {
    createConnectedAccountHostRuntimeInvoker,
} from './runtimeInvoker';

type AuthenticationRuntime =
    PluginConnectedAccountRuntime['authentication']['modes'][string];

const service = Object.freeze({
    pluginId: 'acme.accounts',
    localId: 'work',
});
const mode = PluginConnectedAccountAuthenticationModeV2Schema.parse({
    id: 'manual',
    kind: 'manual',
    outcomeReconciliation: 'none',
    fields: [{
        id: 'token',
        title: 'Token',
        schema: { type: 'string' },
        secret: true,
    }],
});
const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
    id: service.localId,
    title: 'Acme Work',
    authentication: {
        defaultModeId: mode.id,
        modes: [mode],
    },
});

function runtime(
    observeContext: (context: PluginInvocationContext) => void,
): PluginConnectedAccountRuntime {
    return {
        authentication: {
            modes: {
                manual: {
                    kind: 'manual',
                    async complete(_input, context) {
                        observeContext(context);
                        return {
                            status: 'connected',
                            accountId: 'account-a',
                            displayName: 'Account A',
                            scopes: [],
                        };
                    },
                },
            },
        },
        async refresh() {
            return { status: 'connected' };
        },
        async revoke() {
            return { status: 'remoteUnsupported' };
        },
        async status(context) {
            observeContext(context);
            return { status: 'connected' };
        },
        async materialize() {
            return { kind: 'environment', env: {} };
        },
    };
}

describe('connected-account runtime invoker', () => {
    it('returns typed unavailability when a real guarded lease retires before provider entry', async () => {
        const complete = vi.fn(async () => ({
            status: 'connected' as const,
            accountId: 'account-a',
            displayName: 'Account A',
            scopes: Object.freeze([]),
        }));
        const registeredRuntime = {
            ...runtime(() => {}),
            authentication: {
                modes: {
                    manual: {
                        kind: 'manual' as const,
                        complete,
                    },
                },
            },
        } satisfies PluginConnectedAccountRuntime;
        const contribution: ResolvedConnectedAccountDescriptorContribution = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: service.pluginId,
            manifestDigest: 'artifact:acme.accounts:1',
            definition: descriptor,
        };
        const registry = createConnectedAccountContributionRegistry({
            generation: 'generation-1',
            immutableGenerationIdsByPluginId: new Map([
                [service.pluginId, 'artifact-1'],
            ]),
            descriptors: [contribution],
            activateOnDemand: async () => {},
            readRegistrations: () => [{
                pluginId: service.pluginId,
                generation: 'generation-1',
                localId: service.localId,
                runtime: registeredRuntime,
            }],
            isGenerationCurrent: () => true,
        });
        const admittedLease = await registry.resolve(service);
        const configuration = Object.freeze({
            target: Object.freeze({
                kind: 'service' as const,
                service,
                modeId: mode.id,
            }),
            revision: 'unconfigured',
            values: Object.freeze({}),
            getSecret: async () => null,
        });
        const invoker = createConnectedAccountHostRuntimeInvoker({
            resolveRuntime: async (ref) => await registry.resolve(ref),
            resolvePlugin: () => Object.freeze({
                version: '1.0.0',
                hostAccessRequests: Object.freeze([]),
            }),
            resolveHostPolicy: () => Object.freeze({
                hostAccess: Object.freeze([]),
                serviceBinding:
                    createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                        'generation-1',
                        'producer',
                        [],
                    ),
            }),
            createServices: () => {
                registry.dispose();
                return Object.freeze({}) as PluginInvocationContext['services'];
            },
            resolveHostOwnedConfiguredOrigins: () => Object.freeze([]),
        });
        const settle = vi.fn();
        const attempts = createConnectedAccountAuthenticationAttemptOwner({
            maxAttempts: 1,
            createAttemptId: () => 'attempt-1',
            createAccountId: () => 'account-1',
            now: () => 1_000,
            attemptTtlMs: 60_000,
            accounts: Object.freeze({
                readExact: async () => null,
            }),
            configuration: Object.freeze({
                admit: async () => Object.freeze({
                    status: 'ready' as const,
                    snapshot: configuration,
                }),
                isCurrent: async () => true,
            }),
            runtime: Object.freeze({
                admit: async () => Object.freeze({
                    service,
                    descriptor: mode,
                    generation: admittedLease.generation,
                    immutableGenerationId:
                        admittedLease.immutableGenerationId,
                }),
                isCurrent: async () => admittedLease.isCurrent(),
                invoke: async (input) => await invoker.invokeAuthentication({
                    ...input,
                    isConfigurationCurrent: async () => true,
                }),
            }),
            oauth: Object.freeze({
                create: async () => {
                    throw new Error('OAuth is not used by this manual attempt');
                },
            }),
            settlement: Object.freeze({
                settle,
            }),
        });

        await expect(attempts.beginConnect({
            service,
            modeId: mode.id,
        })).resolves.toEqual({
            status: 'awaitingManual',
            attemptId: 'attempt-1',
        });
        await expect(attempts.submitManual({
            attemptId: 'attempt-1',
            fields: Object.freeze({ token: 'candidate' }),
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_runtime_generation_changed',
        });
        expect(complete).not.toHaveBeenCalled();
        expect(settle).not.toHaveBeenCalled();
    });

    it.each(['providerCheck', 'none'] as const)(
        'preserves %s uncertainty when a real guarded lease retires after provider entry',
        async (outcomeReconciliation) => {
            const oauthMode = PluginConnectedAccountAuthenticationModeV2Schema.parse({
                id: 'oauth',
                kind: 'oauthAuthorizationCode',
                pkce: 'required',
                outcomeReconciliation,
            });
            const oauthDescriptor =
                PluginConnectedAccountDescriptorContributionV2Schema.parse({
                    id: service.localId,
                    title: 'Acme Work',
                    authentication: {
                        defaultModeId: oauthMode.id,
                        modes: [oauthMode],
                    },
                });
            let markProviderEntered!: () => void;
            const providerEntered = new Promise<void>((resolve) => {
                markProviderEntered = resolve;
            });
            let rejectProvider!: (error: Error) => void;
            const providerOutcome = new Promise<never>((_resolve, reject) => {
                rejectProvider = reject;
            });
            const complete = vi.fn(async () => {
                markProviderEntered();
                return await providerOutcome;
            });
            const reconcile = vi.fn(async () => ({
                status: 'outcomeUnknown' as const,
                diagnostic: Object.freeze({ code: 'provider_still_uncertain' }),
            }));
            const oauthRuntimeBase = Object.freeze({
                kind: 'oauthAuthorizationCode' as const,
                async begin() {
                    return Object.freeze({
                        status: 'awaitingOAuthRedirect' as const,
                        authorizationUrl:
                            'https://provider.example/authorize',
                    });
                },
                async complete() {
                    return await complete();
                },
                async cancel() {},
            }) satisfies AuthenticationRuntime;
            const authenticationRuntime: AuthenticationRuntime =
                outcomeReconciliation === 'providerCheck'
                    ? Object.freeze({
                        ...oauthRuntimeBase,
                        async reconcile() {
                            return await reconcile();
                        },
                    })
                    : oauthRuntimeBase;
            const registeredRuntime = {
                ...runtime(() => {}),
                authentication: {
                    modes: {
                        oauth: authenticationRuntime,
                    },
                },
            } satisfies PluginConnectedAccountRuntime;
            const contribution: ResolvedConnectedAccountDescriptorContribution = {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: service.pluginId,
                manifestDigest: 'artifact:acme.accounts:1',
                definition: oauthDescriptor,
            };
            const registry = createConnectedAccountContributionRegistry({
                generation: 'generation-1',
                immutableGenerationIdsByPluginId: new Map([
                    [service.pluginId, 'artifact-1'],
                ]),
                descriptors: [contribution],
                activateOnDemand: async () => {},
                readRegistrations: () => [{
                    pluginId: service.pluginId,
                    generation: 'generation-1',
                    localId: service.localId,
                    runtime: registeredRuntime,
                }],
                isGenerationCurrent: () => true,
            });
            const admittedLease = await registry.resolve(service);
            const configuration = Object.freeze({
                target: Object.freeze({
                    kind: 'service' as const,
                    service,
                    modeId: oauthMode.id,
                }),
                revision: 'unconfigured',
                values: Object.freeze({}),
                getSecret: async () => null,
            });
            const invoker = createConnectedAccountHostRuntimeInvoker({
                resolveRuntime: async (ref) => await registry.resolve(ref),
                resolvePlugin: () => Object.freeze({
                    version: '1.0.0',
                    hostAccessRequests: Object.freeze([]),
                }),
                resolveHostPolicy: () => Object.freeze({
                    hostAccess: Object.freeze([]),
                    serviceBinding:
                        createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                            'generation-1',
                            'producer',
                            [],
                        ),
                }),
                createServices: () =>
                    Object.freeze({}) as PluginInvocationContext['services'],
                resolveHostOwnedConfiguredOrigins: () => Object.freeze([]),
            });
            const settle = vi.fn();
            const attempts = createConnectedAccountAuthenticationAttemptOwner({
                maxAttempts: 1,
                createAttemptId: () => 'attempt-1',
                createAccountId: () => 'account-1',
                now: () => 1_000,
                attemptTtlMs: 60_000,
                accounts: Object.freeze({
                    readExact: async () => null,
                }),
                configuration: Object.freeze({
                    admit: async () => Object.freeze({
                        status: 'ready' as const,
                        snapshot: configuration,
                    }),
                    isCurrent: async () => true,
                }),
                runtime: Object.freeze({
                    admit: async () => Object.freeze({
                        service,
                        descriptor: oauthMode,
                        generation: admittedLease.generation,
                        immutableGenerationId:
                            admittedLease.immutableGenerationId,
                    }),
                    isCurrent: async () => admittedLease.isCurrent(),
                    invoke: async (input) =>
                        await invoker.invokeAuthentication({
                            ...input,
                            isConfigurationCurrent: async () => true,
                        }),
                }),
                oauth: Object.freeze({
                    create: async () => Object.freeze({
                        request: Object.freeze({
                            callbackUrl:
                                'http://127.0.0.1:32123/oauth/callback',
                            state: 'oauth-state-1',
                            pkce: Object.freeze({
                                challenge: 'pkce-challenge-1',
                                method: 'S256' as const,
                            }),
                        }),
                        acknowledge: async () => {},
                        acceptCompletion: async (
                            completion:
                                ConnectedAccountOAuthCallbackCompletion,
                        ) => Object.freeze({
                                ...completion,
                                pkceVerifier: 'pkce-verifier-1',
                            }),
                        close: async () => {},
                    }),
                }),
                settlement: Object.freeze({
                    settle,
                }),
            });

            await expect(attempts.beginConnect({
                service,
                modeId: oauthMode.id,
            })).resolves.toEqual({
                status: 'starting',
                attemptId: 'attempt-1',
            });
            for (let index = 0; index < 20; index += 1) {
                const current = await attempts.read({
                    attemptId: 'attempt-1',
                });
                if (current.status === 'awaitingOAuth') break;
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
            const completion = attempts.completeOAuth({
                attemptId: 'attempt-1',
                completion: {
                    code: 'remote-code-1',
                    callbackUrl:
                        'http://127.0.0.1:32123/oauth/callback',
                    state: 'oauth-state-1',
                },
            });
            await providerEntered;
            registry.dispose();
            rejectProvider(new Error('provider response was lost'));

            const expected = outcomeReconciliation === 'providerCheck'
                ? {
                    status: 'outcomeUnknown' as const,
                    attemptId: 'attempt-1',
                    diagnostic: {
                        code:
                            'connected_account_provider_operation_interrupted',
                    },
                }
                : {
                    status: 'reconnectRequired' as const,
                    attemptId: 'attempt-1',
                    code:
                        'connected_account_authentication_outcome_unknown',
                };
            await expect(completion).resolves.toEqual(expected);
            await expect(attempts.reconcile({
                attemptId: 'attempt-1',
            })).resolves.toEqual(expected);
            expect(complete).toHaveBeenCalledOnce();
            expect(reconcile).not.toHaveBeenCalled();
            expect(settle).not.toHaveBeenCalled();
        },
    );

    it('returns typed unavailability before provider work when exact producer network authority is denied', async () => {
        const networkRequest = Object.freeze({
            request: PluginHostAccessRequestV2Schema.parse({
                id: 'connected-account-network',
                capability: 'network',
                reason: 'Authenticate the exact connected account',
                scope: {
                    targets: [{
                        kind: 'connectedAccountOrigin',
                        service,
                    }, {
                        kind: 'fixedOrigin',
                        origin: 'https://api.example.test',
                    }],
                },
            }),
            required: true,
        });
        const complete = vi.fn(async () => ({
            status: 'connected' as const,
            accountId: 'account-a',
            displayName: 'Account A',
            scopes: Object.freeze([]),
        }));
        const deniedRuntime = {
            ...runtime(() => {}),
            authentication: {
                modes: {
                    manual: {
                        kind: 'manual' as const,
                        complete,
                    },
                },
            },
        } satisfies PluginConnectedAccountRuntime;
        const createInvoker = (status: 'available' | 'denied') =>
            createConnectedAccountHostRuntimeInvoker({
                resolveRuntime: async () => Object.freeze({
                    ref: service,
                    generation: 'generation-1',
                    immutableGenerationId: 'artifact-1',
                    descriptor,
                    runtime: deniedRuntime,
                    isCurrent: () => true,
                }),
                resolvePlugin: () => Object.freeze({
                    version: '1.0.0',
                    hostAccessRequests: Object.freeze([networkRequest]),
                }),
                resolveHostPolicy: () => Object.freeze({
                    hostAccess: Object.freeze([{
                        id: networkRequest.request.id,
                        required: true,
                        status,
                        requestFingerprint: 'test-fingerprint',
                    }]),
                    serviceBinding:
                        createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                            'generation-1',
                            'producer',
                            [networkRequest],
                        ),
                }),
                createServices: () => Object.freeze({}) as PluginInvocationContext['services'],
                resolveHostOwnedConfiguredOrigins: vi.fn(() => Object.freeze([])),
            });
        const invocation = {
            admission: Object.freeze({
                service,
                descriptor: mode,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
                modeId: mode.id,
            }),
            operation: Object.freeze({
                kind: 'submitManual',
                fields: Object.freeze({ token: 'user-input' }),
            }),
            context: Object.freeze({
                service,
                attempt: Object.freeze({
                    kind: 'connect',
                    attemptId: 'attempt-1',
                }),
                configuration: Object.freeze({
                    target: Object.freeze({
                        kind: 'service',
                        service,
                        modeId: mode.id,
                    }),
                    revision: 'configuration-1',
                    values: Object.freeze({}),
                    getSecret: async () => null,
                }),
                attemptCredentials: Object.freeze({
                    get: async () => null,
                    set: async () => {},
                    delete: async () => {},
                }),
            }),
            isConfigurationCurrent: () => true,
        } as const;

        await expect(createInvoker('denied').invokeAuthentication(invocation)).resolves.toEqual({
            status: 'unavailable',
            diagnostic: {
                code: 'connected_account_producer_context_unavailable',
            },
        });
        expect(complete).not.toHaveBeenCalled();

        const providerFailure = new Error('Provider exchange outcome is unknown');
        complete.mockRejectedValueOnce(providerFailure);
        await expect(
            createInvoker('available').invokeAuthentication(invocation),
        ).rejects.toBe(providerFailure);
        expect(complete).toHaveBeenCalledOnce();
    });

    it('does not grant authentication or established producer fetch from an ordinary fixed-origin network request', async () => {
        const networkRequest = Object.freeze({
            request: PluginHostAccessRequestV2Schema.parse({
                id: 'ordinary-network',
                capability: 'network',
                reason: 'Unrelated plugin network access',
                scope: {
                    targets: [{
                        kind: 'fixedOrigin',
                        origin: 'https://api.example.test',
                    }],
                },
            }),
            required: true,
        });
        const observedFetch: unknown[] = [];
        const createServices = vi.fn((_seed, binding) => {
            observedFetch.push(binding.availability.fetch);
            return Object.freeze({}) as PluginInvocationContext['services'];
        });
        const invoker = createConnectedAccountHostRuntimeInvoker({
            resolveRuntime: async () => Object.freeze({
                ref: service,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
                descriptor,
                runtime: runtime((context) => {
                    expect(context.services).toBeDefined();
                }),
                isCurrent: () => true,
            }),
            resolvePlugin: () => Object.freeze({
                version: '1.0.0',
                hostAccessRequests: Object.freeze([networkRequest]),
            }),
            resolveHostPolicy: () => Object.freeze({
                hostAccess: Object.freeze([{
                    id: networkRequest.request.id,
                    required: true,
                    status: 'available' as const,
                    requestFingerprint: 'test-fingerprint',
                }]),
                serviceBinding:
                    createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                        'generation-1',
                        'producer',
                        [networkRequest],
                    ),
            }),
            createServices,
            resolveHostOwnedConfiguredOrigins: vi.fn(() => Object.freeze([])),
        });

        await expect(invoker.invokeAuthentication({
            admission: Object.freeze({
                service,
                descriptor: mode,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
                modeId: mode.id,
            }),
            operation: Object.freeze({
                kind: 'submitManual',
                fields: Object.freeze({ token: 'user-input' }),
            }),
            context: Object.freeze({
                service,
                attempt: Object.freeze({
                    kind: 'connect',
                    attemptId: 'attempt-1',
                }),
                configuration: Object.freeze({
                    target: Object.freeze({
                        kind: 'service',
                        service,
                        modeId: mode.id,
                    }),
                    revision: 'configuration-1',
                    values: Object.freeze({}),
                    getSecret: async () => null,
                }),
                attemptCredentials: Object.freeze({
                    get: async () => null,
                    set: async () => {},
                    delete: async () => {},
                }),
            }),
            isConfigurationCurrent: () => true,
        })).resolves.toMatchObject({ status: 'connected' });

        await expect(invoker.invokeEstablished({
            target: Object.freeze({
                account: Object.freeze({
                    service,
                    accountId: 'account-a',
                }),
                expectedCredentialRevision: 'credential-1',
                expectedRuntimeConfigurationRevision: 'configuration-1',
            }),
            operation: Object.freeze({ kind: 'status' }),
            context: Object.freeze({
                account: Object.freeze({
                    service,
                    accountId: 'account-a',
                }),
                configuration: Object.freeze({
                    target: Object.freeze({
                        kind: 'service',
                        service,
                        modeId: mode.id,
                    }),
                    revision: 'configuration-1',
                    values: Object.freeze({}),
                    getSecret: async () => null,
                }),
                credentials: Object.freeze({
                    get: async () => null,
                }),
            }),
            isConfigurationCurrent: () => true,
            isCredentialRevisionCurrent: () => true,
        })).resolves.toMatchObject({ status: 'connected' });

        expect(observedFetch).toEqual(['unavailable', 'unavailable']);
    });
});
