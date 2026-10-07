import { describe, expect, it, vi } from 'vitest';

import {
    ConnectedServiceCredentialRevisionV1Schema,
    PluginConnectedAccountAuthenticationModeV2Schema,
    PluginConnectedAccountDescriptorContributionV2Schema,
    PluginHostAccessRequestV2Schema,
} from '@happier-dev/protocol';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type {
    TargetPluginInterceptedRequest as PluginInterceptedRequest,
} from '../lifecycle/contributions/targetRequestInterceptors';
import type {
    ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type {
    ResolvedConnectedAccountDescriptorContribution,
} from '@/plugins/projection/registry/types';
import {
    createStablePluginHttpHost,
    type PluginRequestInterceptorRegistryV1,
} from '@/plugins/runtime/fetch/service';
import {
    createLoggerAndEventsAvailablePluginInvocationServiceBinding,
} from '@/plugins/runtime/invocation/services/factory';
import {
    createProductionPluginInvocationServiceOwners,
} from '@/plugins/runtime/invocation/services/production';
import type {
    PluginInvocationLogRecord,
} from '@/plugins/runtime/invocation/services/logger';
import {
    createConnectedAccountAuthenticationAttemptOwner,
    type ConnectedAccountAttemptProviderInvocation,
    type ConnectedAccountOAuthCallbackCompletion,
} from './authenticationAttemptOwner';
import {
    createConnectedAccountContributionRegistry,
    type ConnectedAccountRuntimeLease,
} from './contributionRegistry';
import { createPluginRuntimeOccurrenceId } from '../runtimeSlots';
import { createConnectedAccountConfigurationOwner } from './configurationOwner';
import {
    createConnectedAccountHostRuntimeInvoker,
    type ConnectedAccountRuntimeEstablishedOperation,
} from './runtimeInvoker';

type AuthenticationRuntime =
    PluginConnectedAccountRuntime['authentication']['modes'][string];

// DNS is the one system boundary the configured-origin resolution reaches, and
// the invoker forwards this resolver to it. Every fixture name below answers
// with a public address, so admission here is decided by resolved addresses
// rather than by the hostname's spelling.
const RESOLVED_ADDRESSES_BY_HOSTNAME: Readonly<Record<string, readonly string[]>> = Object.freeze({
    'api.telegram.org': ['149.154.167.220'],
    'api.example.test': ['93.184.216.34'],
});
const testResolveNetworkAddresses = async (hostname: string): Promise<readonly string[]> => {
    const addresses = RESOLVED_ADDRESSES_BY_HOSTNAME[hostname];
    if (!addresses) throw new Error(`unexpected DNS lookup for ${hostname}`);
    return addresses;
};

const service = Object.freeze({
    pluginId: 'acme.accounts',
    localId: 'work',
});
const runtimeIdentity = Object.freeze({
    occurrenceId: createPluginRuntimeOccurrenceId(service.pluginId),
    sourceCustody: Object.freeze({
        kind: 'managed' as const,
        immutableGenerationId: 'artifact-1',
        installSource: 'archive' as const,
    }),
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

function createEstablishedInvoker(
    registeredRuntime: PluginConnectedAccountRuntime,
    isCurrent: () => boolean = () => true,
    declaresRecoveryCredits = registeredRuntime.recoveryCredits !== undefined,
) {
    return createConnectedAccountHostRuntimeInvoker({
        resolveNetworkAddresses: testResolveNetworkAddresses,
        resolveRuntime: async () => Object.freeze({
            ref: service,
            ...runtimeIdentity,
            descriptor: { ...descriptor, ...(declaresRecoveryCredits ? { recoveryCredits: { supported: true as const } } : {}) },
            runtime: registeredRuntime,
            isCurrent,
        }),
        resolvePlugin: () => Object.freeze({
            version: '1.0.0',
            hostAccessRequests: Object.freeze([]),
        }),
        resolveHostPolicy: () => Object.freeze({
            hostAccess: Object.freeze([]),
            serviceBinding:
                createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                    runtimeIdentity.occurrenceId,
                    'producer',
                    [],
                ),
        }),
        createServices: () =>
            Object.freeze({}) as PluginInvocationContext['services'],
        registerRawForRedaction() {},
        resolveHostOwnedConfiguredEndpoints: () => Object.freeze([]),
    });
}

function invokeEstablished(
    invoker: ReturnType<typeof createEstablishedInvoker>,
    operation: ConnectedAccountRuntimeEstablishedOperation,
    isCurrent: () => boolean = () => true,
) {
    return invoker.invokeEstablished({
        target: Object.freeze({
            account: Object.freeze({ service, accountId: 'account-a' }),
            expectedCredentialRevision: 'credential-1',
            expectedRuntimeConfigurationRevision: 'configuration-1',
        }),
        operation,
        context: Object.freeze({
            account: Object.freeze({ service, accountId: 'account-a' }),
            configuration: Object.freeze({
                target: Object.freeze({
                    kind: 'service' as const,
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
        isConfigurationCurrent: isCurrent,
        isCredentialRevisionCurrent: isCurrent,
    });
}

describe('connected-account runtime invoker', () => {
    it('preserves every quota window returned by a trusted runtime without a host item cap', async () => {
        const quota = {
            observedAtMs: 1_000,
            planLabel: 'Acme Enterprise',
            limits: Array.from({ length: 129 }, (_, index) => ({
                id: `window-${index}`,
                remaining: index,
            })),
        };
        const invoker = createEstablishedInvoker({
            ...runtime(() => {}),
            async quota() { return quota; },
        });

        await expect(invokeEstablished(invoker, { kind: 'quota' })).resolves.toEqual(quota);
    });
    it('accepts a trusted runtime materialization with computed SDK fields', async () => {
        const headers = { authorization: 'Bearer computed-credential' };
        const invoker = createEstablishedInvoker({
            ...runtime(() => {}),
            async materialize() {
                return { kind: 'httpHeaders', get headers() { return headers; } };
            },
        });
        await expect(invokeEstablished(invoker, {
            kind: 'materialize', request: {
                kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'],
            },
        })).resolves.toEqual({ kind: 'httpHeaders', headers });
    });
    it('consumes through the optional recovery facet under exact account context and fails closed without it', async () => {
        const operation = { kind: 'recoveryCredits.consume', request: { idempotencyKey: 'key-1', providerCreditId: 'credit-1' } } as const;
        const invoker = createEstablishedInvoker({
            ...runtime(() => {}),
            recoveryCredits: {
                async read() { return { observedAtMs: 1, availableCount: 1, credits: [] }; },
                async consume(request, context) {
                    expect(context.account).toEqual({ service, accountId: 'account-a' });
                    expect(request).toEqual(operation.request);
                    return { status: 'consumed' };
                },
            },
        });
        await expect(invokeEstablished(invoker, operation)).resolves.toEqual({ status: 'consumed' });
        await expect(invokeEstablished(createEstablishedInvoker(runtime(() => {})), operation)).resolves.toBeNull();
        const undeclared = createEstablishedInvoker({
            ...runtime(() => {}),
            recoveryCredits: {
                async read() { throw new Error('Undeclared read reached provider'); },
                async consume() { throw new Error('Undeclared consume reached provider'); },
            },
        }, () => true, false);
        await expect(invokeEstablished(undeclared, operation)).resolves.toBeNull();
    });
    it('settles an entered authentication callback across runtime reload when its captured configuration is current', async () => {
        let generationCurrent = true;
        let releaseCompletion!: () => void;
        let markEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
            markEntered = resolve;
        });
        const completion = new Promise<void>((resolve) => {
            releaseCompletion = resolve;
        });
        const registeredRuntime: PluginConnectedAccountRuntime = {
            ...runtime(() => {}),
            authentication: {
                modes: {
                    manual: {
                        kind: 'manual',
                        async complete() {
                            markEntered();
                            await completion;
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
        };
        const invoker = createEstablishedInvoker(
            registeredRuntime,
            () => generationCurrent,
        );

        const outcome = invoker.invokeAuthentication({
            admission: Object.freeze({
                service,
                descriptor: mode,
                ...runtimeIdentity,
                modeId: mode.id,
            }),
            operation: Object.freeze({
                kind: 'submitManual',
                fields: Object.freeze({ token: 'candidate' }),
            }),
            context: Object.freeze({
                service,
                attempt: Object.freeze({ kind: 'connect', attemptId: 'attempt-1' }),
                configuration: Object.freeze({
                    target: Object.freeze({ kind: 'service', service, modeId: mode.id }),
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
        });

        await entered;
        generationCurrent = false;
        releaseCompletion();

        await expect(outcome).resolves.toEqual({
            status: 'connected', accountId: 'account-a', displayName: 'Account A', scopes: [],
        });
    });

    it('copies file materialization bytes into a detached host-owned result', async () => {
        const pluginBytes = new Uint8Array([1, 2, 3]);
        const pluginFiles = Object.freeze({ credential: pluginBytes });
        const pluginResult = Object.freeze({
            kind: 'files' as const,
            files: pluginFiles,
        });
        const registeredRuntime: PluginConnectedAccountRuntime = {
            ...runtime(() => {}),
            async materialize() {
                return pluginResult;
            },
        };

        const result = await invokeEstablished(
            createEstablishedInvoker(registeredRuntime),
            Object.freeze({
                kind: 'materialize' as const,
                request: Object.freeze({
                    kind: 'files' as const,
                    fileIds: Object.freeze(['credential']),
                }),
            }),
        );
        if (result.kind !== 'files') {
            throw new Error('Expected files materialization');
        }

        expect(result).not.toBe(pluginResult);
        expect(result.files).not.toBe(pluginFiles);
        expect(result.files.credential).not.toBe(pluginBytes);
        pluginBytes[0] = 9;
        expect([...result.files.credential!]).toEqual([1, 2, 3]);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.files)).toBe(true);
    });

    it.each([
        Object.freeze({
            name: 'a Node Buffer',
            createBytes: () => Buffer.from([1, 2, 3]),
        }),
        Object.freeze({
            name: 'a Uint8Array subarray',
            createBytes: () => new Uint8Array([0, 1, 2, 3]).subarray(1),
        }),
    ])('accepts $name as binary file materialization and copies it', async ({ createBytes }) => {
        const pluginBytes = createBytes();
        const pluginResult = Object.freeze({
            kind: 'files' as const,
            files: Object.freeze({ credential: pluginBytes }),
        });
        const registeredRuntime: PluginConnectedAccountRuntime = {
            ...runtime(() => {}),
            async materialize() {
                return pluginResult;
            },
        };

        const result = await invokeEstablished(
            createEstablishedInvoker(registeredRuntime),
            Object.freeze({
                kind: 'materialize' as const,
                request: Object.freeze({
                    kind: 'files' as const,
                    fileIds: Object.freeze(['credential']),
                }),
            }),
        );
        if (result.kind !== 'files') {
            throw new Error('Expected files materialization');
        }

        expect(result.files.credential).not.toBe(pluginBytes);
        pluginBytes[0] = 9;
        expect([...result.files.credential!]).toEqual([1, 2, 3]);
    });

    it('redacts runtime credential reads and fences a retained logger after settlement', async () => {
        const records: PluginInvocationLogRecord[] = [];
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: (record) => { records.push(record); } },
        });
        const credential = 'runtime credential value';
        const configurationSecret = 'runtime configuration secret';
        const retained = {
            logger: null as PluginInvocationContext['services']['logger'] | null,
        };
        const registeredRuntime: PluginConnectedAccountRuntime = {
            ...runtime(() => {}),
            async status(context) {
                const readCredential = await context.credentials.get('token');
                const readConfigurationSecret =
                    await context.configuration.getSecret('clientSecret');
                context.services.logger.info('connected account values', {
                    credential: readCredential,
                    credentialBase64: Buffer.from(readCredential ?? '').toString('base64'),
                    configurationSecret: readConfigurationSecret,
                    configurationSecretHex: Buffer.from(
                        readConfigurationSecret ?? '',
                    ).toString('hex'),
                });
                retained.logger = context.services.logger;
                return { status: 'connected' };
            },
        };
        const invoker = createConnectedAccountHostRuntimeInvoker({
            resolveNetworkAddresses: testResolveNetworkAddresses,
            resolveRuntime: async () => Object.freeze({
                ref: service,
                ...runtimeIdentity,
                descriptor,
                runtime: registeredRuntime,
                isCurrent: () => true,
            }),
            resolvePlugin: () => Object.freeze({
                version: '1.0.0',
                hostAccessRequests: Object.freeze([]),
            }),
            resolveHostPolicy: () => Object.freeze({
                hostAccess: Object.freeze([]),
                serviceBinding: owners.createOrdinaryServiceBinding(
                    runtimeIdentity.occurrenceId,
                    'connected-runtime',
                ),
            }),
            createServices: owners.createServices,
            registerRawForRedaction: owners.registerRawForRedaction,
            resolveHostOwnedConfiguredEndpoints: () => Object.freeze([]),
        });

        await expect(invoker.invokeEstablished({
            target: Object.freeze({
                account: Object.freeze({ service, accountId: 'account-a' }),
                expectedCredentialRevision: 'credential-1',
                expectedRuntimeConfigurationRevision: 'configuration-1',
            }),
            operation: Object.freeze({ kind: 'status' }),
            context: Object.freeze({
                account: Object.freeze({ service, accountId: 'account-a' }),
                configuration: Object.freeze({
                    target: Object.freeze({
                        kind: 'service',
                        service,
                        modeId: mode.id,
                    }),
                    revision: 'configuration-1',
                    values: Object.freeze({}),
                    getSecret: async () => configurationSecret,
                }),
                credentials: Object.freeze({
                    get: async () => credential,
                }),
            }),
            isConfigurationCurrent: () => true,
            isCredentialRevisionCurrent: () => true,
        })).resolves.toEqual({ status: 'connected' });

        const serialized = JSON.stringify(records);
        expect(serialized).toContain('[REDACTED]');
        expect(serialized).not.toContain(credential);
        expect(serialized).not.toContain(Buffer.from(credential).toString('base64'));
        expect(serialized).not.toContain(configurationSecret);
        expect(serialized).not.toContain(Buffer.from(configurationSecret).toString('hex'));
        expect(records).toHaveLength(1);
        retained.logger?.info('must not log after settlement');
        expect(records).toHaveLength(1);
        await owners.retireGeneration(runtimeIdentity.occurrenceId, service.pluginId);
    });

    it('redacts secret manual-auth fields before cross-plugin interception while preserving terminal HTTP bytes', async () => {
        const token = '123456:telegram-secret';
        const issuedToken = 'provider-issued-secret';
        const rawUrl = `https://api.telegram.org/bot${token}/getMe`;
        const issuedUrl = `https://api.telegram.org/bot${issuedToken}/getMe`;
        const body = new TextEncoder().encode('terminal-only request body');
        const interceptedRequests: unknown[] = [];
        const terminalRequests: Parameters<HttpService['request']>[0][] = [];
        let owners!: ReturnType<typeof createProductionPluginInvocationServiceOwners>;
        const interceptorRegistry: PluginRequestInterceptorRegistryV1 = Object.freeze({
            declarations: Object.freeze([Object.freeze({
                pluginId: 'observer.plugin',
                contribution: Object.freeze({
                    id: 'observe',
                    origins: ['https://api.telegram.org'],
                }),
            })]),
            activateContributionsOnDemand: async () => Object.freeze([]),
            readBindings: () => Object.freeze([Object.freeze({
                pluginId: 'observer.plugin',
                contribution: Object.freeze({
                    id: 'observe',
                    origins: ['https://api.telegram.org'],
                }),
                async invoke(request: PluginInterceptedRequest) {
                    interceptedRequests.push(request);
                    return Object.freeze({ decision: 'continue' as const, request });
                },
            })]),
        });
        const httpHost = createStablePluginHttpHost({
            adapter: Object.freeze({
                async request(request) {
                    terminalRequests.push(request);
                    return Object.freeze({
                        status: 200,
                        finalUrl: request.url,
                        headers: Object.freeze({}),
                        body: new Uint8Array(),
                    });
                },
                async openWebSocket() {
                    throw new Error('WebSocket is unavailable in this test');
                },
            }),
            interceptorRegistry,
            redactInterceptorText: ({ seed, value }) => owners.redactDiagnosticText({
                pluginId: seed.plugin.id,
                occurrenceId: seed.occurrenceId,
                correlationId: seed.correlationId,
            }, value),
        });
        owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            http: httpHost,
        });
        const networkRequest = Object.freeze({
            request: PluginHostAccessRequestV2Schema.parse({
                id: 'telegram-network',
                capability: 'network',
                reason: 'Authenticate the Telegram bot',
                scope: {
                    targets: [{
                        kind: 'connectedAccountOrigin',
                        service,
                    }, {
                        kind: 'fixedOrigin',
                        origin: 'https://api.telegram.org',
                    }],
                    methods: ['POST'],
                },
            }),
            required: true,
        });
        const registeredRuntime: PluginConnectedAccountRuntime = {
            ...runtime(() => {}),
            authentication: {
                modes: {
                    manual: {
                        kind: 'manual',
                        async complete(input, context) {
                            await context.services.http.request({
                                url: `https://api.telegram.org/bot${input.fields.token}/getMe`,
                                method: 'POST',
                                body,
                                redirect: 'error',
                            });
                            await context.attemptCredentials.set('issued-token', issuedToken);
                            await context.services.http.request({
                                url: issuedUrl,
                                method: 'POST',
                                redirect: 'error',
                            });
                            return {
                                status: 'rejected',
                                diagnostic: {
                                    code: 'provider_rejected',
                                    severity: 'error',
                                    message: `Provider rejected ${issuedToken}`,
                                    details: {
                                        providerDetail:
                                            `Provider rejected ${issuedToken}`,
                                    },
                                },
                            };
                        },
                    },
                },
            },
        };
        const invoker = createConnectedAccountHostRuntimeInvoker({
            resolveNetworkAddresses: testResolveNetworkAddresses,
            resolveRuntime: async () => Object.freeze({
                ref: service,
                ...runtimeIdentity,
                descriptor,
                runtime: registeredRuntime,
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
                serviceBinding: createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                    runtimeIdentity.occurrenceId,
                    'telegram-producer',
                    [networkRequest],
                ),
            }),
            createServices: owners.createServices,
            registerRawForRedaction: owners.registerRawForRedaction,
            redactDiagnosticText(seed, value) {
                return owners.redactDiagnosticText({
                    pluginId: seed.plugin.id,
                    occurrenceId: seed.occurrenceId,
                    correlationId: seed.correlationId,
                }, value);
            },
            resolveHostOwnedConfiguredEndpoints: () => Object.freeze([Object.freeze({
                origin: 'https://api.telegram.org',
                base: 'https://api.telegram.org',
                grantTargetKind: 'connectedAccountOrigin' as const,
            })]),
        });

        await expect(invoker.invokeAuthentication({
            admission: Object.freeze({
                service,
                descriptor: mode,
                ...runtimeIdentity,
                modeId: mode.id,
            }),
            operation: Object.freeze({
                kind: 'submitManual',
                fields: Object.freeze({ token }),
            }),
            context: Object.freeze({
                service,
                attempt: Object.freeze({ kind: 'connect', attemptId: 'attempt-1' }),
                configuration: Object.freeze({
                    target: Object.freeze({ kind: 'service', service, modeId: mode.id }),
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
        })).resolves.toEqual({
            status: 'rejected',
            diagnostic: {
                code: 'provider_rejected',
                severity: 'error',
                message: 'Provider rejected [REDACTED]',
                details: {
                    providerDetail: 'Provider rejected [REDACTED]',
                },
            },
        });

        expect(interceptedRequests).toEqual([
            {
                url: 'https://api.telegram.org/bot[REDACTED]/getMe',
                method: 'POST',
                headers: {},
            },
            {
                url: 'https://api.telegram.org/bot[REDACTED]/getMe',
                method: 'POST',
                headers: {},
            },
        ]);
        expect(JSON.stringify(interceptedRequests)).not.toContain(token);
        expect(JSON.stringify(interceptedRequests)).not.toContain(issuedToken);
        expect(terminalRequests).toEqual([
            expect.objectContaining({ url: rawUrl, body }),
            expect.objectContaining({ url: issuedUrl }),
        ]);
        await owners.dispose();
    });

    it('registers staged refresh credential reads and writes for the invocation redactor', async () => {
        const existingCredential = 'existing-refresh-secret';
        const issuedCredential = 'issued-refresh-secret';
        const registerRawForRedaction = vi.fn();
        const stagedSet = vi.fn(async () => {});
        const registeredRuntime: PluginConnectedAccountRuntime = {
            ...runtime(() => {}),
            async refresh(context) {
                // A Connected Account mutation context carries the mutation's own
                // `operation` metadata. It is not an Action invocation, so the host
                // must not advertise an Action progress reporter it would discard.
                expect(context.operation).toEqual({
                    operationId: 'refresh-1',
                    configurationRevision: 'configuration-1',
                });
                expect(Object.hasOwn(context.operation, 'update')).toBe(false);
                await context.stagedCredentials.get('existing-token');
                await context.stagedCredentials.set('issued-token', issuedCredential);
                return { status: 'connected' };
            },
        };
        const invoker = createConnectedAccountHostRuntimeInvoker({
            resolveNetworkAddresses: testResolveNetworkAddresses,
            resolveRuntime: async () => Object.freeze({
                ref: service,
                ...runtimeIdentity,
                descriptor,
                runtime: registeredRuntime,
                isCurrent: () => true,
            }),
            resolvePlugin: () => Object.freeze({
                version: '1.0.0',
                hostAccessRequests: Object.freeze([]),
            }),
            resolveHostPolicy: () => Object.freeze({
                hostAccess: Object.freeze([]),
                serviceBinding: createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                    runtimeIdentity.occurrenceId,
                    'refresh-producer',
                    [],
                ),
            }),
            createServices: () => Object.freeze({}) as PluginInvocationContext['services'],
            registerRawForRedaction,
            resolveHostOwnedConfiguredEndpoints: () => Object.freeze([]),
        });

        await expect(invoker.invokeEstablished({
            target: Object.freeze({
                account: Object.freeze({ service, accountId: 'account-a' }),
                expectedCredentialRevision: 'credential-1',
                expectedRuntimeConfigurationRevision: 'configuration-1',
            }),
            operation: Object.freeze({
                kind: 'refresh',
                operationId: 'refresh-1',
                stagedCredentials: Object.freeze({
                    get: async () => existingCredential,
                    set: stagedSet,
                    delete: async () => {},
                }),
            }),
            context: Object.freeze({
                account: Object.freeze({ service, accountId: 'account-a' }),
                configuration: Object.freeze({
                    target: Object.freeze({ kind: 'service', service, modeId: mode.id }),
                    revision: 'configuration-1',
                    values: Object.freeze({}),
                    getSecret: async () => null,
                }),
                credentials: Object.freeze({ get: async () => null }),
            }),
            isConfigurationCurrent: () => true,
            isCredentialRevisionCurrent: () => true,
        })).resolves.toEqual({ status: 'connected' });

        expect(registerRawForRedaction.mock.calls.map(([, value]) => value))
            .toEqual([existingCredential, issuedCredential]);
        expect(stagedSet).toHaveBeenCalledWith('issued-token', issuedCredential, undefined);
    });

    it('registers OAuth state and completion credentials before provider handlers run', async () => {
        const oauthMode = PluginConnectedAccountAuthenticationModeV2Schema.parse({
            id: 'oauth',
            kind: 'oauthAuthorizationCode',
            pkce: 'required',
            outcomeReconciliation: 'providerCheck',
        });
        const registerRawForRedaction = vi.fn();
        const observedRegistrations: string[][] = [];
        const registeredRuntime: PluginConnectedAccountRuntime = {
            ...runtime(() => {}),
            authentication: {
                modes: {
                    oauth: {
                        kind: 'oauthAuthorizationCode',
                        async begin() {
                            observedRegistrations.push(
                                registerRawForRedaction.mock.calls.map(([, value]) => value),
                            );
                            return {
                                status: 'awaitingOAuthRedirect',
                                authorizationUrl: 'https://provider.example/authorize',
                            };
                        },
                        async complete() {
                            observedRegistrations.push(
                                registerRawForRedaction.mock.calls.map(([, value]) => value),
                            );
                            return {
                                status: 'connected',
                                accountId: 'account-a',
                                displayName: 'Account A',
                                scopes: [],
                            };
                        },
                        async cancel() {},
                    },
                },
            },
        };
        const invoker = createConnectedAccountHostRuntimeInvoker({
            resolveNetworkAddresses: testResolveNetworkAddresses,
            resolveRuntime: async () => Object.freeze({
                ref: service,
                ...runtimeIdentity,
                descriptor,
                runtime: registeredRuntime,
                isCurrent: () => true,
            }),
            resolvePlugin: () => Object.freeze({
                version: '1.0.0',
                hostAccessRequests: Object.freeze([]),
            }),
            resolveHostPolicy: () => Object.freeze({
                hostAccess: Object.freeze([]),
                serviceBinding: createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                    runtimeIdentity.occurrenceId,
                    'oauth-producer',
                    [],
                ),
            }),
            createServices: () => Object.freeze({}) as PluginInvocationContext['services'],
            registerRawForRedaction,
            resolveHostOwnedConfiguredEndpoints: () => Object.freeze([]),
        });
        const context = Object.freeze({
            service,
            attempt: Object.freeze({ kind: 'connect' as const, attemptId: 'attempt-1' }),
            configuration: Object.freeze({
                target: Object.freeze({ kind: 'service' as const, service, modeId: oauthMode.id }),
                revision: 'configuration-1',
                values: Object.freeze({}),
                getSecret: async () => null,
            }),
            attemptCredentials: Object.freeze({
                get: async () => null,
                set: async () => {},
                delete: async () => {},
            }),
        });
        const admission = Object.freeze({
            service,
            descriptor: oauthMode,
            ...runtimeIdentity,
            modeId: oauthMode.id,
        });

        await invoker.invokeAuthentication({
            admission,
            operation: Object.freeze({
                kind: 'beginOAuth',
                request: Object.freeze({
                    callbackUrl: 'http://127.0.0.1/callback',
                    state: 'oauth-state-secret',
                    pkce: Object.freeze({ challenge: 'public-challenge', method: 'S256' as const }),
                }),
            }),
            context,
            isConfigurationCurrent: () => true,
        });
        await invoker.invokeAuthentication({
            admission,
            operation: Object.freeze({
                kind: 'completeOAuth',
                completion: Object.freeze({
                    code: 'oauth-code-secret',
                    callbackUrl: 'http://127.0.0.1/callback?code=oauth-code-secret',
                    state: 'oauth-state-secret',
                    pkceVerifier: 'pkce-verifier-secret',
                }),
            }),
            context,
            isConfigurationCurrent: () => true,
        });

        expect(observedRegistrations).toEqual([
            ['oauth-state-secret'],
            [
                'oauth-state-secret',
                'oauth-code-secret',
                'http://127.0.0.1/callback?code=oauth-code-secret',
                'oauth-state-secret',
                'pkce-verifier-secret',
            ],
        ]);
    });

    it.each([
        { successor: 'unavailable', authentication: 'manual', retirement: 'callback' },
        { successor: 'sameSource', authentication: 'manual', retirement: 'callback' },
        { successor: 'changedSource', authentication: 'manual', retirement: 'callback' },
        { successor: 'configurationChanged', authentication: 'device', retirement: 'callback' },
        { successor: 'sameSource', authentication: 'device', retirement: 'callback' },
        { successor: 'sameSource', authentication: 'manual', retirement: 'command' },
        { successor: 'changedForm', authentication: 'manual', retirement: 'command' },
        { successor: 'sameSource', authentication: 'manual', retirement: 'resolution' },
    ] as const)(
        'preserves captured $authentication state when the runtime becomes $successor at $retirement', async ({ successor, authentication, retirement }) => {
        const authenticationMode = authentication === 'manual' ? mode
            : PluginConnectedAccountAuthenticationModeV2Schema.parse({
                id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'none',
                ...(successor === 'configurationChanged' ? { configuration: {
                    scope: 'service', changeBehavior: 'reconnect', fields: [{
                        id: 'endpoint', title: 'Endpoint', schema: { type: 'string' }, required: true,
                    }],
                } } : {}),
            });
        const serviceDescriptor = { ...descriptor, authentication: { defaultModeId: authenticationMode.id, modes: [authenticationMode] } };
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
                    device: {
                        kind: 'oauthDeviceCode' as const,
                        begin: async () => {
                            await complete();
                            return {
                                status: 'awaitingDeviceAuthorization' as const,
                                verificationUri: 'https://provider.example/device',
                                userCode: 'ABCD',
                                expiresAtMs: 61_000,
                                pollIntervalMs: 5_000,
                            };
                        },
                        poll: complete,
                        cancel: async () => {},
                    },
                },
            },
        } satisfies PluginConnectedAccountRuntime;
        const contribution: ResolvedConnectedAccountDescriptorContribution = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: service.pluginId,
            definition: serviceDescriptor,
        };
        let identity: Pick<ConnectedAccountRuntimeLease, 'occurrenceId' | 'sourceCustody'> = runtimeIdentity;
        const createRegistry = () => createConnectedAccountContributionRegistry({
            readPluginOccurrenceId: () => identity.occurrenceId,
            readPluginSourceCustody: () => identity.sourceCustody,
            isPluginOccurrenceCurrent: (_pluginId, occurrenceId) => occurrenceId === identity.occurrenceId,
            descriptors: [successor === 'changedForm' && mode.kind === 'manual' && identity !== runtimeIdentity ? {
                ...contribution,
                definition: {
                    ...serviceDescriptor,
                    authentication: {
                        defaultModeId: 'manual',
                        modes: [{ ...mode, fields: [{ id: 'apiKey', title: 'API key', schema: { type: 'string' }, secret: true }] }],
                    },
                },
            } : contribution],
            activateOnDemand: async () => {},
            readRegistrations: () => [{
                pluginId: service.pluginId,
                occurrenceId: identity.occurrenceId,
                localId: service.localId,
                runtime: successor === 'changedForm' && identity !== runtimeIdentity ? {
                    ...registeredRuntime,
                    authentication: { modes: { manual: { kind: 'manual', complete: async ({ fields }) => {
                        if (!fields.apiKey) return { status: 'rejected', diagnostic: { code: 'missing_api_key', severity: 'error' } };
                        return { status: 'connected', displayName: 'Successor', scopes: [] };
                    } } } },
                } : registeredRuntime,
            }],
        });
        let registry = createRegistry();
        const publishSuccessor = () => {
            registry.dispose();
            if (successor !== 'unavailable') {
                identity = Object.freeze({
                    occurrenceId: createPluginRuntimeOccurrenceId(service.pluginId),
                    sourceCustody: Object.freeze({
                        ...runtimeIdentity.sourceCustody,
                        immutableGenerationId: successor === 'changedSource' ? 'artifact-2' : 'artifact-1',
                    }),
                });
                registry = createRegistry();
            }
        };
        const admittedLease = await registry.resolve(service);
        if (!admittedLease) throw new Error('Expected a resolvable connected-account lease');
        const configurationOwner = createConnectedAccountConfigurationOwner({
            // Configuration records and saved secrets are persistence boundaries;
            // snapshot admission/currentness beneath them remain the real owner.
            read: async () => successor === 'configurationChanged' ? {
                revision: identity === runtimeIdentity ? 'configuration-1' : 'configuration-2',
                values: { endpoint: 'https://provider.example' }, secretRefs: {},
            } : null,
            replace: async () => { throw new Error('This attempt must not replace configuration'); },
            destroyAttempt: async () => {},
            secrets: { admit: async () => {}, has: async () => false, read: async () => null },
            isRuntimeCurrent: (input) => registry.describe(service)?.isCurrent() === true
                && input.pluginId === service.pluginId && input.occurrenceId === identity.occurrenceId,
        });
        const invoker = createConnectedAccountHostRuntimeInvoker({
            resolveNetworkAddresses: testResolveNetworkAddresses,
            resolveRuntime: async (ref) => await registry.resolve(ref),
            resolvePlugin: () => Object.freeze({
                version: '1.0.0',
                hostAccessRequests: Object.freeze([]),
            }),
            resolveHostPolicy: () => Object.freeze({
                hostAccess: Object.freeze([]),
                serviceBinding:
                    createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                        runtimeIdentity.occurrenceId,
                        'producer',
                        [],
                    ),
            }),
            createServices: () => {
                if (identity === runtimeIdentity && retirement === 'callback') publishSuccessor();
                return Object.freeze({}) as PluginInvocationContext['services'];
            },
            registerRawForRedaction() {},
            resolveHostOwnedConfiguredEndpoints: () => Object.freeze([]),
        });
        const settle = vi.fn(async () => ({ status: 'connected' as const, account: { service, accountId: 'account-a' } }));
        const attempts = createConnectedAccountAuthenticationAttemptOwner({
            createAttemptId: () => 'attempt-1',
            createAccountId: () => 'account-1',
            now: () => 1_000,
            accounts: Object.freeze({
                readExact: async () => null,
            }),
            configuration: configurationOwner,
            runtime: Object.freeze({
                admit: async () => {
                    const lease = await registry.resolve(service);
                    if (!lease) throw new Error('Runtime unavailable');
                    return Object.freeze({
                        service,
                        descriptor: authenticationMode,
                        occurrenceId: lease.occurrenceId,
                        sourceCustody: lease.sourceCustody,
                        runtimeCustody: {
                            lease,
                            invoke: async (input: ConnectedAccountAttemptProviderInvocation) => invoker.invokeAuthentication({ ...input, isConfigurationCurrent: configurationOwner.isCurrent }),
                            release: async () => {},
                        },
                    });
                },
                isCurrent: async (admission) => registry.describe(service)?.isCurrent() === true
                    && admission.occurrenceId === identity.occurrenceId,
                invoke: async (input) => {
                    if (identity === runtimeIdentity && retirement === 'resolution') publishSuccessor();
                    return await invoker.invokeAuthentication({
                        ...input,
                        isConfigurationCurrent: configurationOwner.isCurrent,
                    });
                },
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
            modeId: authenticationMode.id,
        })).resolves.toEqual({
            status: authentication === 'manual' ? 'awaitingManual' : 'starting',
            attemptId: 'attempt-1',
        });
        if (authentication === 'device') {
            await vi.waitFor(async () => {
                expect(await attempts.read({ attemptId: 'attempt-1' })).toMatchObject({
                    status: successor === 'configurationChanged' ? 'conflict' : 'awaitingDeviceAuthorization',
                    attemptId: 'attempt-1',
                    ...(successor === 'configurationChanged'
                        ? { code: 'connected_account_configuration_changed' }
                        : { userCode: 'ABCD' }),
                });
            });
            if (successor === 'configurationChanged') expect(complete).not.toHaveBeenCalled();
            else expect(complete).toHaveBeenCalledOnce();
            expect(settle).not.toHaveBeenCalled();
            attempts.dispose();
            return;
        }
        if (retirement === 'command') publishSuccessor();
        const response = await attempts.submitManual({
            attemptId: 'attempt-1',
            fields: Object.freeze({ token: 'candidate' }),
        });
        expect(response).toEqual({
            status: 'connected',
            attemptId: 'attempt-1',
            account: { service, accountId: 'account-a' },
        });
        expect(complete).toHaveBeenCalledOnce();
        expect(settle).toHaveBeenCalledOnce();
        await expect(attempts.read({ attemptId: 'attempt-1' })).resolves.toEqual(response);
        await expect(attempts.reconcile({ attemptId: 'attempt-1' })).resolves.toEqual(response);
        await expect(attempts.cancel({ attemptId: 'attempt-1' })).resolves.toEqual(response);
        await expect(attempts.read({ attemptId: 'attempt-1' })).resolves.toMatchObject({
            status: 'unavailable', code: 'connected_account_attempt_not_found',
        });
        attempts.dispose();
    });

    it.each(['providerCheck', 'none'] as const)(
        'preserves %s uncertainty when a current lease retires after provider entry',
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
                definition: oauthDescriptor,
            };
            const registry = createConnectedAccountContributionRegistry({
                                readPluginOccurrenceId: () => runtimeIdentity.occurrenceId,
                readPluginSourceCustody: () => runtimeIdentity.sourceCustody,
                isPluginOccurrenceCurrent: () => true,
                descriptors: [contribution],
                activateOnDemand: async () => {},
                readRegistrations: () => [{
                    pluginId: service.pluginId,
                    occurrenceId: runtimeIdentity.occurrenceId,
                    localId: service.localId,
                    runtime: registeredRuntime,
                }],
            });
            const admittedLease = await registry.resolve(service);
            if (!admittedLease) throw new Error('Expected a resolvable connected-account lease');
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
                resolveNetworkAddresses: testResolveNetworkAddresses,
                resolveRuntime: async (ref) => await registry.resolve(ref),
                resolvePlugin: () => Object.freeze({
                    version: '1.0.0',
                    hostAccessRequests: Object.freeze([]),
                }),
                resolveHostPolicy: () => Object.freeze({
                    hostAccess: Object.freeze([]),
                    serviceBinding:
                        createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                            runtimeIdentity.occurrenceId,
                            'producer',
                            [],
                        ),
                }),
                createServices: () =>
                    Object.freeze({}) as PluginInvocationContext['services'],
                registerRawForRedaction() {},
                resolveHostOwnedConfiguredEndpoints: () => Object.freeze([]),
            });
            const settle = vi.fn();
            const attempts = createConnectedAccountAuthenticationAttemptOwner({
                createAttemptId: () => 'attempt-1',
                createAccountId: () => 'account-1',
                now: () => 1_000,
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
                        occurrenceId: admittedLease.occurrenceId,
                        sourceCustody: admittedLease.sourceCustody,
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
                        severity: 'error',
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
                resolveNetworkAddresses: testResolveNetworkAddresses,
                resolveRuntime: async () => Object.freeze({
                    ref: service,
                    ...runtimeIdentity,
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
                            runtimeIdentity.occurrenceId,
                            'producer',
                            [networkRequest],
                        ),
                }),
                createServices: () => Object.freeze({}) as PluginInvocationContext['services'],
                registerRawForRedaction() {},
                resolveHostOwnedConfiguredEndpoints: vi.fn(() => Object.freeze([])),
            });
        const invocation = {
            admission: Object.freeze({
                service,
                descriptor: mode,
                ...runtimeIdentity,
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
                severity: 'error',
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
            observedFetch.push(binding.availability.http);
            return Object.freeze({}) as PluginInvocationContext['services'];
        });
        const invoker = createConnectedAccountHostRuntimeInvoker({
            resolveNetworkAddresses: testResolveNetworkAddresses,
            resolveRuntime: async () => Object.freeze({
                ref: service,
                ...runtimeIdentity,
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
                        runtimeIdentity.occurrenceId,
                        'producer',
                        [networkRequest],
                    ),
            }),
            createServices,
            registerRawForRedaction() {},
            resolveHostOwnedConfiguredEndpoints: vi.fn(() => Object.freeze([])),
        });

        await expect(invoker.invokeAuthentication({
            admission: Object.freeze({
                service,
                descriptor: mode,
                ...runtimeIdentity,
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
