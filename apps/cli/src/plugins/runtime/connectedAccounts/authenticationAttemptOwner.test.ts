import { describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import {
    CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1,
    PluginConnectedAccountAuthenticationModeV2Schema,
    PluginConnectedAccountConfigurationV2Schema,
    QualifiedConnectedAccountProfileV4Schema,
    type PluginConnectedAccountConfigurationV2,
} from '@happier-dev/protocol';

import {
    CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS,
    createConnectedAccountAuthenticationAttemptOwner,
    type ConnectedAccountAttemptConfigurationAdmission,
    type ConnectedAccountAttemptModeAdmission,
    type ConnectedAccountAttemptProviderOperation,
    type ConnectedAccountAttemptProviderInvocation,
    type ConnectedAccountAttemptSettlementRequest,
    type ConnectedAccountAttemptAddressOwner,
    type ConnectedAccountDeviceTransactionSnapshot,
    type ConnectedAccountOAuthCallbackCompletion,
} from '@happier-dev/cli-common/connectedAccounts';
import {
    ConnectedAccountRuntimeInvocationNotStartedError,
} from './contributionRegistry';
import { createConnectedAccountAttemptConfigurationStore, createConnectedAccountConfigurationOwner, type ConnectedAccountConfigurationOwner } from '@happier-dev/cli-common/connectedAccounts';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { createQualifiedConnectedAccountAttemptTransactionAdapters } from '@/daemon/connectedServices/qualifiedConnectedAccountAttemptTransactionAdapters';
import { anthropicConnectedAccountRuntime, ANTHROPIC_API_KEY_INPUT_SCHEMA } from '../../../../../../packages/plugins/claude/src/connectedAccounts/anthropicRuntime';
import { createUnavailablePluginServices } from '../invocation/services/unavailable';
import { createDeferred } from '@/testkit/async/deferred';
import { resolveHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { createBoundMachineTargetResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createConnectedAccountAttemptTransactionApiBoundary } from '@/testkit/connectedAccountAttemptTransactionApi';
import type { ConnectedAccountConfigurationRecord } from '@happier-dev/cli-common/connectedAccounts';

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
            credentialOrigin: 'authentication',
            outcomeReconciliation: 'none',
            directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
            fields: [{
                id: 'token',
                title: 'Token',
                schema: { type: 'string' },
                secret: true,
            }],
        }),
        occurrenceId: 'generation-1',
        sourceCustody: {
            kind: 'managed' as const,
            immutableGenerationId: 'artifact-acme-1',
            installSource: 'archive' as const,
        },
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
            callbackUrl: input.callbackUrl ?? 'http://127.0.0.1:4000/auth/callback',
            ...(input.configuration ? { configuration: input.configuration } : {}),
        }),
        occurrenceId: 'generation-1',
        sourceCustody: {
            kind: 'managed' as const,
            immutableGenerationId: 'artifact-acme-1',
            installSource: 'archive' as const,
        },
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
        occurrenceId: generation,
        sourceCustody: {
            kind: 'managed' as const,
            immutableGenerationId,
            installSource: 'archive' as const,
        },
    });
}

