import { randomUUID } from 'node:crypto';

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
import type { PermissionRpcPayload } from '../../utils/permissionRpc';
import type { PermissionRpcConsumerOutcome } from '../../utils/permissionRpcRouter';
import type {
  ClaudeUnifiedDialogId,
  ClaudeUnifiedVisibleDialog,
} from '../tuiControls/dialogRegistry';
import {
  buildClaudeUnifiedDialogQuestionInput,
  getClaudeUnifiedDialogIdentity,
  resolveClaudeUnifiedDialogSelectedOption,
} from '../tuiControls/dialogRegistry';

export const CLAUDE_UNIFIED_DIALOG_CHOICE_QUESTION = 'How should Claude continue?' as const;

const REQUEST_TOOL_NAME = 'AskUserQuestion';
const REQUEST_ID_PREFIX = 'claude_dialog_choice_';

export type ClaudeUnifiedDialogChoiceDecision = Readonly<{
  dialogId: ClaudeUnifiedDialogId;
  choice: string;
}>;

type PendingChoice = Readonly<{
  requestId: string;
  dialogId: ClaudeUnifiedDialogId;
  identity: string;
  promise: Promise<ClaudeUnifiedDialogChoiceDecision>;
}>;

type DialogChoiceRequestParams = Readonly<{
  dialog: ClaudeUnifiedVisibleDialog;
  signal?: AbortSignal | undefined;
}>;

type RequestOption = Readonly<{
  choice: string;
  label: string;
  description: string;
  settingMutation?: Readonly<{
    settingId: 'claudeUnifiedTerminalWorkspaceTrust';
    value: 'always_trust_happier_workspaces' | 'always_reject_happier_workspaces';
  }> | undefined;
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
  private activated = false;
  private disposed = false;

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

  hasPendingChoice(dialogId?: ClaudeUnifiedDialogId): boolean {
    return this.pendingChoice !== null
      && (dialogId === undefined || this.pendingChoice.dialogId === dialogId);
  }

  hasPendingChoiceForDialog(dialog: ClaudeUnifiedVisibleDialog): boolean {
    return this.pendingChoice?.identity === getClaudeUnifiedDialogIdentity(dialog);
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
    if (this.pendingChoice) {
      await this.completeSourceOwnedCancellation(this.pendingChoice.requestId, 'claude_unified_dialog_changed');
    }

    const requestId = this.createRequestId();
    const toolInput = buildClaudeUnifiedDialogQuestionInput(params.dialog);
    this.pendingOptions = requestOptions(params.dialog);
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
      return decision;
    }).finally(() => {
      if (this.pendingChoice?.requestId === requestId) {
        this.pendingChoice = null;
        this.pendingOptions = [];
      }
    });

    this.pendingChoice = { requestId, dialogId: params.dialog.dialogId, identity, promise };
    return promise;
  }

  async cancelPendingChoice(reason: string): Promise<void> {
    const requestId = this.pendingChoice?.requestId;
    if (!requestId) return;
    await this.completeSourceOwnedCancellation(requestId, reason);
  }

  async noteDialogResolvedInTerminal(reason: string): Promise<void> {
    await this.cancelAllSourceOwnedRequests(reason);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
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
          },
        }),
      }),
      completeRequest: (params) => {
        this.trackSourceCompletion(
          params.requestId,
          this.requestStore.completeRequest(params),
        );
      },
      cancelAllRequests: (params) => { void this.cancelAllSourceOwnedRequests(params.reason); },
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

  private tryHandlePermissionRpc(payload: PermissionRpcPayload): PermissionRpcConsumerOutcome {
    const requestId = typeof payload?.id === 'string' ? payload.id : '';
    if (!requestId) return false;
    const context = this.permissionCoordinator.getResponseContext(requestId);
    if (!isDialogChoiceContext(context)) return false;
    if (context.status !== 'live') {
      void this.completeSourceOwnedCancellation(requestId, 'claude_unified_dialog_choice_no_live_waiter');
      return true;
    }

    if (payload.approved !== true) {
      const reason = typeof payload.reason === 'string' && payload.reason.length > 0
        ? payload.reason
        : 'claude_unified_dialog_choice_denied';
      void this.completeSourceOwnedCancellation(requestId, reason);
      return true;
    }

    const dialogId = this.pendingChoice?.requestId === requestId
      ? this.pendingChoice.dialogId
      : readDialogId(context.toolInput);
    const options = this.pendingChoice?.requestId === requestId && this.pendingOptions.length > 0
      ? this.pendingOptions
      : readOptionsFromToolInput(context.toolInput);
    const decision = dialogId ? decodeDialogChoice(payload, dialogId, options) : null;
    if (!decision) {
      // The recognized dialogs are numbered-choice-only, so an approved answer that matches no option
      // (e.g. a freeform "Other" entry) cannot be injected. Fail closed with a typed cancellation
      // rather than throwing an opaque `permission_response_failed`; the still-visible dialog is
      // re-surfaced by the next screen observation / turn-end probe.
      void this.completeSourceOwnedCancellation(requestId, 'claude_unified_dialog_choice_unsupported_freeform_answer');
      return true;
    }

    return this.permissionCoordinator.completeResponse({
      context,
      completion: {
        result: decision,
        completedRequest: {
          status: 'approved',
          decision: 'allow',
          extraCompletedFields: {
            answers: payload.answers ?? {},
            dialogId: decision.dialogId,
            dialogChoice: decision.choice,
            ...(decision.dialogId === 'safeguard_pause' ? { safeguardChoice: decision.choice } : {}),
          },
        },
      },
    });
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
