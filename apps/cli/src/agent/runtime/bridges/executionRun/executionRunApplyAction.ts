import { randomUUID } from 'node:crypto';

import type { BackendTargetRefV1, SessionInputCausalPermissionAuthorityV1 } from '@happier-dev/protocol';
import { ReviewFindingsV2Schema } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { refreshReviewNewRoundCostConsentV1, type ReviewEngineListItem } from '@happier-dev/protocol/reviews/reviewEngines';
import { readReviewProfileCostConsent } from '@/agent/executionRuns/profiles/review/costConsent';
import { ReviewFollowUpInputSchema } from '@happier-dev/protocol/reviews/reviewFollowUp';
import { ReviewNativeNewRoundInputV1Schema, resolveReviewRunContinuityV1 } from '@happier-dev/protocol/reviews/reviewRoundActionsV1';
import { REVIEW_NEW_ROUND_ACTION_ID_V1, isReviewRunStartActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { ReviewTriageOverlaySchema } from '@happier-dev/protocol/messages/structured/reviewFindingsV1';
import { isExecutionRunActive } from '@happier-dev/protocol/execution/runs/responseSchemas';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import {
  resolveExecutionRunIntentProfile,
  resolveExecutionRunIntentProfileFromCatalog,
  resolveExecutionRunProfileContributionDescriptor,
  resolveExecutionRunProfileSelectionForAgent,
  type ExecutionRunProfileContributionCatalog,
} from '@/agent/executionRuns/profiles/intentRegistry';
import { VoiceAgentError, type VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { buildExecutionRunProfileStartParams } from './profileStart';
import { projectExecutionRunPublicState } from './publicState';
import type {
  ExecutionRunActionParams,
  ExecutionRunActionResult,
  ExecutionRunManagerStartParams,
  ExecutionRunStartResult,
  ExecutionRunState,
} from './executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type {
  ReviewCommentHostActionCandidate,
  ReviewCommentHostActionMaterializationResult,
} from '@/agent/executionRuns/profiles/review/hostActionMaterializer';
import type { ReviewRunCommentService } from '@/agent/executionRuns/profiles/review/reviewComments';
import { readRetainedReviewFindings } from '@/agent/reviews/normalize/readRetainedReviewFindings';
import { readExecutionRunErrorCode } from './errors';
import { resolveExecutionRunResumeBackendOptions } from './resolveExecutionRunResumeBackendOptions';

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function backendTargetsEqual(left: BackendTargetRefV1, right: BackendTargetRefV1): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'builtInAgent' && right.kind === 'builtInAgent'
    ? left.agentId === right.agentId
    : left.kind === 'configuredAcpBackend' && right.kind === 'configuredAcpBackend'
      ? left.backendId === right.backendId
      : false;
}

