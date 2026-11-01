import { readSpokenActionOutcomeOwner, resolveSpokenActionOutcome } from '@/voice/context/spokenActionOutcome';
import type { VoiceHostTextPlayback } from '@happier-dev/plugin-sdk/voice/client';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import {
  createVoiceToolHandlers,
  resolveVoiceToolEffectClass,
  type VoiceToolHandler,
} from '@/voice/tools/handlers';
import { resolveToolSessionId } from '@/voice/tools/resolveToolSessionId';
import { resolveVoiceBindingBySessionId } from '@/voice/binding/resolveVoiceBindingBySessionId';
import {
  readVoiceAgentActionEffectId,
  type VoiceAgentAcceptedOutputV1,
  type VoiceAgentSendTurnOptions,
} from '@/voice/agent/types';
import {
  getRetainedLocalVoiceEffectOutcomes,
  type LocalVoiceAgentToolResultEntry,
} from '@/voice/tools/localVoiceEffectOutcomeCustody';
import { storage } from '@/sync/domains/state/storage';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import type { VoiceToolResultRedactionPrefs } from '@/voice/context/redactVoiceToolResult';
import { buildToolResultsFollowUpPrompt, projectVoiceToolResultsForFollowUp } from '@/voice/context/buildVoiceToolResultsFollowUp';
import type { VoiceCurrentUiToolPort } from '@/voice/tools/currentUiContextToolPort';

type VoiceToolAction = Readonly<{ t?: unknown; args?: unknown }>;

/**
 * Privacy controls that gate what tool-result detail is serialized back to the voice provider on
 * the follow-up turn. Sourced from the canonical voice privacy settings so the local agent honors
 * the same file-path, session-summary, permission-request, and device-inventory prefs as the
 * push-based context formatters. Redaction itself is owned by
 * `@/voice/context/redactVoiceToolResult` plus the canonical inventory action policy.
 */
export type VoiceToolResultPrivacyPrefs = VoiceToolResultRedactionPrefs;

function resolveVoiceToolResultPrivacyPrefs(): VoiceToolResultPrivacyPrefs {
  const privacy = readVoicePrivacySettings((storage.getState() as { settings?: unknown })?.settings);
  return {
    shareFilePaths: privacy.shareFilePaths,
    shareSessionSummary: privacy.shareSessionSummary,
    sharePermissionRequests: privacy.sharePermissionRequests,
    shareDeviceInventory: privacy.shareDeviceInventory,
    shareRecentMessages: privacy.shareRecentMessages,
  };
}

type VoiceAgentSessionsLike = Readonly<{
  commitUserTranscript?: (sessionId: string, userText: string, localId: string) => Promise<void>;
  stop?: (sessionId: string) => Promise<void>;
  sendTurn: (
    sessionId: string,
    userText: string,
    opts?: VoiceAgentSendTurnOptions,
  ) => Promise<{ assistantText: string; actions?: ReadonlyArray<unknown> }>;
}>;

export type { LocalVoiceAgentToolResultEntry } from '@/voice/tools/localVoiceEffectOutcomeCustody';

export type LocalVoiceAgentTurnDisposition = 'completed' | 'tool_round_limit_reached';

function createAbortError() {
  return Object.assign(new Error('turn_aborted'), { name: 'AbortError' });
}

function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (isAbortRequested(signal)) throw createAbortError();
}

