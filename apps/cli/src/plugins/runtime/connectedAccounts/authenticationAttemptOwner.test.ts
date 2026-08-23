import { describe, expect, it, vi } from 'vitest';
import {
    PluginConnectedAccountAuthenticationModeV2Schema,
    PluginConnectedAccountConfigurationV2Schema,
    type PluginConnectedAccountConfigurationV2,
} from '@happier-dev/protocol';

import {
    createConnectedAccountAuthenticationAttemptOwner,
    type ConnectedAccountAttemptConfigurationAdmission,
    type ConnectedAccountAttemptModeAdmission,
    type ConnectedAccountAttemptProviderOperation,
    type ConnectedAccountAttemptProviderInvocation,
    type ConnectedAccountAttemptSettlementRequest,
    type ConnectedAccountOAuthCallbackCompletion,
} from './authenticationAttemptOwner';
import {
    ConnectedAccountRuntimeInvocationNotStartedError,
} from './contributionRegistry';

const service = Object.freeze({ pluginId: 'acme.accounts', localId: 'work' });
const accountA = Object.freeze({ service, accountId: 'account-a' });

function configured(
    revision = 'configuration-1',
    values: Readonly<Record<string, string>> = Object.freeze({}),
    modeId = 'manual',
): Extract<ConnectedAccountAttemptConfigurationAdmission, { status: 'ready' }> {
    return {
        status: 'ready',
        snapshot: Object.freeze({
            target: Object.freeze({ kind: 'service' as const, service, modeId }),
            revision,
            values: Object.freeze({ ...values }),
            getSecret: async () => null,
        }),
    };
}

function configuredAttempt(
    attemptId: string,
    modeId: string,
): Extract<ConnectedAccountAttemptConfigurationAdmission, { status: 'ready' }> {
    return {
        status: 'ready',
        snapshot: Object.freeze({
            target: Object.freeze({
                kind: 'attempt' as const,
                attemptId,
                service,
                modeId,
            }),
            revision: 'configuration-1',
            values: Object.freeze({ tenant: 'acme' }),
            getSecret: async () => null,
        }),
    };
}

function accountScopedConfiguration(): PluginConnectedAccountConfigurationV2 {
    return PluginConnectedAccountConfigurationV2Schema.parse({
        scope: 'account',
        changeBehavior: 'reconnect',
        fields: [{
            id: 'tenant',
            title: 'Tenant',
            schema: { type: 'string' },
            required: true,
            secret: false,
        }],
    });
}

function manualMode(
    modeId = 'manual',
    overrides: Partial<Omit<ConnectedAccountAttemptModeAdmission, 'descriptor'>> = {},
): ConnectedAccountAttemptModeAdmission {
    return Object.freeze({
        service,
        descriptor: PluginConnectedAccountAuthenticationModeV2Schema.parse({
            id: modeId,
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{
                id: 'token',
                title: 'Token',
                schema: { type: 'string' },
                secret: true,
            }],
        }),
        generation: 'generation-1',
        immutableGenerationId: 'artifact-acme-1',
        ...overrides,
    });
}

function oauthMode(input: Readonly<{
    outcomeReconciliation: 'providerCheck' | 'lateEvidence' | 'none';
    configuration?: PluginConnectedAccountConfigurationV2;
    callbackUrl?: string;
}>): ConnectedAccountAttemptModeAdmission {
    return Object.freeze({
        service,
        descriptor: PluginConnectedAccountAuthenticationModeV2Schema.parse({
            id: 'oauth',
            kind: 'oauthAuthorizationCode',
            pkce: 'required',
            outcomeReconciliation: input.outcomeReconciliation,
            ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
            ...(input.configuration ? { configuration: input.configuration } : {}),
        }),
        generation: 'generation-1',
        immutableGenerationId: 'artifact-acme-1',
    });
}

function deviceMode(
    outcomeReconciliation: 'providerCheck' | 'lateEvidence' | 'none' = 'none',
    generation = 'generation-1',
    immutableGenerationId = 'artifact-acme-1',
    configuration?: PluginConnectedAccountConfigurationV2,
): ConnectedAccountAttemptModeAdmission {
    return Object.freeze({
        service,
        descriptor: PluginConnectedAccountAuthenticationModeV2Schema.parse({
            id: 'device',
            kind: 'oauthDeviceCode',
            outcomeReconciliation,
            ...(configuration ? { configuration } : {}),
        }),
        generation,
        immutableGenerationId,
    });
}

function harness(input: Readonly<{
    maxAttempts?: number;
    configuration?: ConnectedAccountAttemptConfigurationAdmission;
    admitConfiguration?: (input: unknown) => Promise<ConnectedAccountAttemptConfigurationAdmission>;
    admittedMode?: ConnectedAccountAttemptModeAdmission;
    admitMode?: (input: unknown) => Promise<ConnectedAccountAttemptModeAdmission>;
    invoke?: (input: ConnectedAccountAttemptProviderInvocation) => Promise<unknown>;
    configurationCurrent?: () => boolean | Promise<boolean>;
    generationCurrent?: () => boolean | Promise<boolean>;
    account?: Readonly<{
        account: typeof accountA;
        authenticationModeId: string;
        credentialRevision: string;
        configurationRevision: string | null;
    }> | null;
    readAccount?: () => Promise<Readonly<{
        account: typeof accountA;
        authenticationModeId: string;
        credentialRevision: string;
        configurationRevision: string | null;
    }> | null>;
    destroyAttemptConfiguration?: (attemptId: string) => void | Promise<void>;
    now?: () => number;
    attemptTtlMs?: number;
    deviceTransactions?: Readonly<{
        acknowledge(input: unknown): void | Promise<void>;
        read(attemptId: string): unknown | Promise<unknown>;
        clear(attemptId: string): void | Promise<void>;
    }>;
    oauthTransactions?: Readonly<{
        create(input: unknown): Promise<unknown>;
        read?(attemptId: string): unknown | Promise<unknown>;
    }>;
    lateEvidence?: Readonly<{
        reconcile(input: unknown): Promise<unknown>;
    }>;
    assertEffectfulOperationAllowed?: (input: Readonly<{
        intent: 'connect' | 'reconnect';
        service: typeof service;
        attemptId: string;
        authenticationModeId: string;
        authenticationModeCardinality?: 'single' | 'multiple';
        configurationState: 'unconfigured' | 'configured';
    }>) => void | Promise<void>;
    createAttemptId?: () => string;
    createAccountId?: () => string;
    settle?: (
        request: ConnectedAccountAttemptSettlementRequest,
    ) => Promise<
        | Readonly<{
            status: 'connected';
            account: Readonly<{
                service: ConnectedAccountAttemptSettlementRequest['service'];
                accountId: string;
            }>;
        }>
        | Readonly<{ status: 'conflict' | 'rejected' | 'unavailable'; code: string }>
    >;
    reconcileSettlement?: (
        request: ConnectedAccountAttemptSettlementRequest,
    ) => Promise<
        | Readonly<{
            status: 'connected';
            account: Readonly<{
                service: ConnectedAccountAttemptSettlementRequest['service'];
                accountId: string;
            }>;
        }>
        | Readonly<{ status: 'conflict' | 'rejected' | 'unavailable'; code: string }>
    >;
}> = {}) {
    let attemptNumber = 0;
    const invoke = vi.fn(input.invoke ?? (async ({ operation }: ConnectedAccountAttemptProviderInvocation) => {
        if (operation.kind === 'beginOAuth') {
            return {
                status: 'awaitingOAuthRedirect',
                authorizationUrl: 'https://provider.example/authorize',
                expiresAtMs: 61_000,
            };
        }
        if (operation.kind === 'beginDevice') {
            return {
                status: 'awaitingDeviceAuthorization',
                verificationUri: 'https://provider.example/device',
                verificationUriComplete: 'https://provider.example/device?code=ABCD',
                userCode: 'ABCD',
                expiresAtMs: 61_000,
                pollIntervalMs: 5_000,
            };
        }
        return {
            status: 'connected',
            accountId: 'account-a',
            displayName: 'Account A',
            scopes: ['read'],
        };
    }));
    const settle = vi.fn(input.settle ?? (async (request) => ({
        status: 'connected' as const,
        account: Object.freeze({
            service: request.service,
            accountId: request.accountId,
        }),
    })));
    const reconcileSettlement = vi.fn(
        input.reconcileSettlement ?? settle,
    );
    const configurationCurrent = vi.fn(input.configurationCurrent ?? (() => true));
    const generationCurrent = vi.fn(input.generationCurrent ?? (() => true));
    const destroyAttemptConfiguration = vi.fn(
        input.destroyAttemptConfiguration ?? (async () => {}),
    );
    const admitConfiguration = vi.fn(
        input.admitConfiguration ?? (async () => input.configuration ?? configured()),
    );
    const owner = createConnectedAccountAuthenticationAttemptOwner({
        maxAttempts: input.maxAttempts ?? 3,
        createAttemptId:
            input.createAttemptId ?? (() => `attempt-${++attemptNumber}`),
        createAccountId: input.createAccountId ?? (() => 'host-account-1'),
        now: input.now ?? (() => 1_000),
        attemptTtlMs: input.attemptTtlMs ?? 60_000,
        accounts: {
            readExact: vi.fn(input.readAccount ?? (async () =>
                input.account === undefined
                    ? {
                        account: accountA,
                        authenticationModeId: 'manual',
                        credentialRevision: 'credential-7',
                        configurationRevision: null,
                    }
                    : input.account)),
        },
        configuration: {
            admit: admitConfiguration,
            isCurrent: configurationCurrent,
            destroyAttempt: destroyAttemptConfiguration,
        },
        runtime: {
            admit: vi.fn(input.admitMode ?? (async () => input.admittedMode ?? manualMode())),
            isCurrent: generationCurrent,
            invoke,
        },
        oauth: input.oauthTransactions
            ? input.oauthTransactions as never
            : {
                create: vi.fn(async (transactionInput) => ({
                    snapshot: transactionInput.snapshot,
                    request: Object.freeze({
                        callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                        state: 'state-1',
                        pkce: Object.freeze({ challenge: 'challenge-1', method: 'S256' as const }),
                    }),
                    acknowledge: async () => {},
                    acceptCompletion: async (
                        completion: ConnectedAccountOAuthCallbackCompletion,
                    ) => {
                        if (completion.state !== 'state-1') throw new Error('state mismatch');
                        return {
                            ...completion,
                            pkceVerifier: 'verifier-1',
                        };
                    },
                    close: async () => {},
                })),
            },
        ...(input.deviceTransactions
            ? { deviceTransactions: input.deviceTransactions as never }
            : {}),
        ...(input.lateEvidence ? { lateEvidence: input.lateEvidence as never } : {}),
        ...(input.assertEffectfulOperationAllowed
            ? {
                assertEffectfulOperationAllowed:
                    input.assertEffectfulOperationAllowed,
            }
            : {}),
        settlement: { settle, reconcile: reconcileSettlement },
    });
    return {
        owner,
        invoke,
        settle,
        reconcileSettlement,
        configurationCurrent,
        generationCurrent,
        destroyAttemptConfiguration,
        admitConfiguration,
    };
}

async function waitForAttemptStatus(
    owner: ReturnType<typeof harness>['owner'],
    attemptId: string,
    status: string,
): Promise<unknown> {
    let current: unknown;
    await vi.waitFor(async () => {
        current = await owner.read({ attemptId });
        expect(current).toMatchObject({ status });
    });
    return current;
}

type TestOAuthTransactionSnapshot = Readonly<{
    attemptId: string;
    phase: 'starting' | 'awaitingOAuth' | 'outcomeUnknown';
    immutableGenerationId: string;
    preparedSettlement?: ConnectedAccountAttemptSettlementRequest;
}>;

function durableOAuthTransactions(input: Readonly<{
    beforeAcknowledge?: (
        snapshot: TestOAuthTransactionSnapshot,
    ) => void | Promise<void>;
    beforeClose?: () => void | Promise<void>;
}> = {}) {
    let record: {
        snapshot: TestOAuthTransactionSnapshot | undefined;
        consumed: boolean;
        closed: boolean;
    } | null = null;
    const createHandle = (current: NonNullable<typeof record>) => Object.freeze({
        get snapshot() {
            return current.snapshot;
        },
        request: Object.freeze({
            callbackUrl: 'http://127.0.0.1:4000/auth/callback',
            state: 'state-1',
            pkce: Object.freeze({ challenge: 'challenge-1', method: 'S256' as const }),
        }),
        acknowledge: vi.fn(async (snapshot: TestOAuthTransactionSnapshot) => {
            await input.beforeAcknowledge?.(snapshot);
            current.snapshot = snapshot;
        }),
        acceptCompletion: vi.fn(async (
            completion: ConnectedAccountOAuthCallbackCompletion,
        ) => {
            if (
                current.closed
                || current.consumed
                || completion.state !== 'state-1'
                || completion.callbackUrl !== 'http://127.0.0.1:4000/auth/callback'
            ) {
                throw new Error('state mismatch or consumed');
            }
            current.consumed = true;
            return Object.freeze({
                ...completion,
                pkceVerifier: 'durable-verifier-1',
            });
        }),
        close: vi.fn(async () => {
            await input.beforeClose?.();
            current.closed = true;
            if (record === current) record = null;
        }),
    });
    const owner = {
        create: vi.fn(async (input: unknown) => {
            const snapshot = (
                input
                && typeof input === 'object'
                && 'snapshot' in input
            )
                ? (input as Readonly<{ snapshot?: TestOAuthTransactionSnapshot }>).snapshot
                : undefined;
            record = { snapshot, consumed: false, closed: false };
            return createHandle(record);
        }),
        read: vi.fn(async () => record ? createHandle(record) : null),
    };
    return {
        owner,
        readRecord: () => record,
    };
}