function harness(input: Readonly<{
    findByProviderIdentity?: NonNullable<Parameters<typeof createConnectedAccountAuthenticationAttemptOwner>[0]['accounts']['findByProviderIdentity']>;
    configuration?: ConnectedAccountAttemptConfigurationAdmission;
    admitConfiguration?: Parameters<typeof createConnectedAccountAuthenticationAttemptOwner>[0]['configuration']['admit'];
    stageAccountConfiguration?: ConnectedAccountConfigurationOwner['stageAccountConfiguration'];
    admittedMode?: ConnectedAccountAttemptModeAdmission;
    admitMode?: (input: unknown) => Promise<ConnectedAccountAttemptModeAdmission>;
    invoke?: (input: ConnectedAccountAttemptProviderInvocation) => Promise<unknown>;
    configurationCurrent?: ConnectedAccountConfigurationOwner['isCurrent'];
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
    executionMachine?: Readonly<{ serverId: string; machineId: string }>;
    resolveExecutionMachine?: () => Readonly<{ serverId: string; machineId: string }> | null;
    onBackgroundTransition?: Parameters<typeof createConnectedAccountAuthenticationAttemptOwner>[0]['onBackgroundTransition'];
    attemptAddresses?: ConnectedAccountAttemptAddressOwner | null;
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
    readSelectedSecrets?: Parameters<typeof createConnectedAccountAuthenticationAttemptOwner>[0]['readSelectedSecrets'];
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
    let resourceNumber = 0;
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
    const transactionApi = createConnectedAccountAttemptTransactionApiBoundary();
    const transactions = createQualifiedConnectedAccountAttemptTransactionAdapters({
        credentials: { token: 'account-token', encryption: null },
        getAccountEncryptionMode: async () => 'plain',
        getMachineId: () => 'machine-1',
        now: input.now ?? (() => 1_000),
        api: transactionApi,
    });
    const owner = createConnectedAccountAuthenticationAttemptOwner({
        createAttemptId:
            input.createAttemptId ?? (() => `attempt-${++attemptNumber}`),
        createAccountId: input.createAccountId ?? (() => 'host-account-1'),
        createSavedSecretResourceId: () => `secret-${++resourceNumber}`,
        ...(input.readSelectedSecrets ? { readSelectedSecrets: input.readSelectedSecrets } : {}),
        now: input.now ?? (() => 1_000),
        ...(input.resolveExecutionMachine
            ? { resolveExecutionMachine: input.resolveExecutionMachine }
            : input.executionMachine ? { resolveExecutionMachine: () => input.executionMachine! } : {}),
        ...(input.onBackgroundTransition ? { onBackgroundTransition: input.onBackgroundTransition } : {}),
        ...(input.attemptAddresses === null ? {} : {
            attemptAddresses: input.attemptAddresses ?? transactions.address,
        }),
        accounts: {
            ...(input.findByProviderIdentity ? { findByProviderIdentity: input.findByProviderIdentity } : {}),
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
            ...(input.stageAccountConfiguration ? { stageAccountConfiguration: input.stageAccountConfiguration } : {}),
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
        transactionApi,
        transactions,
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

describe('addressed manual attempts', () => {
    function manualHandoffHarness(input: Parameters<typeof harness>[0] = {}) {
        const configuration = createConnectedAccountConfigurationOwner({
            // Configuration persistence and the external plugin/settlement
            // ports are substituted; admission/currentness stay real.
            read: async () => null,
            replace: async () => { throw new Error('No configuration writes expected'); },
            destroyAttempt: async () => {},
            secrets: { admit: async () => {}, has: async () => false, read: async () => null },
            isRuntimeCurrent: () => true,
        });
        return harness({ ...input, admitConfiguration: configuration.admit,
            configurationCurrent: configuration.isCurrent,
            destroyAttemptConfiguration: configuration.destroyAttempt });
    }

    it('restores a manual draft in another host and submits a Saved Secret reference without inline fields', async () => {
        const admittedMode = manualMode();
        const selectedMode = { ...admittedMode, descriptor: PluginConnectedAccountAuthenticationModeV2Schema.parse({
            ...admittedMode.descriptor, credentialFieldKeys: { token: 'token' },
        }) };
        const first = manualHandoffHarness({ admittedMode: selectedMode });
        const next = manualHandoffHarness({ admittedMode: selectedMode, attemptAddresses: first.transactions.address,
            readSelectedSecrets: async () => ({ token: 'synthetic-reference-token' }) });
        try {
            await first.owner.beginConnect({ service, modeId: 'manual' });
            first.owner.dispose();
            expect(await next.owner.ensureRestored({ attemptId: 'attempt-1' })).toBeNull();
            expect(await next.owner.submitManual({ attemptId: 'attempt-1', fields: {}, selectedSecrets: {
                token: { ref: 'happier:shared-secret:v1:00000000-0000-4000-8000-000000000001', resourceRevision: 1 },
            } })).toMatchObject({ status: 'connected', attemptId: 'attempt-1' });
            expect(first.invoke).not.toHaveBeenCalled();
            expect(next.invoke).toHaveBeenCalledOnce();
            expect(first.transactionApi.records.has('attempt-1')).toBe(false);
        } finally { first.owner.dispose(); next.owner.dispose(); }
    });

    it('does not replay a manual submission from a fresh host while its provider result is pending', async () => {
        const provider = createDeferred<unknown>();
        const first = manualHandoffHarness({ invoke: async () => provider.promise });
        const next = manualHandoffHarness({ attemptAddresses: first.transactions.address });
        try {
            await first.owner.beginConnect({ service, modeId: 'manual' });
            const pending = first.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'synthetic-token' } });
            await vi.waitFor(() => expect(first.invoke).toHaveBeenCalledOnce());
            expect(await next.owner.ensureRestored({ attemptId: 'attempt-1' })).toEqual({
                status: 'reconnectRequired', attemptId: 'attempt-1', code: 'connected_account_authentication_outcome_unknown',
            });
            expect(next.invoke).not.toHaveBeenCalled();
            provider.resolve({ status: 'connected', accountId: 'account-a', displayName: 'Example', scopes: [] });
            expect(await pending).toMatchObject({ status: 'connected' });
        } finally { provider.resolve({ status: 'rejected', code: 'fixture_closed' }); first.owner.dispose(); next.owner.dispose(); }
    });

    it('does not recreate a completed manual attempt from an already restored draft', async () => {
        const first = manualHandoffHarness();
        const next = manualHandoffHarness({ attemptAddresses: first.transactions.address });
        try {
            await first.owner.beginConnect({ service, modeId: 'manual' });
            expect(await next.owner.ensureRestored({ attemptId: 'attempt-1' })).toBeNull();
            expect(await first.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'synthetic-token' } }))
                .toMatchObject({ status: 'connected' });
            expect(await next.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'synthetic-token' } }))
                .toMatchObject({ status: 'unavailable' });
            expect(next.invoke).not.toHaveBeenCalled();
            expect(first.transactionApi.records.size).toBe(0);
        } finally { first.owner.dispose(); next.owner.dispose(); }
    });

    it('refuses to restore manual input into a replacement plugin generation', async () => {
        const first = manualHandoffHarness();
        const next = manualHandoffHarness({ attemptAddresses: first.transactions.address,
            admittedMode: manualMode('manual', { sourceCustody: {
                kind: 'managed', immutableGenerationId: 'replacement-artifact', installSource: 'archive',
            } }) });
        try {
            await first.owner.beginConnect({ service, modeId: 'manual' });
            first.owner.dispose();
            expect(await next.owner.ensureRestored({ attemptId: 'attempt-1' })).toMatchObject({
                status: 'conflict', code: 'connected_account_runtime_generation_changed',
            });
            expect(next.invoke).not.toHaveBeenCalled();
        } finally { first.owner.dispose(); next.owner.dispose(); }
    });

    it('restores a manual configuration target in a fresh host before replacement and submit', async () => {
        const original = manualMode();
        const admittedMode = { ...original, descriptor: PluginConnectedAccountAuthenticationModeV2Schema.parse({
            ...original.descriptor, configuration: accountScopedConfiguration(),
        }) };
        const api = createConnectedAccountAttemptTransactionApiBoundary();
        const transactions = createQualifiedConnectedAccountAttemptTransactionAdapters({
            credentials: { token: 'account-token', encryption: null },
            getAccountEncryptionMode: async () => 'plain', getMachineId: () => undefined, now: () => 1_000, api,
        });
        const makeHost = () => {
            const store = createConnectedAccountAttemptConfigurationStore({ createRevision: () => 'configuration-2', transactions });
            const configuration = createConnectedAccountConfigurationOwner({
                read: async target => target.kind === 'attempt' ? store.read(target) : null,
                replace: async input => {
                    if (input.target.kind !== 'attempt') throw new Error('Expected attempt');
                    return store.replace({ ...input, target: input.target });
                },
                destroyAttempt: store.destroy,
                secrets: { admit: async () => {}, has: async () => false, read: async () => null },
                isRuntimeCurrent: () => true,
            });
            return { configuration, ...harness({ admittedMode, attemptAddresses: transactions.address,
                admitConfiguration: configuration.admit, configurationCurrent: configuration.isCurrent,
                destroyAttemptConfiguration: configuration.destroyAttempt }) };
        };
        const first = makeHost();
        const next = makeHost();
        try {
            expect(await first.owner.beginConnect({ service, modeId: 'manual' })).toMatchObject({ status: 'configurationRequired' });
            first.owner.dispose();
            const control = await next.owner.resolveConfigurationControlTarget({ attemptId: 'attempt-1' });
            expect(control).toMatchObject({ target: { kind: 'attempt', attemptId: 'attempt-1' } });
            expect(await next.configuration.replaceForControl({ ...control!, expectedRevision: null,
                values: { tenant: 'fixture' }, secretValues: {} })).toMatchObject({ status: 'committed' });
            expect(await next.owner.continueConnect({ attemptId: 'attempt-1', expectedConfigurationRevision: 'configuration-2' }))
                .toMatchObject({ status: 'awaitingManual' });
            expect(api.records.size).toBe(1);
            expect(await next.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'synthetic-token' } }))
                .toMatchObject({ status: 'connected' });
            expect(next.settle).toHaveBeenCalledOnce();
            expect(next.settle.mock.calls[0]?.[0]).toMatchObject({
                expectedConfigurationRevision: 'configuration-2', stagedAccountConfigurationContent: { values: { tenant: 'fixture' } },
            });
            expect(api.records.size).toBe(0);
        } finally { first.owner.dispose(); next.owner.dispose(); }
    });

    it('preserves the admitted configuration revision when restoring a manual draft', async () => {
        const original = manualMode();
        const admittedMode = { ...original, descriptor: PluginConnectedAccountAuthenticationModeV2Schema.parse({
            ...original.descriptor, configuration: accountScopedConfiguration(),
        }) };
        let record: ConnectedAccountConfigurationRecord = { revision: 'configuration-1', values: { tenant: 'fixture' }, secretRefs: {} };
        const configuration = createConnectedAccountConfigurationOwner({
            read: async () => record,
            replace: async () => { throw new Error('No configuration writes expected'); },
            destroyAttempt: async () => {},
            secrets: { admit: async () => {}, has: async () => false, read: async () => null },
            isRuntimeCurrent: () => true,
        });
        const ports = { admittedMode, admitConfiguration: configuration.admit,
            configurationCurrent: configuration.isCurrent, destroyAttemptConfiguration: configuration.destroyAttempt };
        const first = harness(ports);
        const next = harness({ ...ports, attemptAddresses: first.transactions.address });
        try {
            await first.owner.beginConnect({ service, modeId: 'manual' });
            first.owner.dispose();
            record = { ...record, revision: 'configuration-2' };
            expect(await next.owner.ensureRestored({ attemptId: 'attempt-1' })).toMatchObject({
                status: 'conflict', code: 'connected_account_configuration_changed',
            });
            expect(next.invoke).not.toHaveBeenCalled();
            expect(next.destroyAttemptConfiguration).not.toHaveBeenCalled();
        } finally { first.owner.dispose(); next.owner.dispose(); }
    });

    it('discovers only resumable drafts without discarding another host\'s addresses', async () => {
        const h = harness();
        const nextHost = harness();
        try {
            await h.owner.beginConnect({ service, modeId: 'manual' });
            const pending = await h.transactions.listPending(service);
            expect(await h.owner.selectResumableAttempts(pending)).toEqual(pending);
            // A new host sees the same addressed records, without the old draft.
            expect(await nextHost.owner.selectResumableAttempts(pending)).toEqual(pending);
            expect(h.transactionApi.records.has('attempt-1')).toBe(true);
            const durable = [
                { ...pending[0]!, attemptId: 'oauth', kind: 'oauth' as const, phase: 'awaitingOAuth' as const },
                { ...pending[0]!, attemptId: 'device', kind: 'device' as const, phase: 'awaitingDeviceAuthorization' as const },
            ];
            expect(await nextHost.owner.selectResumableAttempts(durable)).toEqual(durable);
            expect(await nextHost.owner.selectResumableAttempts(durable.map(attempt => ({
                ...attempt, phase: 'configurationRequired' as const,
            })))).toEqual([]);
        } finally { h.owner.dispose(); nextHost.owner.dispose(); }
    });

    it('refuses manual input when addressed transaction custody is unavailable', async () => {
        const h = harness({ attemptAddresses: null });
        try {
            await expect(h.owner.beginConnect({ service, modeId: 'manual' }))
                .resolves.toMatchObject({ status: 'unavailable' });
            expect(h.invoke).not.toHaveBeenCalled();
            expect(h.settle).not.toHaveBeenCalled();
        } finally { h.owner.dispose(); }
    });

    it.each(['connected', 'connected-other-mode', 'refreshing', 'refresh_failed_retryable', 'different'] as const)('reuses a usable imported provider identity without replacing credentials (%s)', async identityCase => {
        const admitted = manualMode('native-import');
        const profile = QualifiedConnectedAccountProfileV4Schema.parse({
            ref: accountA, authenticationModeId: identityCase === 'connected-other-mode' ? 'manual-pat' : 'native-import',
            status: identityCase === 'different' || identityCase === 'connected-other-mode' ? 'connected' : identityCase,
            revisionSemantics: 'revisioned', credentialRevision: 'csr_1234567890123456789012',
            configurationReady: true, configurationRevision: null, expiresAt: null, scopes: [],
            providerIdentity: { accountId: '123' },
        });
        const h = harness({ admittedMode: { ...admitted, descriptor: PluginConnectedAccountAuthenticationModeV2Schema.parse({ ...admitted.descriptor, credentialOrigin: 'native_import' }) },
            findByProviderIdentity: async ({ service: requested, providerIdentity }) => requested.pluginId === service.pluginId
                && providerIdentity.accountId === '123' && identityCase !== 'different' ? profile : null,
            invoke: async () => ({ status: 'connected', providerIdentity: { accountId: '123' }, displayName: 'octocat', scopes: [] }),
        });
        try {
            await h.owner.beginConnect({ service, modeId: 'native-import' });
            const result = await h.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'fixture-token' } });
            expect(result).toMatchObject({ status: 'connected', account: identityCase !== 'different' ? accountA : { service, accountId: 'host-account-1' } });
            expect(h.settle).toHaveBeenCalledTimes(identityCase !== 'different' ? 0 : 1);
            expect(h.invoke).toHaveBeenCalledOnce();
            expect(h.transactionApi.records.has('attempt-1')).toBe(false);
        } finally { h.owner.dispose(); }
    });

    it.each(['needs_reauth', 'expired', 'mode-mismatch', 'unfenced', 'upgraded'] as const)(
        'reimports an unready native identity through fenced reconnect or refuses it (%s)', async scenario => {
            const admitted = manualMode('native-import');
            const credentialRevision = 'csr_1234567890123456789012';
            const profile = QualifiedConnectedAccountProfileV4Schema.parse({
                ref: accountA,
                authenticationModeId: scenario === 'mode-mismatch' ? 'other-mode' : 'native-import',
                status: scenario === 'expired' ? 'connected' : 'needs_reauth',
                ...(scenario === 'unfenced' || scenario === 'upgraded'
                    ? { revisionSemantics: 'legacy_unfenced', credentialRevision: null }
                    : { revisionSemantics: 'revisioned', credentialRevision }),
                configurationReady: true, configurationRevision: null,
                expiresAt: scenario === 'expired' ? 999 : null, scopes: [],
                providerIdentity: { accountId: '123' },
            });
            const h = harness({
                admittedMode: { ...admitted, descriptor: PluginConnectedAccountAuthenticationModeV2Schema.parse({ ...admitted.descriptor, credentialOrigin: 'native_import' }) },
                findByProviderIdentity: async () => profile,
                account: scenario === 'unfenced' ? null : { account: accountA,
                    authenticationModeId: scenario === 'mode-mismatch' ? 'other-mode' : 'native-import',
                    credentialRevision, configurationRevision: null },
                invoke: async ({ context }) => {
                    await context.attemptCredentials.set('accessToken', 'replacement-native-token');
                    return { status: 'connected', providerIdentity: { accountId: '123' }, displayName: 'octocat', scopes: [] };
                },
            });
            try {
                await h.owner.beginConnect({ service, modeId: 'native-import' });
                const result = await h.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'fixture-token' } });
                if (scenario === 'mode-mismatch' || scenario === 'unfenced') {
                    expect(result).toMatchObject({ status: 'conflict', code: scenario === 'mode-mismatch'
                        ? 'connected_account_authentication_mode_mismatch' : 'connected_account_credential_changed' });
                    expect(h.settle).not.toHaveBeenCalled();
                } else {
                    expect(result).toMatchObject({ status: 'connected', account: accountA });
                    expect(h.settle).toHaveBeenCalledOnce();
                    expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({
                        intent: 'reconnect', accountId: accountA.accountId, authenticationModeId: 'native-import',
                        expectedCredentialRevision: credentialRevision, expectedCredentialConfigurationRevision: null,
                        expectedConfigurationRevision: 'configuration-1', stagedCredentials: { accessToken: 'replacement-native-token' },
                    }));
                    expect(h.admitConfiguration).toHaveBeenLastCalledWith(expect.objectContaining({ intent: 'reconnect', account: accountA }));
                }
                expect(h.invoke).toHaveBeenCalledOnce();
                expect(h.transactionApi.records.has('attempt-1')).toBe(false);
            } finally { h.owner.dispose(); }
        },
    );

    it('publishes its address before returning manual input and removes it after settlement', async () => {
        const h = harness();
        try {
            await expect(h.owner.beginConnect({ service, modeId: 'manual' }))
                .resolves.toEqual({ status: 'awaitingManual', attemptId: 'attempt-1' });
            expect(h.transactionApi.records.get('attempt-1')).toMatchObject({
                kind: 'manual', content: { t: 'plain', v: { manual: {
                    sourceCustody: expect.any(Object), expectedConfigurationRevision: 'configuration-1',
                    expectedCredentialRevision: null, expectedCredentialConfigurationRevision: null,
                } } },
                scope: { phase: 'awaitingManual', createdAtMs: 1_000,
                    intent: 'connect', service, modeId: 'manual' },
            });
            await expect(h.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'manual-secret' } }))
                .resolves.toMatchObject({ status: 'connected' });
            expect(h.transactionApi.records.has('attempt-1')).toBe(false);
        } finally { h.owner.dispose(); }
    });

    it.each(['wrong-field', 'unknown-secret'])('keeps refused manual input retryable (%s)', async invalid => {
        const h = harness();
        try {
            await h.owner.beginConnect({ service, modeId: 'manual' });
            await expect(h.owner.submitManual({
                attemptId: 'attempt-1',
                fields: invalid === 'wrong-field' ? { apiKey: 'candidate' } : { token: 'candidate' },
                ...(invalid === 'unknown-secret' ? { selectedSecrets: { wrong: {
                    ref: 'happier:shared-secret:v1:00000000-0000-4000-8000-000000000001', resourceRevision: 1,
                } } } : {}),
            })).resolves.toMatchObject({ status: 'rejected', code: 'connected_account_manual_fields_invalid' });
            expect(h.invoke).not.toHaveBeenCalled();
            expect(h.transactionApi.records.has('attempt-1')).toBe(true);
            await expect(h.owner.read({ attemptId: 'attempt-1' }))
                .resolves.toMatchObject({ status: 'awaitingManual' });
            await expect(h.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'candidate' } }))
                .resolves.toMatchObject({ status: 'connected' });
            expect(h.transactionApi.records.has('attempt-1')).toBe(false);
        } finally { h.owner.dispose(); }
    });

    it('expires unsubmitted manual input at the acknowledged lifetime without entering the provider', async () => {
        let now = 1_000;
        const h = harness({ now: () => now });
        try {
            await h.owner.beginConnect({ service, modeId: 'manual' });
            const expiry = h.transactionApi.records.get('attempt-1')!.expiresAtMs;
            now = expiry - 1;
            await expect(h.owner.read({ attemptId: 'attempt-1' }))
                .resolves.toMatchObject({ status: 'awaitingManual' });
            now = expiry;
            await expect(h.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'manual-secret' } }))
                .resolves.toEqual({ status: 'unavailable', attemptId: 'attempt-1', code: 'connected_account_attempt_expired' });
            expect(h.invoke).not.toHaveBeenCalled();
            expect(h.settle).not.toHaveBeenCalled();
        } finally { h.owner.dispose(); }
    });

    it('keeps cancellation authoritative when the addressed write acknowledgement arrives late', async () => {
        const h = harness();
        const written = createDeferred<void>();
        const acknowledgement = createDeferred<void>();
        const create = h.transactionApi.create;
        vi.spyOn(h.transactionApi, 'create').mockImplementation(async input => {
            const record = await create(input);
            written.resolve();
            await acknowledgement.promise;
            return record;
        });
        try {
            const beginning = h.owner.beginConnect({ service, modeId: 'manual' });
            await written.promise;
            await expect(h.owner.read({ attemptId: 'attempt-1' }))
                .resolves.not.toMatchObject({ status: 'awaitingManual' });
            await expect(h.owner.cancel({ attemptId: 'attempt-1' }))
                .resolves.toMatchObject({ status: 'cancelled' });
            acknowledgement.resolve();
            await expect(beginning).resolves.toMatchObject({
                status: 'conflict', code: 'connected_account_attempt_cancelled',
            });
            expect(h.transactionApi.records.has('attempt-1')).toBe(false);
            expect(h.invoke).not.toHaveBeenCalled();
        } finally { acknowledgement.resolve(); h.owner.dispose(); }
    });
});

