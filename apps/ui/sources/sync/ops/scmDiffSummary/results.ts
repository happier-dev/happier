import {
  ScmDiffSummaryResultReadInputSchema, ScmDiffSummaryResultEditInputSchema, ScmDiffSummaryResultRevisionInputSchema,
  ScmDiffSummaryRefineInputSchema, ScmDiffSummaryAddOutputsInputSchema, ScmDiffSummaryDiscussInputSchema,
  ScmDiffSummaryResultResponseSchema, ScmDiffSummaryResultDeleteResponseSchema,
  type ScmDiffSummaryResultReadInput, type ScmDiffSummaryResultEditInput, type ScmDiffSummaryResultRevisionInput,
  type ScmDiffSummaryRefineInput, type ScmDiffSummaryAddOutputsInput, type ScmDiffSummaryDiscussInput,
  type ScmDiffSummaryResultResponse, type ScmDiffSummaryResultDeleteResponse,
  ScmCommitPlanAcceptInputSchema, ScmCommitPlanControlInputSchema, ScmCommitPlanIncludeHookChangesInputSchema,
  type ScmCommitPlanAcceptInput, type ScmCommitPlanControlInput, type ScmCommitPlanIncludeHookChangesInput,
} from '@happier-dev/protocol/scm';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionDraftRecipientValueV1Schema } from '@happier-dev/protocol/drafts/sessionDrafts';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { ActionPrepareResult } from '@happier-dev/protocol/actions/executor/types';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getSessionDraftSnapshot, writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';
import type { z } from 'zod';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { randomUUID } from '@/platform/randomUUID';

