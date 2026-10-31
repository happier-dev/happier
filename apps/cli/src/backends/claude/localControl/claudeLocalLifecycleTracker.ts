import type {
  LocalTurnLifecycleController,
  LocalTurnLifecycleEvent,
} from '@/agent/localControl/turnLifecycle';
import type { RawJSONLines } from '@/backends/claude/types';
import type { SessionHookData } from '../utils/startHookServer';
import {
  isSidechainSessionHook,
  isClaudeSidechainRuntimeEvidence,
  isLivePrimaryClaudeProviderHook,
  readSessionHookEventName,
} from '../utils/sessionHookAttribution';
export { isClaudeTaskNotificationUserPromptHook } from '../utils/sessionHookTaskNotification';
import { isClaudeTaskNotificationUserPromptHook } from '../utils/sessionHookTaskNotification';
import {
  createClaudeProviderActivityLedger,
  readClaudeProviderTaskActivity,
  readClaudeSessionHookProviderTaskActivity,
  type ClaudeProviderTaskActivity,
} from '../providerActivity/createClaudeProviderActivityLedger';
import { readClaudeTranscriptTurnSignal } from './readClaudeTranscriptTurnSignal';
import {
  isClaudeTranscriptTaskNotification,
} from './readClaudeTranscriptProviderActivity';
import type { createClaudeProviderRuntimeActivityAdapter } from '../providerActivity/createClaudeProviderRuntimeActivityAdapter';
import { isReplaySdkMessage } from '../remote/runtimeActivityEvidence';

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readFirstNonEmptyString(
  value: unknown,
  ...keys: readonly string[]
): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Readonly<Record<string, unknown>>;
  for (const key of keys) {
    const normalized = readNonEmptyString(record[key]);
    if (normalized) return normalized;
  }
  return null;
}

