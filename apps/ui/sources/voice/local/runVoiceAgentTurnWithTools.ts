import {
  createVoiceToolHandlers,
  resolveVoiceToolEffectClass,
  type VoiceToolHandler,
} from '@/voice/tools/handlers';
import { resolveToolSessionId } from '@/voice/tools/resolveToolSessionId';
import {
  readVoiceAgentActionEffectId,
  type VoiceAgentAcceptedOutputV1,
  type VoiceAgentSendTurnOptions,
} from '@/voice/agent/types';
import {
  getRetainedLocalVoiceEffectOutcomes,
  type LocalVoiceAgentToolResultEntry,
} from '@/voice/tools/localVoiceEffectOutcomeCustody';
import {
  formatVoiceToolResultsFollowUp,
  getActionSpec,
  VOICE_TOOL_RESULT_INSTRUCTIONS_PREFIX,
} from '@happier-dev/protocol';
import { resolveVoiceToolResultHumanSummary } from '@/voice/context/resolveVoiceToolResultHumanSummary';
import { isBundledAgentId } from '@/agents/catalog/catalog';
import { storage } from '@/sync/domains/state/storage';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import {
  isVoiceToolResultBlockedByPrivacy,
  redactVoiceToolResultForProvider,
  redactVoiceToolResultValue,
  type VoiceToolResultRedactionPrefs,
} from '@/voice/context/redactVoiceToolResult';
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
  sendTurn: (
    sessionId: string,
    userText: string,
    opts?: VoiceAgentSendTurnOptions,
  ) => Promise<{ assistantText: string; actions?: ReadonlyArray<unknown> }>;
}>;

export type { LocalVoiceAgentToolResultEntry } from '@/voice/tools/localVoiceEffectOutcomeCustody';

const FOLLOW_UP_RESULT_MAX_ITEMS = 8;
const FOLLOW_UP_RESULT_MAX_STRING_LENGTH = 160;
const FOLLOW_UP_RESULT_OMITTED_KEYS = new Set(['uiConnectedService', 'flavorAliases']);
const PROVIDER_RESULT_ARGUMENT_OMITTED_TOOL_NAMES = new Set([
  getActionSpec('action.invoke').bindings?.voiceClientToolName,
  getActionSpec('ui.current_context.command.invoke').bindings?.voiceClientToolName,
].filter((value): value is string => typeof value === 'string' && value.length > 0));

function readBackendIdFromTargetKey(targetKey: string): string | null {
  const trimmed = String(targetKey ?? '').trim();
  if (!trimmed.startsWith('backend:')) return null;
  const rest = trimmed.slice('backend:'.length);
  const parts = rest.split(':');
  const backendId = parts[0]?.trim() ?? '';
  return backendId ? backendId : null;
}

function selectListItemsForFollowUp(params: Readonly<{
  rawItems: ReadonlyArray<Record<string, unknown>>;
  pinnedTargetKeys: ReadonlySet<string>;
  maxItems: number;
}>): ReadonlyArray<Record<string, unknown>> {
  const pinned = new Set<string>(params.pinnedTargetKeys);

  // If there are any non-built-in backends (configured/plugin), pin the first one so we don't
  // accidentally drop it when we slice down large catalog responses for the follow-up prompt.
  for (const item of params.rawItems) {
    const targetKey = typeof item?.targetKey === 'string' ? item.targetKey : '';
    if (!targetKey) continue;
    const backendId = readBackendIdFromTargetKey(targetKey);
    if (backendId && !isBundledAgentId(backendId)) {
      pinned.add(targetKey);
      break;
    }
  }

  const selected: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const item of params.rawItems) {
    if (selected.length >= params.maxItems) break;
    const targetKey = typeof item?.targetKey === 'string' ? item.targetKey : '';
    if (!targetKey || !pinned.has(targetKey) || seen.has(targetKey)) continue;
    seen.add(targetKey);
    selected.push(item);
  }

  for (const item of params.rawItems) {
    if (selected.length >= params.maxItems) break;
    const targetKey = typeof item?.targetKey === 'string' ? item.targetKey : '';
    if (targetKey && seen.has(targetKey)) continue;
    if (targetKey) seen.add(targetKey);
    selected.push(item);
  }

  return selected;
}

function compactToolResultValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > FOLLOW_UP_RESULT_MAX_STRING_LENGTH
      ? `${value.slice(0, FOLLOW_UP_RESULT_MAX_STRING_LENGTH - 1)}…`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.slice(0, FOLLOW_UP_RESULT_MAX_ITEMS).map((entry) => compactToolResultValue(entry));
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !FOLLOW_UP_RESULT_OMITTED_KEYS.has(key))
      .map(([key, entryValue]) => [key, compactToolResultValue(entryValue)] as const)
      .filter(([, entryValue]) => entryValue !== undefined);

    return Object.fromEntries(entries);
  }

  return String(value);
}

function compactToolResultsForFollowUp(
  toolResults: ReadonlyArray<LocalVoiceAgentToolResultEntry>,
  prefs: VoiceToolResultPrivacyPrefs,
): ReadonlyArray<LocalVoiceAgentToolResultEntry> {
  const pinnedBackendTargetKeys = new Set<string>();
  for (const entry of toolResults) {
    if (entry.t !== 'listAgentModels') continue;
    const args = entry.args as { backendTargetKey?: unknown } | null | undefined;
    const backendTargetKey = typeof args?.backendTargetKey === 'string' ? args.backendTargetKey.trim() : '';
    if (backendTargetKey) {
      pinnedBackendTargetKeys.add(backendTargetKey);
    }
  }

  return toolResults.map((entry) => {
    if (isVoiceToolResultBlockedByPrivacy(entry.t, prefs)) {
      return {
        t: entry.t,
        args: null,
        result: {
          ok: false,
          errorCode: 'privacy_disabled',
          errorMessage: 'privacy_disabled',
        },
      };
    }

    const humanSummary = resolveVoiceToolResultHumanSummary({
      toolName: entry.t,
      toolInput: entry.args,
      toolResult: entry.result,
      shareFilePaths: prefs.shareFilePaths,
      shareSessionSummary: prefs.shareSessionSummary,
    });

    if (entry.t === 'listAgentBackends') {
      const result = entry.result;
      const rawItems = Array.isArray((result as { items?: unknown })?.items)
        ? ((result as { items: ReadonlyArray<Record<string, unknown>> }).items ?? [])
        : [];
      const items = selectListItemsForFollowUp({
        rawItems,
        pinnedTargetKeys: pinnedBackendTargetKeys,
        maxItems: FOLLOW_UP_RESULT_MAX_ITEMS,
      }).map((item) => {
            const targetKey = typeof item?.targetKey === 'string' ? item.targetKey : '';
            return {
              ...((targetKey.startsWith('acpBackend:') || targetKey.startsWith('backend:')) ? { targetKey } : {}),
              agentId: typeof item?.agentId === 'string' ? item.agentId : '',
              label: typeof item?.label === 'string' ? item.label : '',
              enabled: item?.enabled !== false,
              experimental: item?.experimental === true,
            };
          });

      return {
        t: entry.t,
        args: compactToolResultValue(redactVoiceToolResultValue(entry.args, prefs)),
        result: {
          ...(result && typeof result === 'object' && (result as { ok?: unknown }).ok === false ? { ok: false } : { ok: true }),
          ...(humanSummary ? { summary: humanSummary } : {}),
          items,
        },
      };
    }

    if (entry.t === 'listAgentModels') {
      const result = entry.result;
      const items = Array.isArray((result as { items?: unknown })?.items)
        ? ((result as { items: ReadonlyArray<Record<string, unknown>> }).items ?? []).slice(0, FOLLOW_UP_RESULT_MAX_ITEMS).map((item) => ({
            modelId: typeof item?.modelId === 'string' ? item.modelId : '',
            label: typeof item?.label === 'string' ? item.label : '',
            ...(typeof item?.providerConnectionId === 'string'
              ? { providerConnectionId: item.providerConnectionId }
              : item?.providerConnectionId === null
                ? { providerConnectionId: null }
                : {}),
            ...(typeof item?.providerName === 'string' && item.providerName.trim().length > 0
              ? { providerName: item.providerName }
              : {}),
          }))
        : [];

      return {
        t: entry.t,
        args: compactToolResultValue(redactVoiceToolResultValue(entry.args, prefs)),
        result: {
          ...(typeof (result as { agentId?: unknown })?.agentId === 'string' ? { agentId: (result as { agentId: string }).agentId } : {}),
          ...(typeof (result as { source?: unknown })?.source === 'string' ? { source: (result as { source: string }).source } : {}),
          ...(result && typeof result === 'object' && typeof (result as { supportsFreeform?: unknown }).supportsFreeform === 'boolean'
            ? { supportsFreeform: (result as { supportsFreeform: boolean }).supportsFreeform }
            : {}),
          ...(humanSummary ? { summary: humanSummary } : {}),
          items,
        },
      };
    }

    return {
      t: entry.t,
      // The provider already owns the originating call. Repeating these arguments in the
      // result channel would disclose Action input or an ephemeral current-UI command id.
      args: PROVIDER_RESULT_ARGUMENT_OMITTED_TOOL_NAMES.has(entry.t)
        ? null
        : compactToolResultValue(redactVoiceToolResultValue(entry.args, prefs)),
      result: (() => {
        const compacted = compactToolResultValue(redactVoiceToolResultForProvider(
          entry.t,
          entry.result,
          prefs,
        ));
        if (!humanSummary) {
          return compacted;
        }
        if (compacted && typeof compacted === 'object' && !Array.isArray(compacted)) {
          return { ...compacted, summary: humanSummary };
        }
        return { summary: humanSummary, value: compacted };
      })(),
    };
  });
}

