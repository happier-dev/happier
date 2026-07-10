export const SUPPORTED_HARNESS_TOOLS = Object.freeze(new Set([
  'find_file',
  'run_command',
  'edit_file',
  'view_file',
  'write_to_file',
  'grep_search',
  'list_dir',
]));

export type AntigravityLocalharnessGeminiConfig =
  | Readonly<{ mode: 'api_key'; apiKey: string | null }>
  | Readonly<{ mode: 'vertex'; project: string | null; location: string | null }>;

export type AntigravityLocalharnessModelConfig = Readonly<{
  name: string;
  types: readonly ['text'];
  geminiApiEndpoint?: Readonly<{
    apiKey: string;
    options?: Readonly<{ thinkingLevel: string }>;
  }>;
  vertexEndpoint?: Readonly<{
    project: string;
    location: string;
    options?: Readonly<{ thinkingLevel: string }>;
  }>;
}>;

export type AntigravityLocalharnessMcpServerConfig = Readonly<{
  name: string;
  stdio?: Readonly<{ command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }>;
  http?: Readonly<{ url: string; headers?: Readonly<Record<string, string>> }>;
  enabledTools?: readonly string[];
  disabledTools?: readonly string[];
  timeoutSeconds?: number;
}>;

export type AntigravityLocalharnessInputConfig = Readonly<{
  storageDirectory?: string;
  clientInfo: Readonly<{
    language: string;
    version: string;
    languageVersion: string;
  }>;
}>;

export type AntigravityLocalharnessHarnessConfig = Readonly<{
  clientInfo?: Readonly<Record<string, unknown>>;
  models: readonly AntigravityLocalharnessModelConfig[];
  workspaces: readonly string[];
  permissionPolicy: Readonly<{
    enforceWorkspaceValidation: true;
    runCommandDefault: 'deny';
  }>;
  mcpServers: readonly AntigravityLocalharnessMcpServerConfig[];
}>;

export type AntigravityLocalharnessOutputConfig = Readonly<{
  protocolFingerprint: string;
  port: number;
  apiKey: string;
}>;

export type AntigravityLocalharnessQuestion = Readonly<{
  id?: string;
  prompt?: string;
  label?: string;
  choices?: readonly string[];
}>;

export type AntigravityLocalharnessEvent =
  | Readonly<{ type: 'conversation_id'; conversationId: string }>
  | Readonly<{ type: 'step_update'; trajectoryId?: string; text?: string; textDelta?: string }>
  | Readonly<{ type: 'thinking'; trajectoryId?: string; text?: string }>
  | Readonly<{ type: 'thinking_delta'; trajectoryId?: string; text?: string; textDelta?: string }>
  | Readonly<{ type: 'tool_call'; trajectoryId?: string; stepIndex?: number; toolCallId?: string; toolName?: string; input?: unknown }>
  | Readonly<{ type: 'tool_result'; trajectoryId?: string; toolCallId?: string; output?: unknown; isError?: boolean }>
  | Readonly<{
      type: 'tool_confirmation_request';
      trajectoryId?: string;
      stepIndex?: number;
      stepId?: string;
      requestId?: string;
      toolName?: string;
      command?: string;
      prompt?: string;
      input?: unknown;
    }>
  | Readonly<{
      type: 'user_questions_request';
      trajectoryId?: string;
      stepIndex?: number;
      stepId?: string;
      requestId?: string;
      questions?: readonly AntigravityLocalharnessQuestion[];
    }>
  | Readonly<{ type: 'usage_metadata'; trajectoryId?: string; totalTokens?: number; inputTokens?: number; outputTokens?: number }>
  | Readonly<{ type: 'trajectory_state_update'; trajectoryId?: string; state?: string }>;