function readHookErrorDiscriminator(data: SessionHookData): string | undefined {
  const raw = data.error ?? data.error_type;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

function hookToLifecycleEvent(data: SessionHookData): LocalTurnLifecycleEvent | null {
  const hookEventName = readSessionHookEventName(data);
  if (hookEventName === 'UserPromptSubmit') {
    if (isClaudeTaskNotificationUserPromptHook(data)) return null;
    return { type: 'turn_started', providerTurnId: null, source: 'claude_hook_user_prompt_submit' };
  }
  if (hookEventName === 'Stop') {
    return { type: 'completion_candidate', providerTurnId: null, source: 'claude_hook_stop' };
  }
  if (hookEventName === 'StopFailure') {
    return {
      type: 'turn_terminal',
      providerTurnId: null,
      reason: 'failed',
      source: 'claude_hook_stop_failure',
      detail: readHookErrorDiscriminator(data),
    };
  }
  if (hookEventName === 'SessionEnd') {
    return { type: 'session_ended', source: 'claude_hook_session_end' };
  }
  return null;
}

export function createClaudeLocalLifecycleTracker(opts: Readonly<{
  lifecycle: LocalTurnLifecycleController;
  runtimeActivityAdapter?: ReturnType<typeof createClaudeProviderRuntimeActivityAdapter> | null;
  providerActivityLedger?: ReturnType<typeof createClaudeProviderActivityLedger>;
  onProviderEvent?: () => void;
  readProviderSessionId?: () => string | null;
}>) {
  const providerActivityLedger = opts.providerActivityLedger ?? createClaudeProviderActivityLedger();
  let pendingTaskNotificationReaction: {
    sessionId: string;
    promptId: string | null;
    transcriptUuid: string | null;
  } | null = null;

  const runRuntimeActivityEffect = (
    _label: string,
    effect: () => Promise<void> | void,
  ): void => {
    try {
      void Promise.resolve(effect()).catch(() => undefined);
    } catch {
      // Runtime-activity projection is non-critical to local lifecycle parsing.
    }
  };

  const handleClaudeRuntimeActivityLoss = (reason: string, options?: Readonly<{ providerStopped: true }>): void => {
    const runtimeActivityAdapter = opts.runtimeActivityAdapter;
    if (!runtimeActivityAdapter) return;
    runRuntimeActivityEffect('runtime-loss-target', () => (options
      ? runtimeActivityAdapter.handleRuntimeLoss(reason, options)
      : runtimeActivityAdapter.handleRuntimeLoss(reason)));
  };

  const observeLifecycle = (event: LocalTurnLifecycleEvent | null): void => {
    if (!event) return;
    opts.lifecycle.observe(event);
  };

  const observeProviderActivityFact = (activity: ClaudeProviderTaskActivity): void => {
    if (opts.runtimeActivityAdapter) {
      runRuntimeActivityEffect(activity.type, () => opts.runtimeActivityAdapter?.observeActivity({
        activity,
        evidence: 'live',
      }));
    } else {
      providerActivityLedger.apply(activity);
    }
  };

  const observeProviderActivity = (message: unknown, expectedSessionId: string): void => {
    if (isReplaySdkMessage(message)) return;
    if (readFirstNonEmptyString(message, 'session_id', 'sessionId') === expectedSessionId
      && !isClaudeSidechainRuntimeEvidence(message)) {
      opts.onProviderEvent?.();
    }
    const activity = readClaudeProviderTaskActivity(message, expectedSessionId);
    if (activity) {
      if (activity.sessionId !== expectedSessionId) return;
      observeProviderActivityFact(activity);
      return;
    }

  };

  const observe = (event: LocalTurnLifecycleEvent | null): void => {
    observeLifecycle(event);
  };

  const clearPendingTaskNotificationReaction = (): void => {
    pendingTaskNotificationReaction = null;
  };

  const openTaskNotificationReaction = (
    source: 'claude_task_notification_reaction_assistant' | 'claude_task_notification_reaction_tool',
  ): void => {
    const snapshot = opts.lifecycle.snapshot();
    clearPendingTaskNotificationReaction();
    if (snapshot.active && !snapshot.terminal) return;
    observe({
      type: 'turn_started',
      providerTurnId: null,
      source,
    });
  };

  return {
    observeHook(data: SessionHookData): void {
      const providerActivity = readClaudeSessionHookProviderTaskActivity(data);
      if (providerActivity) observeProviderActivityFact(providerActivity);
      // Sidechain (subagent) hooks never drive the primary turn lifecycle: a
      // subagent StopFailure/Stop/SessionEnd is not primary-turn evidence.
      // Source-keyed sidechain activity is published at the Claude Session hook
      // boundary so all modes share one runtime-activity producer.
      if (isSidechainSessionHook(data)) {
        return;
      }
      if (isLivePrimaryClaudeProviderHook(data, opts.readProviderSessionId?.())) opts.onProviderEvent?.();
      const hookEventName = readSessionHookEventName(data);
      if (hookEventName === 'UserPromptSubmit') {
        if (isClaudeTaskNotificationUserPromptHook(data)) {
          const snapshot = opts.lifecycle.snapshot();
          const sessionId = readFirstNonEmptyString(data, 'session_id', 'sessionId');
          if ((!snapshot.active || snapshot.terminal) && sessionId) {
            pendingTaskNotificationReaction = {
              sessionId,
              promptId: readFirstNonEmptyString(data, 'prompt_id', 'promptId'),
              transcriptUuid: null,
            };
          }
        } else {
          clearPendingTaskNotificationReaction();
        }
      } else if (hookEventName === 'PostToolUse' && pendingTaskNotificationReaction) {
        const sessionId = readFirstNonEmptyString(data, 'session_id', 'sessionId');
        if (sessionId === pendingTaskNotificationReaction.sessionId) {
          openTaskNotificationReaction('claude_task_notification_reaction_tool');
        }
      } else if (
        hookEventName === 'SessionStart'
        || hookEventName === 'Stop'
        || hookEventName === 'StopFailure'
        || hookEventName === 'SessionEnd'
      ) {
        clearPendingTaskNotificationReaction();
      }
      observe(hookToLifecycleEvent(data));
    },
    observeTranscript(message: RawJSONLines): void {
      const pendingReaction = pendingTaskNotificationReaction;
      if (
        pendingReaction
        && (message as Readonly<Record<string, unknown>>).isReplay !== true
        && (message as Readonly<Record<string, unknown>>).is_replay !== true
        && (message as Readonly<Record<string, unknown>>).isSidechain !== true
      ) {
        const sessionId = readFirstNonEmptyString(message, 'session_id', 'sessionId');
        if (sessionId === pendingReaction.sessionId) {
          if (message.type === 'user' && isClaudeTranscriptTaskNotification(message)) {
            const promptId = readFirstNonEmptyString(message, 'prompt_id', 'promptId');
            if (!pendingReaction.promptId || promptId === pendingReaction.promptId) {
              const transcriptUuid = readFirstNonEmptyString(message, 'uuid');
              if (transcriptUuid) {
                pendingReaction.transcriptUuid = transcriptUuid;
              }
            }
          } else if (
            message.type === 'assistant'
            && pendingReaction.transcriptUuid
            && readFirstNonEmptyString(message, 'parentUuid', 'parent_uuid') === pendingReaction.transcriptUuid
          ) {
            openTaskNotificationReaction('claude_task_notification_reaction_assistant');
          }
        }
      }
      observe(readClaudeTranscriptTurnSignal(message));
    },
    observeLiveProviderActivityRow(message: unknown, expectedSessionId: string): void {
      observeProviderActivity(message, expectedSessionId);
    },
    handleProviderActivityObservationLoss(reason: string): void {
      handleClaudeRuntimeActivityLoss(reason);
    },
    observeProcessExit(options?: Readonly<{ providerStopped?: boolean }>): void {
      clearPendingTaskNotificationReaction();
      handleClaudeRuntimeActivityLoss('claude_process_exit', options?.providerStopped === true
        ? { providerStopped: true } : undefined);
      const snapshot = opts.lifecycle.snapshot();
      if (!snapshot.active || snapshot.terminal) return;
      opts.lifecycle.observe({
        type: 'turn_terminal',
        providerTurnId: snapshot.providerTurnId,
        reason: 'process-exited',
        source: 'claude_local_process_exit',
      });
    },
  };
}
