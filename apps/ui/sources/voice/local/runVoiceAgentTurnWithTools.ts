import { createVoiceToolHandlers } from '@/voice/tools/handlers';
import { resolveToolSessionId } from '@/voice/tools/resolveToolSessionId';
import { resolveVoiceToolResultHumanSummary } from '@/voice/context/resolveVoiceToolResultHumanSummary';

type VoiceToolAction = Readonly<{ t?: unknown; args?: unknown }>;

type VoiceAgentSessionsLike = Readonly<{
  sendTurn: (
    sessionId: string,
    userText: string,
    opts?:
      | {
          onTextDelta?: (delta: string) => void;
          signal?: AbortSignal;
        }
      | undefined,
  ) => Promise<{ assistantText: string; actions?: ReadonlyArray<unknown> }>;
}>;

export type LocalVoiceAgentToolResultEntry = Readonly<{
  t: string;
  args: unknown;
  result: unknown;
}>;

const FOLLOW_UP_RESULT_MAX_ITEMS = 10;
const FOLLOW_UP_RESULT_MAX_STRING_LENGTH = 160;
const FOLLOW_UP_RESULT_OMITTED_KEYS = new Set(['connectedServiceId', 'connectedServiceName', 'flavorAliases']);

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

function compactToolResultsForFollowUp(toolResults: ReadonlyArray<LocalVoiceAgentToolResultEntry>): ReadonlyArray<LocalVoiceAgentToolResultEntry> {
  return toolResults.map((entry) => {
    const humanSummary = resolveVoiceToolResultHumanSummary({
      toolName: entry.t,
      toolInput: entry.args,
      toolResult: entry.result,
      shareFilePaths: true,
    });

    if (entry.t === 'listAgentBackends') {
      const result = entry.result;
      const items = Array.isArray((result as { items?: unknown })?.items)
        ? ((result as { items: ReadonlyArray<Record<string, unknown>> }).items ?? []).slice(0, FOLLOW_UP_RESULT_MAX_ITEMS).map((item) => ({
            agentId: typeof item?.agentId === 'string' ? item.agentId : '',
            label: typeof item?.label === 'string' ? item.label : '',
            enabled: item?.enabled !== false,
            experimental: item?.experimental === true,
          }))
        : [];

      return {
        t: entry.t,
        args: compactToolResultValue(entry.args),
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
          }))
        : [];

      return {
        t: entry.t,
        args: compactToolResultValue(entry.args),
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
      args: compactToolResultValue(entry.args),
      result: (() => {
        const compacted = compactToolResultValue(entry.result);
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

function buildToolResultsFollowUpPrompt(toolResults: ReadonlyArray<LocalVoiceAgentToolResultEntry>): string {
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
    ? 'VOICE_TOOL_RESULT_INSTRUCTIONS: At least one action failed. Do not claim success, do not repeat a requested success token, and explain the failure plainly.'
    : 'VOICE_TOOL_RESULT_INSTRUCTIONS: All actions succeeded. Summarize the completed outcome accurately.';

  return `VOICE_TOOL_RESULTS_JSON:\n${JSON.stringify({ toolResults: compactToolResultsForFollowUp(toolResults) })}\n${instruction}`;
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
  permissionShortcutResult: unknown,
  userActionShortcutResult: unknown,
): string | null {
  const errorCodes = new Set([
    getToolShortcutErrorCode(permissionShortcutResult),
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
  currentToolSessionId?: string | null;
  voiceAgentSessions: VoiceAgentSessionsLike;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
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

  const tools = createVoiceToolHandlers({
    resolveSessionId: (explicitSessionId) =>
      resolveToolSessionId({
        explicitSessionId,
        currentSessionId: params.currentToolSessionId ?? null,
      }),
  });

  const directPermissionDecision = resolveDirectPermissionDecision(params.userText);
  if (directPermissionDecision) {
    const permissionShortcutResult = parseToolResult(
      await (tools as any).processPermissionRequest({ decision: directPermissionDecision, currentSessionOnly: true }),
    );

    if (isSuccessfulToolShortcutResult(permissionShortcutResult)) {
      const toolResults = [
        {
          t: 'processPermissionRequest',
          args: { decision: directPermissionDecision },
          result: permissionShortcutResult,
        },
      ] satisfies LocalVoiceAgentToolResultEntry[];
      const assistantText =
        directPermissionDecision === 'allow'
          ? 'Approved the pending permission request.'
          : 'Denied the pending permission request.';

      await params.onAssistantTurn?.({
        assistantText,
        actions: [{ t: 'processPermissionRequest', args: { decision: directPermissionDecision } }],
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

    const userActionShortcutResult = parseToolResult(
      await (tools as any).answerUserActionRequest({
        decision: mapDirectDecisionToUserActionDecision(directPermissionDecision),
        currentSessionOnly: true,
      }),
    );
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
      permissionShortcutResult,
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

  const runActionsOnce = async (actions: ReadonlyArray<unknown>): Promise<LocalVoiceAgentToolResultEntry[]> => {
    const results: LocalVoiceAgentToolResultEntry[] = [];
    for (const actionRaw of actions) {
      throwIfAborted(params.signal);
      const action = actionRaw as VoiceToolAction;
      const toolName = typeof action?.t === 'string' ? action.t.trim() : '';
      if (!toolName) continue;

      const handler = (tools as any)[toolName] as ((input: unknown) => Promise<string>) | undefined;
      if (typeof handler !== 'function') {
        results.push({
          t: toolName,
          args: action?.args ?? null,
          result: { ok: false, errorCode: 'tool_not_supported', errorMessage: 'tool_not_supported' },
        });
        continue;
      }

      try {
        const value = await handler(action?.args ?? null);
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
    return results;
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
      turnIndex === 0
        ? (params.onTextDelta || params.signal
            ? {
                ...(params.onTextDelta ? { onTextDelta: params.onTextDelta } : {}),
                ...(params.signal ? { signal: params.signal } : {}),
              }
            : undefined)
        : (params.signal ? { signal: params.signal } : undefined),
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

    const toolResults = await runActionsOnce(actions);
    toolResultBatches.push(toolResults);
    await params.onToolResults?.({
      toolResults,
      turnIndex,
    });

    if (toolResults.length === 0) {
      return {
        assistantTurns,
        toolResultBatches,
        totalActions,
      };
    }

    nextPrompt = buildToolResultsFollowUpPrompt(toolResults);
  }

  return {
    assistantTurns,
    toolResultBatches,
    totalActions,
  };
}