function parseToolResult(value: string): unknown {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function stableEffectValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableEffectValue(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableEffectValue((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function localEffectFingerprint(toolName: string, args: unknown): string {
  return `${JSON.stringify(toolName)}:${stableEffectValue(args)}`;
}

function createLocalToolErrorResult(
  toolName: string,
  args: unknown,
  errorCode: string,
): LocalVoiceAgentToolResultEntry {
  return {
    t: toolName,
    args,
    result: { ok: false, errorCode, errorMessage: errorCode },
  };
}

function readToolResultErrorCode(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.ok !== false) return null;
  return typeof record.errorCode === 'string' ? record.errorCode : null;
}

function redactCompletedLocalEffectOutcome(
  entry: LocalVoiceAgentToolResultEntry,
): LocalVoiceAgentToolResultEntry {
  return projectVoiceToolResultsForFollowUp(
    [entry],
    resolveVoiceToolResultPrivacyPrefs(),
  )[0] ?? createLocalToolErrorResult(entry.t, null, 'redaction_failed');
}

export async function runVoiceAgentTurnWithTools(params: Readonly<{
  sessionId: string;
  userText: string;
  durableLocalId: string;
  currentToolSessionId?: string | null;
  currentToolSessionAddress?: SessionAddress | null;
  currentUiContext?: VoiceCurrentUiToolPort;
  playHostText?: VoiceHostTextPlayback;
  voiceAgentSessions: VoiceAgentSessionsLike;
  signal?: AbortSignal;
  onOutputEvent?: (output: VoiceAgentAcceptedOutputV1) => void | Promise<void>;
  onPreparedInstructionsFor?: VoiceAgentSendTurnOptions['onPreparedInstructionsFor'];
  onUserTranscriptAccepted?: () => void | Promise<void>;
  onAssistantTurn?: (params: Readonly<{
    assistantText: string;
    actions: ReadonlyArray<unknown>;
    turnIndex: number;
  }>) => void | Promise<void>;
  onToolResults?: (params: Readonly<{
    toolResults: ReadonlyArray<LocalVoiceAgentToolResultEntry>;
    turnIndex: number;
  }>) => void | Promise<void>;
  maxToolRounds?: number;
}>): Promise<
  Readonly<{
    disposition: LocalVoiceAgentTurnDisposition;
    assistantTurns: ReadonlyArray<string>;
    toolResultBatches: ReadonlyArray<ReadonlyArray<LocalVoiceAgentToolResultEntry>>;
    totalActions: number;
  }>
> {
  const maxToolRoundsRaw = Number(params.maxToolRounds ?? 3);
  const maxToolRounds =
    Number.isFinite(maxToolRoundsRaw) && maxToolRoundsRaw > 0
      ? Math.max(1, Math.min(8, Math.floor(maxToolRoundsRaw)))
      : 3;

  throwIfAborted(params.signal);

  // Global Voice has no coding Session target, but its admitted conversation
  // still owns an exact Home. Capture it before any provider/tool await so
  // Account Actions never depend on whichever Home the UI focuses later.
  const serverId = params.currentToolSessionAddress?.serverId
    ?? resolveVoiceBindingBySessionId({ sessionId: params.sessionId })?.conversationSessionAddress.serverId;
  const tools = createVoiceToolHandlers({
    currentSessionAddress: params.currentToolSessionAddress ?? null,
    currentServerId: serverId,
    resolveSessionId: async (explicitSessionId) =>
      await resolveToolSessionId({
        explicitSessionId,
        currentSessionId: params.currentToolSessionAddress?.sessionId ?? params.currentToolSessionId ?? null,
        currentServerId: params.currentToolSessionAddress?.serverId ?? null,
      }),
    ...(params.currentUiContext ? { currentUiContext: params.currentUiContext } : {}),
    ...(params.playHostText ? { playHostText: params.playHostText } : {}),
  });

  let userTranscriptAccepted = false;
  const noteUserTranscriptAccepted = async () => {
    if (userTranscriptAccepted) return;
    userTranscriptAccepted = true;
    await params.onUserTranscriptAccepted?.();
  };

  const retainedEffectOutcomes = getRetainedLocalVoiceEffectOutcomes(params.sessionId);

  const runRetainedEffect = async (input: Readonly<{
    effectId: string;
    toolName: string;
    args: unknown;
    handler: VoiceToolHandler;
  }>): Promise<Readonly<{
    result: LocalVoiceAgentToolResultEntry;
    completedOrReused: boolean;
  }>> => {
    const fingerprint = localEffectFingerprint(input.toolName, input.args);
    const existing = retainedEffectOutcomes.get(input.effectId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return {
          result: createLocalToolErrorResult(input.toolName, input.args, 'tool_call_identity_conflict'),
          completedOrReused: false,
        };
      }
      return { result: await existing.outcome, completedOrReused: true };
    }

    const outcome = (async (): Promise<LocalVoiceAgentToolResultEntry> => {
      try {
        const parsedResult = parseToolResult(await input.handler(input.args, {
          ...(params.signal ? { signal: params.signal } : {}),
          effectId: input.effectId,
        }));
        const result = readToolResultErrorCode(parsedResult) === 'action_failed'
          ? createLocalToolErrorResult(input.toolName, input.args, 'outcome_unknown')
          : { t: input.toolName, args: input.args, result: parsedResult };
        return redactCompletedLocalEffectOutcome(result);
      } catch {
        return redactCompletedLocalEffectOutcome(
          createLocalToolErrorResult(input.toolName, input.args, 'outcome_unknown'),
        );
      }
    })();
    retainedEffectOutcomes.set(input.effectId, { fingerprint, outcome });
    return { result: await outcome, completedOrReused: true };
  };

  const runActionsOnce = async (
    actions: ReadonlyArray<unknown>,
  ): Promise<Readonly<{
    results: LocalVoiceAgentToolResultEntry[];
    interruptedAfterRetainedOutcome: boolean;
  }>> => {
    const results: LocalVoiceAgentToolResultEntry[] = [];
    for (const actionRaw of actions) {
      throwIfAborted(params.signal);
      const action = actionRaw as VoiceToolAction;
      const toolName = typeof action?.t === 'string' ? action.t.trim() : '';
      if (!toolName) continue;

      const handler = (tools as Record<string, VoiceToolHandler>)[toolName];
      if (typeof handler !== 'function') {
        results.push({
          t: toolName,
          args: action?.args ?? null,
          result: { ok: false, errorCode: 'tool_not_supported', errorMessage: 'tool_not_supported' },
        });
        continue;
      }

      const effectId = readVoiceAgentActionEffectId(actionRaw);
      const effectClass = resolveVoiceToolEffectClass(toolName);
      if (!effectId && effectClass !== 'read_only') {
        results.push(createLocalToolErrorResult(
          toolName,
          action?.args ?? null,
          'tool_call_identity_required',
        ));
        continue;
      }
      if (effectId && effectClass !== 'read_only') {
        const retained = await runRetainedEffect({
          effectId,
          toolName,
          args: action?.args ?? null,
          handler,
        });
        results.push(retained.result);
        if (retained.completedOrReused && isAbortRequested(params.signal)) {
          return { results, interruptedAfterRetainedOutcome: true };
        }
        continue;
      }

      try {
        const value = await handler(action?.args ?? null, {
          ...(params.signal ? { signal: params.signal } : {}),
          ...(effectId ? { effectId } : {}),
        });
        throwIfAborted(params.signal);
        results.push({
          t: toolName,
          args: action?.args ?? null,
          result: parseToolResult(value),
        });
      } catch (error) {
        if (isAbortRequested(params.signal)) throw createAbortError();
        results.push({
          t: toolName,
          args: action?.args ?? null,
          result: {
            ok: false,
            errorCode: 'tool_failed',
            errorMessage: error instanceof Error ? error.message : 'tool_failed',
          },
        });
      }
    }
    return { results, interruptedAfterRetainedOutcome: false };
  };

  const assistantTurns: string[] = [];
  const toolResultBatches: Array<ReadonlyArray<LocalVoiceAgentToolResultEntry>> = [];
  let totalActions = 0;
  let nextPrompt = params.userText;
  let spokenActionOutcome: string | null = null;
  let ownerPresentsOutcome = false;

  for (let turnIndex = 0; turnIndex <= maxToolRounds; turnIndex += 1) {
    throwIfAborted(params.signal);

    const response = await params.voiceAgentSessions.sendTurn(
      params.sessionId,
      nextPrompt,
      {
        ...(params.onOutputEvent && turnIndex < maxToolRounds ? { onOutputEvent: async output => {
          if (output.effects.some(effect => effect.kind === 'execute_side_effect'
            && readSpokenActionOutcomeOwner(effect.action.t, effect.action.args))) ownerPresentsOutcome = true;
          // Action-bearing prose precedes execution; follow-up prose can contradict
          // a refusal. Neither can replace this mutation owner's settlement.
          await params.onOutputEvent?.(ownerPresentsOutcome ? { ...output,
            effects: output.effects.filter(effect => effect.kind !== 'speak' && effect.kind !== 'persist_final'),
          } : output);
        } } : {}),
        ...(params.onPreparedInstructionsFor ? { onPreparedInstructionsFor: params.onPreparedInstructionsFor } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        ...(turnIndex === 0
          ? { onUserTranscriptAccepted: noteUserTranscriptAccepted }
          : {}),
        userTranscript: turnIndex === 0
          // Pending already owns this durable input. A second native write
          // under the same localId has different metadata/sidechain and makes
          // Pending's exact-envelope settlement conflict. Keep the id for
          // provider correlation; the acceptance callback settles the sole row.
          ? { mode: 'suppress' as const, localId: params.durableLocalId }
          : { mode: 'suppress' as const },
      },
    );

    throwIfAborted(params.signal);

    const actions = Array.isArray(response.actions) ? response.actions : [];
    if (actions.length > 0 && turnIndex === maxToolRounds) {
      if (!params.voiceAgentSessions.stop) {
        throw new Error('voice_agent_session_retirement_required');
      }
      await params.voiceAgentSessions.stop(params.sessionId);
      return {
        disposition: 'tool_round_limit_reached',
        assistantTurns,
        toolResultBatches,
        totalActions,
      };
    }

    totalActions += actions.length;
    if (actions.length === 0) {
      // Action-bearing text precedes execution and cannot confirm an outcome.
      // Only the follow-up informed by the real result is a spoken answer.
      const assistantText = spokenActionOutcome ?? String(response.assistantText ?? '').trim();
      assistantTurns.push(assistantText);
      await params.onAssistantTurn?.({ assistantText, actions, turnIndex });
      return {
        disposition: 'completed',
        assistantTurns,
        toolResultBatches,
        totalActions,
      };
    }

    const actionRun = await runActionsOnce(actions);
    const toolResults = actionRun.results;
    toolResultBatches.push(toolResults);
    const outcomes = toolResults.map(resolveSpokenActionOutcome).filter(outcome => outcome !== null);
    if (outcomes.length > 0) {
      ownerPresentsOutcome = true;
      spokenActionOutcome = [spokenActionOutcome, ...outcomes].filter(Boolean).join(' ');
    }
    await params.onToolResults?.({
      toolResults,
      turnIndex,
    });

    if (actionRun.interruptedAfterRetainedOutcome) {
      return {
        disposition: 'completed',
        assistantTurns,
        toolResultBatches,
        totalActions,
      };
    }

    if (toolResults.length === 0) {
      return {
        disposition: 'completed',
        assistantTurns,
        toolResultBatches,
        totalActions,
      };
    }

    nextPrompt = buildToolResultsFollowUpPrompt(toolResults, resolveVoiceToolResultPrivacyPrefs());
  }

  return {
    disposition: 'completed',
    assistantTurns,
    toolResultBatches,
    totalActions,
  };
}
