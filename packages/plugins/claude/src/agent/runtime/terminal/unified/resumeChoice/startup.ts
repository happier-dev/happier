import { createHash, randomUUID } from 'node:crypto';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { isDeepStrictEqual } from 'node:util';
import { StructuredQuestionAnswersV1Schema, type StructuredQuestionAnswersV1 } from '@happier-dev/plugin-sdk/sessions';
import type { NativePermissionChoicesV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { isAskUserQuestionToolName, normalizeAskUserQuestionInputForPublication, buildAskUserQuestionAnswersForClaude, normalizeNativeAskUserQuestionAnswers } from '../../../../permissions/askUserQuestion.js';
import { isSidechainSessionHook, isClaudeSidechainRuntimeEvidence } from '../../../../hooks/sidechain.js';
import { answerClaudeNativeQuestion, resolveClaudeNativeQuestionWithAnswerState, type ClaudeNativeQuestionAnswerState } from '../tuiControls/nativeQuestion.js';
import { parseClaudeNativePermissionScreen } from '../tuiControls/nativePermissionScreen.js';
import { DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS } from '../tuiControls/types.js';

import { NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE, NATIVE_TOOL_APPROVAL_REQUEST_SOURCE } from '@happier-dev/plugin-sdk/sessions';
import { allowsClaudeNativeSessionPersistence } from '../../../../permissions/nativePermissionEngine.js';
import { CLAUDE_NATIVE_QUESTION_REQUEST_SOURCE } from '../../../../permissions/createClaudePermissionEngine.js';
import type { ClaudeAgentSdkContext } from '../../../remote/sdk/session.js';
import type { TerminalControlPort } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  ClaudePermissionContext,
  ClaudePermissionDecision,
} from '../../../../permissions/createClaudePermissionEngine.js';
import {
  DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY,
  type ClaudeUnifiedTerminalWorkspaceTrustPolicy,
} from '../../../../../agentSettings/definition.js';
import { normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy } from '../../../../../protocol/remoteSettings.js';

import {
  CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
  CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
} from '../constants.js';
import type { ClaudeScreenState } from '../screenState.js';
import { answerClaudeUnifiedRegisteredDialog } from '../tuiControls/dialogAnswer.js';
import { captureScreenState } from '../tuiControls/controlRuntime.js';
import {
  buildClaudeUnifiedDialogQuestionInput,
  buildClaudeUnifiedDialogTraceSummary,
  getClaudeUnifiedDialogIdentity,
  getClaudeUnifiedRecognizedDialogRegistryEntry,
  resolveClaudeUnifiedDialogSelectedOption,
  resolveClaudeUnifiedRegisteredDialogOption,
  resolveClaudeUnifiedVisibleDialog,
  createClaudeUnifiedUnrecognizedDialogNotice,
  type ClaudeUnifiedVisibleNativeToolDialog,
  type ClaudeUnifiedDialogOption,
  type ClaudeUnifiedRecognizedDialogId,
  type ClaudeUnifiedVisibleDialog,
  type ClaudeUnifiedVisibleRecognizedDialog,
} from '../tuiControls/dialogRegistry.js';
import {
  DEFAULT_CLAUDE_UNIFIED_RESUME_CHOICE,
  normalizeClaudeUnifiedResumeChoice,
  type ClaudeUnifiedResumeChoicePolicy,
} from './types.js';

export type ClaudeUnifiedResumeChoiceStartupResult =
  | 'unhandled'
  | 'handled'
  | 'waiting_for_user';

export type ClaudeUnifiedStartupRuntimeConfig = Readonly<{
  model: string | null;
  reasoningEffort: string | null;
  ultracode: boolean;
}>;

type PermissionDecisionResult = ClaudePermissionDecision;

const MAX_ORPHAN_STARTUP_DIALOG_ANSWER_ATTEMPTS = 2;

type NativePrompt = {
  occurrenceId: string;
  toolUseId: string | null;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  responseLocation: 'app_and_terminal' | 'terminal_only';
  questionAnswerState: ClaudeNativeQuestionAnswerState;
  observedAnswers?: unknown;
  observedApproved?: boolean;
};

type NativeToolHook = {
  data: Readonly<Record<string, unknown>>;
  preToolUseObserved: boolean;
  activeForInference: boolean;
  appPermissionPending: boolean;
};

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}


function nativeAnswersMatch(actual: unknown, expected: Readonly<Record<string, string>>): boolean {
  const answers = readObject(actual);
  return answers !== null && Object.keys(answers).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => Object.hasOwn(answers, key) && answers[key] === value);
}

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveConfiguredEffortTargets(config: ClaudeUnifiedStartupRuntimeConfig): readonly string[] {
  if (config.ultracode) return ['ultracode', 'xhigh'];
  const effort = normalizeNonEmptyString(config.reasoningEffort);
  return effort ? [effort] : [];
}