export type AntigravityLocalharnessClientMessage =
  | Readonly<{ config: unknown }>
  | Readonly<{ userInput: string }>
  | Readonly<{ haltRequest: true }>
  | Readonly<{ toolConfirmation: Readonly<{ trajectoryId: string; stepIndex: number; accepted: boolean }> }>
  | Readonly<{ questionResponse: Readonly<{ trajectoryId: string; stepIndex: number; cancelled?: boolean; response?: unknown }> }>
  | Readonly<{ toolResponse: Readonly<{ id: string; responseJson: string }> }>;

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function parseJsonObject(value: unknown): unknown {
  const text = readString(value);
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function stepId(trajectoryId: string | undefined, stepIndex: number | undefined): string | undefined {
  if (!trajectoryId || stepIndex === undefined) return undefined;
  return `${trajectoryId}:${stepIndex}`;
}

function requestId(
  trajectoryId: string | undefined,
  stepIndex: number | undefined,
  kind: string,
): string | undefined {
  const id = stepId(trajectoryId, stepIndex);
  return id ? `${id}:${kind}` : undefined;
}

function readAction(stepUpdate: JsonRecord): Readonly<{ toolName: string; command?: string; input: unknown }> | null {
  const actionFields: readonly Readonly<{ field: string; toolName: string; commandField?: string }>[] = [
    { field: 'findFile', toolName: 'find_file' },
    { field: 'runCommand', toolName: 'run_command', commandField: 'commandLine' },
    { field: 'editFile', toolName: 'edit_file' },
    { field: 'viewFile', toolName: 'view_file' },
    { field: 'writeToFile', toolName: 'write_to_file' },
    { field: 'createFile', toolName: 'write_to_file' },
    { field: 'grepSearch', toolName: 'grep_search' },
    { field: 'listDirectory', toolName: 'list_dir' },
  ];
  for (const action of actionFields) {
    const input = stepUpdate[action.field];
    if (!isRecord(input)) continue;
    return {
      toolName: action.toolName,
      command: action.commandField ? readString(input[action.commandField]) ?? undefined : undefined,
      input,
    };
  }
  const mcpTool = stepUpdate.mcpTool;
  if (isRecord(mcpTool)) {
    const serverName = readString(mcpTool.serverName);
    const toolName = readString(mcpTool.toolName);
    if (!serverName || !toolName) return null;
    return {
      toolName: `mcp__${serverName}__${toolName}`,
      input: parseJsonObject(mcpTool.argumentsJson),
    };
  }
  return null;
}

function parseQuestions(stepUpdate: JsonRecord): readonly AntigravityLocalharnessQuestion[] {
  const request = stepUpdate.questionsRequest;
  if (!isRecord(request) || !Array.isArray(request.questions)) return [];
  return request.questions.map((question, index): AntigravityLocalharnessQuestion => {
    if (!isRecord(question)) return { id: `question-${index}` };
    const multipleChoice = question.multipleChoice;
    if (isRecord(multipleChoice)) {
      const choices = Array.isArray(multipleChoice.choices)
        ? multipleChoice.choices.filter((choice): choice is string => typeof choice === 'string')
        : [];
      return {
        id: `question-${index}`,
        prompt: readString(multipleChoice.question) ?? undefined,
        choices,
      };
    }
    return { id: `question-${index}` };
  });
}

function parseStepUpdate(stepUpdate: JsonRecord): AntigravityLocalharnessEvent[] {
  const events: AntigravityLocalharnessEvent[] = [];
  const trajectoryId = readString(stepUpdate.trajectoryId) ?? undefined;
  const stepIndex = readNumber(stepUpdate.stepIndex) ?? undefined;
  const cascadeId = readString(stepUpdate.cascadeId);
  if (cascadeId) {
    events.push({ type: 'conversation_id', conversationId: cascadeId });
  }
  const textDelta = readString(stepUpdate.textDelta);
  const text = readString(stepUpdate.text);
  if (textDelta) {
    events.push({ type: 'step_update', trajectoryId, textDelta });
  } else if (text) {
    events.push({ type: 'step_update', trajectoryId, text });
  }
  const thinkingDelta = readString(stepUpdate.thinkingDelta);
  const thinking = readString(stepUpdate.thinking);
  if (thinkingDelta) {
    events.push({ type: 'thinking_delta', trajectoryId, textDelta: thinkingDelta });
  } else if (thinking) {
    events.push({ type: 'thinking_delta', trajectoryId, text: thinking });
  }

  const action = readAction(stepUpdate);
  if (action && !isRecord(stepUpdate.toolConfirmationRequest)) {
    events.push({
      type: 'tool_call',
      trajectoryId,
      stepIndex,
      toolCallId: stepId(trajectoryId, stepIndex),
      toolName: action.toolName,
      input: action.input,
    });
  }
  if (isRecord(stepUpdate.toolConfirmationRequest)) {
    events.push({
      type: 'tool_confirmation_request',
      trajectoryId,
      stepIndex,
      stepId: stepId(trajectoryId, stepIndex),
      requestId: requestId(trajectoryId, stepIndex, 'tool_confirmation'),
      toolName: action?.toolName ?? 'unknown',
      command: action?.command,
      prompt: readString(stepUpdate.requestText) ?? undefined,
      input: action?.input ?? null,
    });
  }
  if (isRecord(stepUpdate.questionsRequest)) {
    events.push({
      type: 'user_questions_request',
      trajectoryId,
      stepIndex,
      stepId: stepId(trajectoryId, stepIndex),
      requestId: requestId(trajectoryId, stepIndex, 'questions'),
      questions: parseQuestions(stepUpdate),
    });
  }
  return events;
}

export function parseLocalharnessOutputEvent(message: unknown): AntigravityLocalharnessEvent[] {
  if (!isRecord(message)) return [];
  const events: AntigravityLocalharnessEvent[] = [];
  if (isRecord(message.stepUpdate)) {
    events.push(...parseStepUpdate(message.stepUpdate));
  }
  if (isRecord(message.toolCall)) {
    const id = readString(message.toolCall.id) ?? undefined;
    const name = readString(message.toolCall.name) ?? undefined;
    events.push({
      type: 'tool_call',
      toolCallId: id,
      toolName: name,
      input: parseJsonObject(message.toolCall.argumentsJson),
    });
  }
  if (isRecord(message.usageMetadata)) {
    const total = readNumber(message.usageMetadata.totalTokenCount);
    if (total !== null) {
      events.push({
        type: 'usage_metadata',
        totalTokens: total,
        inputTokens: readNumber(message.usageMetadata.promptTokenCount) ?? undefined,
        outputTokens: readNumber(message.usageMetadata.candidatesTokenCount) ?? undefined,
      });
    }
  }
  if (isRecord(message.trajectoryStateUpdate)) {
    events.push({
      type: 'trajectory_state_update',
      trajectoryId: readString(message.trajectoryStateUpdate.trajectoryId) ?? undefined,
      state: readString(message.trajectoryStateUpdate.state) ?? undefined,
    });
  }
  return events;
}

export function buildInitializeConversationEvent(config: AntigravityLocalharnessHarnessConfig): AntigravityLocalharnessClientMessage {
  return {
    config: {
      models: config.models,
      harnessSideTools: {
        find: { enabled: true },
        runCommand: { enabled: true },
        userQuestions: { enabled: true },
        fileEdit: { enabled: true },
        viewFile: { enabled: true },
        writeToFile: { enabled: true },
        grepSearch: { enabled: true },
        listDir: { enabled: true },
        permissions: { enforceWorkspaceValidation: config.permissionPolicy.enforceWorkspaceValidation },
      },
      workspaces: config.workspaces.map((directory) => ({ filesystemWorkspace: { directory } })),
      ...(config.mcpServers.length > 0 ? { mcpServers: config.mcpServers } : {}),
    },
  };
}

export function buildStartTurnEvent(text: string): AntigravityLocalharnessClientMessage {
  return { userInput: text };
}

export function buildCancelEvent(): AntigravityLocalharnessClientMessage {
  return { haltRequest: true };
}

export function buildToolConfirmationEvent(
  event: Extract<AntigravityLocalharnessEvent, { type: 'tool_confirmation_request' }>,
  accepted: boolean,
): AntigravityLocalharnessClientMessage {
  return {
    toolConfirmation: {
      trajectoryId: event.trajectoryId ?? '',
      stepIndex: event.stepIndex ?? 0,
      accepted,
    },
  };
}

export function buildQuestionResponseEvent(
  event: Extract<AntigravityLocalharnessEvent, { type: 'user_questions_request' }>,
  result: Readonly<{ status: string; answers?: unknown }>,
): AntigravityLocalharnessClientMessage {
  const cancelled = result.status === 'cancelled' || result.status === 'canceled';
  const answers = Array.isArray(result.answers) ? result.answers : [];
  return {
    questionResponse: {
      trajectoryId: event.trajectoryId ?? '',
      stepIndex: event.stepIndex ?? 0,
      ...(cancelled
        ? { cancelled: true }
        : {
            response: {
              answers,
            },
          }),
    },
  };
}

export function buildUnsupportedToolResponseEvent(toolCallId: string, toolName: string): AntigravityLocalharnessClientMessage {
  return {
    toolResponse: {
      id: toolCallId,
      responseJson: JSON.stringify({ error: 'unsupported_client_tool', toolName }),
    },
  };
}

export function isHarnessSideTool(toolName: string): boolean {
  if (SUPPORTED_HARNESS_TOOLS.has(toolName)) return true;
  return toolName.startsWith('mcp__');
}