describe('generic prepared restoration', () => {
    it('persists and resumes browser-poll authorization without a user code or provider deadline', async () => {
        let now = 1_000;
        const api = createConnectedAccountAttemptTransactionApiBoundary();
        const transactions = createQualifiedConnectedAccountAttemptTransactionAdapters({
            credentials: { token: 'account-token', encryption: null },
            getAccountEncryptionMode: async () => 'plain', getMachineId: () => 'machine-1',
            now: () => now, api,
        });
        const configuration = configured('configuration-1', {}, 'device');
        const first = harness({ now: () => now, admittedMode: deviceMode(), configuration,
            deviceTransactions: transactions.device, attemptAddresses: transactions.address,
            invoke: async () => ({ status: 'awaitingDeviceAuthorization',
                verificationUri: 'https://provider.example/browser', pollIntervalMs: 5_000 }),
        });
        let replacement: ReturnType<typeof harness> | undefined;
        try {
            await first.owner.beginConnect({ service, modeId: 'device' });
            const response = await waitForAttemptStatus(first.owner, 'attempt-1', 'awaitingDeviceAuthorization');
            const expiry = now + CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS;
            expect(response).toEqual({ status: 'awaitingDeviceAuthorization', attemptId: 'attempt-1',
                verificationUri: 'https://provider.example/browser', pollIntervalMs: 5_000, expiresAtMs: expiry });
            expect(api.records.get('attempt-1')?.expiresAtMs).toBe(expiry);
            first.owner.dispose();
            replacement = harness({ now: () => now, admittedMode: deviceMode(), configuration,
                deviceTransactions: transactions.device, attemptAddresses: transactions.address,
                invoke: async () => ({ status: 'pending', retryAfterMs: 5_000 }),
            });
            await expect(replacement.owner.resumeDevice({ attemptId: 'attempt-1' })).resolves.toEqual(response);
            now += 5_000;
            await expect(replacement.owner.pollDevice({ attemptId: 'attempt-1' }))
                .resolves.toMatchObject({ status: 'pending' });
            expect(replacement.invoke).toHaveBeenCalledOnce();
            now = expiry;
            await expect(replacement.owner.pollDevice({ attemptId: 'attempt-1' }))
                .resolves.toMatchObject({ status: 'unavailable', code: 'connected_account_device_authorization_expired' });
            expect(api.records.has('attempt-1')).toBe(false);
            expect(replacement.invoke).toHaveBeenCalledOnce();
        } finally { first.owner.dispose(); replacement?.owner.dispose(); }
    });

    it('restores device custody passively for read/cancel and resumes the prepared settlement once', async () => {
        let now = 1_000;
        const api = createConnectedAccountAttemptTransactionApiBoundary();
        const transactions = createQualifiedConnectedAccountAttemptTransactionAdapters({
            credentials: { token: 'account-token', encryption: null },
            getAccountEncryptionMode: async () => 'plain', getMachineId: () => 'machine-1',
            now: () => now, api,
        });
        const configuration = configured('configuration-1', {}, 'device');
        const first = harness({ now: () => now, admittedMode: deviceMode(), configuration,
            deviceTransactions: transactions.device, attemptAddresses: transactions.address,
            settle: async () => { throw new Error('The credential write acknowledgement was lost'); },
        });
        await first.owner.beginConnect({ service, modeId: 'device' });
        await waitForAttemptStatus(first.owner, 'attempt-1', 'awaitingDeviceAuthorization');
        now = 6_000;
        await expect(first.owner.pollDevice({ attemptId: 'attempt-1' }))
            .resolves.toMatchObject({ status: 'outcomeUnknown' });
        first.owner.dispose();
        const record = api.records.get('attempt-1');
        if (!record) throw new Error('Expected acknowledged prepared device custody');
        const read = vi.spyOn(api, 'read');
        const replacement = harness({ now: () => now, admittedMode: deviceMode(), configuration,
            deviceTransactions: transactions.device, attemptAddresses: transactions.address,
        });
        try {
            await expect(replacement.owner.ensureRestored({ attemptId: 'attempt-1', record }))
                .resolves.toBeNull();
            await expect(replacement.owner.read({ attemptId: 'attempt-1' }))
                .resolves.toMatchObject({ status: 'outcomeUnknown' });
            await expect(replacement.owner.cancel({ attemptId: 'attempt-1' }))
                .resolves.toMatchObject({ status: 'outcomeUnknown' });
            expect(replacement.invoke).not.toHaveBeenCalled();
            expect(replacement.settle).not.toHaveBeenCalled();
            expect(read).not.toHaveBeenCalled();
            await expect(replacement.owner.resumeDevice({ attemptId: 'attempt-1' }))
                .resolves.toMatchObject({ status: 'connected' });
            expect(replacement.settle).toHaveBeenCalledOnce();
            expect(replacement.invoke).not.toHaveBeenCalled();
            expect(api.records.has('attempt-1')).toBe(false);
        } finally { replacement.owner.dispose(); }
    });
});

