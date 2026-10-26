import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import { deepEqual } from '@/utils/deterministicJson';
import { extractShellCommand, isAskUserQuestionToolName, type StructuredQuestionLike, type StructuredQuestionAnswersV1 } from '@happier-dev/protocol';
import { normalizeLegacyStructuredQuestionAnswers, normalizeStructuredQuestionAnswersV1 } from '@/agent/questions/normalizeStructuredQuestionAnswersV1';
import { normalizeClaudeAskUserQuestionInputForPublication } from '../../utils/normalizeClaudeAskUserQuestionInput';
import { buildNativeAskUserQuestionAnswersForClaude } from '../../utils/askUserQuestionAnswersForClaude';
import { isClaudeSidechainRuntimeEvidence, isSidechainSessionHook } from '../../utils/sessionHookAttribution';
import { matchesClaudeNativeQuestionScreen } from '../tuiControls/nativeQuestionScreen';
import { parseClaudeNativePermissionScreen } from '../tuiControls/nativePermissionScreen';
import { clearClaudePlanModeMetadataBestEffort } from '../../utils/clearPlanModeMetadataBestEffort';
import { getToolDescriptor } from '../../utils/getToolDescriptor';
import { readClaudeToolResultPermissionApproval } from '../../utils/claudeToolResultPermission';

import { AgentStateRequestStore, type AgentStateOutstandingRequest } from '@/agent/permissions/agentStateRequestStore';
import {
  createPermissionRequestCoordinator,
  type PermissionRequestCoordinator,
  type PermissionRequestCoordinatorContext,
  type PermissionRequestCoordinatorStore,
} from '@/agent/permissions/permissionRequestCoordinator';
import {
  CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
  isClaudeUnifiedTerminalDialogChoiceAgentStateRequest,
} from '@happier-dev/agents';

import type { Session } from '../../session';
import type { SessionHookData } from '../../utils/startHookServer';
import type { ClaudeScreenState } from '../tuiControls/screenState';
import type { PermissionRpcPayload } from '../../utils/permissionRpc';
import type { PermissionRpcConsumerOutcome } from '../../utils/permissionRpcRouter';
import type {
  ClaudeUnifiedDialogId,
  ClaudeUnifiedDialogOption,
  ClaudeUnifiedVisibleDialog,
  ClaudeUnifiedVisibleNativeToolDialog,
} from '../tuiControls/dialogRegistry';
import {
  buildClaudeUnifiedDialogQuestionInput,
  getClaudeUnifiedDialogIdentity,
  resolveClaudeUnifiedDialogSelectedOption,
  resolveClaudeUnifiedVisibleDialog,
  CLAUDE_UNIFIED_UNRECOGNIZED_DIALOG_NOTICE,
} from '../tuiControls/dialogRegistry';

export const CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION = 'How should Claude continue?' as const;

const REQUEST_TOOL_NAME = 'AskUserQuestion';
const REQUEST_ID_PREFIX = 'claude_dialog_choice_';

export type ClaudeUnifiedDialogChoiceDecision = Readonly<{
  dialogId: ClaudeUnifiedDialogId;
  choice: string;
  structuredAnswersV1?: StructuredQuestionAnswersV1;
  feedback?: string;
}>;

type PendingChoice = Readonly<{
  requestId: string;
  dialogId: ClaudeUnifiedDialogId;
  identity: string;
  promise: Promise<ClaudeUnifiedDialogChoiceDecision>;
  nativePrompt?: NativePrompt;
  feedbackChoice?: string;
}>;

type TerminalAnswerAcknowledgement = Readonly<{
  promise: Promise<PermissionRpcConsumerOutcome>;
  resolve: () => void;
  reject: (reason: Error) => void;
}>;

type DialogChoiceRequestParams = Readonly<{
  dialog: ClaudeUnifiedVisibleDialog;
  signal?: AbortSignal | undefined;
  /** Native answers must be applied and verified before acknowledging the app response. */
  applyDecision?: (decision: ClaudeUnifiedDialogChoiceDecision) => Promise<void>;
}>;

type NativePrompt = Readonly<{
  occurrenceId: string;
  toolUseId: string | null;
  sessionId: string;
}> & {
  toolName: string;
  toolInput: unknown;
  responseLocation: 'app_and_terminal' | 'terminal_only';
  observedAnswers?: unknown;
  observedApproval?: boolean;
};

type RequestOption = Readonly<{
  choice: string;
  label: string;
  description: string;
  settingMutation?: ClaudeUnifiedDialogOption['settingMutation'];
}>;