describe('ConnectedAccountAuthenticationAttemptOwner', () => {
    it('passes a provider-fixed OAuth callback to the single transaction owner', async () => {
        const create = vi.fn(async (transactionInput: Readonly<{
            snapshot: TestOAuthTransactionSnapshot;
        }>) => ({
            snapshot: transactionInput.snapshot,
            request: Object.freeze({
                callbackUrl: 'https://provider.example/oauth/callback',
                state: 'state-1',
                pkce: Object.freeze({ challenge: 'challenge-1', method: 'S256' as const }),
            }),
            acknowledge: async () => {},
            acceptCompletion: async () => {
                throw new Error('not invoked');
            },
            close: async () => {},
        }));
        const h = harness({
            admittedMode: oauthMode({
                outcomeReconciliation: 'none',
                callbackUrl: 'https://provider.example/oauth/callback',
            }),
            oauthTransactions: { create, read: vi.fn(async () => null) },
        });

        await h.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');

        expect(create).toHaveBeenCalledWith(expect.objectContaining({
            callbackUrl: 'https://provider.example/oauth/callback',
        }));
    });

    it('revalidates mutable peer admission before continuing an active provider attempt', async () => {
        let peer: 'v4' | 'exact-old' = 'v4';
        const assertEffectfulOperationAllowed = vi.fn(() => {
            if (peer === 'exact-old') {
                throw Object.assign(
                    new Error('credential write is no longer supported'),
                    {
                        code:
                            'connected_account_legacy_operation_unsupported',
                    },
                );
            }
        });
        const h = harness({ assertEffectfulOperationAllowed });

        await expect(h.owner.beginConnect({
            service,
            modeId: 'manual',
        })).resolves.toEqual({
            status: 'awaitingManual',
            attemptId: 'attempt-1',
        });

        peer = 'exact-old';
        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'secret' },
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_legacy_operation_unsupported',
        });
        expect(assertEffectfulOperationAllowed).toHaveBeenCalledWith({
            intent: 'connect',
            service,
            attemptId: 'attempt-1',
            authenticationModeId: 'manual',
            configurationState: 'configured',
        });
        expect(h.invoke).not.toHaveBeenCalled();
        expect(h.settle).not.toHaveBeenCalled();
    });

    it('checks peer admission after awaited currentness and immediately before provider invocation', async () => {
        let peer: 'v4' | 'exact-old' = 'v4';
        let releaseCurrentness!: () => void;
        const currentnessGate = new Promise<void>((resolve) => {
            releaseCurrentness = resolve;
        });
        const assertEffectfulOperationAllowed = vi.fn(() => {
            if (peer === 'exact-old') {
                throw Object.assign(
                    new Error('credential write is no longer supported'),
                    {
                        code:
                            'connected_account_legacy_operation_unsupported',
                    },
                );
            }
        });
        const h = harness({
            assertEffectfulOperationAllowed,
            configurationCurrent: async () => {
                await currentnessGate;
                return true;
            },
        });
        const started = await h.owner.beginConnect({
            service,
            modeId: 'manual',
        });
        if (started.status !== 'awaitingManual') {
            throw new Error('manual attempt did not start');
        }

        const completion = h.owner.submitManual({
            attemptId: started.attemptId,
            fields: { token: 'secret' },
        });
        await vi.waitFor(() =>
            expect(h.configurationCurrent).toHaveBeenCalledOnce());
        peer = 'exact-old';
        releaseCurrentness();

        await expect(completion).resolves.toEqual({
            status: 'unavailable',
            attemptId: started.attemptId,
            code: 'connected_account_legacy_operation_unsupported',
        });
        expect(h.invoke).not.toHaveBeenCalled();
        expect(h.settle).not.toHaveBeenCalled();
    });

    it('revalidates the exact reconnect account after awaited peer admission', async () => {
        let currentAccount: Readonly<{
            account: typeof accountA;
            authenticationModeId: string;
            credentialRevision: string;
            configurationRevision: string | null;
        }> | null = {
            account: accountA,
            authenticationModeId: 'manual',
            credentialRevision: 'credential-7',
            configurationRevision: null,
        };
        let holdAdmission = false;
        let markAdmissionStarted!: () => void;
        const admissionStarted = new Promise<void>((resolve) => {
            markAdmissionStarted = resolve;
        });
        let releaseAdmission!: () => void;
        const admissionGate = new Promise<void>((resolve) => {
            releaseAdmission = resolve;
        });
        const h = harness({
            readAccount: async () => currentAccount,
            assertEffectfulOperationAllowed: async () => {
                if (!holdAdmission) return;
                markAdmissionStarted();
                await admissionGate;
            },
        });
        const started = await h.owner.beginReconnect({
            account: accountA,
        });
        if (started.status !== 'awaitingManual') {
            throw new Error('manual reconnect did not start');
        }

        holdAdmission = true;
        const completion = h.owner.submitManual({
            attemptId: started.attemptId,
            fields: { token: 'replacement' },
        });
        await admissionStarted;
        currentAccount = null;
        releaseAdmission();

        await expect(completion).resolves.toEqual({
            status: 'conflict',
            attemptId: started.attemptId,
            code: 'connected_account_credential_changed',
        });
        expect(h.invoke).not.toHaveBeenCalled();
        expect(h.settle).not.toHaveBeenCalled();
    });

    it('does not start an effect after cancellation wins an awaited currentness preflight', async () => {
        let releaseCurrentness!: () => void;
        const currentness = new Promise<void>((resolve) => {
            releaseCurrentness = resolve;
        });
        let holdCurrentness = false;
        const h = harness({
            configurationCurrent: async () => {
                if (holdCurrentness) await currentness;
                return true;
            },
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });
        holdCurrentness = true;
        const submission = h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'candidate' },
        });
        await vi.waitFor(() => expect(h.configurationCurrent).toHaveBeenCalled());

        await expect(h.owner.cancel({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        releaseCurrentness();

        await expect(submission).resolves.toMatchObject({
            status: 'conflict',
            code: 'connected_account_attempt_cancelled',
        });
        expect(h.invoke).not.toHaveBeenCalled();
        expect(h.settle).not.toHaveBeenCalled();
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledOnce();
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
    });

    it('terminalizes a rejected active currentness boundary without leaving the attempt in flight', async () => {
        let rejectCurrentness = false;
        const h = harness({
            configurationCurrent: async () => {
                if (rejectCurrentness) {
                    throw new Error('configuration currentness unavailable');
                }
                return true;
            },
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });
        rejectCurrentness = true;

        const response = {
            status: 'unavailable' as const,
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_internal_unavailable',
        };
        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'candidate' },
        })).resolves.toEqual(response);
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual(
            response,
        );
        expect(h.invoke).not.toHaveBeenCalled();
        expect(h.settle).not.toHaveBeenCalled();
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledOnce();
    });

    it('preserves outcome uncertainty when currentness rejects after a possible provider effect', async () => {
        let rejectCurrentness = false;
        const h = harness({
            configurationCurrent: async () => {
                if (rejectCurrentness) {
                    throw new Error('configuration currentness unavailable');
                }
                return true;
            },
            invoke: async () => {
                rejectCurrentness = true;
                return {
                    status: 'connected',
                    accountId: 'account-a',
                    displayName: 'Account A',
                    scopes: [],
                };
            },
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });

        const response = {
            status: 'outcomeUnknown' as const,
            attemptId: 'attempt-1',
            diagnostic: {
                code: 'connected_account_provider_operation_interrupted',
            },
        };
        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'candidate' },
        })).resolves.toEqual(response);
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual(
            response,
        );
        expect(h.invoke).toHaveBeenCalledOnce();
        expect(h.settle).not.toHaveBeenCalled();
        expect(h.destroyAttemptConfiguration).not.toHaveBeenCalled();
    });

    it.each(['runtime-currentness', 'peer-admission'] as const)(
        'does not create OAuth custody after cancellation wins %s',
        async (boundary) => {
            let signalBoundaryStarted!: () => void;
            const boundaryStarted = new Promise<void>((resolve) => {
                signalBoundaryStarted = resolve;
            });
            let releaseBoundary!: () => void;
            const boundaryWait = new Promise<void>((resolve) => {
                releaseBoundary = resolve;
            });
            let peerAdmissionCalls = 0;
            const create = vi.fn(async () => {
                throw new Error('OAuth transaction must not be created');
            });
            const h = harness({
                admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
                oauthTransactions: {
                    create,
                    read: vi.fn(async () => null),
                },
                generationCurrent: async () => {
                    if (boundary === 'runtime-currentness') {
                        signalBoundaryStarted();
                        await boundaryWait;
                    }
                    return true;
                },
                assertEffectfulOperationAllowed: async () => {
                    peerAdmissionCalls += 1;
                    if (
                        boundary === 'peer-admission'
                        && peerAdmissionCalls === 2
                    ) {
                        signalBoundaryStarted();
                        await boundaryWait;
                    }
                },
            });
            await h.owner.beginConnect({ service, modeId: 'oauth' });
            await boundaryStarted;
            const cancellation = h.owner.cancel({ attemptId: 'attempt-1' });
            releaseBoundary();

            await expect(cancellation).resolves.toEqual({
                status: 'cancelled',
                attemptId: 'attempt-1',
            });
            await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
                status: 'cancelled',
                attemptId: 'attempt-1',
            });
            expect(create).not.toHaveBeenCalled();
            expect(h.settle).not.toHaveBeenCalled();
        },
    );

    it('retains late OAuth creation compensation for exact cleanup retry after cancellation', async () => {
        let closeCalls = 0;
        const durable = durableOAuthTransactions({
            beforeClose: async () => {
                closeCalls += 1;
                if (closeCalls <= 2) {
                    throw new Error('OAuth transaction storage unavailable');
                }
            },
        });
        let signalCreated!: () => void;
        const created = new Promise<void>((resolve) => {
            signalCreated = resolve;
        });
        let releaseCreate!: () => void;
        const createGate = new Promise<void>((resolve) => {
            releaseCreate = resolve;
        });
        const oauthTransactions = {
            create: vi.fn(async (input: unknown) => {
                const transaction = await durable.owner.create(input);
                signalCreated();
                await createGate;
                return transaction;
            }),
            read: durable.owner.read,
        };
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions,
        });
        await h.owner.beginConnect({ service, modeId: 'oauth' });
        await created;

        await expect(h.owner.cancel({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledOnce();
        releaseCreate();
        await vi.waitFor(() => expect(closeCalls).toBe(2));
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        expect(closeCalls).toBe(3);
        expect(durable.readRecord()).toBeNull();
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledOnce();
        expect(h.invoke).toHaveBeenCalledOnce();
        expect(h.invoke).toHaveBeenCalledWith(expect.objectContaining({
            operation: { kind: 'cancel' },
        }));
        expect(h.settle).not.toHaveBeenCalled();
    });

    it('merges a late OAuth handle into rejected cancellation cleanup before retrying', async () => {
        const close = vi.fn(async () => {});
        const durable = durableOAuthTransactions({ beforeClose: close });
        let signalCreated!: () => void;
        const created = new Promise<void>((resolve) => {
            signalCreated = resolve;
        });
        let releaseCreate!: () => void;
        const createGate = new Promise<void>((resolve) => {
            releaseCreate = resolve;
        });
        const oauthTransactions = {
            create: vi.fn(async (input: unknown) => {
                const transaction = await durable.owner.create(input);
                signalCreated();
                await createGate;
                return transaction;
            }),
            read: durable.owner.read,
        };
        const destroyAttemptConfiguration = vi.fn()
            .mockRejectedValueOnce(new Error('configuration cleanup unavailable'))
            .mockRejectedValueOnce(new Error('configuration cleanup unavailable'))
            .mockResolvedValue(undefined);
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions,
            destroyAttemptConfiguration,
        });
        await h.owner.beginConnect({ service, modeId: 'oauth' });
        await created;

        await expect(h.owner.cancel({
            attemptId: 'attempt-1',
        })).rejects.toMatchObject({
            code: 'connected_account_attempt_cleanup_pending',
            attemptId: 'attempt-1',
        });
        releaseCreate();
        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        expect(close).toHaveBeenCalledOnce();
        expect(durable.readRecord()).toBeNull();
        expect(destroyAttemptConfiguration).toHaveBeenCalledTimes(3);
        expect(h.settle).not.toHaveBeenCalled();
    });

    it('retains sole attempt capacity until deferred OAuth creation compensation settles', async () => {
        const durable = durableOAuthTransactions();
        let signalCreated!: () => void;
        const created = new Promise<void>((resolve) => {
            signalCreated = resolve;
        });
        let releaseCreate!: () => void;
        const createGate = new Promise<void>((resolve) => {
            releaseCreate = resolve;
        });
        const h = harness({
            maxAttempts: 1,
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: {
                create: vi.fn(async (input: unknown) => {
                    const transaction = await durable.owner.create(input);
                    signalCreated();
                    await createGate;
                    return transaction;
                }),
                read: durable.owner.read,
            },
        });
        await h.owner.beginConnect({ service, modeId: 'oauth' });
        await created;
        await expect(h.owner.cancel({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });

        await expect(h.owner.beginConnect({
            service,
            modeId: 'oauth',
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'connected_account_attempt_capacity_exhausted',
        });
        releaseCreate();
        await vi.waitFor(() => expect(durable.readRecord()).toBeNull());

        await expect(h.owner.beginConnect({
            service,
            modeId: 'oauth',
        })).resolves.toEqual({
            status: 'starting',
            attemptId: 'attempt-2',
        });
    });

    it('releases retained capacity when deferred OAuth creation rejects after cancellation', async () => {
        let signalCreateStarted!: () => void;
        const createStarted = new Promise<void>((resolve) => {
            signalCreateStarted = resolve;
        });
        let releaseCreate!: () => void;
        const createGate = new Promise<void>((resolve) => {
            releaseCreate = resolve;
        });
        let signalCreateRejected!: () => void;
        const createRejected = new Promise<void>((resolve) => {
            signalCreateRejected = resolve;
        });
        const destroyAttemptConfiguration = vi.fn()
            .mockRejectedValueOnce(new Error('configuration cleanup unavailable'))
            .mockResolvedValue(undefined);
        const h = harness({
            maxAttempts: 1,
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            destroyAttemptConfiguration,
            oauthTransactions: {
                create: vi.fn(async () => {
                    signalCreateStarted();
                    await createGate;
                    signalCreateRejected();
                    throw new Error('OAuth transaction create unavailable');
                }),
                read: vi.fn(async () => null),
            },
        });
        await h.owner.beginConnect({ service, modeId: 'oauth' });
        await createStarted;
        await expect(h.owner.cancel({
            attemptId: 'attempt-1',
        })).rejects.toMatchObject({
            code: 'connected_account_attempt_cleanup_pending',
            attemptId: 'attempt-1',
        });

        releaseCreate();
        await createRejected;
        await vi.waitFor(() =>
            expect(destroyAttemptConfiguration).toHaveBeenCalledTimes(2));
        await expect(h.owner.beginConnect({
            service,
            modeId: 'oauth',
        })).resolves.toEqual({
            status: 'starting',
            attemptId: 'attempt-2',
        });
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        expect(h.invoke).toHaveBeenCalledOnce();
        expect(h.invoke.mock.calls.every(
            ([input]) => input.operation.kind === 'cancel',
        )).toBe(true);
        expect(h.settle).not.toHaveBeenCalled();
    });

    it.each([
        { transport: 'oauth' as const, outcome: 'null' as const },
        { transport: 'oauth' as const, outcome: 'reject' as const },
        { transport: 'device' as const, outcome: 'null' as const },
        { transport: 'device' as const, outcome: 'reject' as const },
    ])(
        'releases retained capacity when cancelled $transport restoration reads $outcome',
        async ({ transport, outcome }) => {
            let signalReadStarted!: () => void;
            const readStarted = new Promise<void>((resolve) => {
                signalReadStarted = resolve;
            });
            let finishRead!: () => void;
            const readResult = new Promise<null>((resolve, reject) => {
                finishRead = () => {
                    if (outcome === 'reject') {
                        reject(new Error('durable transaction read unavailable'));
                    } else {
                        resolve(null);
                    }
                };
            });
            const h = harness({
                maxAttempts: 1,
                ...(transport === 'oauth'
                    ? {
                        oauthTransactions: {
                            create: vi.fn(async () => {
                                throw new Error('unexpected OAuth create');
                            }),
                            read: vi.fn(async () => {
                                signalReadStarted();
                                return await readResult;
                            }),
                        },
                    }
                    : {
                        deviceTransactions: {
                            acknowledge: vi.fn(async () => {}),
                            read: vi.fn(async () => {
                                signalReadStarted();
                                return await readResult;
                            }),
                            clear: vi.fn(async () => {}),
                        },
                    }),
            });
            const restoration = transport === 'oauth'
                ? h.owner.completeOAuth({
                    attemptId: 'restored-attempt',
                    completion: {
                        code: 'callback-code',
                        callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                        state: 'state-1',
                    },
                })
                : h.owner.resumeDevice({ attemptId: 'restored-attempt' });
            await readStarted;
            await expect(h.owner.cancel({
                attemptId: 'restored-attempt',
            })).resolves.toEqual({
                status: 'cancelled',
                attemptId: 'restored-attempt',
            });

            finishRead();
            await expect(restoration).resolves.toEqual({
                status: 'conflict',
                attemptId: 'restored-attempt',
                code: 'connected_account_attempt_cancelled',
            });
            await expect(h.owner.beginConnect({
                service,
                modeId: 'manual',
            })).resolves.toEqual({
                status: 'awaitingManual',
                attemptId: 'attempt-1',
            });
            await expect(h.owner.read({
                attemptId: 'restored-attempt',
            })).resolves.toEqual({
                status: 'cancelled',
                attemptId: 'restored-attempt',
            });
            expect(h.invoke).not.toHaveBeenCalled();
            expect(h.settle).not.toHaveBeenCalled();
        },
    );

    it('returns typed unavailability before allocating an attempt when runtime admission fails', async () => {
        const h = harness({
            admitMode: async () => {
                throw new Error('plugin unavailable');
            },
        });

        await expect(h.owner.beginConnect({
            service,
            modeId: 'manual',
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'connected_account_runtime_unavailable',
        });
        expect(h.admitConfiguration).not.toHaveBeenCalled();
        expect(h.invoke).not.toHaveBeenCalled();
    });

    it('reports runtime generation drift, not unavailability, when admission rejects with the typed currentness error', async () => {
        const h = harness({
            admitMode: async () => {
                throw new ConnectedAccountRuntimeInvocationNotStartedError();
            },
        });

        await expect(h.owner.beginConnect({
            service,
            modeId: 'manual',
        })).resolves.toEqual({
            status: 'conflict',
            code: 'connected_account_runtime_generation_changed',
        });
        expect(h.admitConfiguration).not.toHaveBeenCalled();
        expect(h.invoke).not.toHaveBeenCalled();
    });

    it('reports runtime generation drift when a restored device attempt observes the typed currentness error', async () => {
        const clear = vi.fn(async () => {});
        const h = harness({
            admitMode: async () => {
                throw new ConnectedAccountRuntimeInvocationNotStartedError();
            },
            deviceTransactions: {
                acknowledge: vi.fn(async () => {}),
                read: vi.fn(async () => Object.freeze({
                    attemptId: 'attempt-restored',
                    createdAtMs: 1_000,
                    intent: 'connect',
                    service,
                    modeId: 'device',
                    immutableGenerationId: 'artifact-acme-1',
                    expectedCredentialRevision: null,
                    expectedCredentialConfigurationRevision: null,
                    expectedConfigurationRevision: 'configuration-1',
                    expiresAtMs: 61_000,
                    pollIntervalMs: 5_000,
                    nextPollAtMs: 6_000,
                    verificationUri: 'https://provider.example/device',
                    userCode: 'ABCD',
                    stagedCredentials: Object.freeze({}),
                })),
                clear,
            },
        });

        await expect(h.owner.resumeDevice({
            attemptId: 'attempt-restored',
        })).resolves.toEqual({
            status: 'conflict',
            attemptId: 'attempt-restored',
            code: 'connected_account_runtime_generation_changed',
        });
        expect(clear).toHaveBeenCalledWith('attempt-restored');
        expect(h.invoke).not.toHaveBeenCalled();
    });

    it('reports runtime generation drift when continueConnect observes the typed currentness error', async () => {
        const target = Object.freeze({
            kind: 'attempt' as const,
            attemptId: 'attempt-1',
            service,
            modeId: 'oauth',
        });
        let rejectRuntimeCurrentness = false;
        const h = harness({
            admittedMode: oauthMode({
                outcomeReconciliation: 'none',
                configuration: accountScopedConfiguration(),
            }),
            configuration: {
                status: 'configurationRequired',
                target,
                missingFieldIds: ['tenant'],
            },
            generationCurrent: async () => {
                if (rejectRuntimeCurrentness) {
                    throw new ConnectedAccountRuntimeInvocationNotStartedError();
                }
                return true;
            },
        });
        await h.owner.beginConnect({ service, modeId: 'oauth' });
        rejectRuntimeCurrentness = true;

        await expect(h.owner.continueConnect({
            attemptId: 'attempt-1',
            expectedConfigurationRevision: 'configuration-1',
        })).resolves.toEqual({
            status: 'conflict',
            attemptId: 'attempt-1',
            code: 'connected_account_runtime_generation_changed',
        });
        expect(h.invoke).not.toHaveBeenCalled();
    });

    it('returns typed unavailability and clears a restored device transaction when runtime admission fails', async () => {
        const clear = vi.fn(async () => {});
        const h = harness({
            admitMode: async () => {
                throw new Error('plugin unavailable');
            },
            deviceTransactions: {
                acknowledge: vi.fn(async () => {}),
                read: vi.fn(async () => Object.freeze({
                    attemptId: 'attempt-restored',
                    createdAtMs: 1_000,
                    intent: 'connect',
                    service,
                    modeId: 'device',
                    immutableGenerationId: 'artifact-acme-1',
                    expectedCredentialRevision: null,
                    expectedCredentialConfigurationRevision: null,
                    expectedConfigurationRevision: 'configuration-1',
                    expiresAtMs: 61_000,
                    pollIntervalMs: 5_000,
                    nextPollAtMs: 6_000,
                    verificationUri: 'https://provider.example/device',
                    userCode: 'ABCD',
                    stagedCredentials: Object.freeze({}),
                })),
                clear,
            },
        });

        await expect(h.owner.resumeDevice({
            attemptId: 'attempt-restored',
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-restored',
            code: 'connected_account_runtime_unavailable',
        });
        expect(clear).toHaveBeenCalledWith('attempt-restored');
        expect(h.admitConfiguration).not.toHaveBeenCalled();
        expect(h.invoke).not.toHaveBeenCalled();
    });

    it('returns typed unavailability and clears a restored device transaction when runtime currentness rejects', async () => {
        let durableSnapshot: unknown = null;
        const deviceTransactions = {
            acknowledge: vi.fn(async (input: unknown) => {
                durableSnapshot = input;
            }),
            read: vi.fn(async () => durableSnapshot),
            clear: vi.fn(async () => {
                durableSnapshot = null;
            }),
        };
        const first = harness({
            admittedMode: deviceMode(),
            deviceTransactions,
        });
        await first.owner.beginConnect({ service, modeId: 'device' });
        await waitForAttemptStatus(
            first.owner,
            'attempt-1',
            'awaitingDeviceAuthorization',
        );

        const replacement = harness({
            admittedMode: deviceMode(),
            deviceTransactions,
            generationCurrent: async () => {
                throw new Error('runtime currentness unavailable');
            },
        });
        await expect(replacement.owner.resumeDevice({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_runtime_unavailable',
        });
        expect(deviceTransactions.clear).toHaveBeenCalledWith('attempt-1');
        expect(durableSnapshot).toBeNull();
        expect(replacement.invoke).not.toHaveBeenCalled();
        expect(replacement.settle).not.toHaveBeenCalled();
        await expect(replacement.owner.read({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_not_found',
        });
    });

    it('clears a restored device transaction when current peer admission rejects provider effects', async () => {
        let durableSnapshot: unknown = null;
        const deviceTransactions = {
            acknowledge: vi.fn(async (input: unknown) => {
                durableSnapshot = input;
            }),
            read: vi.fn(async () => durableSnapshot),
            clear: vi.fn(async () => {
                durableSnapshot = null;
            }),
        };
        const first = harness({
            admittedMode: deviceMode(),
            deviceTransactions,
        });
        await first.owner.beginConnect({ service, modeId: 'device' });
        await waitForAttemptStatus(
            first.owner,
            'attempt-1',
            'awaitingDeviceAuthorization',
        );
        expect(durableSnapshot).not.toBeNull();

        const replacement = harness({
            admittedMode: deviceMode(),
            deviceTransactions,
            assertEffectfulOperationAllowed: () => {
                throw Object.assign(
                    new Error('credential write is no longer supported'),
                    { code: 'connected_account_legacy_operation_unsupported' },
                );
            },
        });
        await expect(replacement.owner.resumeDevice({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_legacy_operation_unsupported',
        });
        expect(deviceTransactions.clear).toHaveBeenCalledWith('attempt-1');
        expect(durableSnapshot).toBeNull();
        expect(replacement.invoke).not.toHaveBeenCalled();
        await expect(replacement.owner.read({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_not_found',
        });
    });

    it('retains restored device terminal cleanup for exact retry when clear fails', async () => {
        let durableSnapshot: unknown = null;
        let rejectFirstClear!: (reason: Error) => void;
        const firstClear = new Promise<void>((_resolve, reject) => {
            rejectFirstClear = reject;
        });
        const clear = vi.fn()
            .mockImplementationOnce(async () => await firstClear)
            .mockImplementation(async () => {
                durableSnapshot = null;
            });
        const deviceTransactions = {
            acknowledge: vi.fn(async (input: unknown) => {
                durableSnapshot = input;
            }),
            read: vi.fn(async () => durableSnapshot),
            clear,
        };
        const first = harness({
            admittedMode: deviceMode(),
            deviceTransactions,
        });
        await first.owner.beginConnect({ service, modeId: 'device' });
        await waitForAttemptStatus(
            first.owner,
            'attempt-1',
            'awaitingDeviceAuthorization',
        );
        expect(durableSnapshot).not.toBeNull();

        const replacement = harness({
            admittedMode: deviceMode(),
            deviceTransactions,
            assertEffectfulOperationAllowed: () => {
                throw Object.assign(
                    new Error('credential write is no longer supported'),
                    { code: 'connected_account_legacy_operation_unsupported' },
                );
            },
        });
        const restored = replacement.owner.resumeDevice({
            attemptId: 'attempt-1',
        });
        const restoredOutcome = restored.then(
            () => null,
            (error: unknown) => error,
        );
        await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());

        const concurrentRead = replacement.owner.read({ attemptId: 'attempt-1' });
        await Promise.resolve();
        expect(clear).toHaveBeenCalledOnce();
        expect(replacement.destroyAttemptConfiguration).toHaveBeenCalledOnce();

        rejectFirstClear(new Error('device transaction storage unavailable'));
        await expect(restoredOutcome).resolves.toMatchObject({
            code: 'connected_account_attempt_cleanup_pending',
            attemptId: 'attempt-1',
        });
        await expect(concurrentRead).resolves.toEqual({
            status: 'cleanupPending',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_cleanup_pending',
        });
        expect(durableSnapshot).not.toBeNull();
        expect(replacement.invoke).not.toHaveBeenCalled();

        await expect(replacement.owner.read({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_legacy_operation_unsupported',
        });
        expect(clear).toHaveBeenCalledTimes(2);
        expect(replacement.destroyAttemptConfiguration).toHaveBeenCalledOnce();
        expect(durableSnapshot).toBeNull();
        expect(replacement.invoke).not.toHaveBeenCalled();
        await expect(replacement.owner.read({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_legacy_operation_unsupported',
        });
        expect(clear).toHaveBeenCalledTimes(2);
        expect(replacement.destroyAttemptConfiguration).toHaveBeenCalledOnce();
    });

    it('promotes a first manual connect only through null-CAS after staged credentials and currentness revalidation', async () => {
        const h = harness({
            invoke: async ({ operation, context }) => {
                expect(operation).toEqual({
                    kind: 'submitManual',
                    fields: { token: 'user-input' },
                });
                await context.attemptCredentials.set('accessToken', 'provider-token');
                return {
                    status: 'connected',
                    accountId: 'account-a',
                    providerIdentity: { accountId: 'provider-user-1', email: 'work@example.test' },
                    displayName: 'Account A',
                    scopes: ['read'],
                };
            },
        });

        await expect(h.owner.beginConnect({
            service,
            modeId: 'manual',
            expectedConfigurationRevision: 'configuration-1',
        })).resolves.toEqual({
            status: 'awaitingManual',
            attemptId: 'attempt-1',
        });
        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'user-input' },
        })).resolves.toEqual({
            status: 'connected',
            attemptId: 'attempt-1',
            account: accountA,
        });

        expect(h.settle).toHaveBeenCalledOnce();
        expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({
            intent: 'connect',
            service,
            accountId: 'account-a',
            authenticationModeId: 'manual',
            expectedCredentialRevision: null,
            expectedCredentialConfigurationRevision: null,
            expectedConfigurationRevision: 'configuration-1',
            generation: 'generation-1',
            stagedCredentials: { accessToken: 'provider-token' },
            providerIdentity: { accountId: 'provider-user-1', email: 'work@example.test' },
        }));
        expect(h.configurationCurrent).toHaveBeenCalled();
        expect(h.generationCurrent).toHaveBeenCalled();
    });

    it('mints a canonical first-connect account id without reusing operation identity', async () => {
        const createAccountId = vi.fn(() => 'host-account-opaque');
        let settlementAttempt = 0;
        let finishPreparedSettlement!: (
            value: Readonly<{
                status: 'connected';
                account: Readonly<{
                    service: typeof service;
                    accountId: string;
                }>;
            }>,
        ) => void;
        const preparedSettlement = new Promise<Readonly<{
            status: 'connected';
            account: Readonly<{
                service: typeof service;
                accountId: string;
            }>;
        }>>((resolve) => {
            finishPreparedSettlement = resolve;
        });
        const rereadPreparedSettlement = vi.fn(async (
            _request: ConnectedAccountAttemptSettlementRequest,
        ) => {
            settlementAttempt += 1;
            if (settlementAttempt === 1) {
                throw new Error('credential write committed before response was lost');
            }
            return await preparedSettlement;
        });
        const h = harness({
            createAccountId,
            settle: rereadPreparedSettlement,
            invoke: async () => ({
                status: 'connected',
                providerIdentity: {
                    accountId: 'mutable-provider-subject',
                    email: 'mutable@example.test',
                },
                displayName: 'API key',
                scopes: [],
            }),
        });

        await expect(h.owner.beginConnect({
            service,
            modeId: 'manual',
        })).resolves.toEqual({
            status: 'awaitingManual',
            attemptId: 'attempt-1',
        });
        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'user-input' },
        })).resolves.toMatchObject({
            status: 'outcomeUnknown',
            attemptId: 'attempt-1',
            diagnostic: { code: 'connected_account_settlement_outcome_unknown' },
        });
        const reconciliation = h.owner.reconcile({
            attemptId: 'attempt-1',
        });
        await vi.waitFor(() => expect(rereadPreparedSettlement).toHaveBeenCalledTimes(2));
        const concurrentReconciliation = h.owner.reconcile({
            attemptId: 'attempt-1',
        });
        await Promise.resolve();
        const settlementCallsBeforeRelease =
            rereadPreparedSettlement.mock.calls.length;
        finishPreparedSettlement({
            status: 'connected',
            account: { service, accountId: 'host-account-opaque' },
        });
        await expect(concurrentReconciliation).resolves.toEqual({
            status: 'conflict',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_in_progress',
        });
        await expect(reconciliation).resolves.toEqual({
            status: 'connected',
            attemptId: 'attempt-1',
            account: { service, accountId: 'host-account-opaque' },
        });
        expect(settlementCallsBeforeRelease).toBe(2);
        expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({
            intent: 'connect',
            accountId: 'host-account-opaque',
            expectedCredentialRevision: null,
            providerIdentity: {
                accountId: 'mutable-provider-subject',
                email: 'mutable@example.test',
            },
        }));
        expect(createAccountId).toHaveBeenCalledOnce();
        expect(rereadPreparedSettlement).toHaveBeenCalledTimes(2);
        expect(rereadPreparedSettlement.mock.calls[0]?.[0]).toBe(
            rereadPreparedSettlement.mock.calls[1]?.[0],
        );
        expect(rereadPreparedSettlement.mock.calls[1]?.[0]).toEqual(
            expect.objectContaining({ accountId: 'host-account-opaque' }),
        );
        expect(h.invoke).toHaveBeenCalledOnce();

        const attemptIdentity = harness({
            createAccountId: () => 'unused-host-account',
            invoke: async ({ context }) => ({
                status: 'connected',
                accountId: context.attempt.attemptId,
                displayName: 'Invalid API key account',
                scopes: [],
            }),
        });
        const started = await attemptIdentity.owner.beginConnect({
            service,
            modeId: 'manual',
        });
        expect(started).toEqual({ status: 'awaitingManual', attemptId: 'attempt-1' });
        await expect(attemptIdentity.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'user-input' },
        })).resolves.toMatchObject({
            status: 'rejected',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_identity_forbidden',
        });
        expect(attemptIdentity.settle).not.toHaveBeenCalled();

        const invalidMint = harness({
            createAccountId: () => 'attempt-1',
            invoke: async () => ({
                status: 'connected',
                displayName: 'Invalid host identity',
                scopes: [],
            }),
        });
        await invalidMint.owner.beginConnect({ service, modeId: 'manual' });
        await expect(invalidMint.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'user-input' },
        })).resolves.toMatchObject({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_identity_unavailable',
        });
        expect(invalidMint.settle).not.toHaveBeenCalled();
    });

    it('keeps a rejected prepared settlement retryable across runtime-generation drift', async () => {
        let generationCurrent = true;
        let rejectFirstSettlement!: (reason: Error) => void;
        const firstSettlement = new Promise<never>((_resolve, reject) => {
            rejectFirstSettlement = reject;
        });
        const settle = vi.fn()
            .mockImplementationOnce(async () => await firstSettlement)
            .mockResolvedValue({
                status: 'connected',
                account: accountA,
            });
        const h = harness({
            generationCurrent: () => generationCurrent,
            settle,
            invoke: async () => ({
                status: 'connected',
                accountId: 'account-a',
                displayName: 'Account A',
                scopes: [],
            }),
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });
        const completion = h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'candidate' },
        });
        await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce());
        generationCurrent = false;
        rejectFirstSettlement(new Error('settlement acknowledgement lost'));

        await expect(completion).resolves.toMatchObject({
            status: 'outcomeUnknown',
            attemptId: 'attempt-1',
        });
        expect(settle).toHaveBeenCalledOnce();

        generationCurrent = true;
        await expect(h.owner.reconcile({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'connected',
            attemptId: 'attempt-1',
            account: accountA,
        });
        expect(settle).toHaveBeenCalledTimes(2);
        expect(h.invoke).toHaveBeenCalledOnce();
    });

    it('terminalizes a decisive settlement result despite later configuration drift', async () => {
        let configurationCurrent = true;
        const h = harness({
            configurationCurrent: () => configurationCurrent,
            settle: async () => {
                configurationCurrent = false;
                return {
                    status: 'connected',
                    account: accountA,
                };
            },
            invoke: async () => ({
                status: 'connected',
                accountId: 'account-a',
                displayName: 'Account A',
                scopes: [],
            }),
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });
        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'candidate' },
        })).resolves.toEqual({
            status: 'connected',
            attemptId: 'attempt-1',
            account: accountA,
        });
        expect(h.settle).toHaveBeenCalledOnce();
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'connected',
            attemptId: 'attempt-1',
            account: accountA,
        });
    });

    it('keeps prepared OAuth settlement retryable when snapshot acknowledgement observes drift', async () => {
        let generationCurrent = true;
        let markPreparedAcknowledgementStarted!: () => void;
        const preparedAcknowledgementStarted = new Promise<void>((resolve) => {
            markPreparedAcknowledgementStarted = resolve;
        });
        let releasePreparedAcknowledgement!: () => void;
        const preparedAcknowledgement = new Promise<void>((resolve) => {
            releasePreparedAcknowledgement = resolve;
        });
        const durable = durableOAuthTransactions({
            beforeAcknowledge: async (snapshot) => {
                if (!snapshot.preparedSettlement) return;
                generationCurrent = false;
                markPreparedAcknowledgementStarted();
                await preparedAcknowledgement;
            },
        });
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'providerCheck' }),
            generationCurrent: () => generationCurrent,
            oauthTransactions: durable.owner,
            invoke: async ({ operation }) => operation.kind === 'beginOAuth'
                ? {
                    status: 'awaitingOAuthRedirect',
                    authorizationUrl: 'https://provider.example/authorize',
                }
                : {
                    status: 'connected',
                    accountId: 'account-a',
                    displayName: 'Account A',
                    scopes: [],
                },
        });
        await h.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');
        const completion = h.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'code-1',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        });
        await preparedAcknowledgementStarted;
        releasePreparedAcknowledgement();

        await expect(completion).resolves.toMatchObject({
            status: 'outcomeUnknown',
            attemptId: 'attempt-1',
        });
        expect(h.settle).not.toHaveBeenCalled();

        generationCurrent = true;
        await expect(h.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'ignored-after-preparation',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        })).resolves.toEqual({
            status: 'connected',
            attemptId: 'attempt-1',
            account: accountA,
        });
        expect(h.settle).toHaveBeenCalledOnce();
        expect(h.invoke).toHaveBeenCalledTimes(2);
    });

    it('retries prepared OAuth custody acknowledgement before settlement', async () => {
        const acknowledgePreparedSettlement = vi.fn()
            .mockRejectedValueOnce(new Error('OAuth snapshot unavailable'))
            .mockResolvedValue(undefined);
        const durable = durableOAuthTransactions({
            beforeAcknowledge: async (snapshot) => {
                if (snapshot.preparedSettlement) {
                    await acknowledgePreparedSettlement();
                }
            },
        });
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'providerCheck' }),
            oauthTransactions: durable.owner,
            invoke: async ({ operation }) => operation.kind === 'beginOAuth'
                ? {
                    status: 'awaitingOAuthRedirect',
                    authorizationUrl: 'https://provider.example/authorize',
                }
                : {
                    status: 'connected',
                    accountId: 'account-a',
                    displayName: 'Account A',
                    scopes: [],
                },
        });
        await h.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');
        await expect(h.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'code-1',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        })).resolves.toMatchObject({
            status: 'outcomeUnknown',
            attemptId: 'attempt-1',
        });
        expect(acknowledgePreparedSettlement).toHaveBeenCalledOnce();
        expect(h.settle).not.toHaveBeenCalled();

        await expect(h.owner.reconcile({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'connected',
            attemptId: 'attempt-1',
            account: accountA,
        });
        expect(acknowledgePreparedSettlement).toHaveBeenCalledTimes(2);
        expect(h.settle).toHaveBeenCalledOnce();
        expect(h.invoke).toHaveBeenCalledTimes(2);
    });

    it('settles reconnect against the admitted exact account when the provider omits a proposal', async () => {
        const h = harness({
            account: {
                account: accountA,
                authenticationModeId: 'manual',
                credentialRevision: 'credential-7',
                configurationRevision: 'account-configuration-7',
            },
            invoke: async () => ({
                status: 'connected',
                displayName: 'Account A',
                scopes: [],
            }),
        });

        await expect(h.owner.beginReconnect({ account: accountA })).resolves.toEqual({
            status: 'awaitingManual',
            attemptId: 'attempt-1',
        });
        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'replacement' },
        })).resolves.toEqual({
            status: 'connected',
            attemptId: 'attempt-1',
            account: accountA,
        });
        expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({
            intent: 'reconnect',
            accountId: 'account-a',
            expectedCredentialRevision: 'credential-7',
            expectedCredentialConfigurationRevision: 'account-configuration-7',
        }));
    });

    it.each([
        ['deleted', null],
        ['credential revision changed', {
            account: accountA,
            authenticationModeId: 'manual',
            credentialRevision: 'credential-8',
            configurationRevision: null,
        }],
        ['configuration revision changed', {
            account: accountA,
            authenticationModeId: 'manual',
            credentialRevision: 'credential-7',
            configurationRevision: 'configuration-2',
        }],
        ['authentication mode changed', {
            account: accountA,
            authenticationModeId: 'replacement-mode',
            credentialRevision: 'credential-7',
            configurationRevision: null,
        }],
    ] as const)(
        'rejects a reconnect account that was %s before provider invocation',
        async (_label, changedAccount) => {
            let currentAccount: Readonly<{
                account: typeof accountA;
                authenticationModeId: string;
                credentialRevision: string;
                configurationRevision: string | null;
            }> | null = {
                account: accountA,
                authenticationModeId: 'manual',
                credentialRevision: 'credential-7',
                configurationRevision: null,
            };
            const h = harness({
                readAccount: async () => currentAccount,
            });

            await expect(h.owner.beginReconnect({
                account: accountA,
            })).resolves.toEqual({
                status: 'awaitingManual',
                attemptId: 'attempt-1',
            });

            currentAccount = changedAccount;

            await expect(h.owner.submitManual({
                attemptId: 'attempt-1',
                fields: { token: 'replacement' },
            })).resolves.toEqual({
                status: 'conflict',
                attemptId: 'attempt-1',
                code: 'connected_account_credential_changed',
            });
            expect(h.invoke).not.toHaveBeenCalled();
            expect(h.settle).not.toHaveBeenCalled();
        },
    );

    it('keeps the admitted account-configuration CAS basis when the account changes before reconnect settlement', async () => {
        const settle = vi.fn(async (
            request: ConnectedAccountAttemptSettlementRequest,
        ) => {
            expect(request).toMatchObject({
                intent: 'reconnect',
                expectedCredentialRevision: 'credential-7',
                expectedCredentialConfigurationRevision:
                    'account-configuration-at-admission',
                expectedConfigurationRevision: 'configuration-1',
            });
            return {
                status: 'conflict' as const,
                code: 'connected_account_settlement_conflict',
            };
        });
        const h = harness({
            account: {
                account: accountA,
                authenticationModeId: 'manual',
                credentialRevision: 'credential-7',
                configurationRevision: 'account-configuration-at-admission',
            },
            settle,
            invoke: async () => ({
                status: 'connected',
                displayName: 'Account A',
                scopes: [],
            }),
        });

        await h.owner.beginReconnect({ account: accountA });
        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'replacement' },
        })).resolves.toEqual({
            status: 'conflict',
            attemptId: 'attempt-1',
            code: 'connected_account_settlement_conflict',
        });
        expect(settle).toHaveBeenCalledOnce();
    });

    it('admits reconnect from the exact account and rejects a provider identity drift before settlement', async () => {
        const h = harness({
            admittedMode: manualMode('persisted-mode'),
            account: {
                account: accountA,
                authenticationModeId: 'persisted-mode',
                credentialRevision: 'credential-7',
                configurationRevision: null,
            },
            invoke: async () => ({
                status: 'connected',
                accountId: 'account-b',
                displayName: 'Wrong account',
                scopes: [],
            }),
        });

        await expect(h.owner.beginReconnect({
            account: accountA,
            expectedConfigurationRevision: 'configuration-1',
        })).resolves.toEqual({
            status: 'awaitingManual',
            attemptId: 'attempt-1',
        });
        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'replacement' },
        })).resolves.toMatchObject({
            status: 'rejected',
            code: 'connected_account_reconnect_identity_mismatch',
            attemptId: 'attempt-1',
        });

        expect(h.invoke).toHaveBeenCalledWith(expect.objectContaining({
            admission: expect.objectContaining({ modeId: 'persisted-mode' }),
            context: expect.objectContaining({
                attempt: { kind: 'reconnect', attemptId: 'attempt-1', account: accountA },
            }),
        }));
        expect(h.settle).not.toHaveBeenCalled();
    });

    it('returns configurationRequired without allocating an attempt or invoking provider work', async () => {
        const target = Object.freeze({ kind: 'service' as const, service, modeId: 'oauth' });
        const h = harness({
            admittedMode: oauthMode({
                outcomeReconciliation: 'none',
                configuration: {
                    scope: 'service',
                    changeBehavior: 'reconnect',
                    fields: [{
                        id: 'endpoint',
                        title: 'Endpoint',
                        schema: { type: 'string' },
                        secret: false,
                    }],
                },
            }),
            configuration: {
                status: 'configurationRequired',
                target,
                missingFieldIds: Object.freeze(['endpoint', 'clientSecret']),
            },
        });

        await expect(h.owner.beginConnect({
            service,
            modeId: 'oauth',
        })).resolves.toEqual({
            status: 'configurationRequired',
            target,
            missingFieldIds: ['endpoint', 'clientSecret'],
        });
        expect(h.invoke).not.toHaveBeenCalled();
        expect(h.admitConfiguration).toHaveBeenCalledWith(expect.objectContaining({
            generation: 'generation-1',
            immutableGenerationId: 'artifact-acme-1',
        }));
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'connected_account_attempt_not_found',
        });
    });

    it('rejects configuration or plugin-generation drift after provider completion and before settlement', async () => {
        let configurationCurrent = true;
        let generationCurrent = true;
        const h = harness({
            admittedMode: oauthMode({
                outcomeReconciliation: 'none',
                configuration: {
                    scope: 'service',
                    changeBehavior: 'refresh',
                    fields: [{
                        id: 'endpoint',
                        title: 'Endpoint',
                        schema: { type: 'string' },
                        secret: false,
                    }],
                },
            }),
            configuration: configured('configuration-1', {
                endpoint: 'https://api.example.test',
            }, 'oauth'),
            configurationCurrent: () => configurationCurrent,
            generationCurrent: () => generationCurrent,
            invoke: async ({ operation }) => {
                if (operation.kind === 'beginOAuth') {
                    return {
                        status: 'awaitingOAuthRedirect',
                        authorizationUrl: 'https://provider.example/authorize',
                    };
                }
                configurationCurrent = false;
                generationCurrent = false;
                return {
                    status: 'connected',
                    accountId: 'account-a',
                    displayName: 'Account A',
                    scopes: [],
                };
            },
        });

        await expect(h.owner.beginConnect({ service, modeId: 'oauth' })).resolves.toEqual({
            status: 'starting',
            attemptId: 'attempt-1',
        });
        await expect(waitForAttemptStatus(
            h.owner,
            'attempt-1',
            'awaitingOAuth',
        )).resolves.toMatchObject({
            status: 'awaitingOAuth',
            callbackUrl: 'http://127.0.0.1:4000/auth/callback',
        });
        await expect(h.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'code-1',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        })).resolves.toMatchObject({
            status: 'conflict',
            code: 'connected_account_configuration_changed',
        });
        expect(h.settle).not.toHaveBeenCalled();
    });

    it('reconciles outcomeUnknown only through a declared providerCheck leaf', async () => {
        const invoke = vi.fn(async ({ operation }: ConnectedAccountAttemptProviderInvocation) => {
            if (operation.kind === 'beginOAuth') {
                return {
                    status: 'awaitingOAuthRedirect',
                    authorizationUrl: 'https://provider.example/authorize',
                };
            }
            if (operation.kind === 'reconcile') {
                return {
                    status: 'connected',
                    accountId: 'account-a',
                    displayName: 'Account A',
                    scopes: [],
                };
            }
            return {
                status: 'outcomeUnknown',
                diagnostic: { code: 'provider_response_lost' },
            };
        });
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'providerCheck' }),
            invoke,
        });

        await h.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');
        await expect(h.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'code-1',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        })).resolves.toMatchObject({ status: 'outcomeUnknown', attemptId: 'attempt-1' });
        await expect(h.owner.reconcile({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'connected',
            attemptId: 'attempt-1',
            account: accountA,
        });
        expect(invoke.mock.calls.map(([call]) => call.operation.kind)).toEqual([
            'beginOAuth',
            'completeOAuth',
            'reconcile',
        ]);
    });

    it('serializes provider-check reconciliation before its first asynchronous preflight', async () => {
        let releaseReconciliationPreflight!: () => void;
        const reconciliationPreflight = new Promise<void>((resolve) => {
            releaseReconciliationPreflight = resolve;
        });
        let holdReconciliationPreflight = false;
        const invoke = vi.fn(async ({ operation }: ConnectedAccountAttemptProviderInvocation) => {
            if (operation.kind === 'beginOAuth') {
                return {
                    status: 'awaitingOAuthRedirect',
                    authorizationUrl: 'https://provider.example/authorize',
                };
            }
            if (operation.kind === 'reconcile') {
                return {
                    status: 'pending',
                    retryAfterMs: 1_000,
                };
            }
            return {
                status: 'outcomeUnknown',
                diagnostic: { code: 'provider_response_lost' },
            };
        });
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'providerCheck' }),
            configurationCurrent: async () => {
                if (holdReconciliationPreflight) {
                    await reconciliationPreflight;
                }
                return true;
            },
            invoke,
        });

        await h.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');
        await h.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'code-1',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        });

        holdReconciliationPreflight = true;
        const first = h.owner.reconcile({ attemptId: 'attempt-1' });
        const second = h.owner.reconcile({ attemptId: 'attempt-1' });
        releaseReconciliationPreflight();

        await expect(second).resolves.toEqual({
            status: 'conflict',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_in_progress',
        });
        await expect(first).resolves.toEqual({
            status: 'pending',
            attemptId: 'attempt-1',
            retryAfterMs: 1_000,
        });
        expect(
            invoke.mock.calls.filter(([call]) => call.operation.kind === 'reconcile'),
        ).toHaveLength(1);
    });

    it('claims OAuth completion before its first awaited preflight', async () => {
        let holdCurrentness = false;
        let releaseCurrentness!: () => void;
        const currentness = new Promise<void>((resolve) => {
            releaseCurrentness = resolve;
        });
        const invoke = vi.fn(async ({ operation }: ConnectedAccountAttemptProviderInvocation) => (
            operation.kind === 'beginOAuth'
                ? {
                    status: 'awaitingOAuthRedirect',
                    authorizationUrl: 'https://provider.example/authorize',
                }
                : {
                    status: 'outcomeUnknown',
                    diagnostic: { code: 'callback_delivery_uncertain' },
                }
        ));
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'providerCheck' }),
            configurationCurrent: async () => {
                if (holdCurrentness) await currentness;
                return true;
            },
            invoke,
        });
        await h.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');

        holdCurrentness = true;
        const first = h.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'code-1',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        });
        const second = h.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'code-2',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        });
        releaseCurrentness();

        await expect(second).resolves.toEqual({
            status: 'conflict',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_in_progress',
        });
        await expect(first).resolves.toMatchObject({
            status: 'outcomeUnknown',
            attemptId: 'attempt-1',
        });
        expect(invoke.mock.calls.filter(
            ([call]) => call.operation.kind === 'completeOAuth',
        )).toHaveLength(1);
    });

    it('serializes late-evidence reconciliation through the same one-effect phase', async () => {
        let finishEvidence!: (value: unknown) => void;
        const evidence = new Promise<unknown>((resolve) => {
            finishEvidence = resolve;
        });
        const reconcile = vi.fn(async () => await evidence);
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'lateEvidence' }),
            invoke: async ({ operation }) => {
                if (operation.kind === 'beginOAuth') {
                    return {
                        status: 'awaitingOAuthRedirect',
                        authorizationUrl: 'https://provider.example/authorize',
                    };
                }
                return {
                    status: 'outcomeUnknown',
                    diagnostic: { code: 'callback_delivery_uncertain' },
                };
            },
            lateEvidence: { reconcile },
        });
        await h.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');
        await h.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'code-1',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        });

        const first = h.owner.reconcile({ attemptId: 'attempt-1' });
        await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
        await expect(h.owner.reconcile({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'conflict',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_in_progress',
        });
        finishEvidence({
            status: 'connected',
            accountId: 'account-a',
            displayName: 'Account A',
            scopes: [],
        });
        await expect(first).resolves.toMatchObject({ status: 'connected' });
        expect(h.settle).toHaveBeenCalledOnce();
    });

    it('restores outcomeUnknown after rejected late evidence observes runtime-generation drift', async () => {
        let generationCurrent = true;
        let rejectFirstEvidence!: (reason: Error) => void;
        const firstEvidence = new Promise<unknown>((_resolve, reject) => {
            rejectFirstEvidence = reject;
        });
        const reconcile = vi.fn()
            .mockImplementationOnce(async () => await firstEvidence)
            .mockResolvedValue({
                status: 'connected',
                accountId: 'account-a',
                displayName: 'Account A',
                scopes: [],
            });
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'lateEvidence' }),
            generationCurrent: () => generationCurrent,
            invoke: async ({ operation }) => {
                if (operation.kind === 'beginOAuth') {
                    return {
                        status: 'awaitingOAuthRedirect',
                        authorizationUrl: 'https://provider.example/authorize',
                    };
                }
                return {
                    status: 'outcomeUnknown',
                    diagnostic: { code: 'callback_delivery_uncertain' },
                };
            },
            lateEvidence: { reconcile },
        });
        await h.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');
        await h.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'code-1',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        });

        const first = h.owner.reconcile({ attemptId: 'attempt-1' });
        await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
        generationCurrent = false;
        rejectFirstEvidence(new Error('late evidence transport failed'));

        await expect(first).resolves.toMatchObject({
            status: 'outcomeUnknown',
            attemptId: 'attempt-1',
        });
        expect(reconcile).toHaveBeenCalledOnce();
        expect(h.settle).not.toHaveBeenCalled();

        generationCurrent = true;
        await expect(h.owner.reconcile({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'connected',
            attemptId: 'attempt-1',
            account: accountA,
        });
        expect(reconcile).toHaveBeenCalledTimes(2);
        expect(h.settle).toHaveBeenCalledOnce();
    });

    it('terminally destroys rejected late evidence after configuration drift', async () => {
        let configurationCurrent = true;
        let rejectEvidence!: (reason: Error) => void;
        const evidence = new Promise<unknown>((_resolve, reject) => {
            rejectEvidence = reject;
        });
        const reconcile = vi.fn(async () => await evidence);
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'lateEvidence' }),
            configurationCurrent: () => configurationCurrent,
            invoke: async ({ operation }) => {
                if (operation.kind === 'beginOAuth') {
                    return {
                        status: 'awaitingOAuthRedirect',
                        authorizationUrl: 'https://provider.example/authorize',
                    };
                }
                return {
                    status: 'outcomeUnknown',
                    diagnostic: { code: 'callback_delivery_uncertain' },
                };
            },
            lateEvidence: { reconcile },
        });
        await h.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');
        await h.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'code-1',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        });

        const first = h.owner.reconcile({ attemptId: 'attempt-1' });
        await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
        configurationCurrent = false;
        rejectEvidence(new Error('late evidence transport failed'));

        const terminal = {
            status: 'conflict' as const,
            attemptId: 'attempt-1',
            code: 'connected_account_configuration_changed',
        };
        await expect(first).resolves.toEqual(terminal);
        await expect(h.owner.reconcile({
            attemptId: 'attempt-1',
        })).resolves.toEqual(terminal);
        expect(reconcile).toHaveBeenCalledOnce();
        expect(h.settle).not.toHaveBeenCalled();
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledWith('attempt-1');
    });

    it('turns an unreconcilable possible remote effect into reconnectRequired without replay', async () => {
        const h = harness({
            invoke: async () => ({
                status: 'outcomeUnknown',
                diagnostic: { code: 'provider_response_lost' },
            }),
        });

        await h.owner.beginConnect({ service, modeId: 'manual' });
        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'replacement' },
        })).resolves.toMatchObject({ status: 'reconnectRequired' });
        await expect(h.owner.reconcile({ attemptId: 'attempt-1' })).resolves.toMatchObject({
            status: 'reconnectRequired',
        });
        expect(h.invoke).toHaveBeenCalledOnce();
        expect(h.settle).not.toHaveBeenCalled();
    });

    it('continues first-connect account configuration on the exact allocated attempt and promotes its staged envelope once', async () => {
        const target = Object.freeze({
            kind: 'attempt' as const,
            attemptId: 'attempt-1',
            service,
            modeId: 'oauth',
        });
        const stagedAccountConfigurationContent = Object.freeze({
            t: 'encrypted',
            c: 'opaque-account-configuration',
        });
        let finishConfigurationContinuation!: (
            value: ConnectedAccountAttemptConfigurationAdmission,
        ) => void;
        const configurationContinuation =
            new Promise<ConnectedAccountAttemptConfigurationAdmission>((resolve) => {
                finishConfigurationContinuation = resolve;
            });
        const admitConfiguration = vi.fn()
            .mockResolvedValueOnce({
                status: 'configurationRequired',
                target,
                missingFieldIds: ['tenant'],
            })
            .mockImplementationOnce(async () => await configurationContinuation);
        const continuedConfiguration = {
                status: 'ready',
                snapshot: Object.freeze({
                    target,
                    revision: 'configuration-2',
                    values: Object.freeze({ tenant: 'acme' }),
                    getSecret: async () => null,
                }),
                stagedAccountConfigurationContent,
            } satisfies ConnectedAccountAttemptConfigurationAdmission;
        const h = harness({
            admittedMode: oauthMode({
                outcomeReconciliation: 'none',
                configuration: {
                    scope: 'account',
                    changeBehavior: 'reconnect',
                    fields: [{
                        id: 'tenant',
                        title: 'Tenant',
                        schema: { type: 'string' },
                        secret: false,
                    }],
                },
            }),
            admitConfiguration,
        });

        await expect(h.owner.beginConnect({
            service,
            modeId: 'oauth',
        })).resolves.toEqual({
            status: 'configurationRequired',
            attemptId: 'attempt-1',
            target,
            missingFieldIds: ['tenant'],
        });
        await expect(h.owner.resolveConfigurationControlTarget({
            attemptId: 'attempt-1',
        })).resolves.toMatchObject({
            target,
            mode: { id: 'oauth' },
            generation: 'generation-1',
            immutableGenerationId: 'artifact-acme-1',
        });
        const continuation = h.owner.continueConnect({
            attemptId: 'attempt-1',
            expectedConfigurationRevision: 'configuration-2',
        });
        await vi.waitFor(() => expect(admitConfiguration).toHaveBeenCalledTimes(2));
        await expect(h.owner.resolveConfigurationControlTarget({
            attemptId: 'attempt-1',
        })).resolves.toBeNull();
        await expect(h.owner.continueConnect({
            attemptId: 'attempt-1',
            expectedConfigurationRevision: 'configuration-2',
        })).resolves.toEqual({
            status: 'conflict',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_in_progress',
        });
        finishConfigurationContinuation(continuedConfiguration);
        await expect(continuation).resolves.toMatchObject({
            status: 'starting',
            attemptId: 'attempt-1',
        });
        await expect(h.owner.resolveConfigurationControlTarget({
            attemptId: 'attempt-1',
        })).resolves.toBeNull();
        await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');
        await expect(h.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'code-1',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        })).resolves.toMatchObject({ status: 'connected', account: accountA });

        expect(admitConfiguration).toHaveBeenNthCalledWith(2, expect.objectContaining({
            intent: 'connect',
            service,
            mode: expect.objectContaining({ id: 'oauth' }),
            attemptId: 'attempt-1',
            expectedConfigurationRevision: 'configuration-2',
        }));
        expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({
            expectedCredentialRevision: null,
            expectedConfigurationRevision: 'configuration-2',
            stagedAccountConfigurationContent,
        }));
    });

    it('does not expose a configuration target after cancellation wins its runtime check', async () => {
        const target = Object.freeze({
            kind: 'attempt' as const,
            attemptId: 'attempt-1',
            service,
            modeId: 'oauth',
        });
        let holdRuntimeCheck = false;
        let signalRuntimeCheckStarted!: () => void;
        const runtimeCheckStarted = new Promise<void>((resolve) => {
            signalRuntimeCheckStarted = resolve;
        });
        let releaseRuntimeCheck!: () => void;
        const runtimeCheck = new Promise<void>((resolve) => {
            releaseRuntimeCheck = resolve;
        });
        const h = harness({
            admittedMode: oauthMode({
                outcomeReconciliation: 'none',
                configuration: accountScopedConfiguration(),
            }),
            configuration: {
                status: 'configurationRequired',
                target,
                missingFieldIds: ['tenant'],
            },
            generationCurrent: async () => {
                if (holdRuntimeCheck) {
                    signalRuntimeCheckStarted();
                    await runtimeCheck;
                }
                return true;
            },
        });
        await h.owner.beginConnect({ service, modeId: 'oauth' });
        holdRuntimeCheck = true;
        const resolution = h.owner.resolveConfigurationControlTarget({
            attemptId: 'attempt-1',
        });
        await runtimeCheckStarted;
        const cancellation = h.owner.cancel({ attemptId: 'attempt-1' });
        releaseRuntimeCheck();

        await expect(resolution).resolves.toBeNull();
        await expect(cancellation).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
    });

    it('restores configuration-required custody when continuation currentness rejects', async () => {
        const target = Object.freeze({
            kind: 'attempt' as const,
            attemptId: 'attempt-1',
            service,
            modeId: 'oauth',
        });
        let rejectRuntimeCurrentness = false;
        const h = harness({
            admittedMode: oauthMode({
                outcomeReconciliation: 'none',
                configuration: accountScopedConfiguration(),
            }),
            configuration: {
                status: 'configurationRequired',
                target,
                missingFieldIds: ['tenant'],
            },
            generationCurrent: async () => {
                if (rejectRuntimeCurrentness) {
                    throw new Error('runtime currentness unavailable');
                }
                return true;
            },
        });
        await h.owner.beginConnect({ service, modeId: 'oauth' });
        rejectRuntimeCurrentness = true;

        await expect(h.owner.resolveConfigurationControlTarget({
            attemptId: 'attempt-1',
        })).resolves.toBeNull();
        await expect(h.owner.continueConnect({
            attemptId: 'attempt-1',
            expectedConfigurationRevision: 'configuration-1',
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_runtime_unavailable',
        });

        rejectRuntimeCurrentness = false;
        await expect(h.owner.resolveConfigurationControlTarget({
            attemptId: 'attempt-1',
        })).resolves.toMatchObject({ target });
        await expect(h.owner.continueConnect({
            attemptId: 'attempt-1',
            expectedConfigurationRevision: 'configuration-1',
        })).resolves.toMatchObject({
            status: 'configurationRequired',
            attemptId: 'attempt-1',
        });
        expect(h.invoke).not.toHaveBeenCalled();
        expect(h.settle).not.toHaveBeenCalled();
    });

    it('reserves account-configuration attempt capacity before awaiting admission', async () => {
        let finishFirstAdmission!: (value: ConnectedAccountAttemptConfigurationAdmission) => void;
        const firstAdmission = new Promise<ConnectedAccountAttemptConfigurationAdmission>((resolve) => {
            finishFirstAdmission = resolve;
        });
        const target = Object.freeze({
            kind: 'attempt' as const,
            attemptId: 'attempt-1',
            service,
            modeId: 'oauth',
        });
        const admitConfiguration = vi.fn()
            .mockImplementationOnce(async () => await firstAdmission)
            .mockResolvedValue({
                status: 'configurationRequired',
                target: { ...target, attemptId: 'attempt-2' },
                missingFieldIds: ['tenant'],
            });
        const h = harness({
            maxAttempts: 1,
            admittedMode: oauthMode({
                outcomeReconciliation: 'none',
                configuration: {
                    scope: 'account',
                    changeBehavior: 'reconnect',
                    fields: [{
                        id: 'tenant',
                        title: 'Tenant',
                        schema: { type: 'string' },
                        required: true,
                        secret: false,
                    }],
                },
            }),
            admitConfiguration,
        });

        const first = h.owner.beginConnect({ service, modeId: 'oauth' });
        await vi.waitFor(() => expect(admitConfiguration).toHaveBeenCalledOnce());
        await expect(h.owner.beginConnect({ service, modeId: 'oauth' })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'connected_account_attempt_capacity_exhausted',
        });
        expect(admitConfiguration).toHaveBeenCalledOnce();

        finishFirstAdmission({
            status: 'configurationRequired',
            target,
            missingFieldIds: ['tenant'],
        });
        await expect(first).resolves.toMatchObject({
            status: 'configurationRequired',
            attemptId: 'attempt-1',
        });
    });

    it('keeps durable OAuth restoration within capacity while an account-configuration attempt is reserved', async () => {
        const mode = oauthMode({
            outcomeReconciliation: 'none',
            configuration: accountScopedConfiguration(),
        });
        const durable = durableOAuthTransactions();
        const first = harness({
            admittedMode: mode,
            oauthTransactions: durable.owner,
            admitConfiguration: async (raw) => {
                const attemptId = (raw as Readonly<{ attemptId: string }>).attemptId;
                return configuredAttempt(attemptId, 'oauth');
            },
        });
        await first.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(first.owner, 'attempt-1', 'awaitingOAuth');

        let releaseReservation!: (
            value: ConnectedAccountAttemptConfigurationAdmission,
        ) => void;
        const reservation = new Promise<ConnectedAccountAttemptConfigurationAdmission>(
            (resolve) => {
                releaseReservation = resolve;
            },
        );
        const replacement = harness({
            maxAttempts: 1,
            createAttemptId: () => 'reserved-attempt',
            admittedMode: mode,
            oauthTransactions: durable.owner,
            admitConfiguration: async (raw) => {
                const attemptId = (raw as Readonly<{ attemptId: string }>).attemptId;
                return attemptId === 'reserved-attempt'
                    ? await reservation
                    : configuredAttempt(attemptId, 'oauth');
            },
        });
        const reserved = replacement.owner.beginConnect({
            service,
            modeId: 'oauth',
        });
        await vi.waitFor(() => expect(
            replacement.admitConfiguration,
        ).toHaveBeenCalledWith(expect.objectContaining({
            attemptId: 'reserved-attempt',
        })));

        const restored = await replacement.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'callback-code',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        });
        releaseReservation({
            status: 'configurationRequired',
            target: {
                kind: 'attempt',
                attemptId: 'reserved-attempt',
                service,
                modeId: 'oauth',
            },
            missingFieldIds: ['tenant'],
        });
        await expect(reserved).resolves.toMatchObject({
            status: 'configurationRequired',
            attemptId: 'reserved-attempt',
        });

        expect(restored).toEqual({
            status: 'conflict',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_capacity_exhausted',
        });
        expect(durable.readRecord()).not.toBeNull();
        expect(replacement.invoke).not.toHaveBeenCalled();
    });

    it('keeps durable device restoration within capacity while an account-configuration attempt is reserved', async () => {
        const mode = deviceMode(
            'none',
            'generation-1',
            'artifact-acme-1',
            accountScopedConfiguration(),
        );
        let durableSnapshot: unknown = null;
        const deviceTransactions = {
            acknowledge: vi.fn(async (snapshot: unknown) => {
                durableSnapshot = snapshot;
            }),
            read: vi.fn(async () => durableSnapshot),
            clear: vi.fn(async () => {
                durableSnapshot = null;
            }),
        };
        const first = harness({
            admittedMode: mode,
            deviceTransactions,
            admitConfiguration: async (raw) => {
                const attemptId = (raw as Readonly<{ attemptId: string }>).attemptId;
                return configuredAttempt(attemptId, 'device');
            },
        });
        await first.owner.beginConnect({ service, modeId: 'device' });
        await waitForAttemptStatus(
            first.owner,
            'attempt-1',
            'awaitingDeviceAuthorization',
        );

        let releaseReservation!: (
            value: ConnectedAccountAttemptConfigurationAdmission,
        ) => void;
        const reservation = new Promise<ConnectedAccountAttemptConfigurationAdmission>(
            (resolve) => {
                releaseReservation = resolve;
            },
        );
        const replacement = harness({
            maxAttempts: 1,
            createAttemptId: () => 'reserved-attempt',
            admittedMode: mode,
            deviceTransactions,
            admitConfiguration: async (raw) => {
                const attemptId = (raw as Readonly<{ attemptId: string }>).attemptId;
                return attemptId === 'reserved-attempt'
                    ? await reservation
                    : configuredAttempt(attemptId, 'device');
            },
        });
        const reserved = replacement.owner.beginConnect({
            service,
            modeId: 'device',
        });
        await vi.waitFor(() => expect(
            replacement.admitConfiguration,
        ).toHaveBeenCalledWith(expect.objectContaining({
            attemptId: 'reserved-attempt',
        })));

        const restored = await replacement.owner.resumeDevice({
            attemptId: 'attempt-1',
        });
        releaseReservation({
            status: 'configurationRequired',
            target: {
                kind: 'attempt',
                attemptId: 'reserved-attempt',
                service,
                modeId: 'device',
            },
            missingFieldIds: ['tenant'],
        });
        await expect(reserved).resolves.toMatchObject({
            status: 'configurationRequired',
            attemptId: 'reserved-attempt',
        });

        expect(restored).toEqual({
            status: 'conflict',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_capacity_exhausted',
        });
        expect(durableSnapshot).not.toBeNull();
        expect(deviceTransactions.clear).not.toHaveBeenCalled();
        expect(replacement.invoke).not.toHaveBeenCalled();
    });

    it('installs device restoration custody before the first durable read can be cancelled', async () => {
        let durableSnapshot: unknown = null;
        const seedTransactions = {
            acknowledge: vi.fn(async (snapshot: unknown) => {
                durableSnapshot = snapshot;
            }),
            read: vi.fn(async () => durableSnapshot),
            clear: vi.fn(async () => {
                durableSnapshot = null;
            }),
        };
        const first = harness({
            admittedMode: deviceMode(),
            deviceTransactions: seedTransactions,
        });
        await first.owner.beginConnect({ service, modeId: 'device' });
        await waitForAttemptStatus(
            first.owner,
            'attempt-1',
            'awaitingDeviceAuthorization',
        );
        expect(durableSnapshot).not.toBeNull();

        let signalReadStarted!: () => void;
        const readStarted = new Promise<void>((resolve) => {
            signalReadStarted = resolve;
        });
        let releaseRead!: () => void;
        const readGate = new Promise<void>((resolve) => {
            releaseRead = resolve;
        });
        const clear = vi.fn(async () => {
            durableSnapshot = null;
        });
        const replacement = harness({
            admittedMode: deviceMode(),
            deviceTransactions: {
                acknowledge: vi.fn(async () => {}),
                read: vi.fn(async () => {
                    const snapshot = durableSnapshot;
                    signalReadStarted();
                    await readGate;
                    return snapshot;
                }),
                clear,
            },
        });
        const restoration = replacement.owner.resumeDevice({
            attemptId: 'attempt-1',
        });
        await readStarted;

        const cancelled = replacement.owner.cancel({ attemptId: 'attempt-1' });
        releaseRead();

        await expect(cancelled).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        await expect(restoration).resolves.toEqual({
            status: 'conflict',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_cancelled',
        });
        expect(clear).toHaveBeenCalledWith('attempt-1');
        expect(durableSnapshot).toBeNull();
        expect(replacement.invoke).not.toHaveBeenCalled();
        expect(replacement.settle).not.toHaveBeenCalled();
        await expect(replacement.owner.read({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
    });

    it('admits at most one in-flight provider effect for an attempt', async () => {
        let releaseProvider!: (value: unknown) => void;
        const providerResult = new Promise<unknown>((resolve) => {
            releaseProvider = resolve;
        });
        const h = harness({
            invoke: async () => await providerResult,
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });

        const first = h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'first' },
        });
        const second = h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'second' },
        });
        await vi.waitFor(() => expect(h.invoke).toHaveBeenCalled());
        await Promise.resolve();
        releaseProvider({
            status: 'outcomeUnknown',
            diagnostic: { code: 'provider_response_lost' },
        });
        await expect(second).resolves.toEqual({
            status: 'conflict',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_in_progress',
        });
        expect(h.invoke).toHaveBeenCalledOnce();

        await expect(first).resolves.toMatchObject({
            status: 'reconnectRequired',
            attemptId: 'attempt-1',
        });
        expect(h.invoke).toHaveBeenCalledOnce();
    });

    it('acknowledges an owned OAuth attempt before provider begin completes', async () => {
        let finishBegin!: (value: unknown) => void;
        const beginResult = new Promise<unknown>((resolve) => {
            finishBegin = resolve;
        });
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            invoke: async ({ operation }) => {
                if (operation.kind === 'beginOAuth') return await beginResult;
                return {
                    status: 'connected',
                    accountId: 'account-a',
                    displayName: 'Account A',
                    scopes: [],
                };
            },
        });

        await expect(h.owner.beginConnect({ service, modeId: 'oauth' })).resolves.toEqual({
            status: 'starting',
            attemptId: 'attempt-1',
        });
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'starting',
            attemptId: 'attempt-1',
        });

        finishBegin({
            status: 'awaitingOAuthRedirect',
            authorizationUrl: 'https://provider.example/authorize?state=opaque',
            expiresAtMs: 61_000,
        });
        await expect(waitForAttemptStatus(
            h.owner,
            'attempt-1',
            'awaitingOAuth',
        )).resolves.toMatchObject({
            status: 'awaitingOAuth',
            authorizationUrl: 'https://provider.example/authorize?state=opaque',
            expiresAtMs: 61_000,
        });
    });

    it('does not publish an actionable OAuth phase before its acknowledgement is durable', async () => {
        let observedDuringAcknowledgement: Readonly<{
            read: unknown;
            completion: unknown;
        }> | null = null;
        const durable = durableOAuthTransactions({
            beforeAcknowledge: async (snapshot) => {
                if (
                    snapshot.phase !== 'awaitingOAuth'
                    || observedDuringAcknowledgement
                ) return;
                observedDuringAcknowledgement = Object.freeze({
                    read: await h.owner.read({ attemptId: 'attempt-1' }),
                    completion: await h.owner.completeOAuth({
                        attemptId: 'attempt-1',
                        completion: {
                            code: 'code-1',
                            callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                            state: 'state-1',
                        },
                    }),
                });
            },
        });
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: durable.owner,
        });

        await h.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');

        expect(observedDuringAcknowledgement).toMatchObject({
            read: { status: 'starting', attemptId: 'attempt-1' },
            completion: {
                status: 'conflict',
                attemptId: 'attempt-1',
                code: 'connected_account_attempt_in_progress',
            },
        });
    });

    it('does not publish an actionable device phase before its acknowledgement is durable', async () => {
        let observedDuringAcknowledgement: Readonly<{
            read: unknown;
            poll: unknown;
        }> | null = null;
        const deviceTransactions = {
            acknowledge: vi.fn(async () => {
                if (observedDuringAcknowledgement) return;
                observedDuringAcknowledgement = Object.freeze({
                    read: await h.owner.read({ attemptId: 'attempt-1' }),
                    poll: await h.owner.pollDevice({ attemptId: 'attempt-1' }),
                });
            }),
            read: vi.fn(async () => null),
            clear: vi.fn(async () => {}),
        };
        const h = harness({
            admittedMode: deviceMode('none'),
            deviceTransactions,
        });

        await h.owner.beginConnect({ service, modeId: 'device' });
        await waitForAttemptStatus(
            h.owner,
            'attempt-1',
            'awaitingDeviceAuthorization',
        );

        expect(observedDuringAcknowledgement).toMatchObject({
            read: { status: 'starting', attemptId: 'attempt-1' },
            poll: {
                status: 'conflict',
                attemptId: 'attempt-1',
                code: 'connected_account_attempt_in_progress',
            },
        });
    });

    it('rehydrates an OAuth callback from the durable transaction without exposing its verifier', async () => {
        const durable = durableOAuthTransactions();
        const restartSafeConfiguration = Object.freeze({
            ...configured('configuration-1', { tenant: 'acme' }, 'oauth'),
            stagedAccountConfigurationContent: Object.freeze({
                values: Object.freeze({ tenant: 'acme' }),
                secretRefs: Object.freeze({}),
            }),
        });
        const first = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: durable.owner,
            configuration: restartSafeConfiguration,
        });

        await first.owner.beginConnect({ service, modeId: 'oauth' });
        const awaiting = await waitForAttemptStatus(
            first.owner,
            'attempt-1',
            'awaitingOAuth',
        );
        expect(JSON.stringify(awaiting)).not.toContain('durable-verifier-1');
        expect(durable.readRecord()?.snapshot).toMatchObject({
            attemptId: 'attempt-1',
            phase: 'awaitingOAuth',
            immutableGenerationId: 'artifact-acme-1',
            stagedAccountConfigurationContent: {
                values: { tenant: 'acme' },
                secretRefs: {},
            },
        });

        const replacement = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: durable.owner,
            configuration: restartSafeConfiguration,
            invoke: async ({ operation, context }) => {
                expect(operation).toEqual({
                    kind: 'completeOAuth',
                    completion: {
                        code: 'callback-code',
                        callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                        state: 'state-1',
                        pkceVerifier: 'durable-verifier-1',
                    },
                });
                await context.attemptCredentials.set('accessToken', 'access-1');
                return {
                    status: 'connected',
                    accountId: 'account-a',
                    displayName: 'Account A',
                    scopes: [],
                };
            },
        });
        await expect(replacement.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'callback-code',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        })).resolves.toMatchObject({
            status: 'connected',
            account: accountA,
        });
        expect(replacement.settle).toHaveBeenCalledWith(expect.objectContaining({
            stagedCredentials: { accessToken: 'access-1' },
        }));
    });

    it('makes cancellation authoritative while OAuth restoration is awaiting admission', async () => {
        const durable = durableOAuthTransactions();
        const first = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: durable.owner,
        });
        await first.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(first.owner, 'attempt-1', 'awaitingOAuth');

        let signalAdmissionStarted!: () => void;
        const admissionStarted = new Promise<void>((resolve) => {
            signalAdmissionStarted = resolve;
        });
        let releaseAdmission!: () => void;
        const admission = new Promise<void>((resolve) => {
            releaseAdmission = resolve;
        });
        const replacement = harness({
            oauthTransactions: durable.owner,
            admitMode: async () => {
                signalAdmissionStarted();
                await admission;
                return oauthMode({ outcomeReconciliation: 'none' });
            },
        });
        const restoration = replacement.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'callback-code',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        });
        await admissionStarted;
        const cancellation = replacement.owner.cancel({ attemptId: 'attempt-1' });
        releaseAdmission();

        await expect(cancellation).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        await expect(restoration).resolves.toMatchObject({
            status: 'conflict',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_cancelled',
        });
        expect(durable.readRecord()).toBeNull();
        expect(replacement.invoke).not.toHaveBeenCalled();
        expect(replacement.settle).not.toHaveBeenCalled();
        await expect(replacement.owner.read({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
    });

    it('returns typed unavailability and closes restored OAuth custody when runtime currentness rejects', async () => {
        const durable = durableOAuthTransactions();
        const first = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: durable.owner,
        });
        await first.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(first.owner, 'attempt-1', 'awaitingOAuth');

        const replacement = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: durable.owner,
            generationCurrent: async () => {
                throw new Error('runtime currentness unavailable');
            },
        });
        await expect(replacement.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'callback-code',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_runtime_unavailable',
        });
        expect(durable.readRecord()).toBeNull();
        expect(replacement.invoke).not.toHaveBeenCalled();
        expect(replacement.settle).not.toHaveBeenCalled();
        await expect(replacement.owner.read({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_not_found',
        });
    });

    it('fails a rehydrated OAuth callback closed on stale artifact generation', async () => {
        const durable = durableOAuthTransactions();
        const first = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: durable.owner,
        });
        await first.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(first.owner, 'attempt-1', 'awaitingOAuth');

        const staleAdmission = Object.freeze({
            ...oauthMode({ outcomeReconciliation: 'none' }),
            immutableGenerationId: 'artifact-acme-2',
        });
        const replacement = harness({
            admittedMode: staleAdmission,
            oauthTransactions: durable.owner,
        });
        await expect(replacement.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'callback-code',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        })).resolves.toMatchObject({
            status: 'conflict',
            code: 'connected_account_runtime_generation_changed',
        });
        expect(replacement.invoke).not.toHaveBeenCalled();
        expect(durable.readRecord()).toBeNull();
    });

    it('closes a restored OAuth transaction when current peer admission rejects provider effects', async () => {
        const durable = durableOAuthTransactions();
        const first = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: durable.owner,
        });
        await first.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(first.owner, 'attempt-1', 'awaitingOAuth');
        expect(durable.readRecord()).not.toBeNull();

        const replacement = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: durable.owner,
            assertEffectfulOperationAllowed: () => {
                throw Object.assign(
                    new Error('credential write is no longer supported'),
                    { code: 'connected_account_legacy_operation_unsupported' },
                );
            },
        });
        await expect(replacement.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'callback-code',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_legacy_operation_unsupported',
        });
        expect(durable.readRecord()).toBeNull();
        expect(replacement.invoke).not.toHaveBeenCalled();
        await expect(replacement.owner.read({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_not_found',
        });
    });

    it('retains restored OAuth terminal cleanup for exact retry when close fails', async () => {
        let rejectFirstClose!: (reason: Error) => void;
        const firstClose = new Promise<void>((_resolve, reject) => {
            rejectFirstClose = reject;
        });
        const close = vi.fn()
            .mockImplementationOnce(async () => await firstClose)
            .mockResolvedValue(undefined);
        const durable = durableOAuthTransactions({ beforeClose: close });
        const first = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: durable.owner,
        });
        await first.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(first.owner, 'attempt-1', 'awaitingOAuth');
        expect(durable.readRecord()).not.toBeNull();

        const replacement = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: durable.owner,
            assertEffectfulOperationAllowed: () => {
                throw Object.assign(
                    new Error('credential write is no longer supported'),
                    { code: 'connected_account_legacy_operation_unsupported' },
                );
            },
        });
        const restored = replacement.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'callback-code',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        });
        const restoredOutcome = restored.then(
            () => null,
            (error: unknown) => error,
        );
        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

        const concurrentRead = replacement.owner.read({ attemptId: 'attempt-1' });
        await Promise.resolve();
        expect(close).toHaveBeenCalledOnce();
        expect(replacement.destroyAttemptConfiguration).toHaveBeenCalledOnce();

        rejectFirstClose(new Error('OAuth transaction storage unavailable'));
        await expect(restoredOutcome).resolves.toMatchObject({
            code: 'connected_account_attempt_cleanup_pending',
            attemptId: 'attempt-1',
        });
        await expect(concurrentRead).resolves.toEqual({
            status: 'cleanupPending',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_cleanup_pending',
        });
        expect(durable.readRecord()).not.toBeNull();
        expect(replacement.invoke).not.toHaveBeenCalled();

        await expect(replacement.owner.read({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_legacy_operation_unsupported',
        });
        expect(close).toHaveBeenCalledTimes(2);
        expect(replacement.destroyAttemptConfiguration).toHaveBeenCalledOnce();
        expect(durable.readRecord()).toBeNull();
        expect(replacement.invoke).not.toHaveBeenCalled();
        await expect(replacement.owner.read({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_legacy_operation_unsupported',
        });
        expect(close).toHaveBeenCalledTimes(2);
        expect(replacement.destroyAttemptConfiguration).toHaveBeenCalledOnce();
    });

    it('rejects stale OAuth state after rehydration without invoking the provider', async () => {
        const durable = durableOAuthTransactions();
        const first = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: durable.owner,
        });
        await first.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(first.owner, 'attempt-1', 'awaitingOAuth');

        const replacement = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: durable.owner,
        });
        await expect(replacement.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'callback-code',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'stale-state',
            },
        })).resolves.toMatchObject({
            status: 'rejected',
            code: 'connected_account_oauth_completion_invalid',
        });
        expect(replacement.invoke).not.toHaveBeenCalled();
        expect(durable.readRecord()).toBeNull();
    });

    it('removes durable OAuth state on cancel so a late callback cannot replay', async () => {
        const durable = durableOAuthTransactions();
        const first = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: durable.owner,
        });
        await first.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(first.owner, 'attempt-1', 'awaitingOAuth');
        await expect(first.owner.cancel({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        expect(durable.readRecord()).toBeNull();

        const replacement = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: durable.owner,
        });
        await expect(replacement.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'late-code',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'connected_account_attempt_not_found',
        });
        expect(replacement.invoke).not.toHaveBeenCalled();
    });

    it('persists OAuth outcome uncertainty before provider completion and never replays it after replacement', async () => {
        const durable = durableOAuthTransactions();
        const providerCompletion = new Promise<never>(() => {});
        const first = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'providerCheck' }),
            oauthTransactions: durable.owner,
            invoke: async ({ operation }) => operation.kind === 'beginOAuth'
                ? {
                    status: 'awaitingOAuthRedirect',
                    authorizationUrl: 'https://provider.example/authorize',
                }
                : await providerCompletion,
        });
        await first.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(first.owner, 'attempt-1', 'awaitingOAuth');
        void first.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'callback-code',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        });
        await vi.waitFor(() => expect(durable.readRecord()?.snapshot).toMatchObject({
            phase: 'outcomeUnknown',
        }));

        const replacement = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'providerCheck' }),
            oauthTransactions: durable.owner,
            invoke: async ({ operation }) => {
                if (operation.kind !== 'reconcile') {
                    throw new Error(`unexpected replay: ${operation.kind}`);
                }
                return {
                    status: 'rejected',
                    diagnostic: { code: 'provider_rejected', severity: 'error' },
                };
            },
        });
        await expect(replacement.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'callback-code',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        })).resolves.toMatchObject({
            status: 'outcomeUnknown',
            attemptId: 'attempt-1',
        });
        expect(replacement.invoke).not.toHaveBeenCalled();

        await expect(replacement.owner.reconcile({
            attemptId: 'attempt-1',
        })).resolves.toMatchObject({
            status: 'rejected',
            code: 'provider_rejected',
        });
        expect(replacement.invoke).toHaveBeenCalledOnce();
        expect(replacement.invoke.mock.calls[0]?.[0]).toMatchObject({
            operation: { kind: 'reconcile' },
        });
    });

    it('retains staged OAuth evidence for declared reconciliation after replacement', async () => {
        const durable = durableOAuthTransactions();
        const first = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'providerCheck' }),
            oauthTransactions: durable.owner,
            invoke: async ({ operation, context }) => {
                if (operation.kind === 'beginOAuth') {
                    return {
                        status: 'awaitingOAuthRedirect',
                        authorizationUrl: 'https://provider.example/authorize',
                    };
                }
                await context.attemptCredentials.set('exchangeHandle', 'handle-1');
                return {
                    status: 'outcomeUnknown',
                    diagnostic: { code: 'provider_response_lost' },
                };
            },
        });
        await first.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(first.owner, 'attempt-1', 'awaitingOAuth');
        await expect(first.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'callback-code',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        })).resolves.toMatchObject({ status: 'outcomeUnknown' });
        expect(durable.readRecord()?.snapshot).toMatchObject({
            phase: 'outcomeUnknown',
            stagedCredentials: { exchangeHandle: 'handle-1' },
        });

        const replacement = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'providerCheck' }),
            oauthTransactions: durable.owner,
            invoke: async ({ operation, context }) => {
                if (operation.kind !== 'reconcile') {
                    throw new Error(`unexpected replay: ${operation.kind}`);
                }
                expect(await context.attemptCredentials.get('exchangeHandle'))
                    .toBe('handle-1');
                return {
                    status: 'connected',
                    accountId: 'account-a',
                    displayName: 'Account A',
                    scopes: [],
                };
            },
        });
        await expect(replacement.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'callback-code',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        })).resolves.toMatchObject({ status: 'outcomeUnknown' });
        await expect(replacement.owner.reconcile({
            attemptId: 'attempt-1',
        })).resolves.toMatchObject({ status: 'connected', account: accountA });
        expect(replacement.invoke).toHaveBeenCalledOnce();
    });

    it('turns a rejected background currentness check into a stable terminal response', async () => {
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            generationCurrent: async () => {
                throw new Error('generation authority unavailable');
            },
        });

        await expect(h.owner.beginConnect({ service, modeId: 'oauth' })).resolves.toEqual({
            status: 'starting',
            attemptId: 'attempt-1',
        });
        await expect(waitForAttemptStatus(
            h.owner,
            'attempt-1',
            'unavailable',
        )).resolves.toMatchObject({
            code: 'connected_account_attempt_internal_unavailable',
        });
    });

    it('fails closed before a device provider effect when durable custody is unavailable', async () => {
        const read = vi.fn(async () => {
            throw new Error('durable device transaction route is unavailable');
        });
        const clear = vi.fn(async () => {
            throw new Error('durable device transaction route is unavailable');
        });
        const h = harness({
            admittedMode: deviceMode(),
            deviceTransactions: {
                acknowledge: vi.fn(async () => {}),
                read,
                clear,
            },
        });

        await expect(h.owner.beginConnect({
            service,
            modeId: 'device',
        })).resolves.toEqual({
            status: 'starting',
            attemptId: 'attempt-1',
        });
        await expect(waitForAttemptStatus(
            h.owner,
            'attempt-1',
            'unavailable',
        )).resolves.toMatchObject({
            code: 'connected_account_device_transaction_unavailable',
        });
        expect(read).toHaveBeenCalledWith('attempt-1');
        expect(h.invoke).not.toHaveBeenCalled();
        expect(clear).not.toHaveBeenCalled();
    });

    it('returns typed unavailability when a persisted device transaction cannot be parsed during resume', async () => {
        const read = vi.fn(async () => {
            throw new Error('persisted device transaction schema is invalid');
        });
        const clear = vi.fn(async () => {});
        const h = harness({
            admittedMode: deviceMode(),
            deviceTransactions: {
                acknowledge: vi.fn(async () => {}),
                read,
                clear,
            },
        });

        await expect(h.owner.resumeDevice({
            attemptId: 'attempt-old-schema',
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-old-schema',
            code: 'connected_account_device_transaction_unavailable',
        });
        expect(read).toHaveBeenCalledOnce();
        expect(clear).not.toHaveBeenCalled();
        expect(h.invoke).not.toHaveBeenCalled();
    });

    it('enforces device poll interval, provider slow-down, and expiry without extra provider effects', async () => {
        let now = 1_000;
        let pollNumber = 0;
        const acknowledge = vi.fn(async () => {});
        const h = harness({
            admittedMode: deviceMode(),
            now: () => now,
            attemptTtlMs: 120_000,
            deviceTransactions: {
                acknowledge,
                read: vi.fn(async () => null),
                clear: vi.fn(async () => {}),
            },
            invoke: async ({ operation }) => {
                if (operation.kind === 'beginDevice') {
                    return {
                        status: 'awaitingDeviceAuthorization',
                        verificationUri: 'https://provider.example/device',
                        userCode: 'ABCD',
                        expiresAtMs: 61_000,
                        pollIntervalMs: 5_000,
                    };
                }
                if (operation.kind === 'pollDevice') {
                    pollNumber += 1;
                    return { status: 'pending', retryAfterMs: 7_000 };
                }
                throw new Error('unexpected operation');
            },
        });

        await expect(h.owner.beginConnect({ service, modeId: 'device' })).resolves.toEqual({
            status: 'starting',
            attemptId: 'attempt-1',
        });
        await expect(waitForAttemptStatus(
            h.owner,
            'attempt-1',
            'awaitingDeviceAuthorization',
        )).resolves.toMatchObject({
            verificationUri: 'https://provider.example/device',
            userCode: 'ABCD',
            pollIntervalMs: 5_000,
        });

        await expect(h.owner.pollDevice({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'pending',
            attemptId: 'attempt-1',
            retryAfterMs: 5_000,
        });
        expect(pollNumber).toBe(0);

        now += 5_000;
        await expect(h.owner.pollDevice({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'pending',
            attemptId: 'attempt-1',
            retryAfterMs: 7_000,
        });
        expect(pollNumber).toBe(1);
        expect(acknowledge).toHaveBeenCalledTimes(2);
        expect(acknowledge).toHaveBeenLastCalledWith(expect.objectContaining({
            pollIntervalMs: 7_000,
            nextPollAtMs: 13_000,
        }));

        now += 6_000;
        await expect(h.owner.pollDevice({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'pending',
            attemptId: 'attempt-1',
            retryAfterMs: 1_000,
        });
        expect(pollNumber).toBe(1);

        now = 61_000;
        await expect(h.owner.pollDevice({ attemptId: 'attempt-1' })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'connected_account_device_authorization_expired',
        });
        expect(pollNumber).toBe(1);
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledWith('attempt-1');
    });

    it('keeps an exact-boundary device retry delay positive when the clock advances between reads', async () => {
        let boundaryReads: number[] | null = null;
        let pollNumber = 0;
        const h = harness({
            admittedMode: deviceMode(),
            now: () => boundaryReads?.shift() ?? 1_000,
            attemptTtlMs: 120_000,
            deviceTransactions: {
                acknowledge: vi.fn(async () => {}),
                read: vi.fn(async () => null),
                clear: vi.fn(async () => {}),
            },
            invoke: async ({ operation }) => {
                if (operation.kind === 'beginDevice') {
                    return {
                        status: 'awaitingDeviceAuthorization',
                        verificationUri: 'https://provider.example/device',
                        userCode: 'ABCD',
                        expiresAtMs: 61_000,
                        pollIntervalMs: 5_000,
                    };
                }
                if (operation.kind === 'pollDevice') {
                    pollNumber += 1;
                    return { status: 'pending', retryAfterMs: 5_000 };
                }
                throw new Error('unexpected operation');
            },
        });

        await h.owner.beginConnect({ service, modeId: 'device' });
        await waitForAttemptStatus(
            h.owner,
            'attempt-1',
            'awaitingDeviceAuthorization',
        );
        boundaryReads = [5_999, 5_999, 6_000];

        await expect(h.owner.pollDevice({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'pending',
            attemptId: 'attempt-1',
            retryAfterMs: 1,
        });
        expect(pollNumber).toBe(0);
    });

    it('restores only the minimum device transaction into a replacement owner and polls with the same provider handle', async () => {
        let now = 1_000;
        let durableSnapshot: unknown = null;
        const deviceTransactions = {
            acknowledge: vi.fn(async (input: unknown) => {
                durableSnapshot = input;
            }),
            read: vi.fn(async () => durableSnapshot),
            clear: vi.fn(async () => {
                durableSnapshot = null;
            }),
        };
        const first = harness({
            admittedMode: deviceMode('none', 'process-generation-5', 'artifact-acme-1'),
            now: () => now,
            attemptTtlMs: 120_000,
            deviceTransactions,
            invoke: async ({ operation, context }) => {
                if (operation.kind !== 'beginDevice') throw new Error('unexpected operation');
                await context.attemptCredentials.set('deviceHandle', 'provider-device-handle');
                return {
                    status: 'awaitingDeviceAuthorization',
                    verificationUri: 'https://provider.example/device',
                    userCode: 'ABCD',
                    expiresAtMs: 61_000,
                    pollIntervalMs: 5_000,
                };
            },
        });
        await first.owner.beginConnect({ service, modeId: 'device' });
        await waitForAttemptStatus(first.owner, 'attempt-1', 'awaitingDeviceAuthorization');
        expect(deviceTransactions.acknowledge).toHaveBeenCalledOnce();
        const persistedSnapshot = durableSnapshot;

        const replacement = harness({
            admittedMode: deviceMode('none', 'process-generation-1', 'artifact-acme-1'),
            now: () => now,
            attemptTtlMs: 120_000,
            deviceTransactions,
            invoke: async ({ operation, context }) => {
                if (operation.kind !== 'pollDevice') throw new Error('unexpected operation');
                expect(await context.attemptCredentials.get('deviceHandle'))
                    .toBe('provider-device-handle');
                return {
                    status: 'connected',
                    accountId: 'account-a',
                    displayName: 'Account A',
                    scopes: [],
                };
            },
        });
        await expect(replacement.owner.resumeDevice({
            attemptId: 'attempt-1',
        })).resolves.toMatchObject({
            status: 'awaitingDeviceAuthorization',
            attemptId: 'attempt-1',
            expiresAtMs: 61_000,
            pollIntervalMs: 5_000,
        });
        now += 5_000;
        await expect(replacement.owner.pollDevice({
            attemptId: 'attempt-1',
        })).resolves.toMatchObject({ status: 'connected', account: accountA });
        expect(replacement.settle).toHaveBeenCalledOnce();

        durableSnapshot = persistedSnapshot;
        const incompatible = harness({
            admittedMode: deviceMode('none', 'process-generation-1', 'artifact-acme-2'),
            now: () => now,
            attemptTtlMs: 120_000,
            deviceTransactions,
        });
        await expect(incompatible.owner.resumeDevice({
            attemptId: 'attempt-1',
        })).resolves.toMatchObject({
            status: 'conflict',
            code: 'connected_account_runtime_generation_changed',
        });
    });

    it('rejects device reconnect restoration when the account-configuration sidecar changed after admission', async () => {
        let durableSnapshot: unknown = null;
        const deviceTransactions = {
            acknowledge: vi.fn(async (input: unknown) => {
                durableSnapshot = input;
            }),
            read: vi.fn(async () => durableSnapshot),
            clear: vi.fn(async () => {
                durableSnapshot = null;
            }),
        };
        const first = harness({
            admittedMode: deviceMode(),
            account: {
                account: accountA,
                authenticationModeId: 'device',
                credentialRevision: 'credential-7',
                configurationRevision: 'account-configuration-at-admission',
            },
            deviceTransactions,
            invoke: async ({ operation }) => {
                if (operation.kind !== 'beginDevice') {
                    throw new Error('unexpected provider operation');
                }
                return {
                    status: 'awaitingDeviceAuthorization',
                    verificationUri: 'https://provider.example/device',
                    userCode: 'ABCD',
                    expiresAtMs: 61_000,
                    pollIntervalMs: 5_000,
                };
            },
        });
        await first.owner.beginReconnect({ account: accountA });
        await waitForAttemptStatus(
            first.owner,
            'attempt-1',
            'awaitingDeviceAuthorization',
        );
        expect(durableSnapshot).toMatchObject({
            expectedCredentialConfigurationRevision:
                'account-configuration-at-admission',
        });

        const replacement = harness({
            admittedMode: deviceMode(
                'none',
                'replacement-process',
                'artifact-acme-1',
            ),
            account: {
                account: accountA,
                authenticationModeId: 'device',
                credentialRevision: 'credential-7',
                configurationRevision: 'account-configuration-after-admission',
            },
            deviceTransactions,
        });
        await expect(replacement.owner.resumeDevice({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'conflict',
            attemptId: 'attempt-1',
            code: 'connected_account_credential_changed',
        });
        expect(replacement.invoke).not.toHaveBeenCalled();
        expect(replacement.settle).not.toHaveBeenCalled();
        expect(deviceTransactions.clear).toHaveBeenCalledWith('attempt-1');
    });

    it('persists and reuses one host-minted device settlement identity across lost acknowledgement and restart', async () => {
        let now = 1_000;
        let durableSnapshot: unknown = null;
        const deviceTransactions = {
            acknowledge: vi.fn(async (input: unknown) => {
                durableSnapshot = input;
            }),
            read: vi.fn(async () => durableSnapshot),
            clear: vi.fn(async () => {
                durableSnapshot = null;
            }),
        };
        const firstSettlement = new Promise<never>(() => {});
        const firstCreateAccountId = vi.fn(() => 'host-account-1');
        const first = harness({
            admittedMode: deviceMode(),
            now: () => now,
            attemptTtlMs: 120_000,
            deviceTransactions,
            createAccountId: firstCreateAccountId,
            settle: async () => await firstSettlement,
            invoke: async ({ operation }) => operation.kind === 'beginDevice'
                ? {
                    status: 'awaitingDeviceAuthorization',
                    verificationUri: 'https://provider.example/device',
                    userCode: 'ABCD',
                    expiresAtMs: 61_000,
                    pollIntervalMs: 5_000,
                }
                : {
                    status: 'connected',
                    displayName: 'Account A',
                    scopes: [],
                },
        });
        await first.owner.beginConnect({ service, modeId: 'device' });
        await waitForAttemptStatus(first.owner, 'attempt-1', 'awaitingDeviceAuthorization');
        now += 5_000;
        void first.owner.pollDevice({ attemptId: 'attempt-1' });
        await vi.waitFor(() => expect(first.settle).toHaveBeenCalledOnce());
        expect(deviceTransactions.acknowledge).toHaveBeenCalledTimes(2);
        expect(durableSnapshot).toMatchObject({
            preparedSettlement: {
                accountId: 'host-account-1',
                expectedCredentialRevision: null,
                expectedCredentialConfigurationRevision: null,
            },
        });

        const replacementCreateAccountId = vi.fn(() => 'host-account-2');
        let releaseReplacementSettlement!: () => void;
        const replacementSettlementRelease = new Promise<void>((resolve) => {
            releaseReplacementSettlement = resolve;
        });
        const replacement = harness({
            admittedMode: deviceMode('none', 'replacement-process', 'artifact-acme-1'),
            now: () => now,
            attemptTtlMs: 120_000,
            deviceTransactions,
            createAccountId: replacementCreateAccountId,
            settle: async (request) => {
                await replacementSettlementRelease;
                return {
                    status: 'connected',
                    account: {
                        service: request.service,
                        accountId: request.accountId,
                    },
                };
            },
        });
        const resumption = replacement.owner.resumeDevice({
            attemptId: 'attempt-1',
        });
        await vi.waitFor(() => expect(replacement.settle).toHaveBeenCalledOnce());
        const cancellation = replacement.owner.cancel({
            attemptId: 'attempt-1',
        });
        await Promise.resolve();
        expect(replacement.destroyAttemptConfiguration).not.toHaveBeenCalled();

        releaseReplacementSettlement();
        await expect(resumption).resolves.toMatchObject({
            status: 'connected',
            account: { service, accountId: 'host-account-1' },
        });
        await expect(cancellation).resolves.toMatchObject({
            status: 'connected',
            account: { service, accountId: 'host-account-1' },
        });
        expect(replacementCreateAccountId).not.toHaveBeenCalled();
        expect(replacement.invoke).not.toHaveBeenCalled();
        expect(replacement.settle).toHaveBeenCalledWith(expect.objectContaining({
            accountId: 'host-account-1',
        }));
        expect(firstCreateAccountId).toHaveBeenCalledOnce();
    });

    it('makes local cancellation authoritative over an already-running provider completion', async () => {
        let finishProvider!: (value: unknown) => void;
        const providerResult = new Promise<unknown>((resolve) => {
            finishProvider = resolve;
        });
        let releaseCancellationCleanup!: () => void;
        const cancellationCleanup = new Promise<void>((resolve) => {
            releaseCancellationCleanup = resolve;
        });
        const destroyAttemptConfiguration = vi.fn()
            .mockImplementationOnce(async () => await cancellationCleanup)
            .mockResolvedValue(undefined);
        const h = harness({
            destroyAttemptConfiguration,
            invoke: async () => await providerResult,
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });
        const completion = h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'candidate' },
        });
        await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledOnce());

        const cancellation = h.owner.cancel({ attemptId: 'attempt-1' });
        await vi.waitFor(() => expect(destroyAttemptConfiguration).toHaveBeenCalledOnce());
        finishProvider({
            status: 'connected',
            accountId: 'account-a',
            displayName: 'Account A',
            scopes: [],
        });
        await Promise.resolve();
        await Promise.resolve();
        const cleanupCallsBeforeRelease =
            destroyAttemptConfiguration.mock.calls.length;
        releaseCancellationCleanup();
        await expect(completion).resolves.toMatchObject({
            status: 'conflict',
            code: 'connected_account_attempt_cancelled',
        });
        await expect(cancellation).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        expect(h.settle).not.toHaveBeenCalled();
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        expect(cleanupCallsBeforeRelease).toBe(1);
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledOnce();
        expect(h.invoke).toHaveBeenCalledOnce();
    });

    it('publishes local cancellation without waiting for a hung provider cancel leaf', async () => {
        const never = new Promise<never>(() => {});
        const h = harness({
            admittedMode: deviceMode(),
            invoke: async ({ operation }) => {
                if (operation.kind === 'beginDevice') {
                    return {
                        status: 'awaitingDeviceAuthorization',
                        verificationUri: 'https://provider.example/device',
                        userCode: 'ABCD',
                        expiresAtMs: 61_000,
                        pollIntervalMs: 5_000,
                    };
                }
                if (operation.kind === 'cancel') return await never;
                throw new Error('unexpected operation');
            },
        });
        await h.owner.beginConnect({ service, modeId: 'device' });
        await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingDeviceAuthorization');

        const cancel = h.owner.cancel({ attemptId: 'attempt-1' });
        await expect(Promise.race([
            cancel,
            new Promise((resolve) => setTimeout(() => resolve('timed-out'), 25)),
        ])).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
    });

    it('clears a device transaction again when a pending acknowledgement finishes after cancellation', async () => {
        let now = 1_000;
        let durableSnapshot: unknown = null;
        let releasePendingAcknowledgement!: () => void;
        const pendingAcknowledgement = new Promise<void>((resolve) => {
            releasePendingAcknowledgement = resolve;
        });
        let acknowledgementNumber = 0;
        const deviceTransactions = {
            acknowledge: vi.fn(async (input: unknown) => {
                acknowledgementNumber += 1;
                if (acknowledgementNumber === 2) {
                    await pendingAcknowledgement;
                    durableSnapshot = input;
                    throw new Error('device acknowledgement outcome unknown');
                }
                durableSnapshot = input;
            }),
            read: vi.fn(async () => durableSnapshot),
            clear: vi.fn(async () => {
                durableSnapshot = null;
            }),
        };
        const h = harness({
            admittedMode: deviceMode(),
            now: () => now,
            attemptTtlMs: 120_000,
            deviceTransactions,
            invoke: async ({ operation }) => {
                if (operation.kind === 'beginDevice') {
                    return {
                        status: 'awaitingDeviceAuthorization',
                        verificationUri: 'https://provider.example/device',
                        userCode: 'ABCD',
                        expiresAtMs: 61_000,
                        pollIntervalMs: 5_000,
                    };
                }
                if (operation.kind === 'pollDevice') {
                    return { status: 'pending', retryAfterMs: 5_000 };
                }
                if (operation.kind === 'cancel') return undefined;
                throw new Error('unexpected operation');
            },
        });
        await h.owner.beginConnect({ service, modeId: 'device' });
        await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingDeviceAuthorization');
        expect(durableSnapshot).not.toBeNull();

        now += 5_000;
        const poll = h.owner.pollDevice({ attemptId: 'attempt-1' });
        await vi.waitFor(() => expect(deviceTransactions.acknowledge).toHaveBeenCalledTimes(2));

        await expect(h.owner.cancel({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        expect(durableSnapshot).toBeNull();

        releasePendingAcknowledgement();
        await expect(poll).resolves.toMatchObject({
            status: 'conflict',
            code: 'connected_account_attempt_cancelled',
        });
        expect(durableSnapshot).toBeNull();
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
    });

    it('retains failed late device acknowledgement compensation for exact cleanup retry', async () => {
        let now = 1_000;
        let durableSnapshot: unknown = null;
        let releasePendingAcknowledgement!: () => void;
        const pendingAcknowledgement = new Promise<void>((resolve) => {
            releasePendingAcknowledgement = resolve;
        });
        let acknowledgementNumber = 0;
        let clearNumber = 0;
        const deviceTransactions = {
            acknowledge: vi.fn(async (input: unknown) => {
                acknowledgementNumber += 1;
                if (acknowledgementNumber === 2) {
                    await pendingAcknowledgement;
                }
                durableSnapshot = input;
            }),
            read: vi.fn(async () => durableSnapshot),
            clear: vi.fn(async () => {
                clearNumber += 1;
                if (clearNumber === 2) {
                    throw new Error('device transaction storage unavailable');
                }
                durableSnapshot = null;
            }),
        };
        const h = harness({
            admittedMode: deviceMode(),
            now: () => now,
            attemptTtlMs: 120_000,
            deviceTransactions,
            invoke: async ({ operation }) => {
                if (operation.kind === 'beginDevice') {
                    return {
                        status: 'awaitingDeviceAuthorization',
                        verificationUri: 'https://provider.example/device',
                        userCode: 'ABCD',
                        expiresAtMs: 61_000,
                        pollIntervalMs: 5_000,
                    };
                }
                if (operation.kind === 'pollDevice') {
                    return { status: 'pending', retryAfterMs: 5_000 };
                }
                if (operation.kind === 'cancel') return undefined;
                throw new Error('unexpected operation');
            },
        });
        await h.owner.beginConnect({ service, modeId: 'device' });
        await waitForAttemptStatus(
            h.owner,
            'attempt-1',
            'awaitingDeviceAuthorization',
        );
        now += 5_000;
        const poll = h.owner.pollDevice({ attemptId: 'attempt-1' });
        await vi.waitFor(() =>
            expect(deviceTransactions.acknowledge).toHaveBeenCalledTimes(2));

        await expect(h.owner.cancel({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledOnce();
        releasePendingAcknowledgement();
        await expect(poll).rejects.toMatchObject({
            code: 'connected_account_attempt_cleanup_pending',
            attemptId: 'attempt-1',
        });
        expect(durableSnapshot).not.toBeNull();

        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        expect(clearNumber).toBe(3);
        expect(durableSnapshot).toBeNull();
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledOnce();
        expect(h.settle).not.toHaveBeenCalled();
    });

    it('lets a decisive connected settlement win cancellation after its durable commit', async () => {
        let releaseSettlement!: () => void;
        const settlementRelease = new Promise<void>((resolve) => {
            releaseSettlement = resolve;
        });
        let durableSettlement:
            | ConnectedAccountAttemptSettlementRequest
            | null = null;
        const h = harness({
            settle: async (request) => {
                durableSettlement = request;
                await settlementRelease;
                return {
                    status: 'connected',
                    account: {
                        service: request.service,
                        accountId: request.accountId,
                    },
                };
            },
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });
        const completion = h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'candidate' },
        });
        await vi.waitFor(() => {
            expect(h.settle).toHaveBeenCalledOnce();
            expect(durableSettlement).not.toBeNull();
        });
        const committedSettlement = h.settle.mock.calls[0]?.[0];
        if (!committedSettlement) {
            throw new Error('Expected the settlement request to be durably committed');
        }

        let cancellationResolved = false;
        const cancellation = h.owner.cancel({ attemptId: 'attempt-1' })
            .then((response) => {
                cancellationResolved = true;
                return response;
            });
        await Promise.resolve();
        await Promise.resolve();

        expect(cancellationResolved).toBe(false);
        expect(h.destroyAttemptConfiguration).not.toHaveBeenCalled();
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toMatchObject({
            status: 'outcomeUnknown',
            attemptId: 'attempt-1',
        });

        releaseSettlement();
        const expectedConnected = {
            status: 'connected',
            attemptId: 'attempt-1',
            account: {
                service,
                accountId: committedSettlement.accountId,
            },
        };
        await expect(completion).resolves.toEqual(expectedConnected);
        await expect(cancellation).resolves.toEqual(expectedConnected);
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual(
            expectedConnected,
        );
        expect(h.settle).toHaveBeenCalledOnce();
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledOnce();
    });

    it('preserves ambiguous settlement state when cancellation races a rejected decisive settlement', async () => {
        let rejectSettlement!: (error: Error) => void;
        const firstSettlement = new Promise<void>((_resolve, reject) => {
            rejectSettlement = reject;
        });
        let settlementCalls = 0;
        const h = harness({
            maxAttempts: 1,
            settle: async (request) => {
                settlementCalls += 1;
                if (settlementCalls === 1) {
                    await firstSettlement;
                }
                return {
                    status: 'connected',
                    account: {
                        service: request.service,
                        accountId: request.accountId,
                    },
                };
            },
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });
        const completion = h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'candidate' },
        });
        await vi.waitFor(() => expect(h.settle).toHaveBeenCalledOnce());

        const cancellation = h.owner.cancel({ attemptId: 'attempt-1' });
        rejectSettlement(new Error('write acknowledgement lost'));

        const expectedOutcomeUnknown = {
            status: 'outcomeUnknown',
            attemptId: 'attempt-1',
            diagnostic: {
                code: 'connected_account_settlement_outcome_unknown',
            },
        };
        await expect(completion).resolves.toEqual(expectedOutcomeUnknown);
        await expect(cancellation).resolves.toEqual(expectedOutcomeUnknown);
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual(
            expectedOutcomeUnknown,
        );
        expect(h.destroyAttemptConfiguration).not.toHaveBeenCalled();
        await expect(h.owner.beginConnect({
            service,
            modeId: 'manual',
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'connected_account_attempt_capacity_exhausted',
        });

        await expect(h.owner.reconcile({
            attemptId: 'attempt-1',
        })).resolves.toMatchObject({
            status: 'connected',
            attemptId: 'attempt-1',
        });
        expect(h.settle).toHaveBeenCalledTimes(2);
        expect(h.settle.mock.calls[1]?.[0]).toEqual(h.settle.mock.calls[0]?.[0]);
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledOnce();
        await expect(h.owner.beginConnect({
            service,
            modeId: 'manual',
        })).resolves.toEqual({
            status: 'awaitingManual',
            attemptId: 'attempt-2',
        });
    });

    it('requires reconnect when a lost settlement acknowledgement also loses its exact reconciliation basis', async () => {
        let configurationCurrent = true;
        const h = harness({
            configurationCurrent: () => configurationCurrent,
            settle: async () => {
                configurationCurrent = false;
                throw new Error('write acknowledgement lost');
            },
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });

        const expectedReconnectRequired = {
            status: 'reconnectRequired',
            attemptId: 'attempt-1',
            code: 'connected_account_authentication_reconciliation_unavailable',
        };
        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'candidate' },
        })).resolves.toEqual(expectedReconnectRequired);
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual(
            expectedReconnectRequired,
        );
        expect(h.settle).toHaveBeenCalledOnce();
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledOnce();
    });

    it('requires reconnect when exact reconciliation loses its configuration basis after the acknowledgement was lost', async () => {
        let configurationCurrent = true;
        const h = harness({
            configurationCurrent: () => configurationCurrent,
            settle: async () => {
                throw new Error('credential write acknowledgement lost');
            },
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });
        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'candidate' },
        })).resolves.toMatchObject({
            status: 'outcomeUnknown',
            attemptId: 'attempt-1',
        });
        configurationCurrent = false;

        const expectedReconnectRequired = {
            status: 'reconnectRequired',
            attemptId: 'attempt-1',
            code:
                'connected_account_authentication_reconciliation_unavailable',
        };
        await expect(h.owner.reconcile({
            attemptId: 'attempt-1',
        })).resolves.toEqual(expectedReconnectRequired);
        expect(h.reconcileSettlement).not.toHaveBeenCalled();
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledOnce();
    });

    it('reconciles an uncertain prepared settlement without replaying its write operation', async () => {
        const settle = vi.fn(async (
            _request: ConnectedAccountAttemptSettlementRequest,
        ) => {
            throw new Error('credential write acknowledgement lost');
        });
        const reconcileSettlement = vi.fn(async (
            request: ConnectedAccountAttemptSettlementRequest,
        ) => ({
            status: 'connected' as const,
            account: {
                service: request.service,
                accountId: request.accountId,
            },
        }));
        const h = harness({
            settle,
            reconcileSettlement,
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });

        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'candidate' },
        })).resolves.toMatchObject({
            status: 'outcomeUnknown',
            attemptId: 'attempt-1',
        });
        await expect(h.owner.reconcile({
            attemptId: 'attempt-1',
        })).resolves.toEqual({
            status: 'connected',
            attemptId: 'attempt-1',
            account: {
                service,
                accountId: 'account-a',
            },
        });
        expect(settle).toHaveBeenCalledOnce();
        expect(reconcileSettlement).toHaveBeenCalledOnce();
        expect(reconcileSettlement.mock.calls[0]?.[0]).toBe(
            settle.mock.calls[0]?.[0],
        );
    });

    it('requires reconnect when exact prepared-settlement reconciliation proves a conflict', async () => {
        const h = harness({
            settle: async () => {
                throw new Error('credential write acknowledgement lost');
            },
            reconcileSettlement: async () => ({
                status: 'conflict',
                code: 'connected_account_settlement_conflict',
            }),
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });
        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'candidate' },
        })).resolves.toMatchObject({
            status: 'outcomeUnknown',
            attemptId: 'attempt-1',
        });

        const expectedReconnectRequired = {
            status: 'reconnectRequired',
            attemptId: 'attempt-1',
            code:
                'connected_account_authentication_reconciliation_unavailable',
        };
        await expect(h.owner.reconcile({
            attemptId: 'attempt-1',
        })).resolves.toEqual(expectedReconnectRequired);
        await expect(h.owner.read({
            attemptId: 'attempt-1',
        })).resolves.toEqual(expectedReconnectRequired);
        expect(h.settle).toHaveBeenCalledOnce();
        expect(h.reconcileSettlement).toHaveBeenCalledOnce();
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledOnce();
    });

    it('does not resurrect a cancelled attempt when late-evidence lookup throws', async () => {
        let rejectEvidence!: (error: Error) => void;
        const evidence = new Promise<never>((_resolve, reject) => {
            rejectEvidence = reject;
        });
        const reconcile = vi.fn(async () => await evidence);
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'lateEvidence' }),
            invoke: async ({ operation }) => operation.kind === 'beginOAuth'
                ? {
                    status: 'awaitingOAuthRedirect',
                    authorizationUrl: 'https://provider.example/authorize',
                }
                : {
                    status: 'outcomeUnknown',
                    diagnostic: { code: 'provider_response_lost' },
                },
            lateEvidence: {
                reconcile,
            },
        });
        await h.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');
        await h.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'callback-code',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state: 'state-1',
            },
        });
        const reconciliation = h.owner.reconcile({ attemptId: 'attempt-1' });
        await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());

        await expect(h.owner.cancel({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        rejectEvidence(new Error('late evidence unavailable'));

        await expect(reconciliation).resolves.toMatchObject({
            status: 'conflict',
            code: 'connected_account_attempt_cancelled',
        });
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
    });

    it.each([
        [{ status: 'connected' }, 'manual'],
        [{
            status: 'connected',
            displayName: 'Account A',
            scopes: ['read', 'read'],
        }, 'manual'],
        [{
            status: 'connected',
            displayName: 'Account A',
            scopes: [],
            unexpected: true,
        }, 'manual'],
        [{
            status: 'connected',
            displayName: 'Account A',
            scopes: [],
            providerIdentity: { accountId: 'provider-a', unexpected: true },
        }, 'manual'],
        [{
            status: 'rejected',
            diagnostic: { code: 'provider_denied', unexpected: true },
        }, 'manual'],
        [{
            status: 'awaitingDeviceAuthorization',
            verificationUri: 'https://provider.example/device',
            userCode: 'ABCD',
            expiresAtMs: 61_000,
            pollIntervalMs: 0,
        }, 'device'],
    ] as const)('treats malformed provider results as an uncertain remote outcome without settlement (%o)', async (result, mode) => {
        const h = harness({
            ...(mode === 'device' ? { admittedMode: deviceMode() } : {}),
            invoke: async () => result,
        });

        const begun = await h.owner.beginConnect({ service, modeId: mode });
        if (mode === 'manual') {
            expect(begun).toMatchObject({ status: 'awaitingManual' });
            await expect(h.owner.submitManual({
                attemptId: 'attempt-1',
                fields: { token: 'candidate' },
            })).resolves.toMatchObject({
                status: 'reconnectRequired',
                code: 'connected_account_authentication_outcome_unknown',
            });
        } else {
            await expect(waitForAttemptStatus(
                h.owner,
                'attempt-1',
                'reconnectRequired',
            )).resolves.toMatchObject({
                code: 'connected_account_authentication_outcome_unknown',
            });
        }
        expect(h.settle).not.toHaveBeenCalled();
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledWith('attempt-1');
    });

    it('retains a malformed provider result for declared provider reconciliation without replaying the operation', async () => {
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'providerCheck' }),
            invoke: async () => ({ status: 'connected' }),
        });

        await expect(h.owner.beginConnect({
            service,
            modeId: 'oauth',
        })).resolves.toMatchObject({ status: 'starting' });
        await expect(waitForAttemptStatus(
            h.owner,
            'attempt-1',
            'outcomeUnknown',
        )).resolves.toMatchObject({
            status: 'outcomeUnknown',
            diagnostic: {
                code: 'connected_account_provider_result_invalid',
            },
        });
        expect(h.invoke).toHaveBeenCalledTimes(1);
        expect(h.settle).not.toHaveBeenCalled();
        expect(h.destroyAttemptConfiguration).not.toHaveBeenCalled();
    });

    it('treats an accessor-backed provider result as uncertain without invoking the accessor', async () => {
        const readStatus = vi.fn(() => 'connected');
        const result = Object.defineProperty({}, 'status', {
            enumerable: true,
            get: readStatus,
        });
        const h = harness({ invoke: async () => result });
        await h.owner.beginConnect({ service, modeId: 'manual' });

        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'candidate' },
        })).resolves.toMatchObject({
            status: 'reconnectRequired',
            code: 'connected_account_authentication_outcome_unknown',
        });
        expect(readStatus).not.toHaveBeenCalled();
        expect(h.settle).not.toHaveBeenCalled();
    });

    it('accepts only bounded protocol diagnostics from provider results', async () => {
        const accepted = harness({
            invoke: async () => ({
                status: 'rejected',
                diagnostic: {
                    code: 'provider_denied',
                    severity: 'error',
                    message: 'The provider denied this account.',
                    details: { retryable: false },
                    remediation: { kind: 'retry' },
                },
            }),
        });
        await accepted.owner.beginConnect({ service, modeId: 'manual' });
        await expect(accepted.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'denied' },
        })).resolves.toEqual({
            status: 'rejected',
            attemptId: 'attempt-1',
            code: 'provider_denied',
            diagnostic: {
                code: 'provider_denied',
                severity: 'error',
                message: 'The provider denied this account.',
                details: { retryable: false },
                remediation: { kind: 'retry' },
            },
        });

        for (const diagnostic of [
            { code: 'provider_denied' },
            {
                code: 'provider_denied',
                severity: 'error',
                message: 'x'.repeat(2_049),
            },
        ]) {
            const rejected = harness({
                invoke: async () => ({ status: 'rejected', diagnostic }),
            });
            await rejected.owner.beginConnect({ service, modeId: 'manual' });
            await expect(rejected.owner.submitManual({
                attemptId: 'attempt-1',
                fields: { token: 'denied' },
            })).resolves.toMatchObject({
                status: 'reconnectRequired',
                code: 'connected_account_authentication_outcome_unknown',
            });
            expect(rejected.settle).not.toHaveBeenCalled();
        }
    });

    it('bounds attempt credential staging before any settlement can persist it', async () => {
        const h = harness({
            invoke: async ({ context }) => {
                await context.attemptCredentials.set('token', 'x'.repeat(64 * 1024 + 1));
                return {
                    status: 'connected',
                    displayName: 'Account A',
                    scopes: [],
                };
            },
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });

        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'candidate' },
        })).resolves.toMatchObject({ status: 'reconnectRequired' });
        expect(h.settle).not.toHaveBeenCalled();
    });

    it('destroys attempt-scoped configuration on cancel, provider rejection, and expiry', async () => {
        const attemptTarget = Object.freeze({
            kind: 'attempt' as const,
            attemptId: 'attempt-1',
            service,
            modeId: 'oauth',
        });
        const cancelled = harness({
            admittedMode: oauthMode({
                outcomeReconciliation: 'none',
                configuration: {
                    scope: 'account',
                    changeBehavior: 'reconnect',
                    fields: [{
                        id: 'tenant',
                        title: 'Tenant',
                        schema: { type: 'string' },
                        secret: false,
                    }],
                },
            }),
            configuration: {
                status: 'configurationRequired',
                target: attemptTarget,
                missingFieldIds: ['tenant'],
            },
        });
        await cancelled.owner.beginConnect({ service, modeId: 'oauth' });
        await expect(cancelled.owner.cancel({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        expect(cancelled.destroyAttemptConfiguration).toHaveBeenCalledWith('attempt-1');

        const rejected = harness({
            invoke: async () => ({
                status: 'rejected',
                diagnostic: { code: 'provider_denied', severity: 'error' },
            }),
        });
        await rejected.owner.beginConnect({ service, modeId: 'manual' });
        await expect(rejected.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'denied' },
        })).resolves.toMatchObject({ status: 'rejected', code: 'provider_denied' });
        expect(rejected.destroyAttemptConfiguration).toHaveBeenCalledWith('attempt-1');

        let now = 1_000;
        const expired = harness({
            now: () => now,
            attemptTtlMs: 60_000,
        });
        await expired.owner.beginConnect({ service, modeId: 'manual' });
        now += 60_001;
        await expect(expired.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_expired',
        });
        expect(expired.destroyAttemptConfiguration).toHaveBeenCalledWith('attempt-1');
    });

    it('reclaims expired attempt capacity before reserving a replacement', async () => {
        let now = 1_000;
        const h = harness({
            maxAttempts: 1,
            now: () => now,
            attemptTtlMs: 60_000,
        });
        await expect(h.owner.beginConnect({
            service,
            modeId: 'manual',
        })).resolves.toEqual({
            status: 'awaitingManual',
            attemptId: 'attempt-1',
        });

        now += 60_000;
        await expect(h.owner.beginConnect({
            service,
            modeId: 'manual',
        })).resolves.toEqual({
            status: 'awaitingManual',
            attemptId: 'attempt-2',
        });
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledWith('attempt-1');
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_expired',
        });
    });

    it('retains expired attempt capacity until its exact cleanup succeeds', async () => {
        let now = 1_000;
        let cleanupAvailable = false;
        const destroyAttemptConfiguration = vi.fn(async () => {
            if (!cleanupAvailable) {
                throw new Error('configuration cleanup unavailable');
            }
        });
        const h = harness({
            maxAttempts: 1,
            now: () => now,
            attemptTtlMs: 60_000,
            destroyAttemptConfiguration,
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });

        now += 60_000;
        await expect(h.owner.beginConnect({
            service,
            modeId: 'manual',
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'connected_account_attempt_capacity_exhausted',
        });
        expect(destroyAttemptConfiguration).toHaveBeenCalledOnce();

        await expect(h.owner.beginConnect({
            service,
            modeId: 'manual',
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'connected_account_attempt_capacity_exhausted',
        });
        expect(destroyAttemptConfiguration).toHaveBeenCalledOnce();

        cleanupAvailable = true;
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'connected_account_attempt_expired',
        });
        expect(destroyAttemptConfiguration).toHaveBeenCalledTimes(2);
        await expect(h.owner.beginConnect({
            service,
            modeId: 'manual',
        })).resolves.toEqual({
            status: 'awaitingManual',
            attemptId: 'attempt-2',
        });
    });

    it('surfaces failed durable cleanup and retains it for an exact retry', async () => {
        const destroyAttemptConfiguration = vi.fn()
            .mockRejectedValueOnce(new Error('storage unavailable'))
            .mockResolvedValue(undefined);
        const h = harness({ destroyAttemptConfiguration });
        await h.owner.beginConnect({ service, modeId: 'manual' });

        await expect(h.owner.cancel({ attemptId: 'attempt-1' })).rejects.toMatchObject({
            code: 'connected_account_attempt_cleanup_pending',
            attemptId: 'attempt-1',
        });
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        expect(destroyAttemptConfiguration).toHaveBeenCalledTimes(2);
    });

    it('keeps sole cleanup custody within capacity until its retry settles', async () => {
        let rejectFirstCleanup!: (reason: Error) => void;
        const firstCleanup = new Promise<void>((_resolve, reject) => {
            rejectFirstCleanup = reject;
        });
        const destroyAttemptConfiguration = vi.fn()
            .mockImplementationOnce(async () => await firstCleanup)
            .mockResolvedValue(undefined);
        const h = harness({
            maxAttempts: 1,
            destroyAttemptConfiguration,
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });
        const cancellation = h.owner.cancel({ attemptId: 'attempt-1' });
        const cancellationOutcome = cancellation.then(
            () => null,
            (error: unknown) => error,
        );
        await vi.waitFor(() => expect(destroyAttemptConfiguration).toHaveBeenCalledOnce());

        const whileCleaning = h.owner.beginConnect({
            service,
            modeId: 'manual',
        });
        rejectFirstCleanup(new Error('cleanup storage unavailable'));
        await expect(cancellationOutcome).resolves.toMatchObject({
            code: 'connected_account_attempt_cleanup_pending',
            attemptId: 'attempt-1',
        });
        await expect(whileCleaning).resolves.toMatchObject({
            status: 'unavailable',
            code: 'connected_account_attempt_capacity_exhausted',
        });
        await expect(h.owner.beginConnect({
            service,
            modeId: 'manual',
        })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'connected_account_attempt_capacity_exhausted',
        });

        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled',
            attemptId: 'attempt-1',
        });
        expect(destroyAttemptConfiguration).toHaveBeenCalledTimes(2);
        await expect(h.owner.beginConnect({
            service,
            modeId: 'manual',
        })).resolves.toEqual({
            status: 'awaitingManual',
            attemptId: 'attempt-2',
        });
    });
});