describe('provider-discovered OAuth configuration', () => {
    function deferredOAuth(automatic = false) {
        const api = createConnectedAccountAttemptTransactionApiBoundary();
        const transactions = createQualifiedConnectedAccountAttemptTransactionAdapters({
            credentials: { token: 'account-token', encryption: null },
            getAccountEncryptionMode: async () => 'plain', getMachineId: () => 'machine-1', now: () => 1_000, api,
        });
        const originalMode = oauthMode({ outcomeReconciliation: 'none', configuration: PluginConnectedAccountConfigurationV2Schema.parse({
            ...accountScopedConfiguration(), fields: [...accountScopedConfiguration().fields,
                { id: 'accountId', title: 'Account', schema: { type: 'string' } }],
        }) });
        const admittedMode = { ...originalMode, descriptor: PluginConnectedAccountAuthenticationModeV2Schema.parse({
            ...originalMode.descriptor, postAuthenticationFieldIds: ['accountId'],
        }) };
        let record: ConnectedAccountConfigurationRecord | null = {
            revision: 'configuration-1', values: { tenant: 'acme' }, secretRefs: {},
        };
        const configuration = createConnectedAccountConfigurationOwner({
            // Persistent configuration and transaction transport are the only substituted boundaries.
            read: async () => record,
            replace: async input => {
                if ((record?.revision ?? null) !== input.expectedRevision) return { status: 'conflict' };
                record = { ...input.replacement, revision: 'configuration-2' };
                return { status: 'committed', record };
            },
            destroyAttempt: async () => { record = null; },
            secrets: { admit: async () => {}, has: async () => false, read: async () => null },
            isRuntimeCurrent: () => true,
        });
        const fields = PluginConnectedAccountConfigurationV2Schema.parse({
            scope: 'account', changeBehavior: 'reconnect', fields: [{
                id: 'accountId', title: 'Account', schema: { type: 'string', enum: ['account-1', 'account-2'] }, required: true,
            }],
        }).fields;
        let staged: ConnectedAccountAttemptProviderInvocation['context']['attemptCredentials'] | undefined;
        let now = 1_000;
        const makeHost = () => harness({ admittedMode, oauthTransactions: transactions.oauth, attemptAddresses: transactions.address,
            now: () => now, executionMachine: { serverId: 'server-1', machineId: 'machine-1' },
            admitConfiguration: configuration.admit, stageAccountConfiguration: configuration.stageAccountConfiguration,
            destroyAttemptConfiguration: configuration.destroyAttempt,
            invoke: async ({ operation, context }) => {
                if (operation.kind === 'beginOAuth') return {
                    status: 'awaitingOAuthRedirect', authorizationUrl: 'https://issuer.example/authorize',
                };
                if (operation.kind === 'completeOAuth') {
                    staged = context.attemptCredentials;
                    await staged.set('accessToken', 'staged-oauth-token');
                    if (automatic) {
                        await context.stageAccountConfiguration!({ fields,
                            values: { ...context.configuration.values, accountId: 'account-2' } });
                        return { status: 'connected', displayName: 'Selected account', scopes: ['read'] };
                    }
                    return { status: 'configurationRequired', fields };
                }
                if (operation.kind === 'reconcile') {
                    expect(await context.attemptCredentials.get('accessToken')).toBe('staged-oauth-token');
                    expect(context.configuration.values.accountId).toBe('account-2');
                    return { status: 'connected', displayName: 'Selected account', scopes: ['read'] };
                }
                return { status: 'rejected', diagnostic: { code: 'unexpected_operation' } };
            },
        });
        const begin = async (h: ReturnType<typeof makeHost>) => {
            await h.owner.beginConnect({ service, modeId: 'oauth' });
            await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');
            const transaction = await transactions.oauth.read!('attempt-1');
            return h.owner.completeOAuth({ attemptId: 'attempt-1', completion: {
                code: 'one-use-code', state: transaction!.request.state, callbackUrl: transaction!.request.callbackUrl,
            } });
        };
        const select = async (h: ReturnType<typeof makeHost>, accountId: string) => {
            const control = await h.owner.resolveConfigurationControlTarget({ attemptId: 'attempt-1' });
            expect(control).not.toBeNull();
            return configuration.replaceForControl({ ...control!, expectedRevision: record!.revision,
                values: { tenant: 'acme', accountId }, secretValues: {} });
        };
        return { api, transactions, configuration, fields, makeHost, begin, select, staged: () => staged,
            advanceClock: () => { now = 5_000; } };
    }

    it('selects a discovered account and reconciles without exchanging the OAuth code again', async () => {
        const flow = deferredOAuth();
        const h = flow.makeHost();
        try {
            await expect(flow.begin(h)).resolves.toMatchObject({ status: 'configurationRequired', missingFieldIds: ['accountId'] });
            const control = await h.owner.resolveConfigurationControlTarget({ attemptId: 'attempt-1' });
            expect(control?.mode.configuration?.fields).toEqual(expect.arrayContaining(flow.fields));
            expect(h.settle).not.toHaveBeenCalled();
            await expect(flow.select(h, 'account-2')).resolves.toMatchObject({ status: 'committed' });
            await expect(h.owner.continueConnect({ attemptId: 'attempt-1', expectedConfigurationRevision: 'configuration-2' }))
                .resolves.toMatchObject({ status: 'connected' });
            expect(h.invoke.mock.calls.map(([input]) => input.operation.kind)).toEqual(['beginOAuth', 'completeOAuth', 'reconcile']);
            expect(h.settle.mock.calls[0]?.[0]).toMatchObject({ stagedCredentials: { accessToken: 'staged-oauth-token' },
                stagedAccountConfigurationContent: { values: { tenant: 'acme', accountId: 'account-2' } } });
            expect(flow.api.records.size).toBe(0);
        } finally { h.owner.dispose(); }
    });

    it('stages an automatically selected account during completion with the same configuration owner', async () => {
        const flow = deferredOAuth(true);
        const h = flow.makeHost();
        try {
            await expect(flow.begin(h)).resolves.toMatchObject({ status: 'connected' });
            expect(h.settle.mock.calls[0]?.[0]).toMatchObject({ stagedAccountConfigurationContent: {
                values: { tenant: 'acme', accountId: 'account-2' },
            } });
            expect(flow.api.records.size).toBe(0);
        } finally { h.owner.dispose(); }
    });

    it('rejects an account outside the authorized choice set before reconciliation', async () => {
        const flow = deferredOAuth();
        const h = flow.makeHost();
        try {
            await expect(flow.begin(h)).resolves.toMatchObject({ status: 'configurationRequired' });
            await expect(flow.select(h, 'another-account')).rejects.toMatchObject({ code: 'connected_account_configuration_invalid' });
            expect(h.settle).not.toHaveBeenCalled();
            expect((await h.owner.read({ attemptId: 'attempt-1' })).status).toBe('configurationRequired');
            expect(h.invoke.mock.calls.some(([input]) => input.operation.kind === 'reconcile')).toBe(false);
        } finally { h.owner.dispose(); }
    });

    it('disposes staged credentials and the existing transaction when account selection is cancelled', async () => {
        const flow = deferredOAuth();
        const h = flow.makeHost();
        try {
            await expect(flow.begin(h)).resolves.toMatchObject({ status: 'configurationRequired' });
            await expect(h.owner.cancel({ attemptId: 'attempt-1' })).resolves.toMatchObject({ status: 'cancelled' });
            await expect(flow.staged()!.get('accessToken')).resolves.toBeNull();
            expect(flow.api.records.size).toBe(0);
            expect(h.settle).not.toHaveBeenCalled();
        } finally { h.owner.dispose(); }
    });

    it('keeps the configuration form unpublished when its staged OAuth transaction cannot be persisted', async () => {
        const flow = deferredOAuth();
        const h = flow.makeHost();
        const replace = flow.api.replace.bind(flow.api);
        vi.spyOn(flow.api, 'replace').mockImplementation(async input => {
            if (input.scope.phase === 'configurationRequired') throw new Error('storage unavailable');
            return replace(input);
        });
        try {
            await expect(flow.begin(h)).resolves.toMatchObject({ status: 'unavailable',
                code: 'connected_account_oauth_transaction_unavailable' });
            await expect(flow.staged()!.get('accessToken')).resolves.toBeNull();
            expect(flow.api.records.size).toBe(0);
            expect(h.settle).not.toHaveBeenCalled();
        } finally { h.owner.dispose(); }
    });

    it('restores the same account choices and staged credentials before continuing after restart', async () => {
        const flow = deferredOAuth();
        const first = flow.makeHost();
        const restored = flow.makeHost();
        try {
            await expect(flow.begin(first)).resolves.toMatchObject({ status: 'configurationRequired' });
            flow.advanceClock();
            const pending = await flow.transactions.listPending(service);
            await expect(restored.owner.selectResumableAttempts(pending)).resolves.toEqual(pending);
            await restored.owner.ensureRestored({ attemptId: 'attempt-1' });
            await expect(restored.owner.read({ attemptId: 'attempt-1' })).resolves.toMatchObject({ status: 'configurationRequired' });
            await flow.select(restored, 'account-2');
            await expect(restored.owner.continueConnect({ attemptId: 'attempt-1' })).resolves.toMatchObject({ status: 'connected' });
            expect(restored.invoke.mock.calls.map(([input]) => input.operation.kind)).toEqual(['reconcile']);
            expect(restored.settle.mock.calls[0]?.[0]).toMatchObject({ authenticationProvenance: {
                authenticatedAt: 1_000, machine: { serverId: 'server-1', machineId: 'machine-1' },
            } });
        } finally { first.owner.dispose(); restored.owner.dispose(); }
    });
});