function hasConfiguredModel(config: ClaudeUnifiedStartupRuntimeConfig): boolean {
  return normalizeNonEmptyString(config.model) !== null;
}

function readDecisionAnswers(
  result: PermissionDecisionResult,
): Readonly<Record<string, unknown>> | null {
  if (result.decision === 'denied' || result.decision === 'abort') return null;
  return (result.answers as Readonly<Record<string, unknown>> | undefined) ?? null;
}

/** The terminal applies these exact visible policies; no hook-only offer is added. */
function buildNativeTerminalPermissionChoices(
  dialog: ClaudeUnifiedVisibleNativeToolDialog,
  requestId: string,
): NativePermissionChoicesV1 | null {
  const presentation = dialog.permissionPresentation;
  const choices: NativePermissionChoicesV1['choices'][number][] = [];
  for (const [index, option] of dialog.options.entries()) {
    const feedback = presentation?.feedback?.optionIndex === index;
    const approved = !feedback && /^Yes\b/u.test(option.label);
    const persistent = /^Yes, and don[’']t ask again for: .+$/u.test(option.label)
      || option.label === 'Yes, and keep allowing any reads outside the working directories'
      || option.label === 'No, and block reads outside the working directories from now on';
    const once = option.label === 'Yes' || option.label === 'No' || /ask again next time/u.test(option.label);
    const mode = /^Yes, and (?:use|switch to) auto mode\b/u.test(option.label) ? 'auto'
      : /^Yes, and switch to BYPASS PERMISSIONS\b/u.test(option.label) ? 'bypassPermissions'
        : option.label === 'Yes, manually approve edits' ? 'default'
          : /^Yes, and switch to accept edits\b/u.test(option.label) ? 'acceptEdits' : null;
    const sessionRead = /^Yes, allow reading from .+ during this session$/u.test(option.label);
    if (!feedback && !persistent && !once && !mode && !sessionRead) return null;
    const scope = feedback || once ? 'once' : persistent ? 'localPersistent' : 'session';
    const decision = approved ? 'approved' : 'denied';
    choices.push({ id: option.choice, label: option.label, decision, scope,
      ...(feedback ? { allowsFeedback: true } : {}),
      response: { approved, decision,
        ...(mode ? { updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] } : {}),
      },
    });
  }
  return { requirementId: requestId, source: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID, choices };
}

/**
 * The Claude Unified startup dialog resolver. It is registry-driven: for every screen it resolves
 * the single visible dialog from {@link resolveClaudeUnifiedVisibleDialog} and either
 *  - defers to live runtime control while a slash-control run owns the dialog, or
 *  - auto-answers an orphan effort/model dialog from the launch runtime config during startup, or
 *  - publishes native tool permissions with their offered choices and other dialogs as questions,
 *    then answers the terminal with the user's selected option (the recipe from the registry), or
 *  - fail-closed publishes an `open_terminal` notice for a dialog it does NOT recognize.
 * There is exactly ONE publisher and ONE answer table (the registry) so startup never
 * double-publishes or re-matches terminal text.
 */