export function buildToolResultsFollowUpPrompt(
  toolResults: ReadonlyArray<LocalVoiceAgentToolResultEntry>,
  prefs: VoiceToolResultPrivacyPrefs,
): string {
  const hasErrors = toolResults.some((entry) => {
    const result = entry.result;
    if (!result || typeof result !== 'object') {
      return false;
    }
    const ok = (result as { ok?: unknown }).ok;
    const errorCode = (result as { errorCode?: unknown }).errorCode;
    return ok === false || typeof errorCode === 'string';
  });

  const instruction = hasErrors
    ? `${VOICE_TOOL_RESULT_INSTRUCTIONS_PREFIX} At least one action failed. Do not claim success, do not repeat a requested success token, and explain the failure plainly.`
    : `${VOICE_TOOL_RESULT_INSTRUCTIONS_PREFIX} All actions succeeded. Summarize the completed outcome accurately.`;

  return `${formatVoiceToolResultsFollowUp({ toolResults: compactToolResultsForFollowUp(toolResults, prefs) })}\n${instruction}`;
}

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
  return compactToolResultsForFollowUp(
    [entry],
    resolveVoiceToolResultPrivacyPrefs(),
  )[0] ?? createLocalToolErrorResult(entry.t, null, 'redaction_failed');
}

function isSuccessfulToolShortcutResult(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (value as { ok?: unknown }).ok === true;
}

function getToolShortcutErrorCode(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const errorCode = (value as { errorCode?: unknown }).errorCode;
  return typeof errorCode === 'string' ? errorCode : null;
}

const DIRECT_PERMISSION_SHORTCUT_ALLOWED_TOKENS = new Set([
  'a',
  'allow',
  'an',
  'approve',
  'current',
  'decline',
  'deny',
  'do',
  "don't",
  'file',
  'grant',
  'it',
  'not',
  'pending',
  'permission',
  'please',
  'read',
  'reject',
  'request',
  'session',
  'that',
  'the',
  'this',
  'tool',
  'write',
]);
const DIRECT_PERMISSION_SHORTCUT_BLOCKED_TOKENS = new Set(['after', 'also', 'and', 'because', 'next', 'plus', 'then']);