describe('provider-discovered manual configuration', () => {
    function deferredManual(single = false) {
        const declared = manualMode();
        const admittedMode = { ...declared, descriptor: PluginConnectedAccountAuthenticationModeV2Schema.parse({
            ...declared.descriptor,
            configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
                { id: 'teamId', title: 'Team', schema: { type: 'string' }, required: false },
                { id: 'projectId', title: 'Project', schema: { type: 'string' }, required: false },
            ] },
        }) };
        // An earlier form step committed the optional scope fields empty.
        let record: ConnectedAccountConfigurationRecord | null = { revision: 'configuration-1', values: {}, secretRefs: {} };
        const configuration = createConnectedAccountConfigurationOwner({
            // Persistent configuration is the only substituted boundary; the
            // admission, staging and attempt transaction owners stay real.
            read: async () => record,
            replace: async input => {
                if ((record?.revision ?? null) !== input.expectedRevision) return { status: 'conflict' };
                record = { ...input.replacement, revision: 'configuration-2' };
                return { status: 'committed', record };
            },
            destroyAttempt: async () => { record = null; },
            secrets: { admit: async () => {}, has: async () => false, read: async () => null },
            isRuntimeCurrent: () => true,
        });
        const teams = PluginConnectedAccountConfigurationV2Schema.parse({
            scope: 'account', changeBehavior: 'reconnect', fields: [{
                id: 'teamId', title: 'Team', required: true,
                schema: { type: 'string', enum: single ? ['team_one'] : ['team_one', 'team_two'] },
                presentation: { options: single ? [{ value: 'team_one', title: 'Design team' }]
                    : [{ value: 'team_one', title: 'Design team' }, { value: 'team_two', title: 'Platform team' }] },
            }],
        }).fields;
        let staged: ConnectedAccountAttemptProviderInvocation['context']['attemptCredentials'] | undefined;
        const h = harness({
            admittedMode, admitConfiguration: configuration.admit,
            stageAccountConfiguration: configuration.stageAccountConfiguration,
            destroyAttemptConfiguration: configuration.destroyAttempt,
            invoke: async ({ operation, context }) => {
                if (operation.kind === 'submitManual') {
                    staged = context.attemptCredentials;
                    await staged.set('token', operation.fields.token!);
                    if (single) {
                        await context.stageAccountConfiguration!({ fields: teams,
                            values: { ...context.configuration.values, teamId: 'team_one' } });
                        return { status: 'connected', displayName: 'Design team', scopes: [],
                            providerIdentity: { organizationId: 'team_one' } };
                    }
                    return { status: 'configurationRequired', fields: teams };
                }
                if (operation.kind === 'reconcile') {
                    expect(await context.attemptCredentials.get('token')).toBe('pasted-token');
                    return { status: 'connected', displayName: 'Platform team', scopes: [],
                        providerIdentity: { organizationId: context.configuration.values.teamId as string } };
                }
                return { status: 'rejected', diagnostic: { code: 'unexpected_operation' } };
            },
        });
        const submit = async () => {
            await expect(h.owner.beginConnect({ service, modeId: 'manual' }))
                .resolves.toMatchObject({ status: 'awaitingManual' });
            return h.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'pasted-token' } });
        };
        const select = async (teamId: string) => {
            const control = await h.owner.resolveConfigurationControlTarget({ attemptId: 'attempt-1' });
            expect(control).not.toBeNull();
            return configuration.replaceForControl({ ...control!, expectedRevision: record?.revision ?? null,
                values: { teamId }, secretValues: {} });
        };
        return { h, teams, submit, select, staged: () => staged };
    }

    it('offers the discovered teams and continues the pasted token through the same configuration continuation', async () => {
        const flow = deferredManual();
        const { h } = flow;
        try {
            const responses: unknown[] = [];
            const offered = await flow.submit();
            responses.push(offered);
            expect(offered).toMatchObject({ status: 'configurationRequired', missingFieldIds: ['teamId'] });
            const control = await h.owner.resolveConfigurationControlTarget({ attemptId: 'attempt-1' });
            expect(control?.mode.configuration?.fields).toEqual(expect.arrayContaining(flow.teams));
            expect(h.settle).not.toHaveBeenCalled();
            await expect(flow.select('team_two')).resolves.toMatchObject({ status: 'committed' });
            const connected = await h.owner.continueConnect({ attemptId: 'attempt-1' });
            responses.push(connected);
            expect(connected).toMatchObject({ status: 'connected' });
            expect(h.invoke.mock.calls.map(([input]) => input.operation.kind)).toEqual(['submitManual', 'reconcile']);
            expect(h.settle).toHaveBeenCalledOnce();
            expect(h.settle.mock.calls[0]?.[0]).toMatchObject({ stagedCredentials: { token: 'pasted-token' },
                stagedAccountConfigurationContent: { values: { teamId: 'team_two' } },
                providerIdentity: { organizationId: 'team_two' } });
            // The pasted token never leaves temporary attempt custody except through settlement.
            expect(JSON.stringify(responses)).not.toContain('pasted-token');
            expect(JSON.stringify([...h.transactionApi.records.values()])).not.toContain('pasted-token');
        } finally { h.owner.dispose(); }
    });

    it('rejects a team outside the discovered choices before reconciliation', async () => {
        const flow = deferredManual();
        const { h } = flow;
        try {
            await expect(flow.submit()).resolves.toMatchObject({ status: 'configurationRequired' });
            await expect(flow.select('team_elsewhere')).rejects.toMatchObject({ code: 'connected_account_configuration_invalid' });
            expect((await h.owner.read({ attemptId: 'attempt-1' })).status).toBe('configurationRequired');
            expect(h.invoke.mock.calls.some(([input]) => input.operation.kind === 'reconcile')).toBe(false);
            expect(h.settle).not.toHaveBeenCalled();
        } finally { h.owner.dispose(); }
    });

    it('discards the staged token when the team choice is cancelled', async () => {
        const flow = deferredManual();
        const { h } = flow;
        try {
            await expect(flow.submit()).resolves.toMatchObject({ status: 'configurationRequired' });
            await expect(h.owner.cancel({ attemptId: 'attempt-1' })).resolves.toMatchObject({ status: 'cancelled' });
            await expect(flow.staged()!.get('token')).resolves.toBeNull();
            expect(h.settle).not.toHaveBeenCalled();
        } finally { h.owner.dispose(); }
    });

    it('stages the only discovered team during submission with the same configuration owner', async () => {
        const flow = deferredManual(true);
        const { h } = flow;
        try {
            await expect(flow.submit()).resolves.toMatchObject({ status: 'connected' });
            expect(h.settle.mock.calls[0]?.[0]).toMatchObject({ stagedCredentials: { token: 'pasted-token' },
                stagedAccountConfigurationContent: { values: { teamId: 'team_one' } } });
        } finally { h.owner.dispose(); }
    });
});

describe('OAuth issuer admission', () => {
    it('publishes the sealed transaction expiry when an authorization server supplies no expiry', async () => {
        // The transaction HTTP/database boundary is replaced; the actual PKCE,
        // envelope, revision and attempt owners run together.
        const api = createConnectedAccountAttemptTransactionApiBoundary();
        const { records } = api;
        const transactions = createQualifiedConnectedAccountAttemptTransactionAdapters({ credentials: { token: 'account-token', encryption: null },
            getAccountEncryptionMode: async () => 'plain', getMachineId: () => 'machine-1', now: () => 1_000, api });
        const h = harness({ admittedMode: oauthMode({ outcomeReconciliation: 'none' }), oauthTransactions: transactions.oauth, now: () => 1_000,
            invoke: async () => ({ status: 'awaitingOAuthRedirect', authorizationUrl: 'https://issuer.example/authorize' }) });
        try {
            await h.owner.beginConnect({ service, modeId: 'oauth' });
            const response = await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');
            expect(response).toMatchObject({ expiresAtMs: records.get('attempt-1')!.expiresAtMs });
            expect((await transactions.oauth.read!('attempt-1'))?.snapshot.expiresAtMs).toBe(records.get('attempt-1')!.expiresAtMs);
        } finally { h.owner.dispose(); }
    });
    it('stages discovered host client configuration in the existing attempt and settlement', async () => {
        const mode = oauthMode({ outcomeReconciliation: 'none', configuration: PluginConnectedAccountConfigurationV2Schema.parse({
            scope: 'account', changeBehavior: 'reconnect', fields: [
                { id: 'resource', title: 'Resource', schema: { type: 'string' }, required: true },
                { id: 'issuer', title: 'Issuer', schema: { type: 'string' } },
                { id: 'clientSecret', title: 'Client secret', schema: { type: 'string' }, secret: true },
            ],
        }) });
        const record = { revision: 'configuration-1', values: { resource: 'https://mcp.example/mcp' }, secretRefs: {} };
        // Only persistent storage and secret retrieval are replaced; configuration
        // admission, schema normalization, attempt and settlement logic remain real.
        const configuration = createConnectedAccountConfigurationOwner({
            read: async () => record,
            replace: async () => { throw new Error('Host staging must not write before settlement'); },
            destroyAttempt: async () => {},
            secrets: { admit: async () => {}, has: async () => false, read: async () => null },
            isRuntimeCurrent: () => true,
        });
        const durable = durableOAuthTransactions();
        const admittedMode = { ...mode, service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, sourceCustody: { kind: 'host' as const } };
        const h = harness({ admittedMode, oauthTransactions: durable.owner,
            admitConfiguration: configuration.admit,
            configurationCurrent: async () => true,
            stageAccountConfiguration: input => configuration.stageAccountConfiguration(input),
            invoke: async ({ operation, context }) => {
                if (operation.kind === 'beginOAuth') {
                    await context.stageAccountConfiguration!({ values: { resource: record.values.resource, issuer: 'https://issuer.example' },
                        secretValues: { clientSecret: 'private-client-secret' } });
                    return { status: 'awaitingOAuthRedirect', authorizationUrl: 'https://issuer.example/authorize' };
                }
                return { status: 'connected', accountId: 'server-1', displayName: 'MCP', scopes: ['read'] };
            },
        });
        try {
            await h.owner.beginConnect({ service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, modeId: 'oauth' });
            await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');
            expect(durable.readRecord()?.snapshot).toMatchObject({ stagedAccountConfigurationContent: {
                values: { resource: record.values.resource, issuer: 'https://issuer.example' },
                secretValues: { clientSecret: 'private-client-secret' },
            } });
            const response = await h.owner.completeOAuth({ attemptId: 'attempt-1', completion: {
                code: 'code', state: 'state-1', callbackUrl: 'http://127.0.0.1:4000/auth/callback',
            } });
            expect(response.status).toBe('connected');
            expect(h.settle.mock.calls[0]?.[0]).toMatchObject({ stagedAccountConfigurationContent: {
                values: { issuer: 'https://issuer.example' }, secretValues: { clientSecret: 'private-client-secret' },
            } });
        } finally { h.owner.dispose(); }
    });
    it('restores issuer admission after restart and does not disclose a forged provider error', async () => {
        const durable = durableOAuthTransactions();
        const configuration = configured('configuration-1', {}, 'oauth');
        const admittedMode = oauthMode({ outcomeReconciliation: 'none' });
        const first = harness({ configuration, admittedMode, oauthTransactions: durable.owner,
            invoke: async () => ({ status: 'awaitingOAuthRedirect', authorizationUrl: 'https://issuer.example/authorize',
                issuer: 'https://issuer.example', issuerResponseParameterRequired: true }) });
        const replacement = harness({ configuration, admittedMode, oauthTransactions: durable.owner });
        try {
            await first.owner.beginConnect({ service, modeId: 'oauth' });
            await waitForAttemptStatus(first.owner, 'attempt-1', 'awaitingOAuth');
            expect(durable.readRecord()?.snapshot).toMatchObject({ issuer: 'https://issuer.example', issuerResponseParameterRequired: true });
            const completion = { code: 'code', state: 'state-1', callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                iss: 'https://other.example', error: 'forged-provider-error' };
            const response = await replacement.owner.completeOAuth({ attemptId: 'attempt-1', completion });
            expect(response).toMatchObject({ status: 'rejected', code: 'connected_account_oauth_issuer_invalid' });
            expect(JSON.stringify(response)).not.toContain('forged-provider-error');
            expect(replacement.invoke.mock.calls.some(([input]) => input.operation.kind === 'completeOAuth')).toBe(false);
        } finally { first.owner.dispose(); replacement.owner.dispose(); }
    });
    it.each([
        { required: false, iss: 'https://other.example', expected: 'rejected' },
        { required: true, iss: undefined, expected: 'rejected' },
        { required: false, iss: undefined, expected: 'connected' },
        { required: true, iss: 'https://issuer.example', expected: 'connected' },
        { required: false, iss: '', expected: 'rejected' },
        { required: false, iss: 'https://issuer.example/', expected: 'rejected' },
    ])('validates the sealed issuer before exchange ($required, $iss)', async ({ required, iss, expected }) => {
        // The substituted invocation is the external authorization-server boundary.
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            invoke: async ({ operation }) => operation.kind === 'beginOAuth'
                ? { status: 'awaitingOAuthRedirect', authorizationUrl: 'https://issuer.example/authorize',
                    issuer: 'https://issuer.example', issuerResponseParameterRequired: required }
                : { status: 'connected', accountId: 'account-a', displayName: 'Account', scopes: [] },
        });
        try {
            await h.owner.beginConnect({ service, modeId: 'oauth' });
            await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');
            const response = await h.owner.completeOAuth({ attemptId: 'attempt-1', completion: {
                code: 'code', state: 'state-1', callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                ...(iss === undefined ? {} : { iss }),
            } });
            expect(response.status).toBe(expected);
            if (expected === 'rejected') {
                expect(response).toMatchObject({ code: 'connected_account_oauth_issuer_invalid' });
                expect(h.invoke.mock.calls.some(([input]) => input.operation.kind === 'completeOAuth')).toBe(false);
                expect(h.settle).not.toHaveBeenCalled();
            }
        } finally { h.owner.dispose(); }
    });
});