export function createClaudeUnifiedResumeChoiceStartupHandler(params: Readonly<{
  ctx: ClaudePermissionContext & Pick<ClaudeAgentSdkContext, 'logger'>;
  sessionId: string;
  policy?: ClaudeUnifiedResumeChoicePolicy | null | undefined;
  workspaceTrustPolicy?: ClaudeUnifiedTerminalWorkspaceTrustPolicy | null | undefined;
  port: TerminalControlPort;
  settleMs: number;
  verifyPollIntervalMs?: number;
  verifyPollTimeoutMs?: number;
  wait: (ms: number) => Promise<void>;
  runtimeConfig?: ClaudeUnifiedStartupRuntimeConfig | undefined;
  isRuntimeControlInFlight?: (() => boolean) | undefined;
  /**
   * Startup-ready window predicate. `resume_choice` is owned (auto-answered / single-published) only
   * while startup is active; post-startup it fails OPEN (published like any other dialog) so a resume
   * dialog surfacing after startup is never silently deferred. Absent → defaults to startup-active.
   */
  isStartupActive?: (() => boolean) | undefined;
  /** Event edge used by startup readiness to suspend every timeout/relaunch timer while a human owns the prompt. */
  onPendingUserActionChange?: ((pending: boolean) => void) | undefined;
  onNativeToolApproved?: (toolName: string) => Promise<void>;
}>): Readonly<{
  handle(screen: ClaudeScreenState): Promise<ClaudeUnifiedResumeChoiceStartupResult>;
  hasPendingUserAction(): boolean;
  hasNativePrompt(): boolean;
  resolveToolUseId(data: Readonly<Record<string, unknown>>): string | null;
  observeSessionHook(data: Readonly<Record<string, unknown>>): Promise<void>;
  observeTranscript(message: unknown): Promise<void>;
  dispose(): Promise<void>;
}> {
  const policy = normalizeClaudeUnifiedResumeChoice(params.policy) ?? DEFAULT_CLAUDE_UNIFIED_RESUME_CHOICE;
  const workspaceTrustPolicy = normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy(params.workspaceTrustPolicy)
    ?? DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY;
  let disposed = false;
  let pendingAbort: AbortController | null = null;
  let pendingRequest: Promise<void> | null = null;
  let pendingIdentity: string | null = null;
  let applyingDecision = false;
  let closedIdentity: string | null = null;
  let autoAttemptedIdentity: string | null = null;
  let pendingUserActionNotified = false;
  let nativePrompt: NativePrompt | null = null;
  let pendingNativePrompt: NativePrompt | null = null;
  let pendingRequestId: string | null = null;
  let pendingAppAnswers: StructuredQuestionAnswersV1 | undefined;
  const nativeToolHooks = new Map<string, NativeToolHook>();
  const runtimeInstanceId = randomUUID();
  const orphanDialogAnswerAttempts = new Map<ClaudeUnifiedRecognizedDialogId, number>();

  const cancelPending = async (): Promise<boolean> => {
    const task = pendingRequest;
    // A submitted answer advances native UI before its application ACK and durable
    // Session settlement finish. A screen transition must not cancel that answer.
    // Disposal still retires the occurrence, including any in-flight application.
    if (applyingDecision && !disposed) {
      return false;
    }
    pendingAbort?.abort();
    pendingAbort = null;
    pendingRequest = null;
    pendingIdentity = null;
    pendingRequestId = null;
    pendingNativePrompt = null;
    pendingAppAnswers = undefined;
    if (task) await task.catch(() => undefined);
    if (pendingUserActionNotified) {
      pendingUserActionNotified = false;
      params.onPendingUserActionChange?.(false);
    }
    return true;
  };

  const isStartupActive = (): boolean => params.isStartupActive?.() ?? true;

  const nativePromptForTool = (toolUseId: string): NativePrompt | null => (
    nativePrompt?.toolUseId === toolUseId ? nativePrompt
      : pendingNativePrompt?.toolUseId === toolUseId ? pendingNativePrompt : null
  );
  const questionsFor = (prompt: NativePrompt): readonly unknown[] => {
    const publication = readObject(normalizeAskUserQuestionInputForPublication(prompt.toolName, prompt.toolInput, { native: true }));
    return Array.isArray(publication?.questions) ? publication.questions : [];
  };
  const isCurrent = (dialog: ClaudeUnifiedVisibleNativeToolDialog): boolean => (
    !disposed && nativePrompt?.occurrenceId === dialog.occurrenceId
  );
  const resolveDialog = (screen: ClaudeScreenState): ClaudeUnifiedVisibleDialog | null => {
    const prompt = nativePrompt;
    if (prompt) {
      const questions = questionsFor(prompt);
      if (isAskUserQuestionToolName(prompt.toolName) && screen.nativeQuestionPresentation) {
        if (prompt.toolUseId && resolveClaudeNativeQuestionWithAnswerState(screen.nativeQuestionPresentation, questions, prompt.questionAnswerState)) {
          return { ...prompt, kind: 'native', dialogId: 'ask_user_question', owner: null,
            questions, questionId: 'claudeNativeQuestion', requestReason: 'claude_native_question',
            header: 'Claude question', question: '', options: [] };
        }
        return createClaudeUnifiedUnrecognizedDialogNotice();
      }
      const permission = !isAskUserQuestionToolName(prompt.toolName) ? parseClaudeNativePermissionScreen(screen.text) : null;
      if (permission && prompt.toolUseId && (!permission.amended || permission.kind === 'plan')) {
        const nativeCommand = prompt.toolName === 'Bash' ? readObject(prompt.toolInput)?.command : undefined;
        const command = typeof nativeCommand === 'string' && nativeCommand.trim() ? nativeCommand.trim() : null;
        const dialog: ClaudeUnifiedVisibleNativeToolDialog = { ...prompt, kind: 'native', dialogId: 'tool_permission', owner: null,
          questions: [], questionId: 'claudeNativePermission', requestReason: 'claude_native_permission',
          header: prompt.toolName,
          question: command ? command + '\n\n' + (permission.explanation ?? permission.context) : permission.context,
          permissionPresentation: permission,
          options: permission.options.map((option, index) => ({ choice: `option_${index + 1}`,
            label: option.label, description: '', answer: { kind: 'selection', targetLabel: option.label } })) };
        const nativeChoices = buildNativeTerminalPermissionChoices(dialog, prompt.occurrenceId);
        return nativeChoices ? { ...dialog, nativeChoices } : createClaudeUnifiedUnrecognizedDialogNotice();
      }
      if (screen.nativeQuestionPresentation || screen.permissionPromptVisible || screen.unrecognizedConfirmationDialogVisible) {
        return createClaudeUnifiedUnrecognizedDialogNotice();
      }
    }
    return resolveClaudeUnifiedVisibleDialog(screen);
  };
  const observedStructuredAnswers = (prompt: NativePrompt): StructuredQuestionAnswersV1 | undefined => {
    const actual = readObject(prompt.observedAnswers);
    if (!actual) return undefined;
    if (pendingAppAnswers && nativeAnswersMatch(actual, buildAskUserQuestionAnswersForClaude(questionsFor(prompt), pendingAppAnswers, 'native'))) {
      return pendingAppAnswers;
    }
    return normalizeNativeAskUserQuestionAnswers(questionsFor(prompt), actual) ?? undefined;
  };
  const settleNativePrompt = async (prompt: NativePrompt): Promise<void> => {
    if (prompt.observedApproved === undefined || pendingNativePrompt !== prompt || !pendingRequestId) return;
    const settle = params.ctx.sessions.current.permissions.settleObservedDecision;
    if (!settle) throw new Error('claude_native_prompt_settlement_unavailable');
    const answers = prompt.observedApproved ? observedStructuredAnswers(prompt) : undefined;
    await settle({ requestId: pendingRequestId, source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
      decision: prompt.observedApproved ? 'approved' : 'abort',
      ...(answers ? { answers } : {}),
    });
  };
  const retireNativeTool = async (toolUseId: string, approved: boolean, answers?: unknown): Promise<void> => {
    const hook = nativeToolHooks.get(toolUseId);
    const prompt = nativePromptForTool(toolUseId);
    if (!prompt && hook?.appPermissionPending === true) {
      const toolName = hook.data.tool_name ?? hook.data.toolName;
      const settle = params.ctx.sessions.current.permissions.settleObservedDecision;
      if (typeof toolName === 'string') {
        if (!settle) throw new Error('claude_native_prompt_settlement_unavailable');
        await settle({ requestId: toolUseId,
          source: isAskUserQuestionToolName(toolName) ? CLAUDE_NATIVE_QUESTION_REQUEST_SOURCE
            : allowsClaudeNativeSessionPersistence(toolName) ? NATIVE_TOOL_APPROVAL_REQUEST_SOURCE : NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE,
          decision: approved ? 'approved' : isAskUserQuestionToolName(toolName) ? 'abort' : 'denied',
        });
      }
    }
    nativeToolHooks.delete(toolUseId);
    if (!prompt) return;
    prompt.observedApproved = approved;
    if (answers !== undefined) prompt.observedAnswers = answers;
    if (applyingDecision) return;
    await settleNativePrompt(prompt);
    if (nativePrompt === prompt) nativePrompt = null;
    if (pendingNativePrompt === prompt) await cancelPending();
  };
  const resolveToolUseId = (data: Readonly<Record<string, unknown>>): string | null => {
    const explicit = data.tool_use_id ?? data.toolUseId;
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
    if (isSidechainSessionHook(data)) return null;
    const sessionId = data.session_id ?? data.sessionId;
    const toolName = data.tool_name ?? data.toolName;
    const toolInput = data.tool_input ?? data.toolInput;
    const matching = [...nativeToolHooks.entries()].filter(([, hook]) => (
      hook.preToolUseObserved && hook.activeForInference && (hook.data.session_id ?? hook.data.sessionId) === sessionId
      && (hook.data.tool_name ?? hook.data.toolName) === toolName && isDeepStrictEqual(hook.data.tool_input ?? hook.data.toolInput, toolInput)
    ));
    return matching.length === 1 ? matching[0]![0] : null;
  };
  const observeSessionHook = async (data: Readonly<Record<string, unknown>>): Promise<void> => {
    if (disposed || isSidechainSessionHook(data)) return;
    const event = data.hook_event_name ?? data.hookEventName;
    const id = typeof data.tool_use_id === 'string' ? data.tool_use_id : null;
    if (event === 'PreToolUse' && id) nativeToolHooks.set(id, { data, preToolUseObserved: true,
      activeForInference: true, appPermissionPending: nativeToolHooks.get(id)?.appPermissionPending ?? false });
    if (event === 'PermissionRequest' && id) {
      const hook = nativeToolHooks.get(id);
      nativeToolHooks.set(id, { data: { ...hook?.data, ...data }, preToolUseObserved: hook?.preToolUseObserved ?? false,
        activeForInference: hook?.activeForInference ?? false, appPermissionPending: true });
    }
    if (event === 'PermissionRequestCompleted' && id) {
      const hook = nativeToolHooks.get(id);
      if (hook?.activeForInference) hook.appPermissionPending = false;
      else nativeToolHooks.delete(id);
    }
    if (event === 'ClaudeNativePrompt') {
      const toolName = data.tool_name ?? data.toolName;
      const sessionId = data.session_id ?? data.sessionId;
      if (typeof toolName !== 'string' || typeof sessionId !== 'string') return;
      const toolInput = data.tool_input ?? data.toolInput;
      const toolUseId = resolveToolUseId(data);
      const previous = nativePrompt;
      if (previous && toolUseId !== null && previous.toolUseId === toolUseId && previous.sessionId === sessionId) {
        previous.toolName = toolName;
        previous.toolInput = toolInput;
        previous.responseLocation = data.happierResponseLocation === 'terminal_only' ? 'terminal_only' : 'app_and_terminal';
        return;
      }
      nativePrompt = { occurrenceId: toolUseId ?? randomUUID(), toolUseId, sessionId, toolName, toolInput,
        questionAnswerState: { drafts: new Map(), questionIndex: -1 },
        responseLocation: data.happierResponseLocation === 'terminal_only' ? 'terminal_only' : 'app_and_terminal' };
      if (previous && previous.occurrenceId !== nativePrompt.occurrenceId && !applyingDecision) await cancelPending();
    } else if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && id) {
      const prompt = nativePromptForTool(id);
      const hook = nativeToolHooks.get(id);
      const sessionId = data.session_id ?? data.sessionId;
      if ((prompt?.sessionId ?? hook?.data.session_id ?? hook?.data.sessionId) !== sessionId) return;
      if (event === 'PostToolUse' && (prompt || hook?.preToolUseObserved === true)) {
        const toolName = prompt?.toolName ?? hook?.data.tool_name ?? hook?.data.toolName;
        if (typeof toolName === 'string') await params.onNativeToolApproved?.(toolName);
      }
      await retireNativeTool(id, true, readObject(data.tool_response ?? data.toolResponse)?.answers);
    } else if (event === 'Stop' || event === 'StopFailure' || event === 'SessionEnd' || event === 'UserPromptSubmit') {
      for (const [toolUseId, hook] of nativeToolHooks) {
        if (hook.appPermissionPending) hook.activeForInference = false;
        else nativeToolHooks.delete(toolUseId);
      }
      if (!applyingDecision) { nativePrompt = null; await cancelPending(); }
    }
  };
  const observeTranscript = async (message: unknown): Promise<void> => {
    const row = readObject(message);
    if (disposed || !row || isClaudeSidechainRuntimeEvidence(row)) return;
    const content = readObject(row.message)?.content;
    if (!Array.isArray(content)) return;
    for (const value of content) {
      const block = readObject(value);
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const prompt = nativePromptForTool(block.tool_use_id);
      const hook = nativeToolHooks.get(block.tool_use_id);
      if (row.sessionId !== (prompt?.sessionId ?? hook?.data.session_id ?? hook?.data.sessionId)) continue;
      const permissionDecision = readObject(row.permissionDecision)?.decision;
      // A command failure alone does not say whether an outstanding app permission was approved.
      if (!prompt && permissionDecision !== 'accept' && permissionDecision !== 'reject'
        && row.toolDenialKind !== 'user-rejected') continue;
      if (permissionDecision === 'accept' && (prompt || hook?.preToolUseObserved === true)) {
        const toolName = prompt?.toolName ?? hook?.data.tool_name ?? hook?.data.toolName;
        if (typeof toolName === 'string') await params.onNativeToolApproved?.(toolName);
      }
      await retireNativeTool(block.tool_use_id, permissionDecision === 'accept'
        || (permissionDecision !== 'reject' && row.toolDenialKind !== 'user-rejected' && block.is_error !== true),
      readObject(row.toolUseResult)?.answers);
    }
  };


  const answerVia = async (
    dialogId: ClaudeUnifiedRecognizedDialogId,
    expectedIdentity: string,
    dialogOption: ClaudeUnifiedDialogOption,
  ): Promise<boolean> => {
    const result = await answerClaudeUnifiedRegisteredDialog({
      port: params.port,
      dialogId,
      expectedIdentity,
      option: dialogOption,
      settleMs: params.settleMs,
      wait: params.wait,
    });
    return result.status === 'answered' || result.status === 'not_visible';
  };

  const resolveOrphanOption = (
    dialog: ClaudeUnifiedVisibleRecognizedDialog,
    screen: ClaudeScreenState,
    config: ClaudeUnifiedStartupRuntimeConfig,
  ): ClaudeUnifiedDialogOption | null => {
    const entry = getClaudeUnifiedRecognizedDialogRegistryEntry(dialog.dialogId);
    if (dialog.dialogId === 'effort_change') {
      const targets = resolveConfiguredEffortTargets(config);
      const choice = screen.effortChangeDialogTarget !== null && targets.includes(screen.effortChangeDialogTarget)
        ? 'confirm'
        : 'cancel';
      return resolveClaudeUnifiedRegisteredDialogOption(screen, entry, choice);
    }
    if (dialog.dialogId === 'switch_model') {
      return resolveClaudeUnifiedRegisteredDialogOption(screen, entry, hasConfiguredModel(config) ? 'confirm' : 'cancel');
    }
    return null;
  };

  const answerOrphan = async (
    dialog: ClaudeUnifiedVisibleRecognizedDialog,
    screen: ClaudeScreenState,
    config: ClaudeUnifiedStartupRuntimeConfig,
  ): Promise<ClaudeUnifiedResumeChoiceStartupResult> => {
    const attempts = orphanDialogAnswerAttempts.get(dialog.dialogId) ?? 0;
    if (attempts >= MAX_ORPHAN_STARTUP_DIALOG_ANSWER_ATTEMPTS) return 'unhandled';
    const dialogOption = resolveOrphanOption(dialog, screen, config);
    if (!dialogOption) return 'unhandled';

    const identity = getClaudeUnifiedDialogIdentity(dialog);
    const result = await answerClaudeUnifiedRegisteredDialog({
      port: params.port,
      dialogId: dialog.dialogId,
      expectedIdentity: identity,
      option: dialogOption,
      settleMs: params.settleMs,
      wait: params.wait,
    });
    if (result.status === 'answered' || result.status === 'not_visible') {
      orphanDialogAnswerAttempts.delete(dialog.dialogId);
      return 'handled';
    }
    if (result.status === 'dialog_changed') return 'handled';

    const nextAttempts = attempts + 1;
    orphanDialogAnswerAttempts.set(dialog.dialogId, nextAttempts);
    return nextAttempts >= MAX_ORPHAN_STARTUP_DIALOG_ANSWER_ATTEMPTS ? 'unhandled' : 'handled';
  };

  const startAsk = (dialog: ClaudeUnifiedVisibleDialog): void => {
    if (pendingRequest) return;
    const identity = getClaudeUnifiedDialogIdentity(dialog);
    const digest = createHash('sha256')
      .update(`${runtimeInstanceId}\0${identity}`, 'utf8')
      .digest('hex')
      .slice(0, 24);
    const requestId = dialog.kind === 'native' && dialog.dialogId === 'ask_user_question'
      ? dialog.occurrenceId : `${params.sessionId}:claude-dialog:${digest}`;
    const nativePermission = dialog.kind === 'native' && dialog.dialogId === 'tool_permission' ? dialog : null;
    const nativeChoices = nativePermission?.nativeChoices;
    const abort = new AbortController();
    pendingAbort = abort;
    pendingIdentity = identity;
    pendingRequestId = requestId;
    pendingNativePrompt = dialog.kind === 'native' ? nativePrompt : null;
    const requestedNativePrompt = pendingNativePrompt;
    const applyDecision = async (result: PermissionDecisionResult): Promise<boolean> => {
      if (dialog.kind === 'native') {
        if (!isCurrent(dialog)) return false;
        const prompt = pendingNativePrompt;
        if (dialog.dialogId === 'ask_user_question') {
          const parsed = StructuredQuestionAnswersV1Schema.safeParse(result.answers);
          if (!parsed.success) return false;
          pendingAppAnswers = parsed.data;
          const applied = await answerClaudeNativeQuestion({ port: params.port, questions: dialog.questions,
            answers: parsed.data, state: prompt?.questionAnswerState, isCurrent: () => isCurrent(dialog), wait: params.wait, settleMs: params.settleMs,
            onFailure: (failure) => params.ctx.logger.warn('[ClaudeUnifiedTerminal] Native question answer failed', failure),
            verifyPollIntervalMs: params.verifyPollIntervalMs, verifyPollTimeoutMs: params.verifyPollTimeoutMs,
            verifyApplied: () => prompt?.observedAnswers === undefined ? 'pending'
              : nativeAnswersMatch(prompt.observedAnswers, buildAskUserQuestionAnswersForClaude(dialog.questions, parsed.data, 'native')) ? 'matched' : 'mismatched',
          });
          if (applied.status === 'submitted' || applied.status === 'failed' && applied.reason === 'native_question_already_submitted') {
            params.ctx.logger.warn('[ClaudeUnifiedTerminal] Native question submission confirmation pending');
            throw new PluginError({ code: 'STRUCTURED_QUESTION_SUBMISSION_UNCONFIRMED', retryable: true });
          }
          return applied.status === 'answered';
        }
        const answer = result.nativeChoice;
        const option = answer && answer.requirementId === nativeChoices?.requirementId
          ? dialog.options.find(option => option.choice === answer.choiceId) : null;
        const feedback = answer?.feedback;
        if (!option) return false;
        const applied = await answerClaudeUnifiedRegisteredDialog({ port: params.port, dialogId: dialog.dialogId,
          expectedIdentity: identity, option, resolveDialog, isCurrent: () => isCurrent(dialog), feedback,
          settleMs: params.settleMs, wait: params.wait,
          verifyPollIntervalMs: params.verifyPollIntervalMs, verifyPollTimeoutMs: params.verifyPollTimeoutMs,
        });
        return applied.status === 'answered';
      }
      const dialogOption = resolveClaudeUnifiedDialogSelectedOption(readDecisionAnswers(result), dialog.options);
      return dialogOption && dialog.kind === 'recognized'
        ? await answerVia(dialog.dialogId, identity, dialogOption)
        : dialogOption && dialog.kind === 'unrecognized'
          ? await answerClaudeUnifiedRegisteredDialog({
            port: params.port,
            dialogId: 'unrecognized_confirmation',
            expectedIdentity: identity,
            option: dialogOption,
            settleMs: params.settleMs,
            wait: params.wait,
          }).then((answerResult) => answerResult.status === 'answered' || answerResult.status === 'not_visible')
          : false;
    };
    const task = params.ctx.sessions.current.permissions.requestDecision({
      provider: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
      source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
      requestId,
      toolCallId: requestId,
      toolName: nativePermission ? nativePermission.toolName : 'AskUserQuestion',
      input: nativePermission ? { ...readObject(nativePermission.toolInput), description: nativePermission.question }
        : buildClaudeUnifiedDialogQuestionInput(dialog),
      ...(nativeChoices ? { nativeChoices } : {}),
      traceSummary: buildClaudeUnifiedDialogTraceSummary(dialog),
      reason: dialog.requestReason,
    }, {
      signal: abort.signal,
      acknowledgeDecisionApplication: async (result) => {
        if (!nativePermission && (result.decision === 'denied' || result.decision === 'abort')) return;
        // Cancellation without a selected native option must not write terminal bytes.
        if (nativePermission && !result.nativeChoice) return;
        if (dialog.kind === 'unrecognized' && dialog.mode === 'notice') return;
        if (disposed || abort.signal.aborted || pendingAbort !== abort || pendingIdentity !== identity) {
          throw new Error('claude_unified_dialog_request_retired');
        }
        applyingDecision = true;
        try {
          if (!await applyDecision(result)) {
            throw new Error('claude_unified_dialog_terminal_answer_failed');
          }
        } finally {
          applyingDecision = false;
          const prompt = pendingNativePrompt;
          if (prompt?.observedApproved !== undefined) {
            await settleNativePrompt(prompt);
            if (nativePrompt === prompt) nativePrompt = null;
          }
        }
      },
    }).then((result) => {
      if (pendingRequest !== task || pendingIdentity !== identity || abort.signal.aborted) return;
      if (dialog.kind === 'native' && (nativePermission ? Boolean(result.nativeChoice)
        : result.decision !== 'denied' && result.decision !== 'abort')
        && nativePrompt === requestedNativePrompt) nativePrompt = null;
      // An incomplete/ambiguous prompt is navigation-only. A returned UI value can never become
      // terminal input; the exact episode remains closed until the visible identity changes.
      if (dialog.kind === 'unrecognized' && dialog.mode === 'notice') {
        closedIdentity = identity;
        return;
      }
    }).catch(() => {
      if (pendingRequest === task) closedIdentity = identity;
    }).finally(() => {
      if (pendingRequest !== task) return;
      applyingDecision = false;
      pendingAbort = null;
      pendingRequest = null;
      pendingIdentity = null;
      pendingRequestId = null;
      pendingNativePrompt = null;
      pendingAppAnswers = undefined;
      if (!disposed && nativePrompt && nativePrompt !== requestedNativePrompt) {
        void captureScreenState(params.port).then(result => result.kind === 'state' ? handleScreen(result.state) : undefined)
          .catch((error: unknown) => params.ctx.logger.warn('[ClaudeUnifiedTerminal] Native prompt follow-up observation failed', { error }));
      }
      if (pendingUserActionNotified) {
        pendingUserActionNotified = false;
        params.onPendingUserActionChange?.(false);
      }
    });
    pendingRequest = task;
    if (!pendingUserActionNotified) {
      pendingUserActionNotified = true;
      params.onPendingUserActionChange?.(true);
    }
  };

  const publish = (dialog: ClaudeUnifiedVisibleDialog): ClaudeUnifiedResumeChoiceStartupResult => {
    const identity = getClaudeUnifiedDialogIdentity(dialog);
    if (closedIdentity === identity) return 'unhandled';
    startAsk(dialog);
    return pendingRequest ? 'waiting_for_user' : 'unhandled';
  };

  const handleResumeChoiceDialog = async (
    dialog: ClaudeUnifiedVisibleRecognizedDialog,
    screen: ClaudeScreenState,
  ): Promise<ClaudeUnifiedResumeChoiceStartupResult> => {
    const identity = getClaudeUnifiedDialogIdentity(dialog);
    if (closedIdentity === identity) return 'unhandled';
    if (policy !== 'ask_every_time') {
      if (autoAttemptedIdentity === identity) return 'unhandled';
      autoAttemptedIdentity = identity;
      const entry = getClaudeUnifiedRecognizedDialogRegistryEntry(dialog.dialogId);
      const dialogOption = resolveClaudeUnifiedRegisteredDialogOption(screen, entry, policy);
      const answered = dialogOption ? await answerVia(dialog.dialogId, identity, dialogOption) : false;
      if (!answered) {
        closedIdentity = identity;
        return 'unhandled';
      }
      return 'handled';
    }
    return publish(dialog);
  };

  const handleTrustFolderDialog = async (
    dialog: ClaudeUnifiedVisibleRecognizedDialog,
    screen: ClaudeScreenState,
  ): Promise<ClaudeUnifiedResumeChoiceStartupResult> => {
    if (workspaceTrustPolicy === 'ask_every_time') return publish(dialog);
    const identity = getClaudeUnifiedDialogIdentity(dialog);
    if (autoAttemptedIdentity === identity) return 'unhandled';
    autoAttemptedIdentity = identity;
    const entry = getClaudeUnifiedRecognizedDialogRegistryEntry('trust_folder');
    const optionChoice = workspaceTrustPolicy === 'always_trust_happier_workspaces'
      ? 'always_trust_happier_workspaces'
      : 'always_reject_happier_workspaces';
    const dialogOption = resolveClaudeUnifiedRegisteredDialogOption(screen, entry, optionChoice);
    const answered = dialogOption ? await answerVia('trust_folder', identity, dialogOption) : false;
    if (!answered) {
      closedIdentity = identity;
      return 'unhandled';
    }
    return 'handled';
  };

  const handleScreen = async (screen: ClaudeScreenState): Promise<ClaudeUnifiedResumeChoiceStartupResult> => {
      if (disposed) return 'unhandled';

      let dialog = resolveDialog(screen);
      if (!dialog && nativePrompt) {
        const interval = Math.max(1, params.verifyPollIntervalMs ?? DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.verifyPollIntervalMs);
        const polls = Math.max(1, Math.ceil((params.verifyPollTimeoutMs ?? DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS.verifyPollTimeoutMs) / interval));
        for (let poll = 0; poll < polls && !dialog; poll += 1) {
          await params.wait(interval);
          if (disposed || !nativePrompt) return 'unhandled';
          const captured = await captureScreenState(params.port);
          if (disposed || !nativePrompt) return 'unhandled';
          if (captured.kind !== 'state') return 'unhandled';
          dialog = resolveDialog(captured.state);
        }
        if (!dialog) params.ctx.logger.warn('[ClaudeUnifiedTerminal] Native prompt did not render within terminal verification budget');
      }
      if (disposed) return 'unhandled';
      if (nativePrompt?.responseLocation === 'terminal_only') return 'unhandled';
      if (!dialog) {
        if (nativePrompt) return pendingRequest ? 'waiting_for_user' : 'unhandled';
        if (pendingRequest) {
          await params.wait(params.settleMs);
          const recaptured = await captureScreenState(params.port);
          if (recaptured.kind !== 'state') return 'waiting_for_user';
          const recapturedDialog = resolveClaudeUnifiedVisibleDialog(recaptured.state);
          if (
            recapturedDialog
            && pendingIdentity === getClaudeUnifiedDialogIdentity(recapturedDialog)
          ) {
            return 'waiting_for_user';
          }
          if (!await cancelPending()) return 'waiting_for_user';
        }
        closedIdentity = null;
        return 'unhandled';
      }

      const identity = getClaudeUnifiedDialogIdentity(dialog);
      if (closedIdentity !== null && closedIdentity !== identity) closedIdentity = null;
      // Any identity mutation replaces the episode, including same-id context/option changes.
      if (pendingIdentity !== null && pendingIdentity !== identity) {
        if (!await cancelPending()) return 'waiting_for_user';
      }

      if (dialog.kind !== 'recognized') {
        return publish(dialog);
      }

      const owner = dialog.owner;
      if (owner?.kind === 'prompt_injection') {
        if (!await cancelPending()) return 'waiting_for_user';
        return 'unhandled';
      }
      if (owner?.kind === 'slash_controls') {
        if (params.isRuntimeControlInFlight?.() === true) return 'unhandled';
        if (isStartupActive() && params.runtimeConfig) {
          return answerOrphan(dialog, screen, params.runtimeConfig);
        }
        return publish(dialog);
      }
      if (owner?.kind === 'resume_startup') {
        if (isStartupActive()) return handleResumeChoiceDialog(dialog, screen);
        return publish(dialog);
      }
      if (dialog.dialogId === 'trust_folder') return handleTrustFolderDialog(dialog, screen);
      // Unowned dialogs (such as safeguard_pause) require a user decision.
      return publish(dialog);
  };
  return Object.freeze({
    handle: handleScreen,
    hasPendingUserAction() {
      return pendingRequest !== null;
    },
    hasNativePrompt: () => nativePrompt !== null,
    resolveToolUseId,
    observeSessionHook,
    observeTranscript,
    async dispose() {
      disposed = true;
      nativeToolHooks.clear();
      await cancelPending();
    },
  });
}
