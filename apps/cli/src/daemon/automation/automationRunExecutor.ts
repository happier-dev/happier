import type {
  SpawnSessionErrorCode,
  SpawnSessionOptions,
  SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import type { StoredCredentials } from '@/persistence';
import type {
  SessionServerStartDispatchResultV1,
  SessionServerStartIngressRequestV1,
} from '@happier-dev/protocol';
import {
  AutomationAccountCurrentnessWitnessV1Schema,
  AutomationRunExecutionInputV1Schema,
  ExecutionRunStartResponseSchema,
  ExecutionRunStopResponseSchema,
  materializeAutomationRunExecutionRecipeV1,
  sealAutomationRunResultStoredEnvelopeV1,
  sealAutomationRunFailureDetailStoredEnvelopeV1,
  sealAutomationSessionStartRequestEnvelopeV1,
  openAccountScopedBlobCiphertext,
  parseAutomationRunExecutionRecipeV1,
  readExecutionRunStartRunCreation,
  sameAutomationAccountCurrentnessWitnessV1,
  toAutomationRunExecutionInputV1Origin,
  validateAutomationRunExecutionRecipeOuterV1,
  readAutomationTemplateStoredEnvelopeV1,
  type AutomationAccountCurrentnessWitnessV1,
  type AutomationRunCause,
  type AutomationRunExecutionInputV1,
  type AutomationRunExecutionRecipeV1,
  type AutomationV3WorkerExecutionDispatchOutcome,
  type AutomationV3WorkerResultDelivery,
} from '@happier-dev/protocol';

import {
  isAvailableE2eeAutomationAccountEncryptionV1,
  type AvailableAutomationAccountEncryptionV1,
  type ValidatedAutomationAccountEncryptionV1,
} from '@/plugins/runtime/automations/automationAccountCurrentness';
import { getRandomBytes } from '@/api/encryption';
import * as sessionMessageService from '@/session/services/sendSessionMessage';
import { startAutomationLeaseHeartbeat } from './automationLeaseHeartbeat';
import {
  discardAutomationPromptAfterRunCancellation,
  enqueueAutomationPrompt,
} from './automationPendingQueueClient';
import { isAuthoritativeAutomationRunCancellation } from './automationRunCancellation';
import { runAutomationAgainstExistingSession } from './automationRunExistingSession';
import { runAutomationAsNewSession } from './automationRunNewSession';
import { resolveAutomationTemplateRetainedSession } from './automationRetainedSession';
import {
  parseAutomationTemplateExecution,
  type ParsedAutomationExecution,
} from './automationTemplateExecution';
import { logAutomationWarn } from './automationTelemetry';
import type {
  AutomationClaimedRunPayload,
  AutomationV3ClaimedAutomation,
} from './automationTypes';
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

const EXISTING_SESSION_MACHINE_UNAVAILABLE_ERROR_CODES = new Set<SpawnSessionErrorCode>([
  'CHILD_EXITED_BEFORE_WEBHOOK',
  'SESSION_WEBHOOK_TIMEOUT',
  'SPAWN_FAILED',
]);

function normalizeRunFailure(params: {
  targetType: 'new_session' | 'existing_session';
  errorCode: SpawnSessionErrorCode;
  errorMessage: string;
}): { errorCode: string; errorMessage: string } {
  if (
    params.targetType === 'existing_session'
    && EXISTING_SESSION_MACHINE_UNAVAILABLE_ERROR_CODES.has(params.errorCode)
  ) {
    return {
      errorCode: 'existing_session_unavailable_on_machine',
      errorMessage: `Existing-session automation could not run on this machine: ${params.errorMessage}`,
    };
  }

  return {
    errorCode: params.errorCode,
    errorMessage: params.errorMessage,
  };
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
  startRun: (params: {
    protocol: 'v3';
    runId: string;
    machineId: string;
    attempt: number;
    /** Claim Account currentness. */
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
  }) => Promise<AutomationAccountCurrentnessWitnessV1 | null | void>;
  heartbeatRun: (params: {
    protocol: 'v3';
    runId: string;
    machineId: string;
    attempt: number;
    leaseDurationMs: number;
  }) => Promise<void>;
  succeedRun: (params: {
    protocol: 'v3';
    runId: string;
    machineId: string;
    attempt: number;
    /** Start Account currentness. */
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    producedSessionId?: string | null;
    resultEnvelope?: string | null;
  }) => Promise<void>;
  failRun: (params: AutomationV3RunFailureSettlement) => Promise<void>;
  settleExecutionDispatch?: (params: {
    protocol: 'v3';
    runId: string;
    machineId: string;
    attempt: number;
    accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    outcome: AutomationV3WorkerExecutionDispatchOutcome;
  }) => Promise<void>;
}>;

type ExecuteAutomationAction = (
  actionId: 'execution.run.start' | 'execution.run.stop',
  input: unknown,
  context: Readonly<{
    signal: AbortSignal;
    actionRequestId: string;
    executionRunTargetMachineId: string;
    actionCaller: Readonly<{
      kind: 'automationRun';
      runId: string;
      automationId: string;
      cause: AutomationRunCause;
    }>;
  }>,
) => Promise<
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>
>;

type ResolveAutomationAccountEncryption = (
  signal: AbortSignal,
) => Promise<ValidatedAutomationAccountEncryptionV1>;

type DispatchSessionServerStart = (
  request: SessionServerStartIngressRequestV1,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<SessionServerStartDispatchResultV1>;

type AutomationMachineAdmissionTransport = NonNullable<
  Parameters<typeof sessionMessageService.sendSessionMessage>[0]['machineAdmissionTransport']
>;

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

/**
 * The Automation worker only seals a Session-derived final text after the
 * Session owner has bounded and correlated it to the deterministic input. The
 * outer Run settlement remains the sole terminality owner.
 */
function createV3RunFinalResultEnvelope(params: Readonly<{
  claimed: ClaimableV3AutomationRunPayload;
  accountEncryption: AvailableAutomationAccountEncryptionV1;
  resultDelivery: AutomationV3WorkerResultDelivery;
  text: string;
}>): string | null {
  try {
    const correspondence = {
      accountId: params.resultDelivery.accountId,
      automationId: params.claimed.run.automationId,
      runId: params.claimed.run.id,
      handoffId: params.resultDelivery.handoffId,
    };
    const envelope = params.accountEncryption.witness.mode === 'plain'
      ? sealAutomationRunResultStoredEnvelopeV1({
        mode: 'plain',
        correspondence,
        result: { v: 1, kind: 'text', text: params.text },
      })
      : isAvailableE2eeAutomationAccountEncryptionV1(params.accountEncryption)
        ? sealAutomationRunResultStoredEnvelopeV1({
          mode: 'e2ee',
          correspondence,
          result: { v: 1, kind: 'text', text: params.text },
          material: params.accountEncryption.material.material,
          randomBytes: getRandomBytes,
        })
        : null;
    return envelope === null ? null : JSON.stringify(envelope);
  } catch {
    // The canonical stored-content owner rejects malformed or oversized data.
    // Never fall back to a raw Session result at this private worker seam.
    return null;
  }
}

/**
 * A wait budget is a non-terminal observation: a later lease/rejoin reads the
 * same stable localId. Only exact Session terminal evidence may fail the Run.
 */
async function settleStrictV3SessionFinalResult(params: Readonly<{
  credentials: StoredCredentials | undefined;
  claimed: ClaimableV3AutomationRunPayload;
  accountEncryption: AvailableAutomationAccountEncryptionV1;
  resultDelivery: AutomationV3WorkerResultDelivery;
  sessionId: string;
  localId: string;
  timeoutMs: number;
  isCurrent: () => boolean;
  succeed: (resultEnvelope: string) => Promise<void>;
  fail: (errorCode: string, errorMessage: string) => Promise<void>;
}>): Promise<void> {
  if (!params.credentials || !params.isCurrent()) {
    if (params.isCurrent()) {
      await params.fail(
        'session_result_credentials_unavailable',
        'Automation final-result delivery requires daemon Session credentials',
      );
    }
    return;
  }

  let observed: Awaited<ReturnType<typeof sessionMessageService.waitForSessionInputResult>>;
  try {
    observed = await sessionMessageService.waitForSessionInputResult({
      credentials: params.credentials,
      idOrPrefix: params.sessionId,
      localId: params.localId,
      timeoutMs: params.timeoutMs,
    });
  } catch {
    // A read failure has no terminal Session evidence. Lease recovery rejoins
    // the same admitted input instead of manufacturing an Automation result.
    return;
  }
  if (!params.isCurrent()) return;

  if (!observed.ok) {
    switch (observed.code) {
      case 'session_not_found':
      case 'session_id_ambiguous':
      case 'unsupported':
      case 'invalid_local_id':
        await params.fail(
          `session_result_${observed.code}`,
          `Automation final-result Session read cannot continue: ${observed.code}`,
        );
        return;
      case 'session_lookup_timeout':
      case 'encryption_material_unavailable':
      case 'cancelled':
      case 'result_read_failed':
        return;
    }
  }

  // A prefix resolution or stale local identity must not settle a different
  // Session turn, even if it produced a valid final text.
  if (observed.sessionId !== params.sessionId || observed.localId !== params.localId) {
    return;
  }

  if (observed.result.kind === 'pending') return;
  if (observed.result.kind === 'failed' || observed.result.kind === 'cancelled') {
    await params.fail(
      observed.result.kind === 'failed' ? 'session_turn_failed' : 'session_turn_cancelled',
      observed.result.message,
    );
    return;
  }
  if (observed.result.kind === 'terminal_no_result') {
    await params.fail(
      'session_final_result_missing',
      'Session turn completed without a final assistant text result',
    );
    return;
  }

  const resultEnvelope = createV3RunFinalResultEnvelope({
    claimed: params.claimed,
    accountEncryption: params.accountEncryption,
    resultDelivery: params.resultDelivery,
    text: observed.result.text,
  });
  if (resultEnvelope === null) {
    await params.fail(
      'session_final_result_envelope_unavailable',
      'Automation final-result envelope could not be sealed',
    );
    return;
  }

  try {
    await params.succeed(resultEnvelope);
  } catch {
    // A lost settle response is not evidence of failure. The server’s single
    // Run settlement remains authoritative and a later claim reuses localId.
  }
}

/**
 * A V3 Run can be terminalized before start only under the exact claim
 * witness. This is deliberately separate from S-based settlement: a failed
 * parse or open has not authorized a target effect or a running transition.
 */
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

type StrictRecipeContentReadResult =
  | Readonly<{ kind: 'available'; openedContent?: Readonly<{ template: unknown; triggerEvidence: unknown | null }> }>
  | Readonly<{ kind: 'contentInvalid' }>
  | Readonly<{ kind: 'materialUnavailable' }>;

/**
 * Protocol owns strict recipe parsing/materialization; this narrow daemon
 * helper owns only ciphertext opening after the canonical Account-currentness
 * owner has admitted the exact witness and local material.
 */
function openStrictRecipeContent(params: Readonly<{
  recipe: AutomationRunExecutionRecipeV1;
  accountEncryption: AvailableAutomationAccountEncryptionV1;
}>): StrictRecipeContentReadResult {
  const outer = validateAutomationRunExecutionRecipeOuterV1({
    recipe: params.recipe,
    accountCurrentness: params.accountEncryption.witness,
  });
  if (outer.kind !== 'available') return { kind: 'contentInvalid' };
  if (outer.recipe.template.t === 'plain') return { kind: 'available' };
  if (!isAvailableE2eeAutomationAccountEncryptionV1(params.accountEncryption)) {
    return { kind: 'materialUnavailable' };
  }

  try {
    const template = openAccountScopedBlobCiphertext({
      kind: 'automation_template_payload',
      material: params.accountEncryption.material.material,
      ciphertext: outer.recipe.template.c,
    });
    if (!template) return { kind: 'contentInvalid' };

    const triggerEvidence = outer.recipe.triggerEvidence === null
      ? null
      : outer.recipe.triggerEvidence.t !== 'encrypted'
        ? null
        : openAccountScopedBlobCiphertext({
        kind: 'automation_trigger_evidence',
        material: params.accountEncryption.material.material,
        ciphertext: outer.recipe.triggerEvidence.c,
      });
    if (outer.recipe.triggerEvidence !== null && !triggerEvidence) {
      return { kind: 'contentInvalid' };
    }
    return {
      kind: 'available',
      openedContent: {
        template: template.value,
        triggerEvidence: triggerEvidence?.value ?? null,
      },
    };
  } catch {
    return { kind: 'contentInvalid' };
  }
}

function parseRetainedTemplateExecutionInputForClaim(params: Readonly<{
  raw: string | null;
  cause: AutomationRunCause;
}>): AutomationRunExecutionInputV1 | null {
  if (params.raw === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(params.raw);
  } catch {
    return null;
  }
  const parsed = AutomationRunExecutionInputV1Schema.safeParse(raw);
  if (!parsed.success) return null;

  const expectedOrigin = toAutomationRunExecutionInputV1Origin(params.cause);
  if (!expectedOrigin || expectedOrigin.kind !== parsed.data.origin.kind) return null;
  if (
    expectedOrigin.kind === 'manual'
    && parsed.data.origin.kind === 'manual'
    && expectedOrigin.invokedAt !== parsed.data.origin.invokedAt
  ) return null;
  if (
    expectedOrigin.kind === 'scheduled'
    && parsed.data.origin.kind === 'scheduled'
    && expectedOrigin.scheduledFor !== parsed.data.origin.scheduledFor
  ) return null;
  return parsed.data;
}

async function executeParsedAutomationTemplate(params: Readonly<{
  credentials?: StoredCredentials;
  machineId: string;
  claimed: ClaimableAutomationRunPayload;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  machineAdmissionTransport?: AutomationMachineAdmissionTransport;
  signal: AbortSignal;
  isCurrent: () => boolean;
  template: ParsedAutomationExecution;
  /** Rechecks Account currentness before every retained-template target effect. */
  beforeTargetEffect: () => Promise<boolean>;
  onPromptSessionId: (sessionId: string) => void;
  /** Observes the one canonical new-Session result for the incumbent fallback owner. */
  onProducedNewSessionId?: (sessionId: string) => void;
  /**
   * The incumbent Run settlement remains terminality owner. A known new
   * Session id is evidence of a completed create, even when its first input
   * cannot be admitted or cancellation wins afterwards.
   */
  fail: (errorCode: string, errorMessage: string, producedSessionId?: string | null) => Promise<void>;
  succeed: (producedSessionId?: string | null) => Promise<void>;
}>): Promise<void> {
  const { template } = params;
  const existingSessionTemplate = {
    ...template,
    existingSessionId: template.existingSessionId!,
  };
  const newSessionTemplate = { ...template };

  if (!params.isCurrent() || !await params.beforeTargetEffect()) return;
  const spawnResult = template.targetType === 'existing_session'
    ? await runAutomationAgainstExistingSession({
      spawnSession: params.spawnSession,
      template: existingSessionTemplate,
    })
    : await runAutomationAsNewSession({
      spawnSession: params.spawnSession,
      runId: params.claimed.run.id,
      template: newSessionTemplate,
    });

  if (spawnResult.type === 'success') {
    const producedSessionId = template.targetType === 'new_session'
      && typeof spawnResult.sessionId === 'string'
      && spawnResult.sessionId.trim().length > 0
      ? spawnResult.sessionId.trim()
      : undefined;
    if (producedSessionId) {
      params.onProducedNewSessionId?.(producedSessionId);
    }
    const preserveKnownNewSessionAfterAuthoritativeCancellation = async (): Promise<void> => {
      if (!producedSessionId || !isAuthoritativeAutomationRunCancellation(params.signal)) return;
      await params.fail(
        'session_start_cancelled_after_create',
        'Automation Run cancellation won after the canonical Session result was known',
        producedSessionId,
      );
    };

    if (!params.isCurrent()) {
      await preserveKnownNewSessionAfterAuthoritativeCancellation();
      return;
    }

    const prompt = typeof template.prompt === 'string' ? template.prompt.trim() : '';
    if (prompt) {
      if (!params.isCurrent()) {
        await preserveKnownNewSessionAfterAuthoritativeCancellation();
        return;
      }
      if (!await params.beforeTargetEffect()) {
        if (!params.isCurrent()) {
          await preserveKnownNewSessionAfterAuthoritativeCancellation();
        }
        return;
      }
      const promptSessionId = template.targetType === 'existing_session'
        ? template.existingSessionId!.trim()
        : producedSessionId ?? '';
      if (!promptSessionId) {
        await params.fail(
          'prompt_delivery_failed',
          'spawned session id is unavailable for first-turn delivery',
        );
        return;
      }
      if (!params.machineAdmissionTransport) {
        await params.fail(
          'prompt_delivery_failed',
          'automation prompt delivery requires authenticated machine admission',
          producedSessionId,
        );
        return;
      }
      if (!params.credentials) {
        await params.fail(
          'prompt_delivery_failed',
          'automation prompt delivery requires daemon Session credentials',
          producedSessionId,
        );
        return;
      }

      try {
        if (!params.isCurrent()) {
          await preserveKnownNewSessionAfterAuthoritativeCancellation();
          return;
        }
        if (!await params.beforeTargetEffect()) {
          if (!params.isCurrent()) {
            await preserveKnownNewSessionAfterAuthoritativeCancellation();
          }
          return;
        }
        params.onPromptSessionId(promptSessionId);
        const admission = await enqueueAutomationPrompt({
          credentials: params.credentials,
          sessionId: promptSessionId,
          automationId: params.claimed.automation.id,
          runId: params.claimed.run.id,
          prompt,
          ...(typeof template.displayText === 'string' ? { displayText: template.displayText } : {}),
          machineAdmissionTransport: params.machineAdmissionTransport,
          signal: params.signal,
        });
        if (!params.isCurrent()) {
          await preserveKnownNewSessionAfterAuthoritativeCancellation();
          return;
        }
        if (admission.status === 'rejected') {
          await params.fail(
            'prompt_delivery_failed',
            `Automation Session input admission rejected: ${admission.code}`,
            producedSessionId,
          );
          return;
        }
        if (admission.status === 'outcomeUnknown') {
          await params.fail(
            'prompt_delivery_outcome_unknown',
            `Automation Session input admission outcome is unknown: ${admission.code}`,
            producedSessionId,
          );
          return;
        }
      } catch (error) {
        if (!params.isCurrent()) {
          await preserveKnownNewSessionAfterAuthoritativeCancellation();
          return;
        }
        await params.fail(
          'prompt_delivery_failed',
          error instanceof Error ? error.message : String(error),
          producedSessionId,
        );
        return;
      }
    }

    if (!params.isCurrent()) {
      await preserveKnownNewSessionAfterAuthoritativeCancellation();
      return;
    }
    await params.succeed(spawnResult.sessionId);
    return;
  }

  if (spawnResult.type === 'requestToApproveDirectoryCreation') {
    if (!params.isCurrent()) return;
    await params.fail(
      'directory_approval_required',
      `Directory creation requires approval: ${spawnResult.directory}`,
    );
    return;
  }

  const normalizedFailure = normalizeRunFailure({
    targetType: template.targetType,
    errorCode: spawnResult.errorCode,
    errorMessage: spawnResult.errorMessage,
  });
  if (!params.isCurrent()) return;
  await params.fail(normalizedFailure.errorCode, normalizedFailure.errorMessage);
}

async function executeStrictV3Run(params: Readonly<{
  machineId: string;
  leaseDurationMs: number;
  claimed: ClaimableV3AutomationRunPayload;
  claimClient: AutomationRunClaimClient;
  credentials?: StoredCredentials;
  machineAdmissionTransport?: AutomationMachineAdmissionTransport;
  signal: AbortSignal;
  isCurrent: () => boolean;
  resolveAutomationAccountEncryption?: ResolveAutomationAccountEncryption;
  executeAction?: ExecuteAutomationAction;
  /** Session-owned ingress; Automation supplies only its Run correspondence and opaque V2 request. */
  dispatchSessionServerStart?: DispatchSessionServerStart;
  /** Origin-neutral workflow claim/start owner; Automation supplies only its frozen envelopes. */
  coordinateWorkflowRun?: ReturnType<typeof createProductionWorkflowRunCoordinator>;
  registerReviewHoldRefresh?: (refresh: () => Promise<void>) => void;
  onPromptSessionId: (sessionId: string) => void;
  /**
   * Observes the only canonical Session result before its terminal Run
   * settlement. The incumbent executor retains this evidence if that
   * settlement request loses its response.
   */
  onProducedNewSession: (
    sessionId: string,
    accountEncryption: AvailableAutomationAccountEncryptionV1,
  ) => void;
  recipe: AutomationRunExecutionRecipeV1;
  encryptionAtOpen: AvailableAutomationAccountEncryptionV1;
}>): Promise<void> {
  const claimCurrentness = params.claimed.accountCurrentness;
  const terminalizeInvalidTemplate = async () => await failV3ClaimedRunBeforeStart({
    machineId: params.machineId,
    claimed: params.claimed,
    claimClient: params.claimClient,
    signal: params.signal,
    isCurrent: params.isCurrent,
    resolveAutomationAccountEncryption: params.resolveAutomationAccountEncryption,
    errorCode: 'invalid_template',
    errorMessage: 'Frozen automation execution recipe is invalid',
  });

  const opened = openStrictRecipeContent({
    recipe: params.recipe,
    accountEncryption: params.encryptionAtOpen,
  });
  if (opened.kind === 'contentInvalid') {
    await terminalizeInvalidTemplate();
    return;
  }
  if (opened.kind === 'materialUnavailable') return;

  const materialized = materializeAutomationRunExecutionRecipeV1({
    recipe: params.recipe,
    cause: params.claimed.run.cause,
    accountCurrentness: claimCurrentness,
    runId: params.claimed.run.id,
    ...(opened.openedContent === undefined ? {} : { openedContent: opened.openedContent }),
  });
  if (materialized.kind === 'contentInvalid') {
    await terminalizeInvalidTemplate();
    return;
  }
  if (materialized.kind === 'materialUnavailable') return;

  if (
    materialized.target.kind === 'executionRun'
    && params.claimed.run.resultDelivery?.kind === 'finalResult'
  ) {
    await failV3ClaimedRunBeforeStart({
      machineId: params.machineId,
      claimed: params.claimed,
      claimClient: params.claimClient,
      signal: params.signal,
      isCurrent: params.isCurrent,
      resolveAutomationAccountEncryption: params.resolveAutomationAccountEncryption,
      errorCode: 'execution_run_final_result_unsupported',
      errorMessage: 'Automation final-result delivery is supported only for Session targets',
    });
    return;
  }

  if (
    materialized.target.kind === 'newSession'
    && !params.dispatchSessionServerStart
  ) return;
  if (
    materialized.target.kind === 'executionRun'
    && (!params.executeAction || !params.claimClient.settleExecutionDispatch)
  ) return;
  if (
    materialized.target.kind === 'existingSession'
    && (!params.credentials || !params.machineAdmissionTransport)
  ) return;
  if (!params.isCurrent()) return;

  let rawStartCurrentness: AutomationAccountCurrentnessWitnessV1 | null | void;
  try {
    rawStartCurrentness = await params.claimClient.startRun({
      protocol: 'v3',
      runId: params.claimed.run.id,
      machineId: params.machineId,
      attempt: params.claimed.run.attempt,
      accountCurrentness: claimCurrentness,
    });
  } catch {
    // A lost start response cannot establish S or authorize the target effect.
    return;
  }
  if (!params.isCurrent()) return;
  const startCurrentness = AutomationAccountCurrentnessWitnessV1Schema.safeParse(rawStartCurrentness);
  if (!startCurrentness.success) return;

  const currentnessBeforeEffect = await resolveMatchingAutomationCurrentness({
    signal: params.signal,
    expected: startCurrentness.data,
    resolveAutomationAccountEncryption: params.resolveAutomationAccountEncryption,
  });
  if (!currentnessBeforeEffect || !params.isCurrent()) return;
  const failWithCurrentEffect = async (
    errorCode: string,
    errorMessage: string,
    producedSessionId?: string | null,
  ): Promise<void> => await params.claimClient.failRun(createV3RunFailureSettlement({
    machineId: params.machineId,
    claimed: params.claimed,
    accountEncryption: currentnessBeforeEffect,
    errorCode,
    errorMessage,
    ...(producedSessionId === undefined ? {} : { producedSessionId }),
  }));

  if (materialized.target.kind === 'newSession') {
    let requestEnvelope;
    try {
      requestEnvelope = currentnessBeforeEffect.witness.mode === 'plain'
        ? sealAutomationSessionStartRequestEnvelopeV1({
          mode: 'plain',
          input: materialized.target.spawn,
        })
        : isAvailableE2eeAutomationAccountEncryptionV1(currentnessBeforeEffect)
          ? sealAutomationSessionStartRequestEnvelopeV1({
            mode: 'e2ee',
            input: materialized.target.spawn,
            material: currentnessBeforeEffect.material.material,
            randomBytes: getRandomBytes,
          })
          : null;
    } catch {
      // A malformed/bounded request cannot authorize a target effect. Leave
      // the Run retryable under the incumbent S-based ownership instead of
      // manufacturing an alternate Session path.
      return;
    }
    if (requestEnvelope === null) return;

    let result: SessionServerStartDispatchResultV1;
    try {
      result = await params.dispatchSessionServerStart!({
        v: 1,
        kind: 'session.serverStart.ingress',
        runId: params.claimed.run.id,
        attempt: params.claimed.run.attempt,
        // The materializer is the only Automation owner that derives the
        // deterministic creation identity and rendered initial input. Its
        // Automation-owned envelope is sealed only under fresh S currentness;
        // Session receives opaque bytes and rederives all authority at ingress.
        requestEnvelope,
      }, { signal: params.signal });
    } catch {
      // A lost ingress response cannot establish Session creation truth. The
      // same stable creation key makes an eventual rejoin authoritative.
      return;
    }

    if (result.type === 'error') {
      // A nonretryable Session-start result is terminal. Pending and retryable
      // results retain the incumbent lease-recovery path.
      if (result.retryable || !params.isCurrent()) return;
      await failWithCurrentEffect(
        result.code,
        `Automation Session start failed: ${result.code}`,
      );
      return;
    }
    if (result.type !== 'success') return;
    if (
      result.executionTarget.serverId !== materialized.target.spawn.executionTarget.serverId
      || result.executionTarget.machineId !== materialized.target.spawn.executionTarget.machineId
    ) {
      // A result for a different target cannot settle this immutable Run.
      return;
    }
    params.onProducedNewSession(result.sessionId, currentnessBeforeEffect);
    params.onPromptSessionId(result.sessionId);

    const preserveKnownSessionAfterCancellation = async (): Promise<void> => {
      if (!isAuthoritativeAutomationRunCancellation(params.signal)) return;
      await failWithCurrentEffect(
        'session_start_cancelled_after_create',
        'Automation Run cancellation won after the canonical Session result was known',
        result.sessionId,
      );
    };

    // Cancellation must not discard a committed Session id. The incumbent V3
    // failure/cancellation settlement preserves it without changing terminality.
    if (!params.isCurrent()) {
      await preserveKnownSessionAfterCancellation();
      return;
    }

    if (
      result.initialInput.status === 'accepted'
      || result.initialInput.status === 'alreadyAccepted'
    ) {
      const resultDelivery = params.claimed.run.resultDelivery;
      if (resultDelivery?.kind === 'finalResult') {
        await settleStrictV3SessionFinalResult({
          credentials: params.credentials,
          claimed: params.claimed,
          accountEncryption: currentnessBeforeEffect,
          resultDelivery,
          sessionId: result.sessionId,
          localId: result.initialInput.localId,
          timeoutMs: params.leaseDurationMs,
          isCurrent: params.isCurrent,
          succeed: async (resultEnvelope) => await params.claimClient.succeedRun({
            protocol: 'v3',
            runId: params.claimed.run.id,
            machineId: params.machineId,
            attempt: params.claimed.run.attempt,
            accountCurrentness: startCurrentness.data,
            producedSessionId: result.sessionId,
            resultEnvelope,
          }),
          fail: async (errorCode, errorMessage) => await failWithCurrentEffect(
            errorCode,
            errorMessage,
            result.sessionId,
          ),
        });
        return;
      }
      await params.claimClient.succeedRun({
        protocol: 'v3',
        runId: params.claimed.run.id,
        machineId: params.machineId,
        attempt: params.claimed.run.attempt,
        accountCurrentness: startCurrentness.data,
        producedSessionId: result.sessionId,
      });
      return;
    }

    const inputFailure = result.initialInput.status === 'rejected'
      ? {
          errorCode: 'prompt_delivery_failed',
          errorMessage: `Automation Session input admission rejected: ${result.initialInput.code}`,
        }
      : result.initialInput.status === 'outcomeUnknown'
        ? {
            errorCode: 'prompt_delivery_outcome_unknown',
            errorMessage: `Automation Session input admission outcome is unknown: ${result.initialInput.code}`,
          }
        : {
            errorCode: 'prompt_delivery_failed',
            errorMessage: 'Automation Session creation did not request its required initial input',
          };
    await failWithCurrentEffect(
      inputFailure.errorCode,
      inputFailure.errorMessage,
      result.sessionId,
    );
    return;
  }

  if (materialized.target.kind === 'executionRun') {
    let outcome: AutomationV3WorkerExecutionDispatchOutcome;
    const actionRequestId = `automation-run:${params.claimed.run.id}`;
    const actionCaller = {
      kind: 'automationRun' as const,
      runId: params.claimed.run.id,
      automationId: params.claimed.automation.id,
      cause: params.claimed.run.cause,
    };
    let knownNativeRunId: string | null = null;
    let stopAttempted = false;
    const stopKnownNativeRunAfterAuthoritativeCancellation = async (): Promise<void> => {
      if (
        stopAttempted
        || !knownNativeRunId
        || !isAuthoritativeAutomationRunCancellation(params.signal)
      ) return;

      stopAttempted = true;
      try {
        const stopResult = await params.executeAction!(
          'execution.run.stop',
          { sessionId: null, runId: knownNativeRunId },
          {
            // The worker cancellation only stops its owned wait. A known
            // native Run needs one independent stop request.
            signal: new AbortController().signal,
            actionRequestId: `${actionRequestId}:stop`,
            executionRunTargetMachineId: params.machineId,
            actionCaller,
          },
        );
        if (!stopResult.ok || !ExecutionRunStopResponseSchema.safeParse(stopResult.result).success) {
          logAutomationWarn('Could not confirm native execution Run stop after Automation cancellation',
            stopResult.ok ? undefined : new Error(stopResult.error), {
              runId: params.claimed.run.id,
              automationId: params.claimed.automation.id,
              nativeRunId: knownNativeRunId,
              ...(stopResult.ok ? {} : { errorCode: stopResult.errorCode }),
            });
        }
      } catch (error) {
        logAutomationWarn('Could not confirm native execution Run stop after Automation cancellation', error, {
          runId: params.claimed.run.id,
          automationId: params.claimed.automation.id,
          nativeRunId: knownNativeRunId,
        });
      }
    };
    const reportExecutionDispatchSettlement = async (
      settled: AutomationV3WorkerExecutionDispatchOutcome,
    ): Promise<void> => {
      await params.claimClient.settleExecutionDispatch!({
        protocol: 'v3',
        runId: params.claimed.run.id,
        machineId: params.machineId,
        attempt: params.claimed.run.attempt,
        accountCurrentness: startCurrentness.data,
        outcome: settled,
      });
    };
    try {
      const actionResult = await params.executeAction!(
        'execution.run.start',
        {
          ...materialized.target.request,
          sessionId: null,
          waitForCompletion: true,
        },
        {
          signal: params.signal,
          actionRequestId,
          executionRunTargetMachineId: params.machineId,
          actionCaller,
        },
      );
      if (actionResult.ok) {
        const parsed = ExecutionRunStartResponseSchema.safeParse(actionResult.result);
        if (parsed.success) {
          knownNativeRunId = parsed.data.runId;
        }
        outcome = parsed.success
          ? {
              kind: 'started',
              runId: parsed.data.runId,
              callId: parsed.data.callId,
              sidechainId: parsed.data.sidechainId,
              ...(parsed.data.wait === undefined ? {} : { wait: parsed.data.wait }),
            }
          : {
              kind: 'outcomeUnknown',
              errorCode: 'execution_run_outcome_unknown',
            };
        if (!params.isCurrent()) {
          // Cancellation owns this Run's terminality, but the start already
          // returned a native identity. It is the only pointer back to an
          // execution that may still be running, so the one dispatch
          // settlement owner receives it before the stop attempt.
          if (parsed.success && isAuthoritativeAutomationRunCancellation(params.signal)) {
            try {
              await reportExecutionDispatchSettlement(outcome);
            } finally {
              await stopKnownNativeRunAfterAuthoritativeCancellation();
            }
            return;
          }
          await stopKnownNativeRunAfterAuthoritativeCancellation();
          return;
        }
      } else {
        outcome = readExecutionRunStartRunCreation(actionResult.details) === 'noRunCreated'
          ? { kind: 'noRunCreated', errorCode: actionResult.errorCode }
          : { kind: 'outcomeUnknown', errorCode: actionResult.errorCode };
      }
    } catch {
      if (!params.isCurrent()) return;
      outcome = {
        kind: 'outcomeUnknown',
        errorCode: 'execution_run_target_unavailable',
      };
    }
    if (!params.isCurrent()) return;
    try {
      await reportExecutionDispatchSettlement(outcome);
    } finally {
      await stopKnownNativeRunAfterAuthoritativeCancellation();
    }
    return;
  }

  if (materialized.target.kind !== 'existingSession') return;
  const existingSessionTarget = materialized.target;
  const credentials = params.credentials;
  const machineAdmissionTransport = params.machineAdmissionTransport;
  if (!credentials || !machineAdmissionTransport) return;

  try {
    params.onPromptSessionId(existingSessionTarget.sessionId);
    const admission = await enqueueAutomationPrompt({
      credentials,
      sessionId: existingSessionTarget.sessionId,
      automationId: params.claimed.automation.id,
      runId: params.claimed.run.id,
      prompt: existingSessionTarget.prompt,
      mentions: existingSessionTarget.mentions,
      machineAdmissionTransport,
      signal: params.signal,
    });
    if (!params.isCurrent()) return;
    if (admission.status === 'rejected') {
      await failWithCurrentEffect(
        'prompt_delivery_failed',
        `Automation Session input admission rejected: ${admission.code}`,
      );
      return;
    }
    if (admission.status === 'outcomeUnknown') {
      // The Session owner has not proved whether the input was accepted. A
      // terminal Automation result would be false certainty, so lease expiry
      // re-enters the existing durable admission/rejoin path.
      return;
    }
    const resultDelivery = params.claimed.run.resultDelivery;
    if (resultDelivery?.kind === 'finalResult') {
      await settleStrictV3SessionFinalResult({
        credentials,
        claimed: params.claimed,
        accountEncryption: currentnessBeforeEffect,
        resultDelivery,
        sessionId: existingSessionTarget.sessionId,
        localId: admission.localId,
        timeoutMs: params.leaseDurationMs,
        isCurrent: params.isCurrent,
        succeed: async (resultEnvelope) => await params.claimClient.succeedRun({
          protocol: 'v3',
          runId: params.claimed.run.id,
          machineId: params.machineId,
          attempt: params.claimed.run.attempt,
          accountCurrentness: startCurrentness.data,
          producedSessionId: existingSessionTarget.sessionId,
          resultEnvelope,
        }),
        fail: async (errorCode, errorMessage) => await failWithCurrentEffect(
          errorCode,
          errorMessage,
          existingSessionTarget.sessionId,
        ),
      });
      return;
    }
    await params.claimClient.succeedRun({
      protocol: 'v3',
      runId: params.claimed.run.id,
      machineId: params.machineId,
      attempt: params.claimed.run.attempt,
      accountCurrentness: startCurrentness.data,
      producedSessionId: existingSessionTarget.sessionId,
    });
  } catch (error) {
    if (!params.isCurrent()) return;
    logAutomationWarn('Strict Automation existing-session input owner failed', error, {
      runId: params.claimed.run.id,
      automationId: params.claimed.automation.id,
    });
  }
}

async function executeRetainedTemplateInputOnCurrentLifecycle(params: Readonly<{
  machineId: string;
  claimed: ClaimableV3AutomationRunPayload;
  claimClient: AutomationRunClaimClient;
  credentials?: StoredCredentials;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  machineAdmissionTransport?: AutomationMachineAdmissionTransport;
  signal: AbortSignal;
  isCurrent: () => boolean;
  resolveAutomationAccountEncryption?: ResolveAutomationAccountEncryption;
  input: AutomationRunExecutionInputV1;
  encryptionAtOpen: AvailableAutomationAccountEncryptionV1;
  onPromptSessionId: (sessionId: string) => void;
  onProducedNewSession: (
    sessionId: string,
    accountEncryption: AvailableAutomationAccountEncryptionV1,
  ) => void;
}>): Promise<void> {
  const stored = readAutomationTemplateStoredEnvelopeV1(params.input.templateCiphertext);
  const retainedSession = params.encryptionAtOpen.witness.mode === 'plain' && params.input.targetType === 'existing_session'
    && stored?.legacyExistingSessionId && params.credentials
    ? await resolveAutomationTemplateRetainedSession({ credentials: params.credentials,
      sessionId: stored.legacyExistingSessionId, signal: params.signal }) : undefined;
  const template = parseAutomationTemplateExecution(params.input,
    isAvailableE2eeAutomationAccountEncryptionV1(params.encryptionAtOpen)
    ? params.encryptionAtOpen.material.material
    : undefined, params.encryptionAtOpen.witness.mode, retainedSession ?? undefined);
  if (!template.ok) {
    await failV3ClaimedRunBeforeStart({
      machineId: params.machineId,
      claimed: params.claimed,
      claimClient: params.claimClient,
      signal: params.signal,
      isCurrent: params.isCurrent,
      resolveAutomationAccountEncryption: params.resolveAutomationAccountEncryption,
      errorCode: template.code,
      errorMessage: template.error,
    });
    return;
  }
  if (!params.isCurrent()) return;

  let rawStartCurrentness: AutomationAccountCurrentnessWitnessV1 | null | void;
  try {
    rawStartCurrentness = await params.claimClient.startRun({
      protocol: 'v3',
      runId: params.claimed.run.id,
      machineId: params.machineId,
      attempt: params.claimed.run.attempt,
      accountCurrentness: params.claimed.accountCurrentness,
    });
  } catch {
    return;
  }
  if (!params.isCurrent()) return;
  const startCurrentness = AutomationAccountCurrentnessWitnessV1Schema.safeParse(rawStartCurrentness);
  if (!startCurrentness.success) return;
  const currentnessBeforeEffect = await resolveMatchingAutomationCurrentness({
    signal: params.signal,
    expected: startCurrentness.data,
    resolveAutomationAccountEncryption: params.resolveAutomationAccountEncryption,
  });
  if (!currentnessBeforeEffect || !params.isCurrent()) return;

  await executeParsedAutomationTemplate({
    credentials: params.credentials,
    machineId: params.machineId,
    claimed: params.claimed,
    spawnSession: params.spawnSession,
    machineAdmissionTransport: params.machineAdmissionTransport,
    signal: params.signal,
    isCurrent: params.isCurrent,
    template: template.value,
    beforeTargetEffect: async () => {
      const currentness = await resolveMatchingAutomationCurrentness({
        signal: params.signal,
        expected: startCurrentness.data,
        resolveAutomationAccountEncryption: params.resolveAutomationAccountEncryption,
      });
      return currentness !== null && params.isCurrent();
    },
    onPromptSessionId: params.onPromptSessionId,
    onProducedNewSessionId: (sessionId) => {
      params.onProducedNewSession(sessionId, currentnessBeforeEffect);
    },
    fail: async (errorCode, errorMessage, producedSessionId) => await params.claimClient.failRun(
      createV3RunFailureSettlement({
        machineId: params.machineId,
        claimed: params.claimed,
        accountEncryption: currentnessBeforeEffect,
        errorCode,
        errorMessage,
        ...(producedSessionId === undefined ? {} : { producedSessionId }),
      }),
    ),
    succeed: async (producedSessionId) => await params.claimClient.succeedRun({
      protocol: 'v3',
      runId: params.claimed.run.id,
      machineId: params.machineId,
      attempt: params.claimed.run.attempt,
      accountCurrentness: startCurrentness.data,
      producedSessionId,
    }),
  });
}

export async function executeClaimedRun(params: {
  token: string;
  /** The daemon's authenticated Session owner; required for existing-session input admission. */
  credentials?: StoredCredentials;
  machineId: string;
  claimClient: AutomationRunClaimClient;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  heartbeatMs: number;
  leaseDurationMs: number;
  machineAdmissionTransport?: AutomationMachineAdmissionTransport;
  /** Canonical Account-currentness/material owner for strict V3 recipes. */
  resolveAutomationAccountEncryption?: ResolveAutomationAccountEncryption;
  /** Canonical Action boundary used for detached execution targets. */
  executeAction?: ExecuteAutomationAction;
  /** Session-owned strict new-Session ingress, supplied by the connected daemon client. */
  dispatchSessionServerStart?: DispatchSessionServerStart;
  /** Worker-owned currentness signal for this exact claimed Run attempt. */
  signal?: AbortSignal;
  /** Origin-neutral workflow coordinator supplied by daemon bootstrap. */
  coordinateWorkflowRun?: ReturnType<typeof createProductionWorkflowRunCoordinator>;
  registerReviewHoldRefresh?: Parameters<ReturnType<typeof createProductionWorkflowRunCoordinator>>[0]['registerReviewHoldRefresh'];
  claimed: ClaimableRunPayload;
}): Promise<void> {
  const {
    machineId,
    claimClient,
    spawnSession,
    heartbeatMs,
    leaseDurationMs,
    claimed,
  } = params;
  const attempt = claimed.run.attempt;

  const executionController = new AbortController();
  let heartbeat: ReturnType<typeof startAutomationLeaseHeartbeat> | null = null;
  let workflowAuthorizationCurrentnessCheck: ((signal?: AbortSignal) => Promise<boolean>) | null = null;
  let workflowControlCheck: (() => Promise<'running' | 'pause_requested' | 'cancel_requested'>) | null = null;
  let cancellationPromptSessionId: string | null = null;
  let knownProducedNewSessionId: string | undefined;
  let knownProducedNewSessionEncryption: AvailableAutomationAccountEncryptionV1 | undefined;
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
    // The claimed lease must cover the start round-trip too. If that request
    // stalls past a lost heartbeat, its eventual response cannot authorize a
    // later spawn or Session-input admission.
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
          signal: executionController.signal,
        });
        return;
      }
      if (claimed.run.recipeKind === 'workflow-v2') {
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
      // Current V3 Runs carry one Protocol-owned strict recipe. Parse and
      // materialize it before start: C never authorizes a target effect.
      const strictRecipe = parseAutomationRunExecutionRecipeV1(
        claimed.run.executionInputEnvelope,
      );
      if (strictRecipe.kind === 'available') {
        const encryptionAtOpen = await resolveMatchingAutomationCurrentness({
          signal: executionController.signal,
          expected: claimed.accountCurrentness,
          resolveAutomationAccountEncryption: params.resolveAutomationAccountEncryption,
        });
        if (!encryptionAtOpen || !isCurrent()) return;
        await executeStrictV3Run({
          machineId,
          leaseDurationMs,
          claimed,
          claimClient,
          credentials: params.credentials,
          machineAdmissionTransport: params.machineAdmissionTransport,
          signal: executionController.signal,
          isCurrent,
          resolveAutomationAccountEncryption: params.resolveAutomationAccountEncryption,
          executeAction: params.executeAction,
          dispatchSessionServerStart: params.dispatchSessionServerStart,
          onPromptSessionId: (sessionId) => {
            cancellationPromptSessionId = sessionId;
          },
          onProducedNewSession: (sessionId, accountEncryption) => {
            knownProducedNewSessionId = sessionId;
            knownProducedNewSessionEncryption = accountEncryption;
          },
          recipe: strictRecipe.recipe,
          encryptionAtOpen,
        });
        return;
      }

      const retainedTemplateInput = parseRetainedTemplateExecutionInputForClaim({
        raw: claimed.run.executionInputEnvelope,
        cause: claimed.run.cause,
      });
      if (retainedTemplateInput) {
        const encryptionAtOpen = await resolveMatchingAutomationCurrentness({
          signal: executionController.signal,
          expected: claimed.accountCurrentness,
          resolveAutomationAccountEncryption: params.resolveAutomationAccountEncryption,
        });
        if (!encryptionAtOpen || !isCurrent()) return;
        await executeRetainedTemplateInputOnCurrentLifecycle({
          machineId,
          claimed,
          claimClient,
          credentials: params.credentials,
          spawnSession,
          machineAdmissionTransport: params.machineAdmissionTransport,
          signal: executionController.signal,
          isCurrent,
          resolveAutomationAccountEncryption: params.resolveAutomationAccountEncryption,
          input: retainedTemplateInput,
          encryptionAtOpen,
          onPromptSessionId: (sessionId) => {
            cancellationPromptSessionId = sessionId;
          },
          onProducedNewSession: (sessionId, accountEncryption) => {
            knownProducedNewSessionId = sessionId;
            knownProducedNewSessionEncryption = accountEncryption;
          },
        });
        return;
      }

      // Current recipes and frozen input containing retained 0.2 template data
      // are the only accepted forms. Malformed and undeployed intermediary
      // shapes fail before start.
      await failV3ClaimedRunBeforeStart({
        machineId,
        claimed,
        claimClient,
        signal: executionController.signal,
        isCurrent,
        resolveAutomationAccountEncryption: params.resolveAutomationAccountEncryption,
        errorCode: 'invalid_template',
        errorMessage: 'Frozen automation execution recipe is invalid',
      });
    } catch (error) {
      const authoritativeCancellation = isAuthoritativeAutomationRunCancellation(params.signal);
      if (
        !isDirectWorkflowRunClaim(claimed)
        && knownProducedNewSessionId
        && knownProducedNewSessionEncryption
        && (isCurrent() || authoritativeCancellation)
      ) {
        // The canonical Session result already established creation truth.
        // Reuse the incumbent V3 fail owner to retain that identity when a
        // terminal request loses its response; ordinary invalidation never
        // manufactures settlement authority.
        await claimClient.failRun(createV3RunFailureSettlement({
          machineId,
          claimed,
          accountEncryption: knownProducedNewSessionEncryption,
          producedSessionId: knownProducedNewSessionId,
          errorCode: 'unexpected_error',
          errorMessage: error instanceof Error ? error.message : String(error),
        })).catch((innerError) => {
          logAutomationWarn('Failed to record automation run failure', innerError, {
            runId: claimed.run.id,
            automationId: claimedAutomationId,
          });
        });
        return;
      }
      // An exception before a Session result has no proven target outcome.
      // The incumbent lease owner will reclaim the immutable Run after its
      // bounded deadline.
      if (isCurrent()) {
        logAutomationWarn('Strict Automation Run execution failed before a proven terminal outcome', error, {
          runId: claimed.run.id,
          automationId: claimedAutomationId,
        });
      }
    }

  } finally {
    heartbeat?.stop();
    params.signal?.removeEventListener('abort', abortFromWorker);
    if (
      cancellationPromptSessionId
      && params.credentials
      && claimedAutomationId !== null
      && isAuthoritativeAutomationRunCancellation(params.signal)
    ) {
      await discardAutomationPromptAfterRunCancellation({
        credentials: params.credentials,
        sessionId: cancellationPromptSessionId,
        automationId: claimedAutomationId,
        runId: claimed.run.id,
      }).catch((error) => {
        logAutomationWarn('Failed to discard cancelled Automation Session input', error, {
          runId: claimed.run.id,
          automationId: claimedAutomationId,
          sessionId: cancellationPromptSessionId,
        });
      });
    }
  }
}
