import {
  ScmDiffSummaryResultReadInputSchema, ScmDiffSummaryResultEditInputSchema, ScmDiffSummaryResultRevisionInputSchema,
  ScmDiffSummaryRefineInputSchema, ScmDiffSummaryAddOutputsInputSchema, ScmDiffSummaryDiscussInputSchema,
  ScmDiffSummaryResultResponseSchema, ScmDiffSummaryResultDeleteResponseSchema,
  type ScmDiffSummaryResultReadInput, type ScmDiffSummaryResultEditInput, type ScmDiffSummaryResultRevisionInput,
  type ScmDiffSummaryRefineInput, type ScmDiffSummaryAddOutputsInput, type ScmDiffSummaryDiscussInput,
  type ScmDiffSummaryResultResponse,
  ScmCommitPlanAcceptInputSchema, ScmCommitPlanControlInputSchema, ScmCommitPlanIncludeHookChangesInputSchema,
  type ScmCommitPlanAcceptInput, type ScmCommitPlanControlInput, type ScmCommitPlanIncludeHookChangesInput,
  ScmReviewedMarkInputSchema, ScmReviewedMarkResponseSchema, type ScmReviewedMarkInput,
} from '@happier-dev/protocol/scm';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { SessionDraftRecipientValueV1Schema } from '@happier-dev/protocol/drafts/sessionDrafts';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getSessionDraftSnapshot, writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { invokeUiScmAction, type UiScmActionExecutor } from '@/sync/ops/scm/scmActionInvocation';
import type { z } from 'zod';

export type ScmDiffSummaryResultRpc = (method: string, input: Readonly<{ cwd: string }>, options: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>;
/** Transport authority is an actual Session or Machine, never a Project's presentation scope. */
export type ScmDiffSummaryHost = Readonly<{ sessionId: string; machineId?: never }> | Readonly<{ machineId: string; sessionId?: never }>;
export type ScmCommitPlanOperationResult = ScmDiffSummaryResultResponse | Readonly<{
  success: false; errorCode: string; error: string; approvalArtifactId?: string;
}>;

/** A consumer captures its Account/Session lifetime; saved results have no device-global authority. */
export function createScmDiffSummaryResultOperations(params: ScmDiffSummaryHost & Readonly<{
  serverId?: string | null; accountId?: string | null; signal?: AbortSignal;
  shouldContinue: () => boolean;
  /** An admitted generator turn's real observation handle; never a guessed input id. */
  onRunAdmitted?: (observation: Readonly<{ runId: string; inputId: string; resultId: string }>) => void;
  composerDraft?: Readonly<{ scope: ServerAccountScope }>;
  actionExecutor?: UiScmActionExecutor;
}>) {
  const current = () => !params.signal?.aborted && params.shouldContinue();
  function invoke<T>(actionId: ActionId, input: Readonly<{ cwd: string }>, schema: z.ZodType<T>) {
    return invokeUiScmAction({ actionId, input, schema, executor: params.actionExecutor, shouldContinue: current,
      context: {
        ...(params.sessionId ? { defaultSessionId: params.sessionId, externalActionTarget: { kind: 'session' as const, sessionId: params.sessionId } }
          : { externalActionTarget: { kind: 'machine' as const, machineId: params.machineId! } }),
        ...(params.serverId ? { serverId: params.serverId } : {}),
        ...(params.accountId ? { expectedAccountId: params.accountId } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      } });
  }
  const operation = async (actionId: ActionId, input: Readonly<{ cwd: string }>) => {
    const response = await invoke(actionId, input, ScmDiffSummaryResultResponseSchema);
    if (response.success && response.runId && response.inputId && current()) {
      params.onRunAdmitted?.({ runId: response.runId, inputId: response.inputId, resultId: response.result.resultId });
    }
    return response;
  };
  async function discuss(input: ScmDiffSummaryDiscussInput): Promise<ScmCommitPlanOperationResult> {
    const validated = ScmDiffSummaryDiscussInputSchema.parse(input);
    const draft = params.sessionId ? params.composerDraft : undefined;
    const readRecipientField = () => {
      if (!draft) return null;
      const document = params.sessionId ? getSessionDraftSnapshot(draft.scope, { kind: 'session', sessionId: params.sessionId })?.document : null;
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
    const response = await operation('scm.diffSummary.discuss', validated);
    if (!response.success || !draft) return response;
    const runId = response.runId;
    if (!runId) return { success: false, errorCode: 'admission_unknown', error: 'The admitted conversation could not be identified. Refresh the saved result before sending again.' };
    // The exact routing field owns this transition. A newer recipient selection survives.
    if (params.sessionId && current() && readRecipientField()?.mutationId === capturedField?.mutationId) {
      writeExistingSessionDraft({ scope: draft.scope, sessionId: params.sessionId,
        patch: { routing: { recipient: StrictJsonValueSchema.parse({ mode: 'manual', recipient: { kind: 'execution_run', runId } }) } },
        materializationIntent: 'userEdit' });
    }
    return response;
  }
  return {
    read: (input: ScmDiffSummaryResultReadInput) => operation('scm.diffSummary.result.read', ScmDiffSummaryResultReadInputSchema.parse(input)),
    edit: (input: ScmDiffSummaryResultEditInput) => operation('scm.diffSummary.result.edit', ScmDiffSummaryResultEditInputSchema.parse(input)),
    undo: (input: ScmDiffSummaryResultRevisionInput) => operation('scm.diffSummary.result.undo', ScmDiffSummaryResultRevisionInputSchema.parse(input)),
    refine: (input: ScmDiffSummaryRefineInput) => operation('scm.diffSummary.refine', ScmDiffSummaryRefineInputSchema.parse(input)),
    addOutputs: (input: ScmDiffSummaryAddOutputsInput) => operation('scm.diffSummary.addOutputs', ScmDiffSummaryAddOutputsInputSchema.parse(input)),
    discuss,
    acceptCommitPlan: (input: ScmCommitPlanAcceptInput) => operation('scm.diffSummary.commitPlan.accept', ScmCommitPlanAcceptInputSchema.parse(input)),
    includeCommitPlanHookChanges: (input: ScmCommitPlanIncludeHookChangesInput) => operation('scm.diffSummary.commitPlan.includeHookChanges', ScmCommitPlanIncludeHookChangesInputSchema.parse(input)),
    stopCommitPlan: (input: ScmCommitPlanControlInput) => operation('scm.diffSummary.commitPlan.stop', ScmCommitPlanControlInputSchema.parse(input)),
    cancelCommitPlan: (input: ScmCommitPlanControlInput) => operation('scm.diffSummary.commitPlan.cancel', ScmCommitPlanControlInputSchema.parse(input)),
    recoverCommitPlan: (input: ScmCommitPlanControlInput) => operation('scm.diffSummary.commitPlan.recover', ScmCommitPlanControlInputSchema.parse(input)),
    setReviewed: (input: ScmReviewedMarkInput, reviewed: boolean) => invoke(reviewed ? 'scm.diffSummary.reviewed.mark' : 'scm.diffSummary.reviewed.unmark',
      ScmReviewedMarkInputSchema.parse(input), ScmReviewedMarkResponseSchema),
    delete: (input: ScmDiffSummaryResultRevisionInput) => invoke('scm.diffSummary.result.delete',
      ScmDiffSummaryResultRevisionInputSchema.parse(input), ScmDiffSummaryResultDeleteResponseSchema),
  };
}
