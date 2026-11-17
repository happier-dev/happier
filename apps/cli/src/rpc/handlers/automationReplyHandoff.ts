import { AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1, AutomationReplyHandoffDispatchRequestV1Schema, AutomationReplyHandoffDispatchResultV1Schema } from '@happier-dev/protocol/automations/event';
import { AutomationResultDeliveryInputV1Schema, AutomationResultDeliveryResultV1Schema } from '@happier-dev/protocol/automations/result-delivery';
import { isAutomationReplyHandoffIdForRunV1 } from '@happier-dev/protocol/automations/automationReplyHandoffIdentityV1';
import { openAutomationConversationReplyContextStoredEnvelopeV1, openAutomationRunResultStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationReplyHandoffStoredContent';
import { sameAutomationAccountContentIdentityV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import type { AccountEncryptionCurrentnessResponse, AccountScopedCryptoMaterialSnapshotV1, AutomationAccountCurrentnessWitnessV1, AutomationConversationReplyContextCorrespondenceV1, AutomationReplyHandoffDispatchResultV1, AutomationReplyHandoffSettlementV1, AutomationRunResultCorrespondenceV1 } from '@happier-dev/protocol';
import { openWorkflowFinalResultStoredEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { resolveWorkflowRunDataKeyV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import type { WorkflowRunRecipientCensusResponseV1 } from '@happier-dev/protocol/workflows';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { createWorkflowRunStorageClient } from '@/daemon/workflows/workflowRunStorageClient';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import {
    resolveValidatedAutomationAccountEncryptionV1,
} from '@/plugins/runtime/automations/automationAccountCurrentness';

type AutomationReplyHandoffActionExecutor = typeof executeContributedAction;

export type AutomationReplyHandoffRpcRegistrationOptions = Readonly<{
    /** The exact authenticated Machine hosting this daemon connection. */
    machineId: string;
    /** Canonical authenticated Run storage; Workflow results never use Account content keys. */
    workflowRunStorage: Pick<ReturnType<typeof createWorkflowRunStorageClient>, 'execute'>;
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
    acquireRuntimeLease?: () => Promise<PluginRuntimeRegistryLease>;
    executeContributedAction?: AutomationReplyHandoffActionExecutor;
}>;

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
        // The sealed result belongs to a Run, and its delivery identity is the
        // one thing about that Run a present user can deliberately advance: an
        // authorized further delivery dispatches the Run's next identity while
        // the frozen envelope still carries the identity it was sealed under.
        // Requiring byte equality alone would make that decision undeliverable,
        // so a sealed identity that provably belongs to this exact Run is
        // accepted too. Account, Automation and Run stay exact either way.
        && (
            value.handoffId === expected.handoffId
            || isAutomationReplyHandoffIdForRunV1({
                runId: expected.runId,
                handoffId: value.handoffId,
            })
        );
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
}>): AutomationReplyHandoffDispatchResultV1 {
    return AutomationReplyHandoffDispatchResultV1Schema.parse({
        kind: 'settled' as const,
        settlement: params.settlement,
        accountCurrentness: params.accountCurrentness,
    });
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
    const acquireRuntimeLease = options.acquireRuntimeLease
        ?? acquireAuthoritativePluginRuntimeRegistryLease;
    const dispatchAction = options.executeContributedAction
        ?? executeContributedAction;

    rpc.registerHandler(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1, async (raw, context) => {
        const reportFailure = (failedPhase: string, error: unknown) => context?.reportOperationDiagnostics?.({
            failedPhase,
            causeCode: readActionErrorCodeV1(error) ?? 'action_failed',
            phaseDurationsMs: {},
            phaseTimingsMs: [],
        });
        const unavailable = (
            code: Extract<AutomationReplyHandoffDispatchResultV1, { kind: 'unavailable' }>['code'],
            failure?: Readonly<{ phase: string; error: unknown }>,
        ): AutomationReplyHandoffDispatchResultV1 => {
            reportFailure(failure?.phase ?? 'automationReplyHandoff', failure?.error ?? { code });
            return { kind: 'unavailable', code };
        };
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
                settlement: sameAutomationAccountContentIdentityV1(
                    request.handoff.accountCurrentness,
                    encryptionAtOpen.witness,
                )
                    ? { kind: 'retry', retryAfterMs: 0 }
                    : { kind: 'staleClaim' },
                accountCurrentness: encryptionAtOpen.witness,
            });
        }
        if (!sameAutomationAccountContentIdentityV1(request.handoff.accountCurrentness, encryptionAtOpen.witness)) {
            return settled({
                settlement: { kind: 'staleClaim' },
                accountCurrentness: encryptionAtOpen.witness,
            });
        }

        const recipeKind = request.handoff.recipeKind ?? 'legacy';
        let workflowCensus: WorkflowRunRecipientCensusResponseV1 | null = null;
        if (recipeKind === 'workflow-v2') {
            try {
                workflowCensus = WorkflowRunRecipientCensusResponseV1Schema.parse(
                    await options.workflowRunStorage.execute(
                        { operation: 'run-key.census', runId: request.handoff.runId },
                        { signal },
                    ),
                );
            } catch {
                return signal.aborted ? unavailable('cancelled') : unavailable('targetUnavailable');
            }
            if (signal.aborted) return unavailable('cancelled');
            if (workflowCensus.runId !== request.handoff.runId || workflowCensus.ownerAccountId !== accountId) {
                return unavailable('targetMismatch');
            }
            if (!sameAutomationAccountContentIdentityV1(
                workflowCensus.ownerAccountCurrentness,
                encryptionAtOpen.witness,
            )) {
                return settled({
                    settlement: { kind: 'retry', retryAfterMs: 0 },
                    accountCurrentness: encryptionAtOpen.witness,
                });
            }
        }
        // Each recipe opens a different envelope and proves its correspondence
        // differently: the workflow-v2 binding seals the Account and Run into the
        // envelope, while a legacy envelope carries the correspondence as opened
        // content that still has to match the claim. Both settle into the one
        // result the delivery input consumes, so the recipe is decided once here
        // instead of being re-narrowed at every later read.
        const resultContent = recipeKind === 'workflow-v2'
            ? (() => {
                if (!workflowCensus) return { kind: 'unavailable' as const, causeCode: 'targetUnavailable' };
                const resolved = resolveWorkflowRunDataKeyV1({ encryption: encryptionAtOpen, census: workflowCensus });
                if (resolved.kind !== 'available') return { kind: 'unavailable' as const, causeCode: resolved.reason };
                const opened = openWorkflowFinalResultStoredEnvelopeV1({
                    ...resolved.encryption.runCrypto,
                    binding: { v: 1, purpose: 'final_result', accountId: workflowCensus.ownerAccountId, runId: request.handoff.runId },
                    envelope: request.handoff.resultEnvelope,
                });
                if (opened.kind !== 'available') return { kind: 'unavailable' as const, causeCode: opened.kind };
                return opened.content.result.kind === 'text'
                    ? { kind: 'available' as const, result: { v: 1 as const, kind: 'text' as const, text: opened.content.result.value } }
                    : { kind: 'unavailable' as const, causeCode: 'contractInvalid' };
            })()
            : (() => {
                const opened = openAutomationRunResultStoredEnvelopeV1({
                    mode: encryptionAtOpen.witness.mode,
                    ...(encryptionAtOpen.material ? { material: encryptionAtOpen.material.material } : {}),
                    envelope: request.handoff.resultEnvelope,
                });
                if (opened.kind !== 'available') return { kind: 'unavailable' as const, causeCode: opened.kind };
                return sameCorrespondence(opened.correspondence, expectedCorrespondence)
                    ? { kind: 'available' as const, result: opened.result }
                    : { kind: 'unavailable' as const, causeCode: 'targetMismatch' };
            })();
        const contextContent = openAutomationConversationReplyContextStoredEnvelopeV1({
            mode: encryptionAtOpen.witness.mode,
            ...(encryptionAtOpen.material ? { material: encryptionAtOpen.material.material } : {}),
            envelope: request.handoff.replyContextEnvelope,
        });
        if (
            resultContent.kind !== 'available'
            || contextContent.kind !== 'available'
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
                    settlement: sameAutomationAccountContentIdentityV1(
                        request.handoff.accountCurrentness,
                        encryptionAfterOpenFailure.witness,
                    )
                        ? { kind: 'retry', retryAfterMs: 0 }
                        : { kind: 'staleClaim' },
                    accountCurrentness: encryptionAfterOpenFailure.witness,
                });
            }
            if (!sameAutomationAccountContentIdentityV1(encryptionAtOpen.witness, encryptionAfterOpenFailure.witness)) {
                return settled({
                    settlement: { kind: 'staleClaim' },
                    accountCurrentness: encryptionAfterOpenFailure.witness,
                });
            }
            if (resultContent.kind !== 'available') {
                reportFailure('resultOpen', { code: resultContent.causeCode });
            } else if (contextContent.kind !== 'available') {
                reportFailure('replyContextOpen', { code: contextContent.kind });
            } else {
                reportFailure('replyContextCorrespondence', { code: 'targetMismatch' });
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
            lease = await acquireRuntimeLease();
            if (signal.aborted) return unavailable('cancelled');

            // The runtime owns both installed and daemon-selected targets.
            // Match the serving lease and its currently published owner so a
            // reload cannot substitute another materialization for the frozen one.
            const pluginId = request.target.actionRef.pluginId;
            await lease.registry.activateContributionsOnDemand([{
                pluginId,
                family: 'actions',
                localId: request.target.actionRef.localId,
            }]);
            const materializations = [
                lease.registry.resolveCurrentPluginMaterializationRef?.(pluginId),
                lease.resolveCurrentPluginMaterializationRef?.(pluginId),
            ];
            if (materializations.some((materialization) => (
                !materialization
                || materialization.machineId !== request.target.machineId
                || materialization.pluginId !== pluginId
                || materialization.materializationId !== request.target.materializationId
            ))) {
                return unavailable('targetMismatch');
            }

            // Currentness is re-read after content open and immediately before
            // effect. Rekey/mode movement discards the opened plaintext and
            // lets the server rejoin the same handoff on its current bytes.
            const encryptionBeforeInvoke = await resolveValidatedAutomationAccountEncryptionV1({
                signal,
                resolveAccountEncryptionCurrentness: options.resolveAccountEncryptionCurrentness,
                resolveAccountEncryptionMaterial: options.resolveAccountEncryptionMaterial,
            });
            if (signal.aborted) return unavailable('cancelled');
            if (encryptionBeforeInvoke.kind === 'unavailable') return unavailable('targetUnavailable');
            if (
                encryptionBeforeInvoke.kind !== 'available'
                || !sameAutomationAccountContentIdentityV1(encryptionAtOpen.witness, encryptionBeforeInvoke.witness)
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
                return unavailable('actionExecutionFailed', { phase: 'actionExecution', error: execution.result });
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

            // Custody ids, suppression reasons and provider detail stay with
            // the Channels Action that produced them. The server only needs
            // the coarse settlement plus the post-effect Account witness.
            if (actionResult.data.kind === 'blocked') {
                reportFailure('resultDelivery', { code: actionResult.data.code });
            }
            return settled({
                settlement: projectSettlement(actionResult.data),
                accountCurrentness: encryptionAfterInvoke.witness,
            });
        } catch (error) {
            return unavailable(signal.aborted ? 'cancelled' : 'actionExecutionFailed', {
                phase: 'automationReplyHandoff', error,
            });
        } finally {
            if (lease) {
                await lease.release();
            }
        }
    });
}