function requestOptions(dialog: ClaudeUnifiedVisibleDialog): readonly RequestOption[] {
  return dialog.options.map(({ choice, label, description, settingMutation }) => ({
    choice,
    label,
    description,
    ...(settingMutation ? { settingMutation } : {}),
  }));
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isPrivateGenericDialogToolInput(toolInput: unknown): boolean {
  const input = readObject(toolInput);
  const metadata = readObject(input?.happierDialog);
  return metadata?.kind === 'unrecognized' && metadata.mode === 'generic';
}

function readDialogId(toolInput: unknown): ClaudeUnifiedDialogId | null {
  const input = readObject(toolInput);
  const metadata = readObject(input?.happierDialog);
  const dialogId = metadata?.dialogId;
  return dialogId === 'switch_model'
    || dialogId === 'usage_limit'
    || dialogId === 'resume_choice'
    || dialogId === 'safeguard_pause'
    || dialogId === 'effort_change'
    || dialogId === 'trust_folder'
    || dialogId === 'unrecognized_confirmation'
    ? dialogId
    : null;
}

function readOptionsFromToolInput(toolInput: unknown): readonly RequestOption[] {
  const input = readObject(toolInput);
  const question = Array.isArray(input?.questions) ? readObject(input.questions[0]) : null;
  const rawOptions = Array.isArray(question?.options) ? question.options : [];
  return rawOptions.flatMap((rawOption, index) => {
    const option = readObject(rawOption);
    if (typeof option?.label !== 'string') return [];
    return [{
      choice: typeof option.choice === 'string' ? option.choice : String(index + 1),
      label: option.label,
      description: typeof option.description === 'string' ? option.description : '',
    }];
  });
}

function decodeDialogChoice(
  payload: PermissionRpcPayload,
  dialogId: ClaudeUnifiedDialogId,
  options: readonly RequestOption[],
): ClaudeUnifiedDialogChoiceDecision | null {
  if (payload.approved !== true) return null;
  const answers = readObject(payload.answers);
  const structuredAnswers = readObject(payload.structuredAnswersV1);
  const selected = resolveClaudeUnifiedDialogSelectedOption(
    { ...(structuredAnswers ?? {}), ...(answers ?? {}) },
    options,
  );
  if (!selected) return null;
  return { dialogId, choice: selected.choice };
}

function isDialogChoiceContext(
  context: PermissionRequestCoordinatorContext | null,
): context is PermissionRequestCoordinatorContext {
  return context?.source === CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE;
}

export class ClaudeUnifiedDialogChoiceBroker {
  private readonly session: Session;
  private readonly requestStore: AgentStateRequestStore;
  private readonly permissionCoordinator: PermissionRequestCoordinator<ClaudeUnifiedDialogChoiceDecision>;
  private readonly createRequestId: () => string;
  private readonly nowMs: () => number;
  private readonly sourceCompletionByRequestId = new Map<string, Promise<void>>();
  private pendingChoice: PendingChoice | null = null;
  private pendingOptions: readonly RequestOption[] = [];
  private unresolvedTerminalAnswerIdentity: string | null = null;
  private readonly terminalAnswerAcknowledgements = new Map<string, TerminalAnswerAcknowledgement>();
  private activated = false;
  private disposed = false;
  private nativePrompt: NativePrompt | null = null;
  private applyPendingDecision: DialogChoiceRequestParams['applyDecision'];
  private applyingNativeAnswer = false;

  constructor(session: Session, opts?: Readonly<{
    createRequestId?: (() => string) | undefined;
    nowMs?: (() => number) | undefined;
  }>) {
    this.session = session;
    this.createRequestId = opts?.createRequestId ?? (() => `${REQUEST_ID_PREFIX}${randomUUID()}`);
    this.nowMs = opts?.nowMs ?? Date.now;
    this.requestStore = new AgentStateRequestStore({
      session: session.client,
      logPrefix: '[claude-unified-dialog-choice]',
      pushSender: session.pushSender,
      getAccountSettings: () => session.accountSettings ?? null,
      getAccountSettingsSecretsReadKeys: () => session.accountSettingsSecretsReadKeys,
    });
    this.permissionCoordinator = createPermissionRequestCoordinator<ClaudeUnifiedDialogChoiceDecision>({
      store: this.createCoordinatorStore(),
    });
  }

  activate(): void {
    if (this.activated) return;
    this.activated = true;
    this.session.getOrCreatePermissionRpcRouter().registerConsumer({
      name: 'claude-unified-dialog-choice',
      tryHandlePermissionRpc: (payload) => this.tryHandlePermissionRpc(payload),
    });
  }

  observeSessionHook(data: SessionHookData): void {
    if (this.disposed || isSidechainSessionHook(data)) return;
    const event = data.hook_event_name ?? data.hookEventName;
    const id = typeof data.tool_use_id === 'string' ? data.tool_use_id : null;
    if (event === 'ClaudeNativePrompt') {
      const toolName = data.tool_name ?? data.toolName;
      const sessionId = data.session_id ?? data.sessionId;
      if (typeof toolName !== 'string' || typeof sessionId !== 'string') return;
      const toolInput = data.tool_input ?? data.toolInput;
      const toolUseId = id ?? this.session.claudeToolHookCorrelation.findToolUseId({ sessionId, toolName, toolInput });
      const previous = this.nativePrompt;
      const responseLocation = data.happierResponseLocation === 'terminal_only' ? 'terminal_only' : 'app_and_terminal';
      if (previous && toolUseId !== null && previous.toolUseId === toolUseId && previous.sessionId === sessionId) {
        // Repeated native ingress observes one provider prompt, without another
        // transport waiter. Keep its pending choice and lifecycle reference intact.
        previous.toolName = toolName;
        previous.toolInput = toolInput;
        previous.responseLocation = responseLocation;
        return;
      }
      if (previous) this.clearNativePrompt();
      this.nativePrompt = {
        occurrenceId: toolUseId ?? randomUUID(), toolUseId, sessionId, toolName, toolInput,
        responseLocation,
      };
      this.publishNativeLifecycle(this.nativePrompt, 'PermissionRequest');
      if (previous && !this.applyingNativeAnswer) {
        void this.cancelPendingChoice('claude_native_prompt_replaced').catch(() => {
          logger.infoFile('[claude-unified-dialog-choice] Native prompt replacement settlement failed');
        });
      }
    } else if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && id) {
      const prompt = this.nativePromptForTool(id);
      const result = readObject(data.tool_response ?? data.toolResponse);
      if (prompt && result?.answers !== undefined) prompt.observedAnswers = result.answers;
      if (event === 'PostToolUse') this.clearAcceptedNativePlanMetadata(id, data.session_id ?? data.sessionId);
      void this.retireNativeTool(id, true).catch(() => {
        logger.infoFile('[claude-unified-dialog-choice] Native tool settlement failed');
      });
    } else if (event === 'Stop' || event === 'StopFailure' || event === 'SessionEnd' || event === 'UserPromptSubmit') {
      if (this.nativePrompt && !this.applyingNativeAnswer) {
        this.clearNativePrompt();
        void this.cancelPendingChoice('claude_native_prompt_ended').catch(() => {
          logger.infoFile('[claude-unified-dialog-choice] Native prompt lifecycle settlement failed');
        });
      }
    }
  }

  async observeTranscript(message: unknown): Promise<void> {
    const row = readObject(message);
    if (!row || isClaudeSidechainRuntimeEvidence(row)) return;
    const content = readObject(row.message)?.content;
    if (!Array.isArray(content)) return;
    for (const value of content) {
      const block = readObject(value);
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const prompt = this.nativePromptForTool(block.tool_use_id);
        const hook = this.session.claudeToolHookCorrelation.get(block.tool_use_id);
        const sessionId = prompt?.sessionId ?? hook?.session_id ?? hook?.sessionId;
        if (typeof sessionId !== 'string' || row.sessionId !== sessionId) continue;
        const result = readObject(row.toolUseResult);
        if (prompt && result?.answers !== undefined) prompt.observedAnswers = result.answers;
        const approved = readClaudeToolResultPermissionApproval(row);
        if (approved === true) this.clearAcceptedNativePlanMetadata(block.tool_use_id, row.sessionId);
        await this.retireNativeTool(block.tool_use_id, approved ?? block.is_error !== true);
        this.session.claudeToolHookCorrelation.delete(block.tool_use_id);
      }
    }
  }

  private nativePromptForTool(toolUseId: string): NativePrompt | null {
    if (this.nativePrompt?.toolUseId === toolUseId) return this.nativePrompt;
    return this.pendingChoice?.nativePrompt?.toolUseId === toolUseId ? this.pendingChoice.nativePrompt : null;
  }

  private clearAcceptedNativePlanMetadata(toolUseId: string, sessionId: unknown): void {
    const prompt = this.nativePromptForTool(toolUseId);
    const hook = this.session.claudeToolHookCorrelation.get(toolUseId);
    const toolSessionId = prompt?.sessionId ?? hook?.session_id ?? hook?.sessionId;
    const toolName = prompt?.toolName ?? hook?.tool_name ?? hook?.toolName;
    if (typeof sessionId === 'string' && sessionId === toolSessionId
      && typeof toolName === 'string' && getToolDescriptor(toolName).exitPlan) {
      clearClaudePlanModeMetadataBestEffort(this.session.client, '[claude-unified-dialog-choice]');
    }
  }

  verifyNativeQuestionAnswer(
    dialog: ClaudeUnifiedVisibleNativeToolDialog,
    answers: StructuredQuestionAnswersV1,
  ): 'pending' | 'matched' | 'mismatched' {
    const prompt = this.nativePromptForTool(dialog.occurrenceId);
    if (prompt?.observedAnswers === undefined) return 'pending';
    return deepEqual(prompt.observedAnswers, buildNativeAskUserQuestionAnswersForClaude(dialog.questions, answers)) ? 'matched' : 'mismatched';
  }

  private async retireNativeTool(toolUseId: string, approved: boolean): Promise<void> {
    const prompt = this.nativePromptForTool(toolUseId);
    if (!prompt) return;
    prompt.observedApproval = approved;
    if (this.applyingNativeAnswer) return;
    const pending = this.pendingChoice;
    if (this.nativePrompt === prompt) this.clearNativePrompt();
    if (approved && pending?.nativePrompt === prompt && !this.isSourceOwnedRequestClaimed(pending.requestId)) {
      // Retire the app waiter without replaying the already-applied terminal answer.
      // Record the provider's result rather than mislabeling a local success as canceled.
      this.permissionCoordinator.cancelRequest(pending.requestId, 'claude_native_tool_resolved_in_terminal');
      await this.trackSourceCompletion(pending.requestId, this.requestStore.completeRequest({
        requestId: pending.requestId, status: 'approved', decision: 'allow',
        reason: 'Answered in Claude terminal', observedCompletion: true,
        extraCompletedFields: prompt.observedAnswers === undefined ? {} : { answers: prompt.observedAnswers },
      }));
      this.clearTerminalAnswerFailure();
      return;
    }
    if (pending?.nativePrompt === prompt) await this.cancelPendingChoice('claude_native_tool_resolved_in_terminal');
  }

  private publishNativeLifecycle(prompt: NativePrompt, hookEventName: 'PermissionRequest' | 'PermissionRequestCompleted'): void {
    this.session.onClaudeSessionHook?.({
      hook_event_name: hookEventName, hookEventName,
      session_id: prompt.sessionId, tool_use_id: prompt.toolUseId ?? prompt.occurrenceId,
      tool_name: prompt.toolName,
    });
  }

  private clearNativePrompt(): void {
    const prompt = this.nativePrompt;
    this.nativePrompt = null;
    if (prompt) this.publishNativeLifecycle(prompt, 'PermissionRequestCompleted');
  }

  resolveVisibleDialog(state: ClaudeScreenState): ClaudeUnifiedVisibleDialog | null {
    const prompt = this.nativePrompt;
    if (prompt) {
      if (isAskUserQuestionToolName(prompt.toolName) && state.nativeQuestionPresentation) {
        const normalized = readObject(normalizeClaudeAskUserQuestionInputForPublication(prompt.toolName, prompt.toolInput));
        // The canonical publication normalizer validates the external provider question schema.
        const questions = Array.isArray(normalized?.questions) ? normalized.questions as readonly StructuredQuestionLike[] : [];
        if (prompt.toolUseId && matchesClaudeNativeQuestionScreen(state.nativeQuestionPresentation, questions)) {
          return {
            ...prompt, kind: 'native', dialogId: 'ask_user_question', owner: null,
            questions, questionId: 'claudeNativeQuestion', requestReason: 'claude_native_question',
            header: 'Claude question', question: '', options: [],
          };
        }
        return CLAUDE_UNIFIED_UNRECOGNIZED_DIALOG_NOTICE;
      }
      const permission = !isAskUserQuestionToolName(prompt.toolName) ? parseClaudeNativePermissionScreen(state.text) : null;
      if (permission && prompt.toolUseId && (!permission.amended || permission.kind === 'plan')) {
        const command = prompt.toolName === 'Bash' ? extractShellCommand(prompt.toolInput) : null;
        return {
          ...prompt, kind: 'native', dialogId: 'tool_permission', owner: null,
          questions: [], questionId: 'claudeNativePermission', requestReason: 'claude_native_permission',
          header: prompt.toolName,
          question: command ? `${command}\n\n${permission.explanation ?? permission.context}` : permission.context,
          permissionPresentation: permission,
          options: permission.options.map((option, index) => ({
            choice: `option_${index + 1}`, label: option.label, description: '',
            answer: { kind: 'selection', targetLabel: option.label },
          })),
        };
      }
      if (state.nativeQuestionPresentation || state.permissionPromptVisible || state.unrecognizedConfirmationDialogVisible) {
        // An uncharacterized/cropped native form is never a generic numbered approval.
        return CLAUDE_UNIFIED_UNRECOGNIZED_DIALOG_NOTICE;
      }
    }
    return resolveClaudeUnifiedVisibleDialog(state);
  }

  shouldPublishDialog(dialog: ClaudeUnifiedVisibleDialog): boolean {
    if (dialog.kind === 'native') return dialog.responseLocation === 'app_and_terminal';
    return !(dialog === CLAUDE_UNIFIED_UNRECOGNIZED_DIALOG_NOTICE && this.nativePrompt?.responseLocation === 'terminal_only');
  }

  isNativeAnswerInFlight(): boolean { return this.applyingNativeAnswer; }

  hasNativePrompt(): boolean { return this.nativePrompt !== null; }

  isCurrentNativeDialog(dialog: ClaudeUnifiedVisibleNativeToolDialog): boolean {
    return !this.disposed && this.nativePrompt?.occurrenceId === dialog.occurrenceId;
  }

  hasPendingChoice(dialogId?: ClaudeUnifiedDialogId): boolean {
    return this.pendingChoice !== null
      && (dialogId === undefined || this.pendingChoice.dialogId === dialogId);
  }

  hasPendingChoiceForDialog(dialog: ClaudeUnifiedVisibleDialog): boolean {
    return this.pendingChoice?.identity === getClaudeUnifiedDialogIdentity(dialog);
  }

  hasUnresolvedTerminalAnswerForDialog(dialog: ClaudeUnifiedVisibleDialog): boolean {
    return this.unresolvedTerminalAnswerIdentity === getClaudeUnifiedDialogIdentity(dialog);
  }

  noteTerminalAnswerStarted(dialog: ClaudeUnifiedVisibleDialog): void {
    this.unresolvedTerminalAnswerIdentity = getClaudeUnifiedDialogIdentity(dialog);
  }

  noteTerminalAnswerFailed(dialog: ClaudeUnifiedVisibleDialog): void {
    const identity = getClaudeUnifiedDialogIdentity(dialog);
    this.unresolvedTerminalAnswerIdentity = identity;
    this.terminalAnswerAcknowledgements.get(identity)?.reject(new Error('claude_unified_dialog_terminal_answer_failed'));
    this.terminalAnswerAcknowledgements.delete(identity);
  }

  clearTerminalAnswerFailure(): void {
    this.unresolvedTerminalAnswerIdentity = null;
  }

  noteTerminalAnswerSucceeded(dialog: ClaudeUnifiedVisibleDialog): void {
    const identity = getClaudeUnifiedDialogIdentity(dialog);
    this.clearTerminalAnswerFailure();
    this.terminalAnswerAcknowledgements.get(identity)?.resolve();
    this.terminalAnswerAcknowledgements.delete(identity);
  }

  resolveAutomaticDialogChoice(dialog: ClaudeUnifiedVisibleDialog): ClaudeUnifiedDialogChoiceDecision | null {
    if (dialog.kind !== 'recognized' || dialog.dialogId !== 'trust_folder') return null;
    const settings = this.session.accountSettings as Readonly<Record<string, unknown>> | null;
    const policy = settings?.claudeUnifiedTerminalWorkspaceTrust;
    const choice = policy === 'always_trust_happier_workspaces'
      ? 'trust_once'
      : policy === 'always_reject_happier_workspaces'
        ? 'reject_once'
        : null;
    return choice && dialog.options.some((option) => option.choice === choice)
      ? { dialogId: dialog.dialogId, choice }
      : null;
  }

  async requestDialogChoice(params: DialogChoiceRequestParams): Promise<ClaudeUnifiedDialogChoiceDecision> {
    if (this.disposed) {
      return Promise.reject(new Error('claude_unified_dialog_choice_broker_disposed'));
    }
    const identity = getClaudeUnifiedDialogIdentity(params.dialog);
    if (this.pendingChoice?.identity === identity) return this.pendingChoice.promise;
    await this.cancelAllSourceOwnedRequests('claude_unified_dialog_changed');

    // Native questions join their transcript tool by ID. Permission wrappers retain a
    // separate ID so their exact native choices use the structured-question renderer.
    const requestId = params.dialog.kind === 'native' && params.dialog.dialogId === 'ask_user_question'
      ? params.dialog.occurrenceId
      : this.createRequestId();
    const toolInput = buildClaudeUnifiedDialogQuestionInput(params.dialog);
    this.pendingOptions = requestOptions(params.dialog);
    this.applyPendingDecision = params.applyDecision;
    const promise = this.permissionCoordinator.requestDecision({
      requestId,
      toolName: REQUEST_TOOL_NAME,
      toolInput,
      createdAt: this.nowMs(),
      kind: 'user_action',
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
    }, {
      signal: params.signal,
    }).then(async (decision) => {
      await this.drainSourceCompletions(requestId);
      if (this.disposed) {
        throw new Error('claude_unified_dialog_choice_broker_disposed');
      }
      if (this.pendingChoice?.requestId !== requestId) {
        throw new Error('claude_unified_dialog_choice_no_longer_live');
      }
      // A recorded approval is not yet an applied terminal answer. Keep readiness
      // paused across the handoff to the terminal control task.
      this.noteTerminalAnswerStarted(params.dialog);
      return decision;
    }).catch(async (error: unknown) => {
      await this.drainSourceCompletions(requestId);
      throw error;
    }).finally(() => {
      if (this.pendingChoice?.requestId === requestId) {
        this.pendingChoice = null;
        this.pendingOptions = [];
          this.applyPendingDecision = undefined;
      }
    });

    this.pendingChoice = {
      requestId, dialogId: params.dialog.dialogId, identity, promise,
      ...(params.dialog.kind === 'native' && this.nativePrompt ? { nativePrompt: this.nativePrompt } : {}),
      ...(params.dialog.kind === 'native' && params.dialog.permissionPresentation?.feedback
        ? { feedbackChoice: params.dialog.options[params.dialog.permissionPresentation.feedback.optionIndex]?.choice }
        : {}),
    };
    return promise;
  }

  async cancelPendingChoice(reason: string): Promise<void> {
    const requestId = this.pendingChoice?.requestId;
    if (!requestId) return;
    await this.completeSourceOwnedCancellation(requestId, reason);
  }

  async noteDialogResolvedInTerminal(reason: string): Promise<void> {
    if (this.applyingNativeAnswer) return;
    this.clearTerminalAnswerFailure();
    await this.cancelAllSourceOwnedRequests(reason);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearNativePrompt();
    for (const acknowledgement of this.terminalAnswerAcknowledgements.values()) {
      acknowledgement.reject(new Error('claude_unified_dialog_choice_broker_disposed'));
    }
    this.terminalAnswerAcknowledgements.clear();
    await this.cancelAllSourceOwnedRequests('claude_unified_dialog_choice_broker_disposed');
    await Promise.all(this.sourceCompletionByRequestId.values());
    this.permissionCoordinator.dispose();
  }

  private createCoordinatorStore(): PermissionRequestCoordinatorStore {
    return {
      publishRequest: (params) => this.requestStore.publishRequest({
        ...params,
        notifyPush: !isPrivateGenericDialogToolInput(params.toolInput),
        updateState: (state) => ({
          ...state,
          capabilities: {
            ...(state.capabilities && typeof state.capabilities === 'object' ? state.capabilities : {}),
            askUserQuestionAnswersInPermission: true,
            structuredQuestionAnswersV1Supported: true,
          },
        }),
      }),
      completeRequest: (params) => {
        return this.trackSourceCompletion(
          params.requestId,
          this.requestStore.completeRequest(params),
        );
      },
      hasOutstandingRequest: (requestId) => this.readSourceOwnedOutstandingRequest(requestId) !== null,
      isOutstandingRequestClaimed: (requestId) => {
        const rawRequest = this.session.client.getAgentStateSnapshot?.()?.requests?.[requestId] ?? null;
        return isClaudeUnifiedTerminalDialogChoiceAgentStateRequest(rawRequest)
          && this.requestStore.isOutstandingRequestClaimed(requestId);
      },
      readOutstandingRequest: (requestId) => this.readSourceOwnedOutstandingRequest(requestId),
    };
  }

  private readSourceOwnedOutstandingRequest(requestId: string): AgentStateOutstandingRequest | null {
    const outstanding = this.requestStore.readOutstandingRequest(requestId);
    if (!outstanding) return null;
    const rawRequest = this.session.client.getAgentStateSnapshot?.()?.requests?.[requestId] ?? null;
    return isClaudeUnifiedTerminalDialogChoiceAgentStateRequest(rawRequest) ? outstanding : null;
  }

  private async tryHandlePermissionRpc(
    payload: PermissionRpcPayload,
  ): Promise<PermissionRpcConsumerOutcome> {
    const requestId = typeof payload?.id === 'string' ? payload.id : '';
    if (!requestId) return false;
    const context = this.permissionCoordinator.getResponseContext(requestId, payload.occurrenceId);
    if (!isDialogChoiceContext(context)) return false;
    if (context.status !== 'live') {
      void this.completeSourceOwnedCancellation(requestId, 'claude_unified_dialog_choice_no_live_waiter').catch(() => {
        logger.infoFile('[claude-unified-dialog-choice] Cancellation settlement admission failed');
      });
      return true;
    }

    if (payload.approved !== true) {
      const reason = typeof payload.reason === 'string' && payload.reason.length > 0
        ? payload.reason
        : 'claude_unified_dialog_choice_denied';
      void this.completeSourceOwnedCancellation(requestId, reason).catch(() => {
        logger.infoFile('[claude-unified-dialog-choice] Cancellation settlement admission failed');
      });
      return true;
    }

    const dialogId = this.pendingChoice?.requestId === requestId
      ? this.pendingChoice.dialogId
      : readDialogId(context.toolInput);
    const options = this.pendingChoice?.requestId === requestId && this.pendingOptions.length > 0
      ? this.pendingOptions
      : readOptionsFromToolInput(context.toolInput);
    const input = readObject(context.toolInput);
    const questions = Array.isArray(input?.questions) ? input.questions as readonly StructuredQuestionLike[] : [];
    let decision: ClaudeUnifiedDialogChoiceDecision | null = dialogId === 'ask_user_question'
      ? {
        dialogId, choice: '',
        structuredAnswersV1: payload.structuredAnswersV1 !== undefined
          ? normalizeStructuredQuestionAnswersV1(payload.structuredAnswersV1, questions)
          : normalizeLegacyStructuredQuestionAnswers({ answers: payload.answers, questions }),
      }
      : dialogId ? decodeDialogChoice(payload, dialogId, options) : null;
    const feedbackChoice = this.pendingChoice?.requestId === requestId ? this.pendingChoice.feedbackChoice : undefined;
    if (!decision && dialogId === 'tool_permission' && feedbackChoice) {
      const answers = payload.structuredAnswersV1 !== undefined
        ? normalizeStructuredQuestionAnswersV1(payload.structuredAnswersV1, questions)
        : normalizeLegacyStructuredQuestionAnswers({ answers: payload.answers, questions });
      const feedback = Object.values(answers)[0]?.[0];
      if (feedback) decision = { dialogId, choice: feedbackChoice, feedback, structuredAnswersV1: answers };
    }
    if (!decision) {
      // Recognized dialogs are selection-only, so an approved answer that matches no option
      // (e.g. a freeform "Other" entry) cannot be injected. Fail closed with a typed cancellation
      // rather than throwing an opaque `permission_response_failed`; the still-visible dialog is
      // re-surfaced by the next screen observation / turn-end probe.
      void this.completeSourceOwnedCancellation(requestId, 'claude_unified_dialog_choice_unsupported_freeform_answer').catch(() => {
        logger.infoFile('[claude-unified-dialog-choice] Cancellation settlement admission failed');
      });
      return true;
    }

    const identity = this.pendingChoice?.requestId === requestId ? this.pendingChoice.identity : null;
    const selectedRequestOption = options.find((option) => option.choice === decision.choice);
    let acknowledgement: TerminalAnswerAcknowledgement | null = null;
    // Only a remembered choice has a caller-visible mutation after this RPC. Keep its response
    // pending until terminal verification so the UI cannot persist a policy Claude did not apply.
    if (identity && selectedRequestOption?.settingMutation) {
      if (this.terminalAnswerAcknowledgements.has(identity)) return false;
      let resolvePromise!: (outcome: PermissionRpcConsumerOutcome) => void;
      let rejectPromise!: (reason: Error) => void;
      const promise = new Promise<PermissionRpcConsumerOutcome>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      // Terminal verification may reject while the state acknowledgement is still pending.
      void promise.catch(() => {});
      acknowledgement = {
        promise,
        resolve: () => resolvePromise(true),
        reject: rejectPromise,
      };
      this.terminalAnswerAcknowledgements.set(identity, acknowledgement);
    }

    let completion = false;
    const applyDecision = this.applyPendingDecision;
    const nativePrompt = this.nativePrompt;
    if (applyDecision && this.applyingNativeAnswer) return false;
    try {
      if (applyDecision) {
        this.applyingNativeAnswer = true;
        await applyDecision(decision);
      }
      completion = await this.permissionCoordinator.completeRpcResponse({
        context,
        expectedOccurrenceId: payload.occurrenceId,
        completion: {
          result: decision,
          completedRequest: {
            status: 'approved',
            decision: 'allow',
            extraCompletedFields: {
              answers: payload.answers ?? {},
              dialogId: decision.dialogId,
              dialogChoice: decision.choice,
              ...(decision.structuredAnswersV1 ? { structuredAnswersV1: decision.structuredAnswersV1 } : {}),
              ...(decision.dialogId === 'safeguard_pause' ? { safeguardChoice: decision.choice } : {}),
            },
          },
        },
      });
    } catch (error) {
      if (identity) this.terminalAnswerAcknowledgements.delete(identity);
      if (applyDecision) logger.infoFile('[claude-unified-dialog-choice] Native answer was not acknowledged', error);
      throw error;
    } finally {
      if (applyDecision) {
        this.applyingNativeAnswer = false;
        // A terminal answer can win while an app answer is being verified. Its
        // observed result owns history even when it differs from the app payload.
        if (!completion && nativePrompt?.toolUseId && nativePrompt.observedApproval !== undefined) {
          await this.retireNativeTool(nativePrompt.toolUseId, nativePrompt.observedApproval);
        }
      }
    }
    if (applyDecision && completion && this.nativePrompt === nativePrompt) this.clearNativePrompt();
    if (!acknowledgement || completion !== true) {
      if (identity) this.terminalAnswerAcknowledgements.delete(identity);
      return completion;
    }
    return acknowledgement.promise;
  }

  private async completeSourceOwnedCancellation(requestId: string, reason: string): Promise<void> {
    if (this.isSourceOwnedRequestClaimed(requestId)) return;
    const outstanding = this.readSourceOwnedOutstandingRequest(requestId);
    this.permissionCoordinator.cancelRequest(requestId, reason);
    await this.trackSourceCompletion(
      requestId,
      this.requestStore.completeRequest({
        requestId,
        status: 'canceled',
        decision: 'abort',
        reason,
        fallback: outstanding
          ? {
            toolName: outstanding.toolName,
            toolInput: outstanding.toolInput,
            createdAt: outstanding.createdAt,
            kind: outstanding.kind,
            source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
          }
          : null,
      }),
    );
    if (this.pendingChoice?.requestId === requestId) {
      this.pendingChoice = null;
      this.pendingOptions = [];
    }
  }

  private async cancelAllSourceOwnedRequests(reason: string): Promise<void> {
    const requests = this.session.client.getAgentStateSnapshot?.()?.requests ?? {};
    for (const [requestId, request] of Object.entries(requests)) {
      if (!isClaudeUnifiedTerminalDialogChoiceAgentStateRequest(request)) continue;
      await this.completeSourceOwnedCancellation(requestId, reason);
    }
  }

  private isSourceOwnedRequestClaimed(requestId: string): boolean {
    const rawRequest = this.session.client.getAgentStateSnapshot?.()?.requests?.[requestId] ?? null;
    return isClaudeUnifiedTerminalDialogChoiceAgentStateRequest(rawRequest)
      && this.requestStore.isOutstandingRequestClaimed(requestId);
  }

  private trackSourceCompletion(requestId: string, completion: Promise<void>): Promise<void> {
    const prior = this.sourceCompletionByRequestId.get(requestId);
    const tracked = prior
      ? Promise.all([prior, completion]).then(() => undefined)
      : completion;
    this.sourceCompletionByRequestId.set(requestId, tracked);
    void tracked.then(
      () => {
        if (this.sourceCompletionByRequestId.get(requestId) === tracked) {
          this.sourceCompletionByRequestId.delete(requestId);
        }
      },
      () => {
        if (this.sourceCompletionByRequestId.get(requestId) === tracked) {
          this.sourceCompletionByRequestId.delete(requestId);
        }
      },
    );
    return tracked;
  }

  private async drainSourceCompletions(requestId: string): Promise<void> {
    while (true) {
      const completion = this.sourceCompletionByRequestId.get(requestId);
      if (!completion) return;
      await completion;
    }
  }
}