function tokenizeDirectShortcut(userText: string): string[] {
  return userText
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function resolveDirectPermissionDecision(userText: string): 'allow' | 'deny' | null {
  const tokens = tokenizeDirectShortcut(userText);
  if (tokens.length === 0) return null;

  if (tokens.some((token) => DIRECT_PERMISSION_SHORTCUT_BLOCKED_TOKENS.has(token))) {
    return null;
  }

  const hasDenyKeyword =
    tokens.includes('deny')
    || tokens.includes('reject')
    || tokens.includes('decline')
    || tokens.includes("don't")
    || (tokens.includes('do') && tokens.includes('not') && tokens.includes('allow'));
  const hasAllowKeyword = tokens.includes('approve') || tokens.includes('allow') || tokens.includes('grant');

  if (hasAllowKeyword && hasDenyKeyword) {
    return null;
  }

  if (tokens.some((token) => !DIRECT_PERMISSION_SHORTCUT_ALLOWED_TOKENS.has(token))) {
    return null;
  }

  if (hasDenyKeyword) {
    return 'deny';
  }

  if (hasAllowKeyword) {
    return 'allow';
  }

  return null;
}

function mapDirectDecisionToUserActionDecision(decision: 'allow' | 'deny'): 'approve' | 'reject' {
  return decision === 'allow' ? 'approve' : 'reject';
}

function resolveDirectPermissionDisambiguationText(
  userActionShortcutResult: unknown,
): string | null {
  const errorCodes = new Set([
    getToolShortcutErrorCode(userActionShortcutResult),
  ]);

  if (errorCodes.has('request_not_in_current_session')) {
    return 'I found a pending request outside the current session. Please name the target session first.';
  }
  if (errorCodes.has('multiple_permission_requests') || errorCodes.has('multiple_user_action_requests')) {
    return 'There are multiple pending requests in the current session. Please say which request you want me to answer.';
  }
  return null;
}

function normalizeAssistantTextForActions(
  assistantText: string,
  actions: ReadonlyArray<unknown>,
  turnIndex: number,
): string {
  const trimmed = String(assistantText ?? '').trim();
  if (turnIndex !== 0) return trimmed;

  const actionNames = actions
    .map((actionRaw) => {
      const action = actionRaw as VoiceToolAction;
      return typeof action?.t === 'string' ? action.t.trim() : '';
    })
    .filter((name) => name.length > 0);

  if (actionNames.includes('sendSessionMessage')) {
    return 'I sent that to the coding assistant and am waiting for its update.';
  }

  return trimmed;
}

export async function runVoiceAgentTurnWithTools(params: Readonly<{
  sessionId: string;
  userText: string;
  durableLocalId: string;
  currentToolSessionId?: string | null;
  currentUiContext?: VoiceCurrentUiToolPort;
  voiceAgentSessions: VoiceAgentSessionsLike;
  signal?: AbortSignal;
  onOutputEvent?: (output: VoiceAgentAcceptedOutputV1) => void | Promise<void>;
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

  const tools = createVoiceToolHandlers({
    resolveSessionId: (explicitSessionId) =>
      resolveToolSessionId({
        explicitSessionId,
        currentSessionId: params.currentToolSessionId ?? null,
      }),
    ...(params.currentUiContext ? { currentUiContext: params.currentUiContext } : {}),
  });

  const directPermissionDecision = resolveDirectPermissionDecision(params.userText);
  let outerTranscriptCommitted = false;
  let userTranscriptAccepted = false;
  const noteUserTranscriptAccepted = async () => {
    if (userTranscriptAccepted) return;
    userTranscriptAccepted = true;
    await params.onUserTranscriptAccepted?.();
  };
  if (directPermissionDecision) {
    if (!params.voiceAgentSessions.commitUserTranscript) {
      throw new Error('voice_user_transcript_commit_required');
    }
    await params.voiceAgentSessions.commitUserTranscript(
      params.sessionId,
      params.userText,
      params.durableLocalId,
    );
    outerTranscriptCommitted = true;
    await noteUserTranscriptAccepted();
    const userActionShortcutResult = parseToolResult(
      await (tools as any).answerUserActionRequest({
        decision: mapDirectDecisionToUserActionDecision(directPermissionDecision),
        currentSessionOnly: true,
      }),
    );
    throwIfAborted(params.signal);
    if (isSuccessfulToolShortcutResult(userActionShortcutResult)) {
      const toolResults = [
        {
          t: 'answerUserActionRequest',
          args: { decision: mapDirectDecisionToUserActionDecision(directPermissionDecision) },
          result: userActionShortcutResult,
        },
      ] satisfies LocalVoiceAgentToolResultEntry[];
      const assistantText =
        directPermissionDecision === 'allow'
          ? 'Approved the pending request.'
          : 'Denied the pending request.';

      await params.onAssistantTurn?.({
        assistantText,
        actions: [{ t: 'answerUserActionRequest', args: { decision: mapDirectDecisionToUserActionDecision(directPermissionDecision) } }],
        turnIndex: 0,
      });
      await params.onToolResults?.({
        toolResults,
        turnIndex: 0,
      });

      return {
        assistantTurns: [assistantText],
        toolResultBatches: [toolResults],
        totalActions: 1,
      };
    }

    const directPermissionDisambiguation = resolveDirectPermissionDisambiguationText(
      userActionShortcutResult,
    );
    if (directPermissionDisambiguation) {
      await params.onAssistantTurn?.({
        assistantText: directPermissionDisambiguation,
        actions: [],
        turnIndex: 0,
      });
      return {
        assistantTurns: [directPermissionDisambiguation],
        toolResultBatches: [],
        totalActions: 0,
      };
    }
  }

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

  for (let turnIndex = 0; turnIndex <= maxToolRounds; turnIndex += 1) {
    throwIfAborted(params.signal);

    const response = await params.voiceAgentSessions.sendTurn(
      params.sessionId,
      nextPrompt,
      {
        ...(params.onOutputEvent ? { onOutputEvent: params.onOutputEvent } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        ...(turnIndex === 0
          ? { onUserTranscriptAccepted: noteUserTranscriptAccepted }
          : {}),
        userTranscript: turnIndex === 0 && !outerTranscriptCommitted
          ? { mode: 'persist' as const, localId: params.durableLocalId }
          : { mode: 'suppress' as const },
      },
    );

    throwIfAborted(params.signal);

    const assistantText = normalizeAssistantTextForActions(response.assistantText ?? '', Array.isArray(response.actions) ? response.actions : [], turnIndex);
    const actions = Array.isArray(response.actions) ? response.actions : [];
    assistantTurns.push(assistantText);
    totalActions += actions.length;

    await params.onAssistantTurn?.({
      assistantText,
      actions,
      turnIndex,
    });

    if (actions.length === 0 || turnIndex === maxToolRounds) {
      return {
        assistantTurns,
        toolResultBatches,
        totalActions,
      };
    }

    const actionRun = await runActionsOnce(actions);
    const toolResults = actionRun.results;
    toolResultBatches.push(toolResults);
    await params.onToolResults?.({
      toolResults,
      turnIndex,
    });

    if (actionRun.interruptedAfterRetainedOutcome) {
      return {
        assistantTurns,
        toolResultBatches,
        totalActions,
      };
    }

    if (toolResults.length === 0) {
      return {
        assistantTurns,
        toolResultBatches,
        totalActions,
      };
    }

    nextPrompt = buildToolResultsFollowUpPrompt(toolResults, resolveVoiceToolResultPrivacyPrefs());
  }

  return {
    assistantTurns,
    toolResultBatches,
    totalActions,
  };
}
