import { ConnectedServiceQuotaRecoveryCreditsV1Schema, ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { PluginConnectedAccountDescriptorContributionV2, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { ConnectedAccountCredentialStore as PluginConnectedAccountCredentialStore } from './authenticationTypes.js';
import type { ConnectedAccountEstablishedRuntime, ConnectedAccountRuntimeEstablishedInvocation, ConnectedAccountRuntimeEstablishedOperation, ConnectedAccountRuntimeQuotaBase } from './establishedRuntimeTypes.js';
import { snapshotConnectedAccountEstablishedResult, staleConnectedAccountProducerResult } from './producerResultSnapshot.js';
import type { ConnectedAccountEstablishedPhaseObserver } from './establishedReadScope.js';
import { PluginError } from '../plugins/errors.js';
type MaybePromise<T> = T | Promise<T>;
type ConnectedAccountCallbackCurrentnessPhase = 'beforeCallback' | 'afterCallback';

/** The same provider callback and result publication machinery runs on every host. */
export function createConnectedAccountEstablishedRuntimeDispatcher(params: Readonly<{
  observePhase?: ConnectedAccountEstablishedPhaseObserver;
  onRecoveryCreditsUnavailable?(service: QualifiedConnectedAccountRef['service']): void;
}> = {}) {
  const observeMaterializationPhase: ConnectedAccountEstablishedPhaseObserver = params.observePhase ?? (async (_phase, work) => work());
    function assertEstablishedTarget(input: ConnectedAccountRuntimeEstablishedInvocation): void {
        const assertSameAccount = (left: QualifiedConnectedAccountRef, right: QualifiedConnectedAccountRef) => {
            if (!sameQualifiedConnectedAccountRef(left, right)) {
                throw new Error('Connected-account established context does not match its exact target');
            }
        };
        assertSameAccount(input.target.account, input.context.account);
        const configurationTarget = input.context.configuration.target;
        if (configurationTarget.kind === 'attempt'
            || input.context.configuration.revision !== input.target.expectedRuntimeConfigurationRevision) {
            throw new Error('Connected-account established configuration revision is unavailable');
        }
        if (configurationTarget.kind === 'account') {
            assertSameAccount(input.target.account, configurationTarget.account);
        } else if (input.target.account.service.pluginId !== configurationTarget.service.pluginId
            || input.target.account.service.localId !== configurationTarget.service.localId) {
            throw new Error('Connected-account established context does not match its exact service target');
        }
    }
    /** Admits the exact established target at entry and before credential disclosure. */
    async function assertEstablishedAuthorityCurrent(
        input: ConnectedAccountRuntimeEstablishedInvocation,
        lease: Readonly<{ isCurrent(): boolean }>,
        signal: AbortSignal,
    ): Promise<void> {
        signal.throwIfAborted();
        if (!lease.isCurrent()) throw staleConnectedAccountProducerResult(input.operation.kind);
        const [configurationCurrent, credentialCurrent] = await Promise.all([
            observeMaterializationPhase('runtime_configuration_currentness', () => input.isConfigurationCurrent(input.context.configuration)),
            observeMaterializationPhase('runtime_credential_currentness', () => input.isCredentialRevisionCurrent()),
        ]);
        signal.throwIfAborted();
        if (!lease.isCurrent() || !configurationCurrent || !credentialCurrent) {
            throw staleConnectedAccountProducerResult(input.operation.kind);
        }
    }

    /** Finite admitted work observes local cancellation; materialization qualifies before disclosure. */
    async function assertEstablishedFenceCurrent(
        input: ConnectedAccountRuntimeEstablishedInvocation,
        lease: Readonly<{ isCurrent(): boolean }>,
        signal: AbortSignal,
        phase?: ConnectedAccountCallbackCurrentnessPhase,
    ): Promise<void> {
        if (phase === 'afterCallback' && input.operation.kind === 'materialize') {
            return await assertEstablishedAuthorityCurrent(input, lease, signal);
        }
        signal.throwIfAborted();
        if (!lease.isCurrent() || input.configurationRevocationSignal?.(input.context.configuration)?.aborted) {
            throw staleConnectedAccountProducerResult(input.operation.kind);
        }
    }
/**
 * The typed invocation boundary, rather than a recursive runtime wrapper,
 * owns the occurrence/currentness fence around every plugin callback. The
 * callback's own rejection stays visible while current; a retirement while it
 * is pending wins over that stale producer result just as every other host
 * currentness boundary does.
 */
async function invokeCurrentConnectedAccountCallback<TResult, TOutput>(
    assertCurrent: (phase: ConnectedAccountCallbackCurrentnessPhase) => Promise<void>,
    callback: () => MaybePromise<TResult>,
    snapshotResult: (result: TResult) => TOutput,
): Promise<TOutput>;
async function invokeCurrentConnectedAccountCallback<TResult>(
    assertCurrent: (phase: ConnectedAccountCallbackCurrentnessPhase) => Promise<void>,
    callback: () => MaybePromise<TResult>,
): Promise<TResult>;
async function invokeCurrentConnectedAccountCallback(
    assertCurrent: (phase: ConnectedAccountCallbackCurrentnessPhase) => Promise<void>,
    callback: () => MaybePromise<unknown>,
    snapshotResult?: (result: unknown) => unknown,
): Promise<unknown> {
    await observeMaterializationPhase('runtime_callback_before', () => assertCurrent('beforeCallback'));
    try {
        const result = await observeMaterializationPhase('runtime_callback', callback);
        return snapshotResult ? snapshotResult(result) : result;
    } finally {
        await observeMaterializationPhase('runtime_callback_after', () => assertCurrent('afterCallback'));
    }
}

    function guardStagedCredentials(
        source: PluginConnectedAccountCredentialStore,
        assertCurrent: () => Promise<void>,
        registerRawForRedaction: (value: string) => void,
    ): PluginConnectedAccountCredentialStore {
        return Object.freeze({
            async get(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                await assertCurrent();
                const value = await source.get(key, options);
                await assertCurrent();
                if (value !== null) registerRawForRedaction(value);
                return value;
            },
            async set(
                key: string,
                value: string,
                options?: Readonly<{ signal?: AbortSignal }>,
            ) {
                await assertCurrent();
                await source.set(key, value, options);
                await assertCurrent();
                registerRawForRedaction(value);
            },
            async delete(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                await assertCurrent();
                await source.delete(key, options);
                await assertCurrent();
            },
        });
    }

    async function invokeEstablishedRuntime<Context extends object, TQuota extends ConnectedAccountRuntimeQuotaBase, TOperation extends ConnectedAccountRuntimeEstablishedOperation>(
        runtime: Partial<ConnectedAccountEstablishedRuntime<Context, TQuota>>,
        descriptor: PluginConnectedAccountDescriptorContributionV2,
        context: Context,
        input: ConnectedAccountRuntimeEstablishedInvocation<TOperation>,
        registerRawForRedaction: (value: string) => void,
        assertCurrent: (phase?: ConnectedAccountCallbackCurrentnessPhase) => Promise<void>,
        redactDiagnosticText?: (value: string) => string,
    ) {
        const options = input.signal ? { signal: input.signal } : undefined;
        const operation = input.operation;
        const unsupportedOperation = () => new PluginError({
            code: 'unsupported',
            message: 'This Connected Account runtime does not support the requested operation.',
            retryable: false,
            details: { operation: operation.kind },
        });
        // Copy a terminal producer result before its final fresh qualification.
        // There is no authority-consuming step between callback settlement and
        // this copy; computed fields still cannot publish after revocation.
        const settleCallback = (callback: () => MaybePromise<unknown>, quotaLeafUnavailable = false) =>
            invokeCurrentConnectedAccountCallback(assertCurrent, callback, result =>
                snapshotConnectedAccountEstablishedResult<TOperation, TQuota>(operation, result, {
                    quotaLeafUnavailable,
                    ...(redactDiagnosticText ? { redactDiagnosticText } : {}),
                }));
        let result: unknown;
        let quotaLeafUnavailable = false;
        switch (operation.kind) {
            case 'recoveryCredits.read':
            case 'recoveryCredits.consume': {
                const facet = descriptor.recoveryCredits?.supported === true
                    ? runtime.recoveryCredits
                    : undefined;
                quotaLeafUnavailable = !facet;
                return await settleCallback(async () => {
                    if (!facet) return null;
                    if (operation.kind === 'recoveryCredits.read') return await facet.read(context, options);
                    if (!operation.request.idempotencyKey.trim()) throw new Error('Recovery credit idempotency key is required');
                    return await facet.consume(Object.freeze({
                        idempotencyKey: operation.request.idempotencyKey.trim(),
                        ...(operation.request.providerLimitIds === undefined ? {} : { providerLimitIds: Object.freeze([...operation.request.providerLimitIds]) }),
                        ...(operation.request.providerCreditId?.trim()
                            ? { providerCreditId: operation.request.providerCreditId.trim() }
                            : {}),
                    }), context, options);
                }, quotaLeafUnavailable);
            }
            case 'refresh':
            case 'enrichCredentialContext':
                return await settleCallback(
                    async () => {
                        if (operation.kind === 'refresh' && !runtime.refresh) throw unsupportedOperation();
                        if (operation.kind === 'enrichCredentialContext' && !runtime.enrichCredentialContext) {
                            return { status: 'outcomeUnknown', diagnostic: {
                                code: 'connected_account_context_enrichment_unsupported',
                                message: 'This Connected Account runtime does not support credential context enrichment.',
                            } };
                        }
                        const mutationContext = Object.freeze({
                            ...context,
                            operation: Object.freeze({
                                operationId: operation.operationId,
                                configurationRevision:
                                    input.target.expectedRuntimeConfigurationRevision,
                            }),
                            stagedCredentials: guardStagedCredentials(
                                operation.stagedCredentials,
                                assertCurrent,
                                (value) => registerRawForRedaction(value),
                            ),
                        });
                        return operation.kind === 'refresh'
                            ? await runtime.refresh!(mutationContext, options)
                            : await runtime.enrichCredentialContext!(mutationContext, options);
                    },
                );
            case 'status':
                return await settleCallback(
                    () => {
                        if (!runtime.status) throw unsupportedOperation();
                        return runtime.status(context, options);
                    },
                );
            case 'quota':
                if (runtime.quota) {
                    const quota = await invokeCurrentConnectedAccountCallback(
                        assertCurrent,
                        () => {
                            input.assertProviderCallAllowed?.();
                            return runtime.quota!(context, options);
                        },
                    );
                    // Quota output has no recovery authority. Only the admitted,
                    // explicitly declared facet may contribute reset inventory.
                    const base = {
                        observedAtMs: quota.observedAtMs,
                        limits: quota.limits,
                        ...(quota.providerOrganizationId === undefined ? {} : { providerOrganizationId: quota.providerOrganizationId }),
                        ...(quota.planLabel === undefined ? {} : { planLabel: quota.planLabel }),
                        ...(quota.subscription === undefined ? {} : { subscription: quota.subscription }),
                    };
                    result = base;
                    const facet = descriptor.recoveryCredits?.supported === true
                        ? runtime.recoveryCredits : undefined;
                    if (facet) {
                        try {
                            const inventory = await invokeCurrentConnectedAccountCallback(
                                assertCurrent, () => facet.read(context, options),
                            );
                            const recoveryCredits = ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                                availableCount: inventory.availableCount,
                                credits: inventory.credits.map(({ providerCreditId, status, kind, ...metadata }) => ({
                                    ...metadata,
                                    id: providerCreditId,
                                    kind: kind ?? 'usage_limit_reset',
                                    status: status === 'unavailable' ? 'unknown' : status,
                                })),
                            });
                            const recoveryCreditDetails = inventory.recoveryCreditDetails === undefined ? undefined
                                : ConnectedServiceQuotaRecoveryCreditDetailsByIdV1Schema.parse(inventory.recoveryCreditDetails);
                            result = { ...base, recoveryCredits,
                                ...(recoveryCreditDetails === undefined ? {} : { recoveryCreditDetails }),
                            };
                        } catch {
                            // A failed ancillary read removes actionable inventory;
                            // provider text is never included in the default signal.
                            params.onRecoveryCreditsUnavailable?.(input.target.account.service);
                            await assertCurrent();
                        }
                    }
                } else {
                    quotaLeafUnavailable = true;
                    result = await invokeCurrentConnectedAccountCallback(assertCurrent, () => null);
                }
                break;
            case 'revoke':
                return await settleCallback(
                    () => {
                        if (!runtime.revoke) throw unsupportedOperation();
                        return runtime.revoke(context, options);
                    },
                );
            case 'materialize':
                return await settleCallback(
                    () => {
                        if (!runtime.materialize) throw unsupportedOperation();
                        return runtime.materialize(
                            operation.request,
                            context,
                            { ...options, ...(operation.existingFiles ? { existingFiles: operation.existingFiles } : {}) },
                        );
                    },
                );
        }

        const snapshot = snapshotConnectedAccountEstablishedResult<TOperation, TQuota>(operation, result, {
            quotaLeafUnavailable,
            ...(redactDiagnosticText ? { redactDiagnosticText } : {}),
        });
        await assertCurrent();
        return snapshot;
    }

  return Object.freeze({ assertEstablishedTarget, assertEstablishedAuthorityCurrent, assertEstablishedFenceCurrent,
    invokeCurrentConnectedAccountCallback, guardStagedCredentials, invokeEstablishedRuntime });
}
