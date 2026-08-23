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
    ConnectedAccountMaterialization as PluginConnectedAccountMaterialization,
    ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

import {
    materializeFirstPartyConnectedAccountBearer,
} from '@/daemon/connectedServices/requestAuth/firstPartyConnectedAccountRequestAuthAdapter';
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
    type ConnectedAccountOAuthCallbackCompletion,
} from './authenticationAttemptOwner';
import {
    createConnectedAccountContributionRegistry,
} from './contributionRegistry';
import {
    createConnectedAccountHostRuntimeInvoker,
    type ConnectedAccountRuntimeEstablishedOperation,
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

function createEstablishedInvoker(
    registeredRuntime: PluginConnectedAccountRuntime,
    isCurrent: () => boolean = () => true,
) {
    return createConnectedAccountHostRuntimeInvoker({
        resolveRuntime: async () => Object.freeze({
            ref: service,
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            descriptor,
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
                    'generation-1',
                    'producer',
                    [],
                ),
        }),
        createServices: () =>
            Object.freeze({}) as PluginInvocationContext['services'],
        registerRawForRedaction() {},
        resolveHostOwnedConfiguredOrigins: () => Object.freeze([]),
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
    it('refuses a proxy materialization that retires its generation during request-auth inspection', async () => {
        let generationCurrent = true;
        const rawHeaders = Object.freeze({
            authorization: 'Bearer must-not-escape',
        });
        const materialization = new Proxy({
            kind: 'httpHeaders' as const,
            headers: rawHeaders,
        }, {
            ownKeys(target) {
                generationCurrent = false;
                return Reflect.ownKeys(target);
            },
        });
        const registeredRuntime: PluginConnectedAccountRuntime = {
            ...runtime(() => {}),
            async materialize() {
                return materialization;
            },
        };
        const invoker = createEstablishedInvoker(
            registeredRuntime,
            () => generationCurrent,
        );
        const credentialRevision =
            ConnectedServiceCredentialRevisionV1Schema.parse(
                'csr_abcdefghijklmnopqrstuv',
            );
        let disclosed: Awaited<
            ReturnType<typeof materializeFirstPartyConnectedAccountBearer>
        > | null = null;

        await expect((async () => {
            disclosed = await materializeFirstPartyConnectedAccountBearer({
                resolved: Object.freeze({
                    account: Object.freeze({
                        service,
                        accountId: 'account-a',
                    }),
                    credentialRevision,
                }),
                materialization: Object.freeze({
                    kind: 'httpHeaders' as const,
                    origin: 'https://api.example.test',
                    headerNames: Object.freeze(['authorization']),
                }),
                transport: Object.freeze({ kind: 'v4' as const }),
                establishedRuntimeOwner: Object.freeze({
                    async invokeWithReceipt(input) {
                        return Object.freeze({
                            result: await invokeEstablished(
                                invoker,
                                input.operation,
                                () => generationCurrent,
                            ),
                            basis: Object.freeze({
                                credentialRevision,
                                isCurrent: () => generationCurrent,
                            }),
                        });
                    },
                }),
                resolveCredential: async () => null,
            });
        })()).rejects.toMatchObject({
            code: 'connected_account_producer_result_stale',
        });
        expect(disclosed).toBeNull();
    });

    it.each([
        Object.freeze({
            name: 'headers',
            operation: Object.freeze({
                kind: 'materialize' as const,
                request: Object.freeze({
                    kind: 'httpHeaders' as const,
                    origin: 'https://api.example.test',
                    headerNames: Object.freeze(['authorization']),
                }),
            }),
            resultKind: 'httpHeaders' as const,
            resultField: 'headers' as const,
            resultValue: Object.freeze({
                authorization: 'Bearer must-not-escape',
            }),
        }),
        Object.freeze({
            name: 'environment',
            operation: Object.freeze({
                kind: 'materialize' as const,
                request: Object.freeze({
                    kind: 'environment' as const,
                    keys: Object.freeze(['TOKEN']),
                }),
            }),
            resultKind: 'environment' as const,
            resultField: 'env' as const,
            resultValue: Object.freeze({ TOKEN: 'must-not-escape' }),
        }),
        Object.freeze({
            name: 'files',
            operation: Object.freeze({
                kind: 'materialize' as const,
                request: Object.freeze({
                    kind: 'files' as const,
                    fileIds: Object.freeze(['credential']),
                }),
            }),
            resultKind: 'files' as const,
            resultField: 'files' as const,
            resultValue: Object.freeze({
                credential: new Uint8Array([115, 101, 99, 114, 101, 116]),
            }),
        }),
    ])(
        'rejects accessor-backed $name without reading or returning materialized data',
        async ({ operation, resultKind, resultField, resultValue }) => {
            const readMaterial = vi.fn(() => resultValue);
            const maliciousResult = Object.defineProperty({
                kind: resultKind,
            }, resultField, {
                enumerable: true,
                get: readMaterial,
            });
            const registeredRuntime: PluginConnectedAccountRuntime = {
                ...runtime(() => {}),
                async materialize() {
                    // Deliberately hostile plugin return used to exercise the host boundary.
                    return maliciousResult as PluginConnectedAccountMaterialization;
                },
            };

            await expect(invokeEstablished(
                createEstablishedInvoker(registeredRuntime),
                operation,
            )).rejects.toMatchObject({
                code: 'connected_account_producer_result_invalid',
            });
            expect(readMaterial).not.toHaveBeenCalled();
        },
    );

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

    it('refuses a status result that retires its generation during inspection before health persistence', async () => {
        let generationCurrent = true;
        const healthPersistence = vi.fn();
        const statusResult = new Proxy({
            status: 'connected' as const,
            displayName: 'Must not persist',
            scopes: Object.freeze([]),
        }, {
            getOwnPropertyDescriptor(target, property) {
                if (property === 'displayName') generationCurrent = false;
                return Reflect.getOwnPropertyDescriptor(target, property);
            },
        });
        const registeredRuntime: PluginConnectedAccountRuntime = {
            ...runtime(() => {}),
            async status() {
                return statusResult;
            },
        };

        await expect((async () => {
            const result = await invokeEstablished(
                createEstablishedInvoker(
                    registeredRuntime,
                    () => generationCurrent,
                ),
                Object.freeze({ kind: 'status' as const }),
                () => generationCurrent,
            );
            await healthPersistence(result);
        })()).rejects.toMatchObject({
            code: 'connected_account_producer_result_stale',
        });
        expect(healthPersistence).not.toHaveBeenCalled();
    });

    it('distinguishes an unavailable quota leaf from an invalid null quota result', async () => {
        await expect(invokeEstablished(
            createEstablishedInvoker(runtime(() => {})),
            Object.freeze({ kind: 'quota' as const }),
        )).resolves.toBeNull();

        const invalidQuotaRuntime: PluginConnectedAccountRuntime = {
            ...runtime(() => {}),
            async quota() {
                // Deliberately violates the SDK contract at the untrusted plugin boundary.
                return null as never;
            },
        };
        await expect(invokeEstablished(
            createEstablishedInvoker(invalidQuotaRuntime),
            Object.freeze({ kind: 'quota' as const }),
        )).rejects.toMatchObject({
            code: 'connected_account_producer_result_invalid',
        });
    });

    it('rejects rejected health results that carry fields outside the strict union member', async () => {
        const registeredRuntime: PluginConnectedAccountRuntime = {
            ...runtime(() => {}),
            async status() {
                return Object.freeze({
                    status: 'rejected',
                    diagnostic: Object.freeze({
                        code: 'provider_rejected',
                        severity: 'error',
                    }),
                    displayName: 'must-not-cross-the-host-boundary',
                }) as never;
            },
        };

        await expect(invokeEstablished(
            createEstablishedInvoker(registeredRuntime),
            Object.freeze({ kind: 'status' as const }),
        )).rejects.toMatchObject({
            code: 'connected_account_producer_result_invalid',
        });
    });

    it('refuses a quota result that retires its generation before quota persistence', async () => {
        let generationCurrent = true;
        const quotaPersistence = vi.fn();
        const quotaResult = new Proxy({
            observedAtMs: 1_000,
            limits: Object.freeze([]),
        }, {
            getOwnPropertyDescriptor(target, property) {
                if (property === 'limits') generationCurrent = false;
                return Reflect.getOwnPropertyDescriptor(target, property);
            },
        });
        const registeredRuntime: PluginConnectedAccountRuntime = {
            ...runtime(() => {}),
            async quota() {
                return quotaResult;
            },
        };

        await expect((async () => {
            const result = await invokeEstablished(
                createEstablishedInvoker(
                    registeredRuntime,
                    () => generationCurrent,
                ),
                Object.freeze({ kind: 'quota' as const }),
                () => generationCurrent,
            );
            await quotaPersistence(result);
        })()).rejects.toMatchObject({
            code: 'connected_account_producer_result_stale',
        });
        expect(quotaPersistence).not.toHaveBeenCalled();
    });

    it('refuses a refresh result that retires its generation before credential persistence', async () => {
        let generationCurrent = true;
        const credentialPersistence = vi.fn();
        const refreshResult = new Proxy({
            status: 'connected' as const,
        }, {
            ownKeys(target) {
                generationCurrent = false;
                return Reflect.ownKeys(target);
            },
        });
        const registeredRuntime: PluginConnectedAccountRuntime = {
            ...runtime(() => {}),
            async refresh() {
                return refreshResult;
            },
        };

        await expect((async () => {
            const result = await invokeEstablished(
                createEstablishedInvoker(
                    registeredRuntime,
                    () => generationCurrent,
                ),
                Object.freeze({
                    kind: 'refresh' as const,
                    operationId: 'refresh-1',
                    stagedCredentials: Object.freeze({
                        get: async () => null,
                        set: async () => {},
                        delete: async () => {},
                    }),
                }),
                () => generationCurrent,
            );
            await credentialPersistence(result);
        })()).rejects.toMatchObject({
            code: 'connected_account_producer_result_stale',
        });
        expect(credentialPersistence).not.toHaveBeenCalled();
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
            resolveRuntime: async () => Object.freeze({
                ref: service,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
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
                    'generation-1',
                    'connected-runtime',
                ),
            }),
            createServices: owners.createServices,
            registerRawForRedaction: owners.registerRawForRedaction,
            resolveHostOwnedConfiguredOrigins: () => Object.freeze([]),
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
        await owners.retireGeneration('generation-1', service.pluginId);
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
                generation: seed.generation,
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
            resolveRuntime: async () => Object.freeze({
                ref: service,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
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
                    'generation-1',
                    'telegram-producer',
                    [networkRequest],
                ),
            }),
            createServices: owners.createServices,
            registerRawForRedaction: owners.registerRawForRedaction,
            redactDiagnosticText(seed, value) {
                return owners.redactDiagnosticText({
                    pluginId: seed.plugin.id,
                    generation: seed.generation,
                    correlationId: seed.correlationId,
                }, value);
            },
            resolveHostOwnedConfiguredOrigins: () => Object.freeze(['https://api.telegram.org']),
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
            resolveRuntime: async () => Object.freeze({
                ref: service,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
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
                    'generation-1',
                    'refresh-producer',
                    [],
                ),
            }),
            createServices: () => Object.freeze({}) as PluginInvocationContext['services'],
            registerRawForRedaction,
            resolveHostOwnedConfiguredOrigins: () => Object.freeze([]),
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
            resolveRuntime: async () => Object.freeze({
                ref: service,
                generation: 'generation-1',
                immutableGenerationId: 'artifact-1',
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
                    'generation-1',
                    'oauth-producer',
                    [],
                ),
            }),
            createServices: () => Object.freeze({}) as PluginInvocationContext['services'],
            registerRawForRedaction,
            resolveHostOwnedConfiguredOrigins: () => Object.freeze([]),
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
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
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
        if (!admittedLease) throw new Error('Expected a resolvable connected-account lease');
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
            registerRawForRedaction() {},
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
                registerRawForRedaction() {},
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
                registerRawForRedaction() {},
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
            registerRawForRedaction() {},
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