it('continues a captured manual attempt after runtime reload without readmitting or replaying authentication', async () => {
    let current = true;
    const h = harness({ generationCurrent: () => current });
    const begun = await h.owner.beginConnect({ service, modeId: 'manual' });
    expect(begun.status).toBe('awaitingManual');
    if (!('attemptId' in begun) || !begun.attemptId) throw new Error('Expected an attempt');
    current = false;

    await expect(h.owner.submitManual({
        attemptId: begun.attemptId, fields: { token: 'candidate' },
    })).resolves.toMatchObject({ status: 'connected', account: accountA });
    expect(h.invoke).toHaveBeenCalledOnce();
    expect(h.settle).toHaveBeenCalledOnce();
    h.owner.dispose();
});

it('settles typed authentication facts from a trusted runtime with computed fields', async () => {
    const h = harness({ invoke: async () => ({
        status: 'connected', accountId: 'account-a',
        get displayName() { return 'Computed account name'; },
        scopes: ['read'],
    }) });
    await h.owner.beginConnect({ service, modeId: 'manual' });
    await expect(h.owner.submitManual({
        attemptId: 'attempt-1', fields: { token: 'candidate' },
    })).resolves.toMatchObject({ status: 'connected', account: accountA });
    expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Computed account name' }));
    h.owner.dispose();
});

it('allows provider cancellation cleanup to finish without a guessed callback deadline', async () => {
    vi.useFakeTimers();
    // Native AbortSignal.timeout owns a real clock, outside Vitest's JS timers.
    // Adapt that clock boundary so the actual attempt owner can be tested deterministically.
    const timeoutClock = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')), delay);
        return controller.signal;
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let cleanupStarted!: () => void;
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    let cleanupFinished!: () => void;
    const finished = new Promise<void>((resolve) => { cleanupFinished = resolve; });
    let cleanupSignal: AbortSignal | undefined;
    const h = harness({
        admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
        invoke: async ({ operation, signal }) => {
            if (operation.kind === 'cancel') {
                cleanupSignal = signal;
                cleanupStarted();
                await cleanupGate;
                signal?.throwIfAborted();
                cleanupFinished();
                return undefined;
            }
            return {
                status: 'awaitingOAuthRedirect',
                authorizationUrl: 'https://provider.example/authorize',
                expiresAtMs: 61_000,
            };
        },
    });
    try {
        await h.owner.beginConnect({ service, modeId: 'oauth' });
        await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');
        await expect(h.owner.cancel({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled', attemptId: 'attempt-1',
        });
        await started;
        await vi.advanceTimersByTimeAsync(6_000);
        expect(cleanupSignal?.aborted ?? false).toBe(false);
        releaseCleanup();
        await finished;
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
            status: 'cancelled', attemptId: 'attempt-1',
        });
    } finally {
        releaseCleanup();
        h.owner.dispose();
        timeoutClock.mockRestore();
        vi.useRealTimers();
    }
});

