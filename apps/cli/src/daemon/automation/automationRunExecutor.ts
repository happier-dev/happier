import type {
  SpawnSessionErrorCode,
  SpawnSessionOptions,
  SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import type { StoredCredentials } from '@/persistence';
import type {
  SessionInputAdmissionResultV1,
  SessionPendingEnqueueByMachineRequestV1,
  SessionServerStartDispatchResultV1,
  SessionServerStartIngressRequestV1,
} from '@happier-dev/protocol';
import {
  AutomationAccountCurrentnessWitnessV1Schema,
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
  validateAutomationRunExecutionRecipeOuterV1,
  type AutomationAccountCurrentnessWitnessV1,
  type AutomationRunCause,
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
import {
  parseAutomationTemplateExecution,
  type ParsedAutomationExecution,
  type AutomationTemplateEncryption,
} from './automationTemplateExecution';
import { logAutomationWarn } from './automationTelemetry';
import type { AutomationClaimedRunPayload } from './automationTypes';

export type ClaimableRunPayload = AutomationClaimedRunPayload;

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
  errorDetailEnvelope: string | null;
  errorMessage?: never;
}>;

type AutomationV2RunFailureSettlement = Readonly<{
  protocol: 'v2';
  runId: string;
  machineId: string;
  attempt: number;
  producedSessionId?: string | null;
  errorCode: string;
  /** Released V2 transport adapter only. */
  errorMessage: string;
  errorDetailEnvelope?: never;
  accountCurrentness?: never;
}>;

type AutomationRunClaimClient = Readonly<{
  startRun: (params: {
    protocol: 'v2' | 'v3';
    runId: string;
    machineId: string;
    attempt: number;
    /** C for V3; predecessor V2 does not carry Account currentness. */
    accountCurrentness?: AutomationAccountCurrentnessWitnessV1;
  }) => Promise<AutomationAccountCurrentnessWitnessV1 | null | void>;
  heartbeatRun: (params: {
    protocol: 'v2' | 'v3';
    runId: string;
    machineId: string;
    attempt: number;
    leaseDurationMs: number;
  }) => Promise<void>;
  succeedRun: (params: {
    protocol: 'v2' | 'v3';
    runId: string;
    machineId: string;
    attempt: number;
    /** S for V3; predecessor V2 does not carry Account currentness. */
    accountCurrentness?: AutomationAccountCurrentnessWitnessV1;
    producedSessionId?: string | null;
    resultEnvelope?: string | null;
  }) => Promise<void>;
  failRun: (params: AutomationV3RunFailureSettlement | AutomationV2RunFailureSettlement) => Promise<void>;
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
  claimed: Extract<ClaimableRunPayload, { protocol: 'v3' }>;
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
  claimed: Extract<ClaimableRunPayload, { protocol: 'v3' }>;
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
  claimed: Extract<ClaimableRunPayload, { protocol: 'v3' }>;
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
  claimed: Extract<ClaimableRunPayload, { protocol: 'v3' }>;
  claimClient: AutomationRunClaimClient;
  signal: AbortSignal;
  isCurrent: () => boolean;
  resolveAutomationAccountEncryption?: ResolveAutomationAccountEncryption;
  errorCode: string;
  errorMessage: string;
}>): Promise<void> {
  if (!params.isCurrent()) return;
  const currentness = await resolveMatchingAutomationCurrentness({
    signal: params.signal,
    expected: params.claimed.accountCurrentness,
    resolveAutomationAccountEncryption: params.resolveAutomationAccountEncryption,
  });
  if (!currentness || !params.isCurrent()) return;
  await params.claimClient.failRun(createV3RunFailureSettlement({
    machineId: params.machineId,
    claimed: params.claimed,
    accountEncryption: currentness,
    errorCode: params.errorCode,
    errorMessage: params.errorMessage,
  }));
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

async function executeParsedAutomationTemplate(params: Readonly<{
  credentials?: StoredCredentials;
  machineId: string;
  claimed: ClaimableRunPayload;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  machineAdmissionTransport?: (
    request: SessionPendingEnqueueByMachineRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<SessionInputAdmissionResultV1>;
  signal: AbortSignal;
  isCurrent: () => boolean;
  template: ParsedAutomationExecution;
  /** Rechecks S before every V3 target effect; V2 supplies a no-op. */
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
  claimed: Extract<ClaimableRunPayload, { protocol: 'v3' }>;
  claimClient: AutomationRunClaimClient;
  credentials?: StoredCredentials;
  machineAdmissionTransport?: (
    request: SessionPendingEnqueueByMachineRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<SessionInputAdmissionResultV1>;
  signal: AbortSignal;
  isCurrent: () => boolean;
  resolveAutomationAccountEncryption?: ResolveAutomationAccountEncryption;
  executeAction?: ExecuteAutomationAction;
  /** Session-owned ingress; Automation supplies only its Run correspondence and opaque V2 request. */
  dispatchSessionServerStart?: DispatchSessionServerStart;
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
            await reportExecutionDispatchSettlement(outcome);
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

export async function executeClaimedRun(params: {
  token: string;
  /** The daemon's authenticated Session owner; required for existing-session input admission. */
  credentials?: StoredCredentials;
  machineId: string;
  claimClient: AutomationRunClaimClient;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  heartbeatMs: number;
  leaseDurationMs: number;
  encryption?: AutomationTemplateEncryption;
  machineAdmissionTransport?: (
    request: SessionPendingEnqueueByMachineRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<SessionInputAdmissionResultV1>;
  /** Canonical Account-currentness/material owner for strict V3 recipes. */
  resolveAutomationAccountEncryption?: ResolveAutomationAccountEncryption;
  /** Canonical Action boundary used for detached execution targets. */
  executeAction?: ExecuteAutomationAction;
  /** Session-owned strict new-Session ingress, supplied by the connected daemon client. */
  dispatchSessionServerStart?: DispatchSessionServerStart;
  /** Worker-owned currentness signal for this exact claimed Run attempt. */
  signal?: AbortSignal;
  claimed: ClaimableRunPayload;
}): Promise<void> {
  const {
    machineId,
    claimClient,
    spawnSession,
    heartbeatMs,
    leaseDurationMs,
    encryption,
    claimed,
  } = params;
  const attempt = claimed.run.attempt;

  const executionController = new AbortController();
  let heartbeat: ReturnType<typeof startAutomationLeaseHeartbeat> | null = null;
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
      },
      onError: (error) => {
        abortExecution();
        logAutomationWarn('Lease heartbeat failed', error, {
          runId: claimed.run.id,
          automationId: claimed.automation.id,
        });
      },
    });

    if (claimed.protocol === 'v3') {
      try {
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

        // Current V3 has one cause-bound recipe model. Its unreleased
        // predecessor is not a compatibility reader; released V2 remains
        // isolated on the distinct V2 claim branch below.
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
          knownProducedNewSessionId
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
              automationId: claimed.automation.id,
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
            automationId: claimed.automation.id,
          });
        }
      }
      return;
    }

    await claimClient.startRun({ protocol: 'v2', runId: claimed.run.id, machineId, attempt });
    if (!isCurrent()) return;

    const parsedTemplate = parseAutomationTemplateExecution({
      run: {
        id: claimed.run.id,
        automationId: claimed.run.automationId,
      },
      automation: {
        id: claimed.automation.id,
        name: claimed.automation.name,
        enabled: claimed.automation.enabled,
        targetType: claimed.automation.targetType,
        templateCiphertext: claimed.automation.templateCiphertext,
      },
    }, encryption);

    if (!parsedTemplate.ok) {
      if (!isCurrent()) return;
      await claimClient.failRun({
        protocol: 'v2',
        runId: claimed.run.id,
        machineId,
        attempt,
        errorCode: parsedTemplate.code,
        errorMessage: parsedTemplate.error,
      });
      return;
    }

    await executeParsedAutomationTemplate({
      credentials: params.credentials,
      machineId,
      claimed,
      spawnSession,
      machineAdmissionTransport: params.machineAdmissionTransport,
      signal: executionController.signal,
      isCurrent,
      template: parsedTemplate.value,
      beforeTargetEffect: async () => true,
      onPromptSessionId: (sessionId) => {
        cancellationPromptSessionId = sessionId;
      },
      onProducedNewSessionId: (sessionId) => {
        knownProducedNewSessionId = sessionId;
      },
      fail: async (errorCode, errorMessage, producedSessionId) => await claimClient.failRun({
        protocol: 'v2',
        runId: claimed.run.id,
        machineId,
        attempt,
        ...(producedSessionId === undefined ? {} : { producedSessionId }),
        errorCode,
        errorMessage,
      }),
      succeed: async (producedSessionId) => await claimClient.succeedRun({
        protocol: 'v2',
        runId: claimed.run.id,
        machineId,
        attempt,
        producedSessionId,
      }),
  });
  } catch (error) {
    const authoritativeCancellation = isAuthoritativeAutomationRunCancellation(params.signal);
    if (!isCurrent() && (!authoritativeCancellation || !knownProducedNewSessionId)) return;
    // The existing fail/cancel owner is the only safe fallback after a
    // terminal RPC loses its acknowledgement. An ordinary invalidation must
    // not settle; authoritative cancellation may retain only the known
    // canonical new-Session identity.
    await claimClient.failRun({
      protocol: 'v2',
      runId: claimed.run.id,
      machineId,
      attempt,
      ...(knownProducedNewSessionId === undefined
        ? {}
        : { producedSessionId: knownProducedNewSessionId }),
      errorCode: 'unexpected_error',
      errorMessage: error instanceof Error ? error.message : String(error),
    }).catch((innerError) => {
      logAutomationWarn('Failed to record automation run failure', innerError, {
        runId: claimed.run.id,
        automationId: claimed.automation.id,
      });
    });
  } finally {
    heartbeat?.stop();
    params.signal?.removeEventListener('abort', abortFromWorker);
    if (
      cancellationPromptSessionId
      && params.credentials
      && isAuthoritativeAutomationRunCancellation(params.signal)
    ) {
      await discardAutomationPromptAfterRunCancellation({
        token: params.token,
        sessionId: cancellationPromptSessionId,
        automationId: claimed.automation.id,
        runId: claimed.run.id,
      }).catch((error) => {
        logAutomationWarn('Failed to discard cancelled Automation Session input', error, {
          runId: claimed.run.id,
          automationId: claimed.automation.id,
          sessionId: cancellationPromptSessionId,
        });
      });
    }
  }
}
