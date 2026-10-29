import {
  ScmDiffSummaryResultReadInputSchema, ScmDiffSummaryResultEditInputSchema, ScmDiffSummaryResultRevisionInputSchema,
  ScmDiffSummaryRefineInputSchema, ScmDiffSummaryAddOutputsInputSchema, ScmDiffSummaryDiscussInputSchema,
  ScmDiffSummaryResultResponseSchema, ScmDiffSummaryResultDeleteResponseSchema,
  type ScmDiffSummaryResultReadInput, type ScmDiffSummaryResultEditInput, type ScmDiffSummaryResultRevisionInput,
  type ScmDiffSummaryRefineInput, type ScmDiffSummaryAddOutputsInput, type ScmDiffSummaryDiscussInput,
  type ScmDiffSummaryResultResponse,
  ScmCommitPlanAcceptInputSchema, ScmCommitPlanControlInputSchema, ScmCommitPlanIncludeHookChangesInputSchema,
  type ScmCommitPlanAcceptInput, type ScmCommitPlanControlInput, type ScmCommitPlanIncludeHookChangesInput,
  ScmReviewedMarkInputSchema, ScmReviewedUnmarkInputSchema, ScmReviewedMarkResponseSchema, type ScmReviewedUnmarkInput,
} from '@happier-dev/protocol/scm';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { SessionDraftRecipientValueV1Schema } from '@happier-dev/protocol/drafts/sessionDrafts';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getSessionDraftSnapshot, writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { invokeUiScmAction, type UiScmActionExecutor, type UiScmActionFailure } from '@/sync/ops/scm/scmActionInvocation';
import { ScmOperationErrorCodeSchema } from '@happier-dev/protocol/scm';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import type { core } from 'zod/mini';

/** Source-control failure codes are presented by their one copy owner; saved-result codes keep the Machine's copy. */
function presentScmFailure<R>(actionId: ActionId, response: R): R {
  const failure = response as Readonly<{ success?: unknown; errorCode?: unknown; error?: unknown }> | null;
  if (!failure || failure.success !== false) return response;
  const scmCode = ScmOperationErrorCodeSchema.safeParse(failure.errorCode);
  if (!scmCode.success) return response;
  const error = typeof failure.error === 'string' ? failure.error : undefined;
  return { ...failure, error: getScmUserFacingError({ errorCode: scmCode.data, error, fallback: error ?? '',
    ...(actionId === 'scm.diffSummary.discuss' ? { subject: 'message' as const } : {}) }) } as R;
}

export type ScmDiffSummaryResultRpc = (method: string, input: Readonly<{ cwd: string }>, options: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>;
/** Transport authority is an actual Session or Machine, never a Project's presentation scope. */
export type ScmDiffSummaryHost = Readonly<{ sessionId: string; machineId?: never }> | Readonly<{ machineId: string; sessionId?: never }>;
export type ScmCommitPlanOperationResult = ScmDiffSummaryResultResponse | Readonly<{
  success: false; errorCode: string; error: string; approvalArtifactId?: string;
}>;

type ResultReadResponse = ScmDiffSummaryResultResponse | UiScmActionFailure;
const defaultReadExecutor = {};
// Only concurrent reads share work. Settled results live exclusively in the saved-result store.
const pendingResultReads = new WeakMap<object, Map<string, Promise<ResultReadResponse>>>();

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
  async function invoke<T>(actionId: ActionId, input: Readonly<{ cwd: string }>, schema: core.$ZodType<T>, sharedRead = false) {
    return presentScmFailure(actionId, await invokeUiScmAction({ actionId, input, schema, executor: params.actionExecutor, shouldContinue: sharedRead ? () => true : current,
      context: {
        ...(params.sessionId ? { defaultSessionId: params.sessionId, externalActionTarget: { kind: 'session' as const, sessionId: params.sessionId } }
          : { externalActionTarget: { kind: 'machine' as const, machineId: params.machineId! } }),
        ...(params.serverId ? { serverId: params.serverId } : {}),
        ...(params.accountId ? { expectedAccountId: params.accountId } : {}),
        ...(params.signal && !sharedRead ? { signal: params.signal } : {}),
      } }));
  }
  const operation = async (actionId: ActionId, input: Readonly<{ cwd: string }>) => {
    const response = await invoke(actionId, input, ScmDiffSummaryResultResponseSchema);
    if (response.success && response.runId && response.inputId && current()) {
      params.onRunAdmitted?.({ runId: response.runId, inputId: response.inputId, resultId: response.result.resultId });
    }
    return response;
  };
  async function read(input: ScmDiffSummaryResultReadInput): Promise<ResultReadResponse> {
    const validated = ScmDiffSummaryResultReadInputSchema.parse(input);
    const retired = (): UiScmActionFailure => ({ success: false, errorCode: 'result_unavailable', error: 'The captured Account or SCM host retired.' });
    if (!current()) return retired();
    // Sharing requires exact Account and transport custody. Unqualified callers retain their own read.
    if (!params.serverId || !params.accountId) return operation('scm.diffSummary.result.read', validated);
    const executor = params.actionExecutor ?? defaultReadExecutor;
    const reads = pendingResultReads.get(executor) ?? new Map<string, Promise<ResultReadResponse>>();
    pendingResultReads.set(executor, reads);
    const key = JSON.stringify([params.serverId, params.accountId, params.sessionId ?? null, params.machineId ?? null, validated.cwd, validated.resultId]);
    let pending = reads.get(key);
    if (!pending) {
      // The authenticated Action captures its own authority. One retiring reader cannot cancel siblings;
      // every reader checks its own lifetime again before consuming the shared response.
      pending = invoke('scm.diffSummary.result.read', validated, ScmDiffSummaryResultResponseSchema, true)
        .finally(() => { reads.delete(key); });
      reads.set(key, pending);
    }
    const response = await pending;
    return current() ? response : retired();
  }
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
    read,
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
    setReviewed: (input: ScmReviewedUnmarkInput, reviewed: boolean) => invoke(reviewed ? 'scm.diffSummary.reviewed.mark' : 'scm.diffSummary.reviewed.unmark',
      (reviewed ? ScmReviewedMarkInputSchema : ScmReviewedUnmarkInputSchema).parse(input), ScmReviewedMarkResponseSchema),
    delete: (input: ScmDiffSummaryResultRevisionInput) => invoke('scm.diffSummary.result.delete',
      ScmDiffSummaryResultRevisionInputSchema.parse(input), ScmDiffSummaryResultDeleteResponseSchema),
  };
}
