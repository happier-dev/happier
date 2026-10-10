import { sameAutomationAccountCurrentnessWitnessV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { sealAutomationRunFailureDetailStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationRunFailureDetailStoredContent';
import type { AutomationAccountCurrentnessWitnessV1 } from '@happier-dev/protocol';
import {
  isAvailableE2eeAutomationAccountEncryptionV1,
  type AvailableAutomationAccountEncryptionV1,
  type ValidatedAutomationAccountEncryptionV1,
} from '@/plugins/runtime/automations/automationAccountCurrentness';
import { getRandomBytes } from '@/api/encryption';
import { startAutomationLeaseHeartbeat } from './automationLeaseHeartbeat';
import { logAutomationWarn } from './automationTelemetry';
import type { AutomationClaimedRunPayload, AutomationV3ClaimedAutomation } from './automationTypes';
import type { createProductionWorkflowRunCoordinator } from '@/daemon/workflows/production';
import {
  WORKFLOW_AUTHORIZATION_NOT_CURRENT_ABORT_REASON,
  WORKFLOW_CANCEL_REQUESTED_ABORT_REASON,
} from '@/daemon/workflows/coordinator';

export type ClaimableRunPayload = AutomationClaimedRunPayload;

type ClaimableAutomationRunPayload = Exclude<ClaimableRunPayload, { automation: null }>;
type ClaimableV3AutomationRunPayload = Extract<
  ClaimableAutomationRunPayload,
  { protocol: 'v3'; automation: AutomationV3ClaimedAutomation }
>;
type ClaimableDirectWorkflowRunPayload = Extract<
  ClaimableRunPayload,
  { protocol: 'v3'; automation: null }
>;

function isDirectWorkflowRunClaim(
  claimed: ClaimableRunPayload,
): claimed is ClaimableDirectWorkflowRunPayload {
  return claimed.run.automationId === null;
}

type AutomationV3RunFailureSettlement = Readonly<{
  protocol: 'v3';
  runId: string;
  machineId: string;
  attempt: number;
  /** C before start or S after start; current V3 settlement always carries it. */
  accountCurrentness: AutomationAccountCurrentnessWitnessV1;
  producedSessionId?: string | null;
  errorCode: string;
  terminalState?: 'skipped';
  errorDetailEnvelope: string | null;
  errorMessage?: never;
}>;

type AutomationRunClaimClient = Readonly<{
  heartbeatRun: (params: {
    protocol: 'v3';
    runId: string;
    machineId: string;
    attempt: number;
    leaseDurationMs: number;
  }) => Promise<void>;
  failRun: (params: AutomationV3RunFailureSettlement) => Promise<void>;
}>;

type ResolveAutomationAccountEncryption = (
  signal: AbortSignal,
) => Promise<ValidatedAutomationAccountEncryptionV1>;

async function resolveMatchingAutomationCurrentness(params: Readonly<{
  signal: AbortSignal;
  expected: AutomationAccountCurrentnessWitnessV1;
  resolveAutomationAccountEncryption?: ResolveAutomationAccountEncryption;
}>): Promise<AvailableAutomationAccountEncryptionV1 | null> {
  if (!params.resolveAutomationAccountEncryption || params.signal.aborted) return null;
  let resolved: ValidatedAutomationAccountEncryptionV1;
  try {
    resolved = await params.resolveAutomationAccountEncryption(params.signal);
  } catch {
    return null;
  }
  if (params.signal.aborted || resolved.kind !== 'available') return null;
  return sameAutomationAccountCurrentnessWitnessV1(resolved.witness, params.expected)
    ? resolved
    : null;
}

/**
 * Error codes remain structural. Every direct V3 terminal detail is sealed at
 * the daemon while the matching Account material is current; an unavailable
 * material path records no detail rather than falling back to a raw string.
 */
function createV3RunFailureSettlement(params: Readonly<{
  machineId: string;
  claimed: ClaimableV3AutomationRunPayload;
  accountEncryption: AvailableAutomationAccountEncryptionV1;
  errorCode: string;
  errorMessage: string;
  producedSessionId?: string | null;
}>): AutomationV3RunFailureSettlement {
  let errorDetailEnvelope: string | null = null;
  try {
    const envelope = params.accountEncryption.witness.mode === 'plain'
      ? sealAutomationRunFailureDetailStoredEnvelopeV1({
        mode: 'plain',
        correspondence: {
          automationId: params.claimed.run.automationId,
          runId: params.claimed.run.id,
        },
        detail: params.errorMessage,
      })
      : isAvailableE2eeAutomationAccountEncryptionV1(params.accountEncryption)
        ? sealAutomationRunFailureDetailStoredEnvelopeV1({
          mode: 'e2ee',
          correspondence: {
            automationId: params.claimed.run.automationId,
            runId: params.claimed.run.id,
          },
          detail: params.errorMessage,
          material: params.accountEncryption.material.material,
          randomBytes: getRandomBytes,
        })
        : null;
    errorDetailEnvelope = envelope === null ? null : JSON.stringify(envelope);
  } catch {
    // A rejected bounded/private detail does not change the structural Run
    // failure or create a raw-compatible fallback transport.
  }
  return {
    protocol: 'v3',
    runId: params.claimed.run.id,
    machineId: params.machineId,
    attempt: params.claimed.run.attempt,
    accountCurrentness: params.accountEncryption.witness,
    ...(params.producedSessionId === undefined ? {} : { producedSessionId: params.producedSessionId }),
    errorCode: params.errorCode,
    errorDetailEnvelope,
  };
}

async function failV3ClaimedRunBeforeStart(params: Readonly<{
  machineId: string;
  claimed: ClaimableV3AutomationRunPayload;
  claimClient: AutomationRunClaimClient;
  signal: AbortSignal;
  isCurrent: () => boolean;
  resolveAutomationAccountEncryption?: ResolveAutomationAccountEncryption;
  errorCode: string;
  terminalState?: 'skipped';
  errorMessage: string;
}>): Promise<void> {
  if (!params.isCurrent()) return;
  const currentness = await resolveMatchingAutomationCurrentness({
    signal: params.signal,
    expected: params.claimed.accountCurrentness,
    resolveAutomationAccountEncryption: params.resolveAutomationAccountEncryption,
  });
  if (!currentness || !params.isCurrent()) return;
  await params.claimClient.failRun({
    ...createV3RunFailureSettlement({
      machineId: params.machineId,
      claimed: params.claimed,
      accountEncryption: currentness,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
    }),
    ...(params.terminalState !== undefined ? { terminalState: params.terminalState } : {}),
  });
}

export async function executeClaimedRun(params: {
  machineId: string;
  claimClient: AutomationRunClaimClient;
  heartbeatMs: number;
  leaseDurationMs: number;
  /** Canonical Account-currentness/material owner for private admission diagnostics. */
  resolveAutomationAccountEncryption?: ResolveAutomationAccountEncryption;
  /** Worker-owned currentness signal for this exact claimed Run attempt. */
  signal?: AbortSignal;
  /** Origin-neutral workflow coordinator supplied by daemon bootstrap. */
  coordinateWorkflowRun?: ReturnType<typeof createProductionWorkflowRunCoordinator>;
  registerReviewHoldRefresh?: Parameters<ReturnType<typeof createProductionWorkflowRunCoordinator>>[0]['registerReviewHoldRefresh'];
  acquireMachineStartCapacity?: Parameters<ReturnType<typeof createProductionWorkflowRunCoordinator>>[0]['acquireMachineStartCapacity'];
  claimed: ClaimableRunPayload;
}): Promise<void> {
  const {
    machineId,
    claimClient,
    heartbeatMs,
    leaseDurationMs,
    claimed,
  } = params;
  const attempt = claimed.run.attempt;

  const executionController = new AbortController();
  let heartbeat: ReturnType<typeof startAutomationLeaseHeartbeat> | null = null;
  let workflowAuthorizationCurrentnessCheck: ((signal?: AbortSignal) => Promise<boolean>) | null = null;
  let workflowControlCheck: (() => Promise<'running' | 'pause_requested' | 'cancel_requested'>) | null = null;
  const abortExecution = (reason?: unknown) => {
    heartbeat?.stop();
    if (!executionController.signal.aborted) {
      executionController.abort(reason);
    }
  };
  const abortFromWorker = () => abortExecution(params.signal?.reason);
  if (params.signal?.aborted) {
    abortExecution(params.signal.reason);
  } else {
    params.signal?.addEventListener('abort', abortFromWorker, { once: true });
  }
  const isCurrent = () => !executionController.signal.aborted;
  const claimedAutomationId = claimed.run.automationId;

  try {
    if (!isCurrent()) return;
    // Workflow admission and execution remain covered by this exact claim lease.
    heartbeat = startAutomationLeaseHeartbeat({
      heartbeatMs,
      onHeartbeat: async () => {
        await claimClient.heartbeatRun({
          protocol: claimed.protocol,
          runId: claimed.run.id,
          machineId,
          attempt,
          leaseDurationMs,
        });
        if (workflowAuthorizationCurrentnessCheck
          && !await workflowAuthorizationCurrentnessCheck(executionController.signal)) {
          abortExecution(WORKFLOW_AUTHORIZATION_NOT_CURRENT_ABORT_REASON);
        }
        if (workflowControlCheck && await workflowControlCheck() === 'cancel_requested') {
          abortExecution(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
        }
      },
      onError: (error) => {
        abortExecution();
        logAutomationWarn('Lease heartbeat failed', error, {
          runId: claimed.run.id,
          automationId: claimedAutomationId,
        });
      },
    });

    try {
      if (isDirectWorkflowRunClaim(claimed)) {
        if (!params.coordinateWorkflowRun) throw new Error('Workflow Run coordinator is unavailable');
        await params.coordinateWorkflowRun({
          runId: claimed.run.id,
          attempt: claimed.run.attempt,
          expectedRevision: claimed.run.revision,
          ...(claimed.run.workflowResumeRequestedRevision === undefined ? {} : {
            workflowResumeRequestedRevision: claimed.run.workflowResumeRequestedRevision,
          }),
          accountCurrentness: claimed.accountCurrentness,
          acceptedEnvelope: claimed.run.workflowAcceptedSnapshotEnvelope,
          registerAuthorizationCurrentnessCheck: (check) => {
            workflowAuthorizationCurrentnessCheck = check;
          },
          registerControlCheck: (check) => {
            workflowControlCheck = check;
          },
          registerReviewHoldRefresh: params.registerReviewHoldRefresh,
          acquireMachineStartCapacity: params.acquireMachineStartCapacity,
          signal: executionController.signal,
        });
        return;
      }
      if (claimed.run.recipeKind === 'workflow-v2'
        || (claimed.run.recipeKind === 'legacy' && claimed.run.executionInputEnvelope !== null)) {
        if (claimed.run.executionInputEnvelope === null || !params.coordinateWorkflowRun) {
          throw new Error('Workflow Run coordinator is unavailable');
        }
        const result = await params.coordinateWorkflowRun({
          runId: claimed.run.id,
          automationId: claimed.run.automationId,
          attempt: claimed.run.attempt,
          expectedRevision: claimed.run.revision,
          ...(claimed.run.workflowResumeRequestedRevision === undefined ? {} : {
            workflowResumeRequestedRevision: claimed.run.workflowResumeRequestedRevision,
          }),
          accountCurrentness: claimed.accountCurrentness,
          definitionEnvelope: claimed.run.executionInputEnvelope,
          acceptedEnvelope: claimed.run.workflowAcceptedSnapshotEnvelope,
          workflowDefinitionId: claimed.automation.workflowDefinitionId,
          scopeSessionId: claimed.automation.scopeSessionId,
          causeWorkDepth: claimed.run.causeWorkDepth,
          lastSucceededRun: claimed.run.lastSucceededRun,
          automationEvidenceEnvelope: claimed.run.automationEvidenceEnvelope,
          automationCause: claimed.run.cause,
          registerAuthorizationCurrentnessCheck: (check) => {
            workflowAuthorizationCurrentnessCheck = check;
          },
          registerControlCheck: (check) => {
            workflowControlCheck = check;
          },
          registerReviewHoldRefresh: params.registerReviewHoldRefresh,
          acquireMachineStartCapacity: params.acquireMachineStartCapacity,
          signal: executionController.signal,
        });
        if ('admission' in result && result.admission === 'refused') {
          await failV3ClaimedRunBeforeStart({
            machineId, claimed, claimClient, signal: executionController.signal, isCurrent,
            resolveAutomationAccountEncryption: params.resolveAutomationAccountEncryption,
            errorCode: result.reason,
            ...(result.state === 'skipped' ? { terminalState: 'skipped' as const } : {}),
            errorMessage: `Workflow trigger admission refused: ${result.reason}${result.blockId === undefined ? '' : ` (block ${result.blockId})`}`,
          });
        }
        return;
      }
      // Definitions convert through the Account owner. Already-frozen ordinary
      // predecessor input enters that same Workflow admission owner above;
      // unsupported historical shapes never gain a second execution authority.
      await failV3ClaimedRunBeforeStart({
        machineId, claimed, claimClient, signal: executionController.signal, isCurrent,
        resolveAutomationAccountEncryption: params.resolveAutomationAccountEncryption,
        errorCode: 'invalid_template',
        errorMessage: 'Automation Run requires a Workflow execution recipe',
      });
    } catch (error) {
      // The canonical Workflow lifecycle owns target outcomes and recovery.
      // A failed dispatch leaves the incumbent lease available for reclaim.
      if (isCurrent()) {
        logAutomationWarn('Workflow Run execution failed before a proven terminal outcome', error, {
          runId: claimed.run.id,
          automationId: claimedAutomationId,
        });
      }
    }
  } finally {
    heartbeat?.stop();
    params.signal?.removeEventListener('abort', abortFromWorker);
  }
}