export async function applyExecutionRunAction(args: Readonly<{
  runId: string;
  params: ExecutionRunActionParams;
  runs: Map<string, ExecutionRunState>;
  controllers: ReadonlyMap<string, ExecutionRunController>;
  voiceAgentManager: VoiceAgentManager;
  startRun: (params: ExecutionRunManagerStartParams) => Promise<ExecutionRunStartResult>;
  enqueueCommittedAcp?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: {
      localId: string;
      meta?: Record<string, unknown>;
      provenance: Readonly<{ kind: 'non_dependent'; source: 'external' }>;
    },
  ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  parentProvider: ACPProvider;
  onVoiceAgentWelcomed?: (runId: string, welcomedEpoch: number) => Promise<void> | void;
  profileCatalog?: ExecutionRunProfileContributionCatalog;
  materializeReviewHostAction?: (
    readCurrentCandidate: () => ReviewCommentHostActionCandidate | null,
    isRunActive: () => boolean,
  ) => Promise<ReviewCommentHostActionMaterializationResult>;
  causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
  effectiveCallerPermissionMode?: string;
  reviewComments?: ReviewRunCommentService;
  applyReviewNarrationAction?: (actionId: 'review.walkthrough' | 'review.explain_findings', input: unknown) => Promise<ExecutionRunActionResult>;
}>): Promise<ExecutionRunActionResult> {
  const run = args.runs.get(args.runId);
  if (args.params.actionId === 'review.triage') {
    // A finding's decision lives only in its ReviewComment; the run's result is not rewritten.
    if (!ReviewTriageOverlaySchema.safeParse(args.params.input ?? {}).success) {
      return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Invalid triage overlay' };
    }
    if (!args.reviewComments) return { ok: false, errorCode: 'review_comment_persistence_unavailable', error: 'ReviewComment persistence is unavailable' };
    const retainedPayload = run ? readRetainedReviewFindings(run) : null;
    return await args.reviewComments.triage(args.runId, args.params.input, retainedPayload?.findings);
  }
  if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };

  if (args.params.actionId === 'review.walkthrough' || args.params.actionId === 'review.explain_findings') {
    return args.applyReviewNarrationAction
      ? await args.applyReviewNarrationAction(args.params.actionId, args.params.input)
      : { ok: false, errorCode: 'execution_run_host_action_unavailable', error: 'Review narration host services are unavailable' };
  }

  if (run.intent === 'review' && isReviewRunStartActionIdV1(args.params.actionId)) {
    // This stays runtime-owned because follow-up orchestration needs the live run and
    // startRun/retention plumbing, not just a pure profile transform.
    const current = projectExecutionRunPublicState(run, args.controllers.get(args.runId) ?? null);
    if (isExecutionRunActive(current) || current.lifecycle?.state === 'recovering') {
      return { ok: false, errorCode: 'execution_run_busy', error: 'The review is still running or retiring' };
    }
    const newRound = args.params.actionId === REVIEW_NEW_ROUND_ACTION_ID_V1
      ? ReviewNativeNewRoundInputV1Schema.safeParse(args.params.input ?? {}) : null;
    if (newRound && !newRound.success) {
      return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Invalid new-round input' };
    }
    const continuity = resolveReviewRunContinuityV1(current, newRound?.success
      ? { kind: 'new_round', ...newRound.data } : { kind: 'follow_up' });
    if (!continuity.ok) return continuity;
    const continueRetained = continuity.continuity === 'continues';
    const retainedStartContext = {
      ...(run.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: run.requesterWorkAttributionV1 } : {}),
      ...(run.roleId ? { roleId: run.roleId } : {}),
    };

    if (newRound?.success) {
      let paidSelection: ReviewEngineListItem | undefined;
      try {
        const selected = args.profileCatalog ? resolveExecutionRunProfileSelectionForAgent(args.profileCatalog, {
          intent: 'review', agentId: run.backendId, profileId: run.profileId, profileSourceCustody: run.profileSourceCustody,
        }) : null;
        const profile = selected && args.profileCatalog ? resolveExecutionRunProfileContributionDescriptor(args.profileCatalog, selected.profileId) : null;
        const costConsent = readReviewProfileCostConsent(profile);
        if (costConsent) paidSelection = {
          engineId: run.backendId, value: buildBackendTargetKeyV2(readBackendTargetRefV2(run.backendTarget)),
          label: profile?.title ?? run.backendId, enabled: true,
          capabilities: { structuredNarration: false }, costConsent, ...(selected ? { profileId: selected.profileId } : {}),
        };
      } catch (error) {
        return { ok: false, errorCode: readExecutionRunErrorCode(error) ?? 'invalid_input',
          error: error instanceof Error ? error.message : 'Review round preparation failed' };
      }
      if (!args.reviewComments) return { ok: false, errorCode: 'review_record_unavailable', error: 'Review records are unavailable' };
      let preparedReview: Awaited<ReturnType<ReviewRunCommentService['prepareNewRound']>>;
      try { preparedReview = await args.reviewComments.prepareNewRound(run); }
      catch (error) {
        return { ok: false, errorCode: readExecutionRunErrorCode(error) ?? 'action_failed',
          error: error instanceof Error ? error.message : 'Review round preparation failed' };
      }
      const { reviewInput, ...prepared } = preparedReview;
      const roundInput = paidSelection
        ? refreshReviewNewRoundCostConsentV1(reviewInput, paidSelection, newRound.data.costConsent)
        : run.intentInput && typeof run.intentInput === 'object' ? run.intentInput : {};
      const { start: retainedStart, ...selection } = resolveExecutionRunResumeBackendOptions({ run });
      const previousInput = run.intentInput && typeof run.intentInput === 'object' ? run.intentInput : {};
      const previousRoundContext = {
        reviewRound: 'reviewRound' in previousInput ? previousInput.reviewRound : null,
        reviewFindings: newRound.data.fresh ? null : readRetainedReviewFindings(run),
      };
      try {
        const started = await args.startRun({ ...retainedStart, ...selection, ...retainedStartContext,
          sessionId: run.sessionId, intent: 'review', backendTarget: run.backendTarget,
          instructions: run.instructions,
          intentInput: { ...roundInput,
            ...prepared, previousRoundContext, reviewRoundSettlement: 'execution' },
          ...(run.runtimeSettings?.accountSettings ? { accountSettings: run.runtimeSettings.accountSettings } : {}),
          ...(run.display ? { display: run.display } : {}),
          permissionMode: args.effectiveCallerPermissionMode ?? run.permissionMode,
          approvalProfileId: run.approvalProfileId ?? null,
          ...(args.causalPermissionAuthority ? { causalPermissionAuthority: args.causalPermissionAuthority } : {}),
          retentionPolicy: run.retentionPolicy, runClass: run.runClass, ioMode: run.ioMode,
          ...(continueRetained ? (run.resumeHandle ? { resumeHandle: run.resumeHandle } : {}) : { resumeHandle: null }),
          parentRunId: run.runId,
        });
        return { ok: true, result: { ...started, reviewRound: prepared.reviewRound,
          ...(prepared.comparisonId ? { comparisonId: prepared.comparisonId } : {}) } };
      } catch (error) {
        await args.reviewComments.failUnstartedRound(prepared.reviewRound);
        return { ok: false, errorCode: readExecutionRunErrorCode(error) ?? 'action_failed',
          error: error instanceof Error ? error.message : 'Review launch failed' };
      }
    }

    const parsed = ReviewFollowUpInputSchema.safeParse(args.params.input ?? {});
    if (!parsed.success) {
      return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Invalid follow-up input' };
    }

    const existingPayload = readRetainedReviewFindings(run);
    if (!existingPayload) {
      return { ok: false, errorCode: 'execution_run_action_not_supported', error: 'Not a review run' };
    }

    const threadId = parsed.data.threadId ?? `review_thread_${randomUUID()}`;
    let started: ExecutionRunStartResult;
    try { started = await args.startRun({ ...retainedStartContext,
      sessionId: run.sessionId,
      intent: 'review',
      backendTarget: run.backendTarget,
      ...(run.runtimeSettings?.accountSettings ? { accountSettings: run.runtimeSettings.accountSettings } : {}),
      instructions: run.instructions,
      intentInput: {
        kind: 'review_follow_up.v1',
        parentRunRef: existingPayload.runRef,
        threadId,
        findingIds: parsed.data.findingIds,
        ...(parsed.data.replyToQuestionId ? { replyToQuestionId: parsed.data.replyToQuestionId } : {}),
        messageMarkdown: parsed.data.messageMarkdown,
        summary: existingPayload.summary,
        overviewMarkdown: existingPayload.overviewMarkdown,
        findings: existingPayload.findings,
        questions: existingPayload.questions,
        assumptions: existingPayload.assumptions,
      },
      ...(run.display ? { display: run.display } : {}),
      permissionMode: args.effectiveCallerPermissionMode ?? run.permissionMode,
      approvalProfileId: run.approvalProfileId ?? null,
      ...(args.causalPermissionAuthority
        ? { causalPermissionAuthority: args.causalPermissionAuthority }
        : {}),
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'streaming',
      resumeHandle: run.resumeHandle,
      ...(run.profileId ? { profileId: run.profileId } : {}),
      parentRunId: run.runId,
    }); } catch (error) {
      if (readExecutionRunErrorCode(error) !== 'execution_run_busy') throw error;
      return { ok: false, errorCode: 'execution_run_busy', error: 'The reviewer is processing another input' };
    }

    return { ok: true, result: { threadId, ...started } };
  }

  if (run.intent === 'voice_agent') {
    // Voice commit/welcome remain runtime-owned orchestration because they require the live
    // VoiceAgentManager and controller identity. The profile controls visibility; the runtime
    // owns the imperative side effects.
    const actionId = String(args.params.actionId ?? '').trim();
    if (actionId === 'voice_agent.commit') {
      const ctrl = args.controllers.get(args.runId);
      if (!ctrl || ctrl.kind !== 'voice_agent') {
        return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
      }
      try {
        const maxChars = (() => {
          const v: any = args.params.input ?? null;
          const raw = Number(v?.maxChars ?? 0);
          return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
        })();
        const committed = await args.voiceAgentManager.commit({
          voiceAgentId: ctrl.voiceAgentId,
          ...(maxChars ? { maxChars } : {}),
          ...(args.causalPermissionAuthority
            ? { causalPermissionAuthority: args.causalPermissionAuthority }
            : {}),
        });
        const updatedResumeHandle = run.retentionPolicy === 'resumable' ? args.voiceAgentManager.getResumeHandle(ctrl.voiceAgentId) : null;
        if (updatedResumeHandle && run.retentionPolicy === 'resumable') {
          const latest = args.runs.get(args.runId) ?? null;
          if (latest && latest.status === 'running') {
            args.runs.set(args.runId, { ...latest, resumeHandle: updatedResumeHandle });
          }
        }
        return { ok: true, result: { commitText: committed.commitText } };
      } catch (e) {
        if (e instanceof VoiceAgentError) {
          if (e.code === 'VOICE_AGENT_BUSY') return { ok: false, errorCode: 'execution_run_busy', error: e.message };
          if (e.code === 'VOICE_AGENT_NOT_FOUND') return { ok: false, errorCode: 'execution_run_not_found', error: e.message };
          return { ok: false, errorCode: 'execution_run_failed', error: e.message };
        }
        return { ok: false, errorCode: readExecutionRunErrorCode(e) ?? 'execution_run_failed', error: e instanceof Error ? e.message : 'Commit failed' };
      }
    }
    if (actionId === 'voice_agent.welcome') {
      const ctrl = args.controllers.get(args.runId);
      if (!ctrl || ctrl.kind !== 'voice_agent') {
        return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
      }
      try {
        const welcomeText = (() => {
          const input = args.params.input;
          const raw: unknown = input && typeof input === 'object' ? Reflect.get(input, 'welcomeText') : undefined;
          return typeof raw === 'string' ? raw : undefined;
        })();
        const welcomed = await args.voiceAgentManager.welcome({
          voiceAgentId: ctrl.voiceAgentId,
          ...(welcomeText !== undefined ? { welcomeText } : {}),
          ...(args.causalPermissionAuthority
            ? { causalPermissionAuthority: args.causalPermissionAuthority }
            : {}),
        });
        await args.onVoiceAgentWelcomed?.(args.runId, ctrl.transcript.epoch);
        return { ok: true, result: { assistantText: welcomed.assistantText,
          ...(welcomed.preparedInstructionsFor ? { preparedInstructionsFor: welcomed.preparedInstructionsFor } : {}) } };
      } catch (e) {
        if (e instanceof VoiceAgentError) {
          if (e.code === 'VOICE_AGENT_BUSY') return { ok: false, errorCode: 'execution_run_busy', error: e.message };
          if (e.code === 'VOICE_AGENT_NOT_FOUND') return { ok: false, errorCode: 'execution_run_not_found', error: e.message };
          return { ok: false, errorCode: 'execution_run_failed', error: e.message };
        }
        return { ok: false, errorCode: 'execution_run_failed', error: e instanceof Error ? e.message : 'Welcome failed' };
      }
    }
  }

  const profile = args.profileCatalog
    ? resolveExecutionRunIntentProfileFromCatalog(
        args.profileCatalog,
        run.intent,
        run.profileId,
        run.profileSourceCustody,
      )
    : resolveExecutionRunIntentProfile(run.intent);
  const availableActionIds = profile.listAvailableActionIds?.({
    start: buildExecutionRunProfileStartParams(run),
    structuredMeta: run.structuredMeta ?? null,
    controllerKind: args.controllers.get(args.runId)?.kind ?? null,
  }) ?? [];
  if (run.status !== 'succeeded' && args.params.actionId === 'reviews.comments.create') {
    return { ok: false, errorCode: 'execution_run_action_not_supported', error: 'Review comment proposals are not available for an incomplete run' };
  }
  if (!availableActionIds.includes(args.params.actionId)) {
    return { ok: false, errorCode: 'execution_run_action_not_supported', error: 'Action is not available for this run' };
  }
  if (args.params.actionId === 'reviews.comments.create') {
    if (!args.materializeReviewHostAction || !args.profileCatalog) {
      return { ok: false, errorCode: 'execution_run_host_action_unavailable', error: 'Review host-action materialization is unavailable' };
    }
    const readCurrentCandidate = (): ReviewCommentHostActionCandidate | null => {
      const current = args.runs.get(args.runId);
      if (!current || current.status !== 'succeeded' || current.intent !== 'review') return null;
      if (current.sessionId === null) return null;
      const profileId = typeof current.profileId === 'string' ? current.profileId.trim() : '';
      if (!profileId) return null;
      const descriptor = args.profileCatalog?.profileDescriptorsById.get(profileId) ?? null;
      if (!descriptor?.pluginId || !descriptor.definition.actions?.some(
        (action) => action.kind === 'hostAction' && action.actionId === 'reviews.comments.create',
      )) return null;
      const retained = current.structuredMeta?.kind === 'review_findings.v2'
        ? ReviewFindingsV2Schema.safeParse(current.structuredMeta.payload)
        : null;
      if (!retained?.success
        || retained.data.runRef.runId !== current.runId
        || retained.data.runRef.callId !== current.callId
        || retained.data.runRef.backendId !== current.backendId
        || (retained.data.runRef.backendTarget
          && !backendTargetsEqual(retained.data.runRef.backendTarget, current.backendTarget))
        || !retained.data.proposedComments?.length) return null;
      return Object.freeze({
        actionId: 'reviews.comments.create',
        sessionId: current.sessionId,
        runId: current.runId,
        callId: current.callId,
        profileId,
        pluginId: descriptor.pluginId,
        agentId: current.backendId,
        proposals: retained.data.proposedComments,
      });
    };
    let materialized: ReviewCommentHostActionMaterializationResult;
    try {
      materialized = await args.materializeReviewHostAction(readCurrentCandidate,
        () => args.runs.get(args.runId)?.status === 'succeeded');
    } catch {
      return {
        ok: false,
        errorCode: 'execution_run_host_action_failed',
        error: 'Review host-action materialization failed',
      };
    }
    return materialized.ok
      ? { ok: true, result: materialized.result }
      : materialized;
  }
  if (!profile.applyAction) {
    return { ok: false, errorCode: 'execution_run_action_not_supported', error: 'Unsupported action' };
  }

  const acted = profile.applyAction({
    start: buildExecutionRunProfileStartParams(run),
    actionId: args.params.actionId,
    input: args.params.input,
    structuredMeta: run.structuredMeta ?? null,
  });

  if (!acted.ok) {
    return { ok: false, errorCode: acted.errorCode, error: acted.error };
  }

  args.runs.set(args.runId, {
    ...run,
    ...(acted.updatedStructuredMeta ? { structuredMeta: acted.updatedStructuredMeta } : {}),
    ...(typeof acted.updatedToolResultOutput !== 'undefined' ? { latestToolResult: acted.updatedToolResultOutput } : {}),
  });

  const toolResultBody: ACPMessageData = {
    type: 'tool-result',
    callId: run.callId,
    output: acted.updatedToolResultOutput ?? { ok: true, actionId: args.params.actionId },
    id: randomUUID(),
  };

  if (!args.enqueueCommittedAcp) {
    return {
      ok: false,
      errorCode: 'execution_run_transcript_custody_unavailable',
      error: 'Durable execution-run transcript custody is unavailable',
    };
  }
  try {
    const admission = await args.enqueueCommittedAcp(args.parentProvider, toolResultBody, {
      localId: randomUUID(),
      ...(acted.updatedToolResultMeta ? { meta: acted.updatedToolResultMeta } : {}),
      provenance: { kind: 'non_dependent', source: 'external' },
    });
    if (!admission.persisted) {
      return {
        ok: false,
        errorCode: 'execution_run_transcript_custody_unavailable',
        error: 'Durable execution-run transcript custody is unavailable',
      };
    }
  } catch {
    return {
      ok: false,
      errorCode: 'execution_run_transcript_custody_unavailable',
      error: 'Durable execution-run transcript custody is unavailable',
    };
  }

  return { ok: true, updatedToolResult: acted.updatedToolResultOutput ?? { ok: true } };
}