type TestOAuthTransactionSnapshot = Readonly<{
    attemptId: string;
    phase: 'starting' | 'awaitingOAuth' | 'outcomeUnknown';
    sourceCustody: ConnectedAccountAttemptModeAdmission['sourceCustody'];
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
    it('does not impose a guessed lifetime on a manual attempt', async () => {
        let now = 1_000;
        const h = harness({ now: () => now });
        await h.owner.beginConnect({ service, modeId: 'manual' });
        now += 16 * 60_000;
        await expect(h.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'candidate' } })).resolves.toMatchObject({ status: 'connected' });
        h.owner.dispose();
    });
    it('retains user-owned manual attempts beyond guessed capacity and lifetime limits', async () => {
        let now = 1_000;
        const h = harness({ now: () => now });
        for (let index = 1; index <= 65; index += 1) {
            await expect(h.owner.beginConnect({ service, modeId: 'manual' })).resolves.toMatchObject({
                status: 'awaitingManual', attemptId: `attempt-${index}`,
            });
        }
        now += 16 * 60_000;
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toMatchObject({ status: 'awaitingManual' });
        await expect(h.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'candidate' } })).resolves.toMatchObject({ status: 'connected' });
        h.owner.dispose();
    });
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

    it('enforces manual descriptor input schemas before invoking the provider or settling an account', async () => {
        const admitted = manualMode();
        const descriptor = PluginConnectedAccountAuthenticationModeV2Schema.parse({
            id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'API key', secret: true,
                schema: { type: 'string', pattern: '^service-key-' } }],
        });
        const h = harness({ admittedMode: { ...admitted, descriptor } });
        await h.owner.beginConnect({ service, modeId: 'manual' });
        await expect(h.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'not-a-valid-key' } })).resolves.toMatchObject({
            status: 'rejected', code: 'connected_account_manual_fields_invalid',
        });
        expect(h.invoke).not.toHaveBeenCalled();
        expect(h.settle).not.toHaveBeenCalled();
        await h.owner.beginConnect({ service, modeId: 'manual' });
        await expect(h.owner.submitManual({ attemptId: 'attempt-2', fields: { token: 'service-key-valid' } })).resolves.toMatchObject({ status: 'connected' });
        expect(h.settle).toHaveBeenCalledOnce();
    });

    it('validates entered and selected Anthropic keys before settling their resource custody', async () => {
        const mode = anthropicConnectedAccountRuntime.authentication.modes['api-key'];
        if (!mode || mode.kind !== 'manual') throw new Error('Missing manual mode');
        let providerStatus = 401;
        const unavailableServices = createUnavailablePluginServices();
        const admitted = manualMode();
        const descriptor = PluginConnectedAccountAuthenticationModeV2Schema.parse({
            id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
            credentialFieldKeys: { token: 'token' },
            fields: [{ id: 'token', title: 'API key', secret: true, schema: ANTHROPIC_API_KEY_INPUT_SCHEMA }],
        });
        const h = harness({ admittedMode: { ...admitted, descriptor }, readSelectedSecrets: async selections =>
            Object.fromEntries(Object.keys(selections).map(field => [field, 'sk-ant-selected'])), invoke: async (invocation) => {
            if (invocation.operation.kind !== 'submitManual') throw new Error('Unexpected operation');
            return await mode.complete({ fields: invocation.operation.fields }, {
                ...invocation.context, signal: invocation.signal ?? new AbortController().signal,
                plugin: { id: service.pluginId, version: '1.0.0' },
                contribution: { id: service.localId, qualifiedId: `${service.pluginId}/${service.localId}` },
                surface: 'ui', invokedAtMs: 1_000,
                // Only the provider's HTTP transport is substituted; staging and settlement admission are real.
                services: { ...unavailableServices, http: { ...unavailableServices.http,
                    request: async () => ({ status: providerStatus, finalUrl: 'https://api.anthropic.com/v1/models', headers: {}, body: new Uint8Array() }),
                } },
            });
        } });
        await h.owner.beginConnect({ service, modeId: 'manual' });
        await expect(h.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'sk-ant-qa-fake' } })).resolves.toMatchObject({
            status: 'rejected', code: 'anthropic_api_key_rejected',
        });
        expect(h.settle).not.toHaveBeenCalled();
        providerStatus = 200;
        await h.owner.beginConnect({ service, modeId: 'manual' });
        await expect(h.owner.submitManual({ attemptId: 'attempt-2', fields: { token: 'sk-ant-verified' } })).resolves.toMatchObject({ status: 'connected' });
        expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({ stagedCredentials: { token: 'sk-ant-verified' },
            credentialSecretResources: { token: { resourceId: expect.any(String), displayName: 'API key' } },
        }));
        await h.owner.beginConnect({ service, modeId: 'manual' });
        const selectedSecrets = { token: { ref: 'happier:shared-secret:v1:selected-key', resourceRevision: 1 } };
        await expect(h.owner.submitManual({ attemptId: 'attempt-3', fields: {}, selectedSecrets }))
            .resolves.toMatchObject({ status: 'connected' });
        expect(h.settle).toHaveBeenLastCalledWith(expect.objectContaining({
            stagedCredentials: { token: 'sk-ant-selected' }, credentialSecretRefs: selectedSecrets,
        }));
        expect(h.settle.mock.calls.at(-1)?.[0]).not.toHaveProperty('credentialSecretResources');
    });

    it('claims manual submission before acquiring a selected key so a concurrent submit cannot enter twice', async () => {
        const selected = createDeferred<Readonly<Record<string, string>>>();
        let reads = 0;
        const admitted = manualMode();
        const descriptor = PluginConnectedAccountAuthenticationModeV2Schema.parse({
            id: 'manual', kind: 'manual', outcomeReconciliation: 'none', accountDirectSave: true,
            fields: [{ id: 'token', title: 'Key', secret: true, schema: { type: 'string', minLength: 1 } }],
        });
        const h = harness({ admittedMode: { ...admitted, descriptor }, readSelectedSecrets: async () => {
            reads += 1;
            return selected.promise;
        } });
        await h.owner.beginConnect({ service, modeId: 'manual' });
        const input = { attemptId: 'attempt-1', fields: {}, selectedSecrets: {
            token: { ref: 'happier:shared-secret:v1:selected-key', resourceRevision: 1 },
        } };
        const first = h.owner.submitManual(input);
        const second = h.owner.submitManual(input);
        selected.resolve({ token: 'selected-key' });
        expect(await second).toMatchObject({ status: 'conflict', code: 'connected_account_attempt_in_progress' });
        expect(await first).toMatchObject({ status: 'connected' });
        expect(reads).toBe(1);
    });

    it('checks peer admission before provider invocation', async () => {
        let peer: 'v4' | 'exact-old' = 'v4';
        const h = harness({ assertEffectfulOperationAllowed: () => {
            if (peer === 'exact-old') throw Object.assign(new Error('unsupported'), {
                code: 'connected_account_legacy_operation_unsupported',
            });
        } });
        await h.owner.beginConnect({ service, modeId: 'manual' });
        peer = 'exact-old';
        await expect(h.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'candidate' } }))
            .resolves.toMatchObject({ status: 'unavailable', code: 'connected_account_legacy_operation_unsupported' });
        expect(h.invoke).not.toHaveBeenCalled();
        expect(h.settle).not.toHaveBeenCalled();
    });

    it('does not create OAuth custody after cancellation wins peer admission', async () => {
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
            assertEffectfulOperationAllowed: async () => {
                peerAdmissionCalls += 1;
                if (peerAdmissionCalls === 2) {
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
    });

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

    it('closes deferred OAuth creation custody after cancellation', async () => {
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

    it('retains cancellation when deferred OAuth creation rejects', async () => {
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
        'retains cancellation when $transport restoration reads $outcome',
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

    it('keeps the typed admission cause instead of a bare runtime unavailability', async () => {
        const h = harness({
            admitMode: async () => {
                throw new PluginError({ code: 'connected_account_service_unavailable',
                    message: 'Acme plugin did not activate.', remediation: { kind: 'retry' } });
            },
        });

        await expect(h.owner.beginConnect({ service, modeId: 'manual' })).resolves.toEqual({
            status: 'unavailable',
            code: 'connected_account_service_unavailable',
            diagnostic: {
                code: 'connected_account_service_unavailable', severity: 'error',
                message: 'Acme plugin did not activate.', remediation: { kind: 'retry' },
                details: { failureCause: expect.objectContaining({ errorCode: 'connected_account_service_unavailable' }) },
            },
        });
    });

    it('carries a thrown provider cause on the interrupted outcome', async () => {
        const h = harness({
            invoke: async () => {
                throw new PluginError({ code: 'acme_team_unavailable', message: 'Acme could not read this team.',
                    remediation: { kind: 'openSettings', path: '/settings/team' } });
            },
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });

        await expect(h.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'candidate' } })).resolves.toMatchObject({
            diagnostic: {
                code: 'connected_account_provider_operation_interrupted', severity: 'error',
                message: 'Acme could not read this team.', remediation: { kind: 'openSettings', path: '/settings/team' },
                details: { failureCause: expect.objectContaining({ errorCode: 'acme_team_unavailable' }) },
            },
        });
        h.owner.dispose();
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
                    sourceCustody: Object.freeze({
                        kind: 'managed' as const,
                        immutableGenerationId: 'artifact-acme-1',
                        installSource: 'archive' as const,
                    }),
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

    it('continues configuration-required custody across runtime replacement', async () => {
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
            status: 'configurationRequired',
            attemptId: 'attempt-1',
            target,
            missingFieldIds: ['tenant'],
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
                    sourceCustody: Object.freeze({
                        kind: 'managed' as const,
                        immutableGenerationId: 'artifact-acme-1',
                        installSource: 'archive' as const,
                    }),
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

    it('promotes a first manual connect through null-CAS after staged credentials', async () => {
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
                    providerIdentity: { accountId: 'provider-user-1', email: 'work@example.test', organizationId: 'org-b' },
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
            sourceCustody: expect.objectContaining({
                kind: 'managed',
                immutableGenerationId: 'artifact-acme-1',
            }),
            stagedCredentials: { accessToken: 'provider-token' },
            providerIdentity: { accountId: 'provider-user-1', email: 'work@example.test', organizationId: 'org-b' },
        }));
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
            configurationCurrent: async () => configurationCurrent,
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

    it('settles prepared OAuth credentials once across runtime replacement', async () => {
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

        await expect(completion).resolves.toEqual({
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
            occurrenceId: 'generation-1',
            sourceCustody: expect.objectContaining({
                kind: 'managed',
                immutableGenerationId: 'artifact-acme-1',
            }),
        }));
        await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'connected_account_attempt_not_found',
        });
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
            executionMachine: { serverId: 'home-auth', machineId: 'machine-auth' },
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
        expect(h.settle.mock.calls[0]?.[0]).not.toHaveProperty('authenticationProvenance');
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
        })).resolves.toMatchObject({ status: 'reconnectRequired',
            diagnostic: { code: 'provider_response_lost' } });
        await expect(h.owner.reconcile({ attemptId: 'attempt-1' })).resolves.toMatchObject({
            status: 'reconnectRequired',
            diagnostic: { code: 'provider_response_lost' },
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
            occurrenceId: 'generation-1',
            sourceCustody: {
                kind: 'managed',
                immutableGenerationId: 'artifact-acme-1',
            },
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

    it('preserves the captured configuration request when runtime currentness is unavailable', async () => {
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
            status: 'configurationRequired',
            attemptId: 'attempt-1',
            target,
            missingFieldIds: ['tenant'],
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
        const onBackgroundTransition = vi.fn();
        let finishBegin!: (value: unknown) => void;
        const beginResult = new Promise<unknown>((resolve) => {
            finishBegin = resolve;
        });
        const h = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            onBackgroundTransition,
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
        await vi.waitFor(() => expect(onBackgroundTransition).toHaveBeenCalledOnce());
        expect(onBackgroundTransition).toHaveBeenCalledWith(expect.objectContaining({
            service,
            settlementPhase: 'notPrepared',
            response: expect.objectContaining({ status: 'awaitingOAuth' }),
        }));
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
        const api = createConnectedAccountAttemptTransactionApiBoundary();
        const transactions = createQualifiedConnectedAccountAttemptTransactionAdapters({
            credentials: { token: 'account-token', encryption: null },
            getAccountEncryptionMode: async () => 'plain', getMachineId: () => 'machine-1',
            now: () => 1_000, api,
        });
        const restartSafeConfiguration = Object.freeze({
            ...configured('configuration-1', { tenant: 'acme' }, 'oauth'),
            stagedAccountConfigurationContent: Object.freeze({
                values: Object.freeze({ tenant: 'acme' }),
                secretRefs: Object.freeze({}),
            }),
        });
        const first = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: transactions.oauth,
            attemptAddresses: transactions.address,
            configuration: restartSafeConfiguration,
        });

        await first.owner.beginConnect({ service, modeId: 'oauth' });
        const awaiting = await waitForAttemptStatus(
            first.owner,
            'attempt-1',
            'awaitingOAuth',
        );
        const record = api.records.get('attempt-1');
        if (!record || record.content.t !== 'plain'
            || typeof record.content.v !== 'object' || record.content.v === null
            || Array.isArray(record.content.v)) throw new Error('Expected the acknowledged plain transaction');
        const payload = record.content.v;
        if (!('verifier' in payload) || typeof payload.verifier !== 'string'
            || !('state' in payload) || typeof payload.state !== 'string'
            || !('snapshot' in payload)) {
            throw new Error('Expected sealed OAuth callback custody');
        }
        const { verifier, state } = payload;
        expect(JSON.stringify(awaiting)).not.toContain(verifier);
        expect(payload.snapshot).toMatchObject({
            attemptId: 'attempt-1',
            phase: 'awaitingOAuth',
            authorizationUrl: 'https://provider.example/authorize',
            sourceCustody: {
                kind: 'managed',
                immutableGenerationId: 'artifact-acme-1',
            },
            stagedAccountConfigurationContent: {
                values: { tenant: 'acme' },
                secretRefs: {},
            },
        });
        first.owner.dispose();

        const replacement = harness({
            admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            oauthTransactions: transactions.oauth,
            attemptAddresses: transactions.address,
            configuration: restartSafeConfiguration,
            invoke: async ({ operation, context }) => {
                expect(operation).toEqual({
                    kind: 'completeOAuth',
                    completion: {
                        code: 'callback-code',
                        callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                        state,
                        pkceVerifier: verifier,
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
        await expect(replacement.owner.read({
            attemptId: 'attempt-1',
        })).resolves.toMatchObject({
            status: 'awaitingOAuth',
            authorizationUrl: 'https://provider.example/authorize',
        });
        await expect(replacement.owner.completeOAuth({
            attemptId: 'attempt-1',
            completion: {
                code: 'callback-code',
                callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                state,
            },
        })).resolves.toMatchObject({
            status: 'connected',
            account: accountA,
        });
        expect(replacement.settle).toHaveBeenCalledWith(expect.objectContaining({
            stagedCredentials: { accessToken: 'access-1' },
        }));
        replacement.owner.dispose();
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
            sourceCustody: {
                kind: 'managed' as const,
                immutableGenerationId: 'artifact-acme-2',
                installSource: 'archive' as const,
            },
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

        // A reopened form needs the acknowledged code, even after a pending poll.
        await expect(h.owner.resumeDevice({ attemptId: 'attempt-1' })).resolves.toMatchObject({
            status: 'awaitingDeviceAuthorization',
            attemptId: 'attempt-1',
            userCode: expect.any(String),
            pollIntervalMs: 7_000,
        });

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
        const executionMachine = { serverId: 'home-auth', machineId: 'original-machine' };
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
            executionMachine,
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
                authenticationProvenance: { authenticatedAt: 6_000, machine: executionMachine },
            },
        });

        now += 1_000;
        const replacementCreateAccountId = vi.fn(() => 'host-account-2');
        let releaseReplacementSettlement!: () => void;
        const replacementSettlementRelease = new Promise<void>((resolve) => {
            releaseReplacementSettlement = resolve;
        });
        const replacement = harness({
            admittedMode: deviceMode('none', 'replacement-process', 'artifact-acme-1'),
            now: () => now,
            executionMachine: { serverId: 'home-auth', machineId: 'replacement-machine' },
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
            authenticationProvenance: { authenticatedAt: 6_000, machine: executionMachine },
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
            status: 'awaitingManual',
            attemptId: 'attempt-2',
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
            attemptId: 'attempt-3',
        });
    });

    it('reconciles an uncertain prepared settlement without replaying its write operation', async () => {
        let now = 1_000;
        const executionMachine = { serverId: 'home-auth', machineId: 'machine-auth' };
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
            executionMachine,
            now: () => now,
        });
        await h.owner.beginConnect({ service, modeId: 'manual' });
        now = 2_000;
        await expect(h.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'candidate' },
        })).resolves.toMatchObject({
            status: 'outcomeUnknown',
            attemptId: 'attempt-1',
        });
        expect(settle.mock.calls[0]?.[0]).toMatchObject({
            authenticationProvenance: { authenticatedAt: 2_000, machine: executionMachine },
        });
        now = 3_000;
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

    it('omits an unknown Home identity and captures a later portable binding rather than its profile alias', async () => {
        const profile = { id: 'laptop-profile', serverUrl: 'https://home.example.test', webappUrl: 'https://home.example.test' };
        let target = await resolveHomeTarget({
            input: { kind: 'saved_profile', profileRef: profile.id }, readSavedProfile: async () => profile,
        });
        let machineId = 'before-registration';
        const h = harness({
            resolveExecutionMachine: createBoundMachineTargetResolver({
                resolveCurrentServerIdentityId: () => target.homeServerIdentityId,
                resolveCurrentMachineId: () => machineId,
            }),
        });
        expect(target.profileId).toBe('laptop-profile');
        await h.owner.beginConnect({ service, modeId: 'manual' });
        await expect(h.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'candidate' } }))
            .resolves.toMatchObject({ status: 'connected' });
        expect(h.settle.mock.calls[0]?.[0]).not.toHaveProperty('authenticationProvenance');

        target = await resolveHomeTarget({ input: { kind: 'saved_profile', profileRef: profile.id }, readSavedProfile: async () => ({
            ...profile, homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_shared_home',
                canonicalServerUrl: profile.serverUrl, revision: 1, endpoints: [{ kind: 'https', url: profile.serverUrl }] },
        }) });
        machineId = 'registered-machine';
        await h.owner.beginConnect({ service, modeId: 'manual' });
        await expect(h.owner.submitManual({ attemptId: 'attempt-2', fields: { token: 'next-candidate' } }))
            .resolves.toMatchObject({ status: 'connected' });
        expect(h.settle.mock.calls[1]?.[0]).toMatchObject({ authenticationProvenance: {
            authenticatedAt: 1_000, machine: { serverId: 'srv_shared_home', machineId: 'registered-machine' },
        } });
    });

    it.each([undefined, 'native_import'] as const)('leaves original authentication unknown for manual credential origin %s', async (credentialOrigin) => {
        const admitted = manualMode('existing-login');
        const h = harness({
            admittedMode: { ...admitted, descriptor: PluginConnectedAccountAuthenticationModeV2Schema.parse({ ...admitted.descriptor, credentialOrigin }) },
            executionMachine: { serverId: 'home-auth', machineId: 'machine-auth' },
        });
        await h.owner.beginConnect({ service, modeId: 'existing-login' });
        await expect(h.owner.submitManual({ attemptId: 'attempt-1', fields: { token: 'existing-token' } }))
            .resolves.toMatchObject({ status: 'connected' });
        expect(h.settle.mock.calls[0]?.[0]).not.toHaveProperty('authenticationProvenance');
    });

    it.each(['conflict', 'unavailable'] as const)('retains the prepared settlement diagnostic when reconciliation is %s', async status => {
        const h = harness({
            settle: async () => {
                throw new Error('credential write acknowledgement lost');
            },
            reconcileSettlement: async () => ({
                status,
                code: status === 'conflict' ? 'connected_account_settlement_conflict' : 'connected_account_configuration_unavailable',
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

        const expectedReconnectRequired = status === 'conflict' ? {
            status: 'reconnectRequired',
            attemptId: 'attempt-1',
            code: 'connected_account_settlement_conflict',
        } : { status: 'outcomeUnknown', attemptId: 'attempt-1',
            diagnostic: { code: 'connected_account_configuration_unavailable' } };
        await expect(h.owner.reconcile({
            attemptId: 'attempt-1',
        })).resolves.toEqual(expectedReconnectRequired);
        await expect(h.owner.read({
            attemptId: 'attempt-1',
        })).resolves.toEqual(expectedReconnectRequired);
        expect(h.settle).toHaveBeenCalledOnce();
        expect(h.reconcileSettlement).toHaveBeenCalledOnce();
        expect(h.destroyAttemptConfiguration).toHaveBeenCalledTimes(status === 'conflict' ? 1 : 0);
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


    it('preserves trusted provider diagnostics without interpreting them as authentication', async () => {
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

    });


    it('relays typed rate-limit evidence from a terminal provider result', async () => {
        const retryNotBeforeMs = 1_786_000_060_000;
        const accepted = harness({
            invoke: async () => ({
                status: 'unavailable',
                diagnostic: { code: 'provider_rate_limited', severity: 'error' },
                failureClass: 'rateLimit',
                retryNotBeforeMs,
            }),
        });
        await accepted.owner.beginConnect({ service, modeId: 'manual' });
        await expect(accepted.owner.submitManual({
            attemptId: 'attempt-1',
            fields: { token: 'candidate' },
        })).resolves.toEqual({
            status: 'unavailable',
            attemptId: 'attempt-1',
            code: 'provider_rate_limited',
            diagnostic: { code: 'provider_rate_limited', severity: 'error' },
            failureClass: 'rateLimit',
            retryNotBeforeMs,
        });

    });


    it('preserves typed credential values above the invented 64KiB staging cap', async () => {
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
        })).resolves.toMatchObject({ status: 'connected' });
        expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({
            stagedCredentials: { token: 'x'.repeat(64 * 1024 + 1) },
        }));
    });

    it('retains refused manual configuration until cancel and destroys cancelled configuration', async () => {
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
        expect(rejected.destroyAttemptConfiguration).not.toHaveBeenCalled();
        await expect(rejected.owner.read({ attemptId: 'attempt-1' }))
            .resolves.toMatchObject({ status: 'awaitingManual' });
        await rejected.owner.cancel({ attemptId: 'attempt-1' });
        expect(rejected.destroyAttemptConfiguration).toHaveBeenCalledWith('attempt-1');

    });


    it('closes a provider-expired OAuth transaction without unrelated traffic', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        try {
            const durable = durableOAuthTransactions();
            const h = harness({
                now: () => Date.now(),
                admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
                oauthTransactions: durable.owner,
                invoke: async () => ({
                    status: 'awaitingOAuthRedirect',
                    authorizationUrl: 'https://provider.example/authorize',
                    expiresAtMs: Date.now() + 60_000,
                }),
            });
            await h.owner.beginConnect({ service, modeId: 'oauth' });
            await waitForAttemptStatus(h.owner, 'attempt-1', 'awaitingOAuth');
            expect(durable.readRecord()).not.toBeNull();

            // No unrelated begin or read arrives. The single earliest-expiry
            // timer physically reclaims the durable RepeatKey-backed
            // transaction and expires the attempt on its own.
            await vi.advanceTimersByTimeAsync(60_000);
            expect(durable.readRecord()).toBeNull();
            await expect(h.owner.read({ attemptId: 'attempt-1' })).resolves.toEqual({
                status: 'unavailable',
                attemptId: 'attempt-1',
                code: 'connected_account_attempt_expired',
            });
            expect(h.destroyAttemptConfiguration).toHaveBeenCalledWith('attempt-1');
            h.owner.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not create expiry timers for manual attempts', async () => {
        vi.useFakeTimers();
        try {
            const h = harness({
                now: () => Date.now(),
            });
            await expect(h.owner.beginConnect({
                service,
                modeId: 'manual',
            })).resolves.toEqual({
                status: 'awaitingManual',
                attemptId: 'attempt-1',
            });
            expect(vi.getTimerCount()).toBe(0);

            await expect(h.owner.cancel({ attemptId: 'attempt-1' })).resolves.toEqual({
                status: 'cancelled',
                attemptId: 'attempt-1',
            });
            expect(vi.getTimerCount()).toBe(0);

            await expect(h.owner.beginConnect({
                service,
                modeId: 'manual',
            })).resolves.toEqual({
                status: 'awaitingManual',
                attemptId: 'attempt-2',
            });
            expect(vi.getTimerCount()).toBe(0);

            h.owner.dispose();
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(h.destroyAttemptConfiguration).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
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

    it('keeps exact cleanup custody without blocking independent attempts', async () => {
        let rejectFirstCleanup!: (reason: Error) => void;
        const firstCleanup = new Promise<void>((_resolve, reject) => {
            rejectFirstCleanup = reject;
        });
        const destroyAttemptConfiguration = vi.fn()
            .mockImplementationOnce(async () => await firstCleanup)
            .mockResolvedValue(undefined);
        const h = harness({
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
            status: 'awaitingManual',
            attemptId: 'attempt-2',
        });
        await expect(h.owner.beginConnect({
            service,
            modeId: 'manual',
        })).resolves.toMatchObject({
            status: 'awaitingManual',
            attemptId: 'attempt-3',
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
            attemptId: 'attempt-4',
        });
    });
});

describe('Connected Account provider-start await', () => {
    function starting() {
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        // Third-party provider invocation is the boundary; the attempt lifecycle,
        // transaction and cancellation owners remain real beneath it.
        const h = harness({ admittedMode: oauthMode({ outcomeReconciliation: 'none' }),
            invoke: async ({ operation }) => {
                if (operation.kind !== 'beginOAuth') return { status: 'cancelled' };
                entered.resolve();
                await release.promise;
                return { status: 'awaitingOAuthRedirect', authorizationUrl: 'https://provider.example/authorize', expiresAtMs: 61_000 };
            } });
        return { ...h, entered, release };
    }
    it('awaits the existing background start while ordinary reads remain nonblocking', async () => {
        const h = starting();
        try {
            expect(await h.owner.beginConnect({ service, modeId: 'oauth' })).toEqual({ status: 'starting', attemptId: 'attempt-1' });
            await h.entered.promise;
            expect(await h.owner.read({ attemptId: 'attempt-1' })).toEqual({ status: 'starting', attemptId: 'attempt-1' });
            let settled = false;
            const waiting = h.owner.read({ attemptId: 'attempt-1', waitForProviderStart: true }).then(response => { settled = true; return response; });
            await Promise.resolve();
            await Promise.resolve();
            expect(settled).toBe(false);
            h.release.resolve();
            expect(await waiting).toMatchObject({ status: 'awaitingOAuth', attemptId: 'attempt-1', authorizationUrl: 'https://provider.example/authorize' });
        } finally { h.release.resolve(); h.owner.dispose(); }
    });
    it.each(['cancel', 'dispose', 'callerAbort'] as const)('releases a waiting caller on %s while the provider has not returned', async outcome => {
        const h = starting();
        try {
            await h.owner.beginConnect({ service, modeId: 'oauth' });
            await h.entered.promise;
            const controller = new AbortController();
            const waiting = h.owner.read({ attemptId: 'attempt-1', waitForProviderStart: true, signal: controller.signal });
            if (outcome === 'cancel') {
                await h.owner.cancel({ attemptId: 'attempt-1' });
                expect(await waiting).toMatchObject({ status: 'cancelled', attemptId: 'attempt-1' });
            } else if (outcome === 'dispose') {
                h.owner.dispose();
                expect(await waiting).toMatchObject({ status: 'conflict', attemptId: 'attempt-1', code: 'connected_account_attempt_cancelled' });
            } else {
                controller.abort(new Error('Request retired'));
                await expect(waiting).rejects.toThrow('Request retired');
                expect(await h.owner.read({ attemptId: 'attempt-1' })).toEqual({ status: 'starting', attemptId: 'attempt-1' });
            }
        } finally { h.release.resolve(); h.owner.dispose(); }
    });
});
