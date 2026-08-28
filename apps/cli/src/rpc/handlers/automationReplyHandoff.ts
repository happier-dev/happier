import { randomBytes as nodeRandomBytes } from 'node:crypto';

import {
    AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1,
    AutomationReplyHandoffDispatchRequestV1Schema,
    AutomationReplyHandoffDispatchResultV1Schema,
    AutomationResultDeliveryInputV1Schema,
    AutomationResultDeliveryResultV1Schema,
    openAutomationConversationReplyContextStoredEnvelopeV1,
    openAutomationRunResultStoredEnvelopeV1,
    sameAutomationAccountContentIdentityV1,
    sameAutomationAccountCurrentnessWitnessV1,
    sealAutomationReplyHandoffReceiptStoredEnvelopeV1,
    type AccountEncryptionCurrentnessResponse,
    type AccountScopedCryptoMaterialSnapshotV1,
    type AutomationAccountCurrentnessWitnessV1,
    type AutomationConversationReplyContextCorrespondenceV1,
    type AutomationReplyHandoffDispatchResultV1,
    type AutomationReplyHandoffSettlementV1,
    type AutomationRunResultCorrespondenceV1,
} from '@happier-dev/protocol';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import {
    createPluginRegistryStateStore,
    type PluginRegistryAvailabilityInventory,
} from '@/plugins/store/registry/currentState';
import { configuration } from '@/configuration';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import {
    isAvailableE2eeAutomationAccountEncryptionV1,
    resolveValidatedAutomationAccountEncryptionV1,
} from '@/plugins/runtime/automations/automationAccountCurrentness';

type AutomationReplyHandoffActionExecutor = typeof executeContributedAction;

/**
 * This validates the persisted result-delivery target, not an Action caller.
 * It stays target-owned so a live caller path cannot reselect authority by
 * plugin id.
 */
type ResolveCurrentAutomationReplyTargetMaterializationId = (
    pluginId: string,
) => Promise<string | null>;

function resolveCurrentAutomationReplyTargetMaterializationId(
    inventory: PluginRegistryAvailabilityInventory,
    pluginId: string,
): string | null {
    const matches = inventory.materializations.filter((row) => (
        row.pluginId === pluginId
        && row.enabled
        && row.trustState === 'trusted'
    ));
    return matches.length === 1 ? matches[0]!.materializationId : null;
}

function createCurrentAutomationReplyTargetMaterializationResolver(): ResolveCurrentAutomationReplyTargetMaterializationId {
    const stateStore = createPluginRegistryStateStore({ happyHomeDir: configuration.happyHomeDir });
    return async (pluginId) => resolveCurrentAutomationReplyTargetMaterializationId(
        await stateStore.readAvailabilityInventory(),
        pluginId,
    );
}

export type AutomationReplyHandoffRpcRegistrationOptions = Readonly<{
    /** The exact authenticated Machine hosting this daemon connection. */
    machineId: string;
    /** The current account belonging to that Machine's authenticated daemon. */
    resolveAccountId: (signal?: AbortSignal) => Promise<string | null>;
    /** The persisted daemon-installation identity; absent identity fails closed. */
    resolveInstallationId: () => string | null | Promise<string | null>;
    /** Canonical server Account-currentness endpoint; never substitute cached mode. */
    resolveAccountEncryptionCurrentness: (
        signal?: AbortSignal,
    ) => Promise<AccountEncryptionCurrentnessResponse>;
    /**
     * Canonical local Account-material snapshot. Plain Accounts must resolve no
     * E2EE material; E2EE snapshots are matched to currentness before use.
     */
    resolveAccountEncryptionMaterial: (
        signal?: AbortSignal,
    ) => Promise<AccountScopedCryptoMaterialSnapshotV1 | null>;
    resolveCurrentTargetMaterializationId?: ResolveCurrentAutomationReplyTargetMaterializationId;
    acquireRuntimeLease?: () => Promise<PluginRuntimeRegistryLease>;
    executeContributedAction?: AutomationReplyHandoffActionExecutor;
}>;

function unavailable(
    code: Extract<AutomationReplyHandoffDispatchResultV1, { kind: 'unavailable' }>['code'],
): AutomationReplyHandoffDispatchResultV1 {
    return { kind: 'unavailable', code };
}

function readSignal(signal: AbortSignal | undefined): AbortSignal {
    return signal ?? new AbortController().signal;
}

