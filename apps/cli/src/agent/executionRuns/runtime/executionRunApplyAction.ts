import { randomUUID } from 'node:crypto';

import {
  ReviewFindingsV1Schema,
  ReviewFindingsV2Schema,
  ReviewFollowUpInputSchema,
} from '@happier-dev/protocol';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { resolveExecutionRunIntentProfile } from '../profiles/intentRegistry';
import { buildReviewFindingsV2Payload } from '../../reviews/normalize/buildReviewFindingsV2Payload';
import { VoiceAgentError, type VoiceAgentManager } from '../../voice/agent/VoiceAgentManager';
import { buildExecutionRunProfileStartParams } from './profileStart';
import {
  readExecutionRunParentSessionPermissionResponseTarget,
  type ExecutionRunParentSessionPermissionResponseTarget,
} from '@/agent/executionRuns/policy/executionRunPermissionInteractionPolicy';
import type {
  ExecutionRunActionParams,
  ExecutionRunActionResult,
  ExecutionRunManagerStartParams,
  ExecutionRunStartResult,
  ExecutionRunState,
} from '@/agent/executionRuns/runtime/executionRunTypes';
import type { ExecutionRunController } from '../controllers/types';

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readExecutionRunPermissionResponseInput(input: unknown): Readonly<{
  requestId: string;
  approved: boolean;
  responseTarget: ExecutionRunParentSessionPermissionResponseTarget | null;
}> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const responseTarget = readExecutionRunParentSessionPermissionResponseTarget(record.responseTarget);
  const requestId = readNonEmptyString(record.requestId) ?? responseTarget?.providerRequestId ?? null;
  if (!requestId || typeof record.approved !== 'boolean') {
    return null;
  }

  return {
    requestId,
    approved: record.approved,
    responseTarget,
  };
}

export async function applyExecutionRunAction(args: Readonly<{
  runId: string;
  params: ExecutionRunActionParams;
  runs: Map<string, ExecutionRunState>;
  controllers: ReadonlyMap<string, ExecutionRunController>;
  respondToPermissionRequest: (args: Readonly<{
    runId: string;
    requestId: string;
    approved: boolean;
    responseTarget?: ExecutionRunParentSessionPermissionResponseTarget | null;
  }>) => Promise<{ ok: boolean; errorCode?: string; error?: string }>;
  voiceAgentManager: VoiceAgentManager;
  startRun: (params: ExecutionRunManagerStartParams) => Promise<ExecutionRunStartResult>;
  sendAcp: (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
  sendCommittedAcp?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; meta?: Record<string, unknown> },
  ) => Promise<void>;
  parentProvider: ACPProvider;
  onVoiceAgentWelcomed?: (runId: string, welcomedEpoch: number) => Promise<void> | void;
}>): Promise<ExecutionRunActionResult> {
  const run = args.runs.get(args.runId);
  if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };

  if (String(args.params.actionId ?? '').trim() === 'permission.respond') {
    const parsed = readExecutionRunPermissionResponseInput(args.params.input ?? null);
    if (!parsed) {
      return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Invalid permission response input' };
    }
    return await args.respondToPermissionRequest({
      runId: args.runId,
      requestId: parsed.requestId,
      approved: parsed.approved,
      ...(parsed.responseTarget ? { responseTarget: parsed.responseTarget } : {}),
    });
  }

  if (run.intent === 'review' && String(args.params.actionId ?? '').trim() === 'review.follow_up') {
    // This stays runtime-owned because follow-up orchestration needs the live run and
    // startRun/retention plumbing, not just a pure profile transform.
    const canResume = run.retentionPolicy === 'resumable' && Boolean(run.resumeHandle);
    const canFallback = (() => {
      const target = run.backendTarget;
      if (!target) return false;
      if (target.kind !== 'builtInAgent') return false;
      // Coderabbit runs are not follow-up capable unless we can resume the original vendor session.
      if (target.agentId === 'coderabbit') return false;
      return true;
    })();
    if (!canResume && !canFallback) {
      return { ok: false, errorCode: 'execution_run_action_not_supported', error: 'Follow-up is not supported for this run' };
    }

    const parsed = ReviewFollowUpInputSchema.safeParse(args.params.input ?? {});
    if (!parsed.success) {
      return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Invalid follow-up input' };
    }

    const existingPayload =
      run.structuredMeta?.kind === 'review_findings.v2'
        ? ReviewFindingsV2Schema.parse(run.structuredMeta.payload)
        : run.structuredMeta?.kind === 'review_findings.v1'
          ? (() => {
            const legacy = ReviewFindingsV1Schema.parse(run.structuredMeta.payload);
            return buildReviewFindingsV2Payload({
              runId: legacy.runRef.runId,
              callId: legacy.runRef.callId,
              backendId: legacy.runRef.backendId,
              backendTarget: legacy.runRef.backendTarget,
              summary: legacy.summary,
              findings: legacy.findings,
              triage: legacy.triage,
              limits: legacy.limits,
              generatedAtMs: legacy.generatedAtMs,
            });
          })()
          : null;
    if (!existingPayload) {
      return { ok: false, errorCode: 'execution_run_action_not_supported', error: 'Not a review run' };
    }

    const threadId = parsed.data.threadId ?? `review_thread_${randomUUID()}`;
    const started = await args.startRun({
      sessionId: run.sessionId,
      intent: 'review',
      backendTarget: run.backendTarget,
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
      permissionMode: run.permissionMode,
      retentionPolicy: run.resumeHandle ? 'resumable' : 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
      ...(run.resumeHandle ? { resumeHandle: run.resumeHandle } : {}),
      parentRunId: run.runId,
    });

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
        const committed = await args.voiceAgentManager.commit({ voiceAgentId: ctrl.voiceAgentId, ...(maxChars ? { maxChars } : {}) });
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
        return { ok: false, errorCode: 'execution_run_failed', error: e instanceof Error ? e.message : 'Commit failed' };
      }
    }
    if (actionId === 'voice_agent.welcome') {
      const ctrl = args.controllers.get(args.runId);
      if (!ctrl || ctrl.kind !== 'voice_agent') {
        return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
      }
      try {
        const welcomeText = (() => {
          const v: any = args.params.input ?? null;
          const raw = typeof v?.welcomeText === 'string' ? v.welcomeText.trim() : '';
          return raw ? raw : undefined;
        })();
        const welcomed = await args.voiceAgentManager.welcome({ voiceAgentId: ctrl.voiceAgentId, ...(welcomeText ? { welcomeText } : {}) });
        await args.onVoiceAgentWelcomed?.(args.runId, ctrl.transcript.epoch);
        return { ok: true, result: { assistantText: welcomed.assistantText } };
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

  const profile = resolveExecutionRunIntentProfile(run.intent);
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

  if (args.sendCommittedAcp) {
    try {
      await args.sendCommittedAcp(args.parentProvider, toolResultBody, {
        localId: randomUUID(),
        ...(acted.updatedToolResultMeta ? { meta: acted.updatedToolResultMeta } : {}),
      });
    } catch {
      args.sendAcp(
        args.parentProvider,
        toolResultBody,
        acted.updatedToolResultMeta ? { meta: acted.updatedToolResultMeta } : undefined,
      );
    }
  } else {
    // Re-emit a tool-result so the owning tool-call message can merge updated meta.
    args.sendAcp(
      args.parentProvider,
      toolResultBody,
      acted.updatedToolResultMeta ? { meta: acted.updatedToolResultMeta } : undefined,
    );
  }

  return { ok: true, updatedToolResult: acted.updatedToolResultOutput ?? { ok: true } };
}