export type ScmDiffSummaryResultRpc = (method: string, input: Readonly<{ cwd: string }>, options: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>;
type CommitPlanMutationAction = 'scm.diffSummary.commitPlan.accept' | 'scm.diffSummary.commitPlan.includeHookChanges';
export type ScmCommitPlanOperationResult = ScmDiffSummaryResultResponse | Readonly<{
  success: false; errorCode: string; error: string; approvalArtifactId?: string;
}>;

/** A consumer captures its Account/Session lifetime; saved results have no device-global authority. */
export function createScmDiffSummaryResultOperations(params: Readonly<{
  sessionId: string; serverId?: string | null; accountId?: string | null; signal?: AbortSignal;
  shouldContinue: () => boolean; rpc?: ScmDiffSummaryResultRpc;
  composerDraft?: Readonly<{ scope: ServerAccountScope }>;
  actionExecutor?: Readonly<{ prepare: (actionId: CommitPlanMutationAction, input: unknown, context?: UiActionExecutorContext) => Promise<ActionPrepareResult> }>;
}>) {
  const rpc: ScmDiffSummaryResultRpc = params.rpc ?? (async (method, input, options) => {
    const { runSessionScmRpc } = await import('@/sync/ops/sessionScm');
    return runSessionScmRpc(params.sessionId, method, input, params.serverId, options.signal, params.accountId);
  });
  const current = () => !params.signal?.aborted && params.shouldContinue();
  async function invoke<T extends ScmDiffSummaryResultResponse | ScmDiffSummaryResultDeleteResponse>(
    method: string, input: Readonly<{ cwd: string }>, schema: z.ZodType<T>,
  ): Promise<T | Extract<ScmDiffSummaryResultResponse, { success: false }>> {
    if (!current()) return { success: false, errorCode: 'result_unavailable', error: 'The captured Account or Session retired.' };
    try {
      const raw = await rpc(method, input, { ...(params.signal ? { signal: params.signal } : {}) });
      if (!current()) return { success: false, errorCode: 'result_unavailable', error: 'The captured Account or Session retired.' };
      const parsed = schema.safeParse(raw);
      if (parsed.success) return parsed.data;
      // Unsupported older daemons and transport errors degrade at this operation only.
      if (raw && typeof raw === 'object' && 'error' in raw && typeof raw.error === 'string') return { success: false, errorCode: 'result_unavailable', error: raw.error };
      return { success: false, errorCode: 'result_unavailable', error: 'The saved-result response could not be validated.' };
    } catch (error) {
      return { success: false, errorCode: 'result_unavailable', error: error instanceof Error ? error.message : 'The owning machine is unavailable.' };
    }
  }
  const operation = (method: string, input: Readonly<{ cwd: string }>) => invoke(method, input, ScmDiffSummaryResultResponseSchema);
  async function discuss(input: ScmDiffSummaryDiscussInput): Promise<ScmDiffSummaryResultResponse> {
    const validated = ScmDiffSummaryDiscussInputSchema.parse(input);
    const draft = params.composerDraft;
    const readRecipientField = () => {
      if (!draft) return null;
      const document = getSessionDraftSnapshot(draft.scope, { kind: 'session', sessionId: params.sessionId })?.document;
      return document?.target.kind === 'session' ? document.target.routing.recipient : null;
    };
    const capturedField = readRecipientField();
    if (draft) {
      const routing = SessionDraftRecipientValueV1Schema.safeParse(capturedField?.value);
      const { message: _message, ...target } = validated;
      if (!routing.success || routing.data?.mode !== 'scm_diff_summary'
        || !pluginJsonValuesEqual(StrictJsonValueSchema.parse(routing.data.target), StrictJsonValueSchema.parse(target))) {
        return { success: false, errorCode: 'discussion_unavailable', error: 'The composer discussion target changed. Select it again before sending.' };
      }
    }
    const response = await operation(RPC_METHODS.SCM_DIFF_SUMMARY_DISCUSS, validated);
    if (!response.success || !draft) return response;
    const runId = response.runId;
    if (!runId) return { success: false, errorCode: 'admission_unknown', error: 'The admitted conversation could not be identified. Refresh the saved result before sending again.' };
    // The exact routing field owns this transition. A newer recipient selection survives.
    if (current() && readRecipientField()?.mutationId === capturedField?.mutationId) {
      writeExistingSessionDraft({ scope: draft.scope, sessionId: params.sessionId,
        patch: { routing: { recipient: StrictJsonValueSchema.parse({ mode: 'manual', recipient: { kind: 'execution_run', runId } }) } },
        materializationIntent: 'userEdit' });
    }
    return response;
  }
  async function confirmedOperation(actionId: CommitPlanMutationAction, input: ScmCommitPlanAcceptInput | ScmCommitPlanIncludeHookChangesInput): Promise<ScmCommitPlanOperationResult> {
    if (!current()) return { success: false, errorCode: 'result_unavailable', error: 'The captured Account or Session retired.' };
    try {
      const executor = params.actionExecutor ?? (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
      const prepared = await executor.prepare(actionId, input, {
        surface: 'ui', actionRequestId: randomUUID(), defaultSessionId: params.sessionId,
        externalActionTarget: { kind: 'session', sessionId: params.sessionId },
        ...(params.serverId ? { serverId: params.serverId } : {}),
        ...(params.accountId ? { expectedAccountId: params.accountId } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      if (!current()) return { success: false, errorCode: 'result_unavailable', error: 'The captured Account or Session retired.' };
      const response = prepared.kind === 'settled' ? prepared.result : await prepared.invocation.run();
      if (!current()) return { success: false, errorCode: 'result_unavailable', error: 'The captured Account or Session retired.' };
      if (!response.ok) return { success: false, errorCode: response.errorCode ?? 'result_unavailable', error: response.error };
      const approval = ActionApprovalRequestCreatedResultSchema.safeParse(response.result);
      if (approval.success) return { success: false, errorCode: 'approval_required', error: 'The Action awaits approval.', approvalArtifactId: approval.data.artifactId };
      const parsed = ScmDiffSummaryResultResponseSchema.safeParse(response.result);
      return parsed.success ? parsed.data : { success: false, errorCode: 'result_unavailable', error: 'The saved-result response could not be validated.' };
    } catch (error) {
      return { success: false, errorCode: 'result_unavailable', error: error instanceof Error ? error.message : 'The owning machine is unavailable.' };
    }
  }
  return {
    read: (input: ScmDiffSummaryResultReadInput) => operation(RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ, ScmDiffSummaryResultReadInputSchema.parse(input)),
    edit: (input: ScmDiffSummaryResultEditInput) => operation(RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_EDIT, ScmDiffSummaryResultEditInputSchema.parse(input)),
    undo: (input: ScmDiffSummaryResultRevisionInput) => operation(RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_UNDO, ScmDiffSummaryResultRevisionInputSchema.parse(input)),
    refine: (input: ScmDiffSummaryRefineInput) => operation(RPC_METHODS.SCM_DIFF_SUMMARY_REFINE, ScmDiffSummaryRefineInputSchema.parse(input)),
    addOutputs: (input: ScmDiffSummaryAddOutputsInput) => operation(RPC_METHODS.SCM_DIFF_SUMMARY_ADD_OUTPUTS, ScmDiffSummaryAddOutputsInputSchema.parse(input)),
    discuss,
    acceptCommitPlan: (input: ScmCommitPlanAcceptInput) => confirmedOperation('scm.diffSummary.commitPlan.accept', ScmCommitPlanAcceptInputSchema.parse(input)),
    includeCommitPlanHookChanges: (input: ScmCommitPlanIncludeHookChangesInput) => confirmedOperation('scm.diffSummary.commitPlan.includeHookChanges', ScmCommitPlanIncludeHookChangesInputSchema.parse(input)),
    stopCommitPlan: (input: ScmCommitPlanControlInput) => operation('scm.diffSummary.commitPlan.stop', ScmCommitPlanControlInputSchema.parse(input)),
    cancelCommitPlan: (input: ScmCommitPlanControlInput) => operation('scm.diffSummary.commitPlan.cancel', ScmCommitPlanControlInputSchema.parse(input)),
    recoverCommitPlan: (input: ScmCommitPlanControlInput) => operation('scm.diffSummary.commitPlan.recover', ScmCommitPlanControlInputSchema.parse(input)),
    delete: (input: ScmDiffSummaryResultRevisionInput) => invoke(RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_DELETE,
      ScmDiffSummaryResultRevisionInputSchema.parse(input), ScmDiffSummaryResultDeleteResponseSchema),
  };
}