function sameCorrespondence(
    value: AutomationRunResultCorrespondenceV1,
    expected: Readonly<{
        accountId: string;
        automationId: string;
        runId: string;
        handoffId: string;
    }>,
): boolean {
    return value.accountId === expected.accountId
        && value.automationId === expected.automationId
        && value.runId === expected.runId
        && 'handoffId' in value
        && value.handoffId === expected.handoffId;
}

function sameReplyContextCorrespondence(
    correspondence: AutomationConversationReplyContextCorrespondenceV1,
    expected: Readonly<{
        automationId: string;
        occurrenceKey: string;
    }>,
): boolean {
    return correspondence.automationId === expected.automationId
        && correspondence.occurrenceKey === expected.occurrenceKey;
}

function projectSettlement(
    result: ReturnType<typeof AutomationResultDeliveryResultV1Schema.parse>,
): AutomationReplyHandoffSettlementV1 {
    switch (result.kind) {
        case 'accepted': return { kind: 'accepted' };
        case 'retired': return { kind: 'accepted' };
        case 'suppressed': return { kind: 'suppressed' };
        case 'retry': return { kind: 'retry', retryAfterMs: result.retryAfterMs };
        case 'blocked': return { kind: 'blocked' };
    }
}

function settled(params: Readonly<{
    settlement: AutomationReplyHandoffSettlementV1;
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    receiptEnvelope?: unknown;
}>): AutomationReplyHandoffDispatchResultV1 {
    const candidate = {
        kind: 'settled' as const,
        settlement: params.settlement,
        accountCurrentness: params.accountCurrentness,
        ...(params.receiptEnvelope === undefined ? {} : { receiptEnvelope: params.receiptEnvelope }),
    };
    return AutomationReplyHandoffDispatchResultV1Schema.parse(candidate);
}

/**
 * Registers the one host-internal Conversation reply-handoff receiver. Its
 * Socket RPC method is blocked from client `CALL`; this handler verifies every
 * frozen target/correspondence fact, uses canonical Account currentness before
 * opening or invoking, and returns only coarse settlement to the server.
 */
export function registerAutomationReplyHandoffRpcHandler(
    rpc: RpcHandlerRegistrar,
    options: AutomationReplyHandoffRpcRegistrationOptions,
): void {
    const resolveCurrentTargetMaterializationId = options.resolveCurrentTargetMaterializationId
        ?? createCurrentAutomationReplyTargetMaterializationResolver();
    const acquireRuntimeLease = options.acquireRuntimeLease
        ?? acquireAuthoritativePluginRuntimeRegistryLease;
    const dispatchAction = options.executeContributedAction
        ?? executeContributedAction;

    rpc.registerHandler(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1, async (raw, context) => {
        const parsed = AutomationReplyHandoffDispatchRequestV1Schema.safeParse(raw);
        if (!parsed.success) return unavailable('invalidRequest');

        const signal = readSignal(context?.signal);
        if (signal.aborted) return unavailable('cancelled');

        const request = parsed.data;
        if (request.target.machineId !== options.machineId) {
            return unavailable('targetMismatch');
        }

        let accountId: string | null;
        let installationId: string | null;
        try {
            [accountId, installationId] = await Promise.all([
                options.resolveAccountId(signal),
                options.resolveInstallationId(),
            ]);
        } catch {
            return signal.aborted ? unavailable('cancelled') : unavailable('targetUnavailable');
        }
        if (signal.aborted) return unavailable('cancelled');
        if (
            accountId !== request.target.accountId
            || installationId !== request.target.machineInstallationId
        ) {
            return unavailable('targetMismatch');
        }

        const expectedCorrespondence = {
            accountId: request.target.accountId,
            automationId: request.handoff.automationId,
            runId: request.handoff.runId,
            handoffId: request.handoff.handoffId,
        };
        const expectedReplyContextCorrespondence = {
            automationId: request.handoff.automationId,
            occurrenceKey: request.handoff.occurrenceKey,
        };
        const encryptionAtOpen = await resolveValidatedAutomationAccountEncryptionV1({
            signal,
            resolveAccountEncryptionCurrentness: options.resolveAccountEncryptionCurrentness,
            resolveAccountEncryptionMaterial: options.resolveAccountEncryptionMaterial,
        });
        if (signal.aborted) return unavailable('cancelled');
        if (encryptionAtOpen.kind === 'unavailable') return unavailable('targetUnavailable');
        if (encryptionAtOpen.kind === 'retry') {
            return settled({
                settlement: sameAutomationAccountCurrentnessWitnessV1(
                    request.handoff.accountCurrentness,
                    encryptionAtOpen.witness,
                )
                    ? { kind: 'retry', retryAfterMs: 0 }
                    : { kind: 'staleClaim' },
                accountCurrentness: encryptionAtOpen.witness,
            });
        }
        if (!sameAutomationAccountCurrentnessWitnessV1(request.handoff.accountCurrentness, encryptionAtOpen.witness)) {
            return settled({
                settlement: { kind: 'staleClaim' },
                accountCurrentness: encryptionAtOpen.witness,
            });
        }

        const resultContent = openAutomationRunResultStoredEnvelopeV1({
            mode: encryptionAtOpen.witness.mode,
            ...(encryptionAtOpen.material ? { material: encryptionAtOpen.material.material } : {}),
            envelope: request.handoff.resultEnvelope,
        });
        const contextContent = openAutomationConversationReplyContextStoredEnvelopeV1({
            mode: encryptionAtOpen.witness.mode,
            ...(encryptionAtOpen.material ? { material: encryptionAtOpen.material.material } : {}),
            envelope: request.handoff.replyContextEnvelope,
        });
        if (
            resultContent.kind !== 'available'
            || contextContent.kind !== 'available'
            || !sameCorrespondence(resultContent.correspondence, expectedCorrespondence)
            || !sameReplyContextCorrespondence(
                contextContent.correspondence,
                expectedReplyContextCorrespondence,
            )
        ) {
            // A transition can win after the claim-time/current-open witness
            // but before content opening. Re-read before classifying an
            // unreadable claim as terminally invalid: current authority wins
            // and the server will requeue its transformed Run bytes.
            const encryptionAfterOpenFailure = await resolveValidatedAutomationAccountEncryptionV1({
                signal,
                resolveAccountEncryptionCurrentness: options.resolveAccountEncryptionCurrentness,
                resolveAccountEncryptionMaterial: options.resolveAccountEncryptionMaterial,
            });
            if (signal.aborted) return unavailable('cancelled');
            if (encryptionAfterOpenFailure.kind === 'unavailable') {
                return unavailable('targetUnavailable');
            }
            if (encryptionAfterOpenFailure.kind === 'retry') {
                return settled({
                    settlement: sameAutomationAccountCurrentnessWitnessV1(
                        request.handoff.accountCurrentness,
                        encryptionAfterOpenFailure.witness,
                    )
                        ? { kind: 'retry', retryAfterMs: 0 }
                        : { kind: 'staleClaim' },
                    accountCurrentness: encryptionAfterOpenFailure.witness,
                });
            }
            if (!sameAutomationAccountCurrentnessWitnessV1(encryptionAtOpen.witness, encryptionAfterOpenFailure.witness)) {
                return settled({
                    settlement: { kind: 'staleClaim' },
                    accountCurrentness: encryptionAfterOpenFailure.witness,
                });
            }
            return settled({
                settlement: { kind: 'blocked' },
                accountCurrentness: encryptionAfterOpenFailure.witness,
            });
        }
        const input = AutomationResultDeliveryInputV1Schema.parse({
            v: 1,
            handoffId: expectedCorrespondence.handoffId,
            runId: expectedCorrespondence.runId,
            automationId: expectedCorrespondence.automationId,
            source: {
                kind: 'automationResult',
                automationRunId: expectedCorrespondence.runId,
                resultId: expectedCorrespondence.handoffId,
                automationId: expectedCorrespondence.automationId,
                resultDelivery: 'finalResult',
            },
            result: resultContent.result,
            opaqueContext: contextContent.opaqueContext,
        });

        let lease: PluginRuntimeRegistryLease | null = null;
        try {
            const currentBeforeLease = await resolveCurrentTargetMaterializationId(
                request.target.actionRef.pluginId,
            );
            if (currentBeforeLease !== request.target.materializationId) {
                return unavailable('targetMismatch');
            }
            lease = await acquireRuntimeLease();
            if (signal.aborted) return unavailable('cancelled');

            // A lease pins the generation used for the Action. Re-read the
            // exact target after acquiring it so a reload cannot pair an old
            // registry with a newly published materialization.
            const currentAfterLease = await resolveCurrentTargetMaterializationId(
                request.target.actionRef.pluginId,
            );
            if (currentAfterLease !== request.target.materializationId) {
                return unavailable('targetMismatch');
            }

            // Currentness is re-read after content open and immediately before
            // effect. Rekey/mode movement discards the opened plaintext and
            // lets the server rejoin the same handoff without a stale receipt.
            const encryptionBeforeInvoke = await resolveValidatedAutomationAccountEncryptionV1({
                signal,
                resolveAccountEncryptionCurrentness: options.resolveAccountEncryptionCurrentness,
                resolveAccountEncryptionMaterial: options.resolveAccountEncryptionMaterial,
            });
            if (signal.aborted) return unavailable('cancelled');
            if (encryptionBeforeInvoke.kind === 'unavailable') return unavailable('targetUnavailable');
            if (
                encryptionBeforeInvoke.kind !== 'available'
                || !sameAutomationAccountCurrentnessWitnessV1(encryptionAtOpen.witness, encryptionBeforeInvoke.witness)
            ) {
                return settled({
                    settlement: { kind: 'retry', retryAfterMs: 0 },
                    accountCurrentness: encryptionBeforeInvoke.witness,
                });
            }

            const execution = await dispatchAction({
                runtimeRegistry: lease.registry,
                actionId: `${request.target.actionRef.pluginId}/${request.target.actionRef.localId}`,
                input,
                context: {
                    surface: 'plugin',
                    invocationSurface: 'background',
                    caller: {
                        kind: 'automationRun',
                        automationId: expectedCorrespondence.automationId,
                        runId: expectedCorrespondence.runId,
                        cause: request.handoff.cause,
                    },
                    signal,
                },
            });
            if (signal.aborted) return unavailable('cancelled');
            if (!execution.matched) {
                return unavailable('actionUnavailable');
            }
            if (!execution.result.ok) {
                // `notStarted` is effect-safety evidence, not proof that the
                // frozen Action contract is absent. Generation retirement,
                // connected-account binding, and other pre-handler runtime
                // failures use it and must retry. Only `matched: false` above
                // proves that this materialization has no such Action.
                return unavailable('actionExecutionFailed');
            }
            const actionResult = AutomationResultDeliveryResultV1Schema.safeParse(
                execution.result.result,
            );
            if (!actionResult.success) return unavailable('contractInvalid');

            // The pre-invocation materialization check plus retained runtime
            // lease selects A. A newly published B after the Action may not
            // overrule an already durable custody effect from A; the target
            // plugin owns that currentness/custody commit and rejoin.
            const encryptionAfterInvoke = await resolveValidatedAutomationAccountEncryptionV1({
                signal,
                resolveAccountEncryptionCurrentness: options.resolveAccountEncryptionCurrentness,
                resolveAccountEncryptionMaterial: options.resolveAccountEncryptionMaterial,
            });
            if (signal.aborted) return unavailable('cancelled');
            if (encryptionAfterInvoke.kind === 'unavailable') return unavailable('targetUnavailable');
            if (
                encryptionAfterInvoke.kind !== 'available'
                || !sameAutomationAccountContentIdentityV1(
                    encryptionAtOpen.witness,
                    encryptionAfterInvoke.witness,
                )
            ) {
                return settled({
                    settlement: { kind: 'retry', retryAfterMs: 0 },
                    accountCurrentness: encryptionAfterInvoke.witness,
                });
            }

            const receiptEnvelope = isAvailableE2eeAutomationAccountEncryptionV1(encryptionAfterInvoke)
                ? sealAutomationReplyHandoffReceiptStoredEnvelopeV1({
                    mode: 'e2ee',
                    correspondence: expectedCorrespondence,
                    result: actionResult.data,
                    // E2EE availability is returned only after the local
                    // material snapshot matched the canonical witness.
                    material: encryptionAfterInvoke.material.material,
                    randomBytes: (length) => new Uint8Array(nodeRandomBytes(length)),
                })
                : sealAutomationReplyHandoffReceiptStoredEnvelopeV1({
                    mode: 'plain',
                    correspondence: expectedCorrespondence,
                    result: actionResult.data,
                });
            return settled({
                settlement: projectSettlement(actionResult.data),
                accountCurrentness: encryptionAfterInvoke.witness,
                receiptEnvelope,
            });
        } catch {
            return signal.aborted ? unavailable('cancelled') : unavailable('actionExecutionFailed');
        } finally {
            if (lease) {
                await lease.release();
            }
        }
    });
}
