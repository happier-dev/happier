/**
 * AcpBackend - Agent Client Protocol backend using official SDK
 *
 * This module provides a universal backend implementation using the official
 * @agentclientprotocol/sdk. Agent-specific behavior (timeouts, filtering,
 * error handling) is delegated to TransportHandler implementations.
 */

import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type Agent,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type LoadSessionRequest,
  type PromptRequest,
  type SetSessionModeRequest,
  type ContentBlock,
} from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
  McpServerConfig,
} from '../core';
import { logger } from '@/ui/logger';
import { delay } from '@/utils/time';
import packageJson from '../../../package.json';
import {
  type TransportHandler,
  type StderrContext,
  type ToolNameContext,
  DefaultTransport,
} from '../transport';
import {
  type SessionUpdate,
  type HandlerContext,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  handleAgentMessageChunk,
  handleUserMessageChunk,
  handleAgentThoughtChunk,
  handleToolCallUpdate,
  handleToolCall,
  handleLegacyMessageChunk,
  handlePlanUpdate,
  handleThinkingUpdate,
  handleAvailableCommandsUpdate,
  handleCurrentModeUpdate,
} from './sessionUpdateHandlers';
import { nodeToWebStreams } from './nodeToWebStreams';
import { buildAcpSpawnSpec } from './acpSpawn';
import { killProcessTree } from './killProcessTree';
import {
  pickPermissionOutcome,
  type PermissionOptionLike,
} from './permissions/permissionMapping';
import {
  extractPermissionInputWithFallback,
  extractPermissionToolNameHint,
  resolvePermissionToolName,
  type PermissionRequestLike,
} from './permissions/permissionRequest';
import { AcpReplayCapture, type AcpReplayEvent } from './history/acpReplayCapture';

/**
 * Retry configuration for ACP operations
 */
const RETRY_CONFIG = {
  /** Maximum number of retry attempts for init/newSession */
  maxAttempts: 3,
  /** Base delay between retries in ms */
  baseDelayMs: 1000,
  /** Maximum delay between retries in ms */
  maxDelayMs: 5000,
} as const;

/**
 * Extended RequestPermissionRequest with additional fields that may be present
 */
type ExtendedRequestPermissionRequest = RequestPermissionRequest & {
  toolCall?: {
    toolCallId?: string;
    id?: string;
    kind?: string;
    toolName?: string;
    rawInput?: Record<string, unknown>;
    input?: Record<string, unknown>;
    arguments?: Record<string, unknown>;
    content?: Record<string, unknown>;
  };
  kind?: string;
  rawInput?: Record<string, unknown>;
  input?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  content?: Record<string, unknown>;
  options?: Array<{
    optionId?: string;
    name?: string;
    kind?: string;
  }>;
};

// SessionNotification payload shape differs across ACP SDK versions (some use `update`, some use `updates[]`).
// We normalize dynamically in `handleSessionUpdate` and avoid relying on the SDK type here.

type SessionConfigOptionValueId = string;

type SessionConfigOption = Readonly<{
  id: string;
  name: string;
  description?: string;
  type: string;
  currentValue: SessionConfigOptionValueId;
  options?: ReadonlyArray<Readonly<{ value: SessionConfigOptionValueId; name: string; description?: string }>>;
}>;

/**
 * Permission handler interface for ACP backends
 */
export interface AcpPermissionHandler {
  /**
   * Handle a tool permission request
   * @param toolCallId - The unique ID of the tool call
   * @param toolName - The name of the tool being called
   * @param input - The input parameters for the tool
   * @returns Promise resolving to permission result with decision
   */
  handleToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown
  ): Promise<{ decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort' }>;
}

export type SessionMode = {
  id: string;
  name: string;
  description?: string;
};

export type SessionModeState = {
  currentModeId: string;
  availableModes: SessionMode[];
};

export type SessionModel = {
  id: string;
  name: string;
  description?: string;
};

export type SessionModelState = {
  currentModelId: string;
  availableModels: SessionModel[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' ? value : null;
}

function normalizeConfigOptionValueId(value: unknown): SessionConfigOptionValueId | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

function normalizeSessionConfigOptions(raw: ReadonlyArray<unknown>): SessionConfigOption[] {
  const out: SessionConfigOption[] = [];

  for (const entryRaw of raw) {
    const entry = asRecord(entryRaw);
    if (!entry) continue;

    const id = getString(entry, 'id');
    const name = getString(entry, 'name');
    const type = getString(entry, 'type');
    if (!id || !name || !type) continue;

    const currentValue = normalizeConfigOptionValueId((entry as any).currentValue);
    if (currentValue === null) continue;

    const description = getString(entry, 'description');
    const optionsCandidate = (entry as any).options;
    const optionsRaw = Array.isArray(optionsCandidate) ? optionsCandidate : null;

    let options: SessionConfigOption['options'] | undefined = undefined;
    if (optionsRaw) {
      const normalized: Array<{ value: SessionConfigOptionValueId; name: string; description?: string }> = [];
      for (const optRaw of optionsRaw) {
        const opt = asRecord(optRaw);
        if (!opt) continue;
        const value = normalizeConfigOptionValueId((opt as any).value);
        const optName = getString(opt, 'name');
        if (value === null || !optName) continue;
        const optDescription = getString(opt, 'description');
        normalized.push({ value, name: optName, ...(optDescription ? { description: optDescription } : {}) });
      }
      if (normalized.length > 0) options = normalized;
    }

    out.push({
      id,
      name,
      type,
      currentValue,
      ...(description ? { description } : {}),
      ...(options ? { options } : {}),
    });
  }

  return out;
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function isAcpFsEnabled(): boolean {
  // Default ON: ACP agents that support the `fs` capability will route file reads/writes
  // through the client (Happier). This is the only reliable way for Happier to enforce
  // workspace boundaries for ACP backends.
  const raw = process.env.HAPPIER_ACP_FS;
  if (raw === undefined) return true;
  return isTruthyEnv(raw);
}

export function buildInitializeRequest(params: {
  clientName: string;
  clientVersion: string;
}): InitializeRequest {
  const fsEnabled = isAcpFsEnabled();
  return {
    protocolVersion: 1,
    clientCapabilities: {
      fs: {
        readTextFile: fsEnabled,
        writeTextFile: fsEnabled,
      },
    },
    clientInfo: {
      name: params.clientName,
      version: params.clientVersion,
    },
  };
}

export function createAcpClientFsMethods(params: {
  cwd: string;
  permissionHandler?: AcpPermissionHandler;
}): Pick<Client, 'readTextFile' | 'writeTextFile'> {
  const rootResolved = resolve(params.cwd);
  const rootRealPromise = fs.realpath(rootResolved).catch(() => rootResolved);

  const isWithinRoot = (root: string, target: string): boolean => {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  };

  const assertWithinCwd = async (targetPath: string, opts: { kind: 'read' | 'write' }): Promise<void> => {
    const targetResolved = resolve(targetPath);
    if (!isWithinRoot(rootResolved, targetResolved)) {
      throw new Error(`Permission denied for ${opts.kind}TextFile (path traversal)`);
    }

    const rootReal = await rootRealPromise;
    const resolveExistingAncestorRealPath = async (startPath: string): Promise<string> => {
      let candidate = startPath;
      while (true) {
        const candidateReal = await fs.realpath(candidate).catch((error) => {
          const errno = (error as NodeJS.ErrnoException | undefined)?.code;
          if (errno === 'ENOENT') return null;
          throw new Error(`Permission denied for ${opts.kind}TextFile (cannot resolve path)`);
        });
        if (candidateReal) return candidateReal;
        const parent = dirname(candidate);
        if (parent === candidate) {
          throw new Error(`Permission denied for ${opts.kind}TextFile (cannot resolve path)`);
        }
        candidate = parent;
      }
    };

    if (opts.kind === 'read') {
      const targetReal = await fs.realpath(targetResolved).catch((error) => {
        const errno = (error as NodeJS.ErrnoException | undefined)?.code;
        if (errno === 'ENOENT') return targetResolved;
        throw new Error(`Permission denied for ${opts.kind}TextFile (cannot resolve path)`);
      });
      if (!isWithinRoot(rootReal, targetReal)) {
        throw new Error(`Permission denied for ${opts.kind}TextFile (path traversal)`);
      }
      return;
    }

    const targetReal = await fs.realpath(targetResolved).catch((error) => {
      const errno = (error as NodeJS.ErrnoException | undefined)?.code;
      if (errno === 'ENOENT') return null;
      throw new Error(`Permission denied for ${opts.kind}TextFile (cannot resolve path)`);
    });
    if (targetReal && !isWithinRoot(rootReal, targetReal)) {
      throw new Error(`Permission denied for ${opts.kind}TextFile (path traversal)`);
    }

    const existingAncestorReal = await resolveExistingAncestorRealPath(dirname(targetResolved));
    if (!isWithinRoot(rootReal, existingAncestorReal)) {
      throw new Error(`Permission denied for ${opts.kind}TextFile (path traversal)`);
    }
  };

  const readTextFile: NonNullable<Client['readTextFile']> = async (req) => {
    const targetPath = isAbsolute(req.path) ? resolve(req.path) : resolve(rootResolved, req.path);
    await assertWithinCwd(targetPath, { kind: 'read' });
    const full = await fs.readFile(targetPath, 'utf8');
    const line = typeof req.line === 'number' ? req.line : null;
    const limit = typeof req.limit === 'number' ? req.limit : null;

    if (line === null && limit === null) {
      return { content: full };
    }

    const lines = full.split('\n');
    const startIdx = Math.max(0, (line ?? 1) - 1);
    const endIdx = limit === null ? lines.length : startIdx + Math.max(0, limit);
    const slice = lines.slice(startIdx, endIdx);
    // Preserve behavior similar to "read lines": remove trailing empty line if caused by final newline.
    if (slice.length > 0 && slice[slice.length - 1] === '') slice.pop();
    return { content: slice.join('\n') };
  };

  const writeTextFile: NonNullable<Client['writeTextFile']> = async (req) => {
    const targetPath = isAbsolute(req.path) ? resolve(req.path) : resolve(rootResolved, req.path);
    await assertWithinCwd(targetPath, { kind: 'write' });
    const reqRecord = asRecord(req) ?? {};
    const meta = asRecord(reqRecord._meta) ?? {};
    const toolCallId = typeof meta.toolCallId === 'string' ? meta.toolCallId : `acp-fs-write:${randomUUID()}`;

    if (params.permissionHandler) {
      const result = await params.permissionHandler.handleToolCall(toolCallId, 'writeTextFile', {
        path: targetPath,
        bytes: Buffer.byteLength(req.content, 'utf8'),
      });

      const approved =
        result.decision === 'approved' ||
        result.decision === 'approved_for_session' ||
        result.decision === 'approved_execpolicy_amendment';

      if (!approved) {
        throw new Error(`Permission denied for writeTextFile (${toolCallId})`);
      }
    }

    await fs.mkdir(dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, req.content, 'utf8');
    return {};
  };

  return { readTextFile, writeTextFile };
}

/**
 * Configuration for AcpBackend
 */
export interface AcpBackendOptions {
  /** Agent name for identification */
  agentName: string;

  /** Working directory for the agent */
  cwd: string;

  /** Command to spawn the ACP agent */
  command: string;

  /** Arguments for the agent command */
  args?: string[];

  /** Environment variables to pass to the agent */
  env?: Record<string, string>;

  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;

  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;

  /** Transport handler for agent-specific behavior (timeouts, filtering, etc.) */
  transportHandler?: TransportHandler;

  /** Optional callback to check if prompt has change_title instruction */
  hasChangeTitleInstruction?: (prompt: string) => boolean;

  /**
   * Optional ACP authentication method to invoke after `initialize`, before `newSession` / `loadSession`.
   *
   * This is primarily used by agents like Codex ACP that advertise auth methods but do not auto-authenticate
   * from environment variables until the `authenticate` method is called.
   */
  authMethodId?: string;
}

/**
 * Helper to run an async operation with retry logic
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    operationName: string;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    onRetry?: (attempt: number, error: Error) => void;
  }
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < options.maxAttempts) {
        // Calculate delay with exponential backoff
        const delayMs = Math.min(
          options.baseDelayMs * Math.pow(2, attempt - 1),
          options.maxDelayMs
        );

        logger.debug(`[AcpBackend] ${options.operationName} failed (attempt ${attempt}/${options.maxAttempts}): ${lastError.message}. Retrying in ${delayMs}ms...`);
        options.onRetry?.(attempt, lastError);

        await delay(delayMs);
      }
    }
  }

  throw lastError;
}

/**
 * ACP backend using the official @agentclientprotocol/sdk
 */
export class AcpBackend implements AgentBackend {
  private listeners: AgentMessageHandler[] = [];
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private acpSessionId: string | null = null;
  private disposed = false;
  private replayCapture: AcpReplayCapture | null = null;
  /** Track active tool calls to prevent duplicate events */
  private activeToolCalls = new Set<string>();
  private toolCallTimeouts = new Map<string, NodeJS.Timeout>();
  /** Track tool call start times for performance monitoring */
  private toolCallStartTimes = new Map<string, number>();
  /** Pending permission requests that need response */
  private pendingPermissions = new Map<string, (response: RequestPermissionResponse) => void>();

  /** Map from permission request ID to real tool call ID for tracking */
  private permissionToToolCallMap = new Map<string, string>();

  /** Map from real tool call ID to tool name for auto-approval */
  private toolCallIdToNameMap = new Map<string, string>();
  private toolCallIdToInputMap = new Map<string, Record<string, unknown>>();

  /** Cache last selected permission option per tool call id (handles duplicate permission prompts) */
  private lastSelectedPermissionOptionIdByToolCallId = new Map<string, string>();

  /** Track if we just sent a prompt with change_title instruction */
  private recentPromptHadChangeTitle = false;

  private sessionModeState: SessionModeState | null = null;
  private sessionModelState: SessionModelState | null = null;
  private sessionConfigOptionsState: ReadonlyArray<SessionConfigOption> | null = null;

  getSessionModeState(): SessionModeState | null {
    return this.sessionModeState;
  }

  getSessionModelState(): SessionModelState | null {
    return this.sessionModelState;
  }

  getSessionConfigOptionsState(): ReadonlyArray<SessionConfigOption> | null {
    return this.sessionConfigOptionsState;
  }

  /** Track tool calls count since last prompt (to identify first tool call) */
  private toolCallCountSincePrompt = 0;
  /** Timeout for emitting 'idle' status after last message chunk */
  private idleTimeout: NodeJS.Timeout | null = null;

  /** Transport handler for agent-specific behavior */
  private readonly transport: TransportHandler;

  constructor(private options: AcpBackendOptions) {
    this.transport = options.transportHandler ?? new DefaultTransport(options.agentName);
  }

  onMessage(handler: AgentMessageHandler): void {
    this.listeners.push(handler);
  } 

  offMessage(handler: AgentMessageHandler): void {
    const index = this.listeners.indexOf(handler);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  private emit(msg: AgentMessage): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (error) {
        logger.warn('[AcpBackend] Error in message handler:', error);
      }
    }
  }

  private buildAcpMcpServersForSessionRequest(): NewSessionRequest['mcpServers'] {
    if (!this.options.mcpServers) return [] as unknown as NewSessionRequest['mcpServers'];
    const mcpServers = Object.entries(this.options.mcpServers).map(([name, config]) => ({
      name,
      command: config.command,
      args: config.args || [],
      env: config.env
        ? Object.entries(config.env).map(([envName, envValue]) => ({ name: envName, value: envValue }))
        : [],
    }));
    return mcpServers as unknown as NewSessionRequest['mcpServers'];
  }

  private async createConnectionAndInitialize(params: { operationId: string }): Promise<{ initTimeout: number }> {
    logger.debug(`[AcpBackend] Starting process + initializing connection (op=${params.operationId})`);

    if (this.process || this.connection) {
      throw new Error('ACP backend is already initialized');
    }

    try {
      // Spawn the ACP agent process.
      // Use cross-spawn so Windows quoting/.cmd resolution is handled safely without joining args.
      const spec = buildAcpSpawnSpec({
        command: this.options.command,
        args: this.options.args || [],
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
      });

      this.process = spawn(spec.command, spec.args, spec.options);

    if (!this.process.stdin || !this.process.stdout || !this.process.stderr) {
      throw new Error('Failed to create stdio pipes');
    }

    // Handle stderr output via transport handler
    this.process.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      if (!text.trim()) return;

      // Build context for transport handler
      const hasActiveInvestigation = this.transport.isInvestigationTool
        ? Array.from(this.activeToolCalls).some(id => this.transport.isInvestigationTool!(id))
        : false;

      const context: StderrContext = {
        activeToolCalls: this.activeToolCalls,
        hasActiveInvestigation,
      };

      // Log to file (not console)
      if (hasActiveInvestigation) {
        logger.debug(`[AcpBackend] 🔍 Agent stderr (during investigation): ${text.trim()}`);
      } else {
        logger.debug(`[AcpBackend] Agent stderr: ${text.trim()}`);
      }

      // Let transport handler process stderr and optionally emit messages
      if (this.transport.handleStderr) {
        const result = this.transport.handleStderr(text, context);
        if (result.message) {
          this.emit(result.message);
          // If the transport surfaces a fatal error via a status message, fail any pending
          // `waitForResponseComplete()` caller so we don't degrade into a generic timeout.
          if (result.message.type === 'status' && result.message.status === 'error' && this.waitingForResponse) {
            const detail =
              typeof result.message.detail === 'string' && result.message.detail.trim()
                ? result.message.detail
                : 'ACP transport reported an error';
            this.failPendingResponseWait(new Error(detail));
          }
        }
      }
    });

    this.process.on('error', (err) => {
      // Log to file only, not console
      logger.debug(`[AcpBackend] Process error:`, err);
      this.failPendingResponseWait(err instanceof Error ? err : new Error(String(err)));
      this.emit({ type: 'status', status: 'error', detail: err.message });
    });

    this.process.on('exit', (code, signal) => {
      if (!this.disposed && code !== 0 && code !== null) {
        logger.debug(`[AcpBackend] Process exited with code ${code}, signal ${signal}`);
        const detail = `Exit code: ${code}`;
        this.failPendingResponseWait(new Error(detail));
        this.emit({ type: 'status', status: 'error', detail });
      }
    });

    // Create Web Streams from Node streams
    const streams = nodeToWebStreams(
      this.process.stdin,
      this.process.stdout
    );
    const writable = streams.writable;
    const readable = streams.readable;

    // Filter stdout via transport handler before ACP parsing
    // Some agents output debug info that breaks JSON-RPC parsing
    const transport = this.transport;
    const filteredReadable = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = readable.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let buffer = '';
        let filteredCount = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              // Flush any remaining buffer
              if (buffer.trim()) {
                const filtered = transport.filterStdoutLine?.(buffer);
                if (filtered === undefined) {
                  controller.enqueue(encoder.encode(buffer));
                } else if (filtered !== null) {
                  controller.enqueue(encoder.encode(filtered));
                } else {
                  filteredCount++;
                }
              }
              if (filteredCount > 0) {
                logger.debug(`[AcpBackend] Filtered out ${filteredCount} non-JSON lines from ${transport.agentName} stdout`);
              }
              controller.close();
              break;
            }

            // Decode and accumulate data
            buffer += decoder.decode(value, { stream: true });

            // Process line by line (ndJSON is line-delimited)
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep last incomplete line in buffer

            for (const line of lines) {
              if (!line.trim()) continue;

              // Use transport handler to filter lines
              // Note: filterStdoutLine returns null to filter out, string to keep
              // If method not implemented (undefined), pass through original line
              const filtered = transport.filterStdoutLine?.(line);
              if (filtered === undefined) {
                // Method not implemented, pass through
                controller.enqueue(encoder.encode(line + '\n'));
              } else if (filtered !== null) {
                // Method returned transformed line
                controller.enqueue(encoder.encode(filtered + '\n'));
              } else {
                // Method returned null, filter out
                filteredCount++;
              }
            }
          }
        } catch (error) {
          logger.debug(`[AcpBackend] Error filtering stdout stream:`, error);
          controller.error(error);
        } finally {
          reader.releaseLock();
        }
      }
    });

    // Create ndJSON stream for ACP
    const stream = ndJsonStream(writable, filteredReadable);

    // Create Client implementation
    const client: Client = {
      sessionUpdate: async (params: SessionNotification) => {
        this.handleSessionUpdate(params);
      },
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {

        const extendedParams = params as ExtendedRequestPermissionRequest;
        const toolCall = extendedParams.toolCall;
        const options = extendedParams.options || [];
        // ACP spec: toolCall.toolCallId is the correlation ID. Fall back to legacy fields when needed.
        const toolCallId =
          (typeof toolCall?.toolCallId === 'string' && toolCall.toolCallId.trim().length > 0)
            ? toolCall.toolCallId.trim()
            : (typeof toolCall?.id === 'string' && toolCall.id.trim().length > 0)
              ? toolCall.id.trim()
              : randomUUID();
        const permissionId = toolCallId;

        const toolNameHint = extractPermissionToolNameHint(extendedParams as PermissionRequestLike);
        const input = extractPermissionInputWithFallback(
          extendedParams as PermissionRequestLike,
          toolCallId,
          this.toolCallIdToInputMap
        );
        let toolName = resolvePermissionToolName({
          toolNameHint,
          toolCallId,
          toolCallIdToNameMap: this.toolCallIdToNameMap,
        });

        // If the agent re-prompts with the same toolCallId, reuse the previous selection when possible.
        const cachedOptionId = this.lastSelectedPermissionOptionIdByToolCallId.get(toolCallId);
        if (cachedOptionId && options.some((opt) => opt.optionId === cachedOptionId)) {
          logger.debug(`[AcpBackend] Duplicate permission prompt for ${toolCallId}, reusing cached optionId=${cachedOptionId}`);
          return { outcome: { outcome: 'selected', optionId: cachedOptionId } };
        }

        // If toolName is "other" or "Unknown tool", try to determine real tool name
        const context: ToolNameContext = {
          recentPromptHadChangeTitle: this.recentPromptHadChangeTitle,
          toolCallCountSincePrompt: this.toolCallCountSincePrompt,
        };
        toolName = this.transport.determineToolName?.(toolName, toolCallId, input, context) ?? toolName;

        if (toolName !== (toolCall?.kind || toolCall?.toolName || extendedParams.kind || 'Unknown tool')) {
          logger.debug(`[AcpBackend] Detected tool name: ${toolName} from toolCallId: ${toolCallId}`);
        }

        // Seed tool-call identity for later tool_call_update events.
        // Some providers emit a permission prompt before (or instead of) an initial tool_call update.
        // When the subsequent tool_call_update omits kind/title, we still want stable tool names and
        // the correct renderer in the UI.
        if (!this.toolCallIdToNameMap.has(toolCallId)) {
          this.toolCallIdToNameMap.set(toolCallId, toolName);
        }
        if (input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length > 0) {
          if (!this.toolCallIdToInputMap.has(toolCallId)) {
            this.toolCallIdToInputMap.set(toolCallId, input);
          }
        }

        // Increment tool call counter for context tracking
        this.toolCallCountSincePrompt++;

        const inputKeys = input && typeof input === 'object' && !Array.isArray(input)
          ? Object.keys(input as Record<string, unknown>)
          : [];
        logger.debug(`[AcpBackend] Permission request: tool=${toolName}, toolCallId=${toolCallId}, inputKeys=${inputKeys.join(',')}`);
        logger.debug(`[AcpBackend] Permission request params structure:`, JSON.stringify({
          hasToolCall: !!toolCall,
          toolCallToolCallId: toolCall?.toolCallId,
          toolCallKind: toolCall?.kind,
          toolCallToolName: toolCall?.toolName,
          toolCallId: toolCall?.id,
          paramsKind: extendedParams.kind,
          options: options.map((opt) => ({ optionId: opt.optionId, kind: opt.kind, name: opt.name })),
          paramsKeys: Object.keys(params),
        }, null, 2));

        // Emit permission request event for UI/mobile handling
        this.emit({
          type: 'permission-request',
          id: permissionId,
          reason: toolName,
          payload: {
            ...params,
            permissionId,
            toolCallId,
            toolName,
            input,
            options: options.map((opt) => ({
              id: opt.optionId,
              name: opt.name,
              kind: opt.kind,
            })),
          },
        });

        // Use permission handler if provided, otherwise auto-approve
        if (this.options.permissionHandler) {
          try {
            const result = await this.options.permissionHandler.handleToolCall(
              toolCallId,
              toolName,
              input
            );

            const isApproved = result.decision === 'approved'
              || result.decision === 'approved_for_session'
              || result.decision === 'approved_execpolicy_amendment';

            await this.respondToPermission(permissionId, isApproved);
            if (!isApproved) {
              this.clearTrackedToolCall(toolCallId, `permission decision=${result.decision}`);
            }
            const outcome = pickPermissionOutcome(options as PermissionOptionLike[], result.decision);
            if (outcome.outcome === 'selected') {
              this.lastSelectedPermissionOptionIdByToolCallId.set(toolCallId, outcome.optionId);
            } else {
              this.lastSelectedPermissionOptionIdByToolCallId.delete(toolCallId);
            }
            return { outcome };
          } catch (error) {
            // Log to file only, not console
            logger.debug('[AcpBackend] Error in permission handler:', error);
            this.clearTrackedToolCall(toolCallId, 'permission handler error');
            // Fallback to deny on error
            return { outcome: { outcome: 'cancelled' } };
          }
        }

        // Auto-approve once if no permission handler.
        const outcome = pickPermissionOutcome(options as PermissionOptionLike[], 'approved');
        if (outcome.outcome === 'selected') {
          this.lastSelectedPermissionOptionIdByToolCallId.set(toolCallId, outcome.optionId);
        } else {
          this.lastSelectedPermissionOptionIdByToolCallId.delete(toolCallId);
        }
        return { outcome };
      },
    };

    if (isAcpFsEnabled()) {
      Object.assign(
        client,
        createAcpClientFsMethods({
          cwd: this.options.cwd,
          permissionHandler: this.options.permissionHandler,
        })
      );
    }

    // Create ClientSideConnection
    this.connection = new ClientSideConnection(
      (_agent: Agent) => client,
      stream
    );

    // Initialize the connection with timeout and retry
    const initRequest = buildInitializeRequest({
      clientName: 'happier-cli',
      clientVersion: packageJson.version,
    });

    // Some ACP agents (notably Gemini CLI) can swallow early stdin before their ACP
    // stdio bridge is ready. Waiting briefly avoids poisoning the channel.
    const initDelay = (() => {
      const raw = this.transport.getInitDelayMs?.();
      return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
    })();
    if (initDelay > 0) {
      logger.debug(`[AcpBackend] Waiting ${initDelay}ms before initialize (${this.transport.agentName})...`);
      await delay(initDelay);
    }

    const initTimeout = this.transport.getInitTimeout();
    logger.debug(`[AcpBackend] Initializing connection (timeout: ${initTimeout}ms)...`);

    const initResponse = await withRetry(
      async () => {
        let timeoutHandle: NodeJS.Timeout | null = null;
        try {
          const result = await Promise.race([
            this.connection!.initialize(initRequest).then((res) => {
              if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
              }
              return res;
            }),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => {
                reject(new Error(`Initialize timeout after ${initTimeout}ms - ${this.transport.agentName} did not respond`));
              }, initTimeout);
            }),
          ]);
          return result;
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
      },
      {
        operationName: 'Initialize',
        maxAttempts: RETRY_CONFIG.maxAttempts,
        baseDelayMs: RETRY_CONFIG.baseDelayMs,
        maxDelayMs: RETRY_CONFIG.maxDelayMs,
      }
    );

    logger.debug(`[AcpBackend] Initialize completed`);

    const authMethodId = typeof this.options.authMethodId === 'string' ? this.options.authMethodId.trim() : '';
    if (authMethodId) {
      const methods = (initResponse as InitializeResponse | null)?.authMethods ?? [];
      const supported = Array.isArray(methods) && methods.some((m) => {
        const record = asRecord(m);
        if (!record) return false;
        return getString(record, 'id') === authMethodId;
      });
      if (!supported) {
        throw new Error(`[AcpBackend] ACP agent does not advertise auth method '${authMethodId}'`);
      }

      logger.debug(`[AcpBackend] Authenticating with methodId=${authMethodId}...`);
      await withRetry(
        async () => {
          let timeoutHandle: NodeJS.Timeout | null = null;
          try {
            const result = await Promise.race([
              this.connection!.authenticate({ methodId: authMethodId }).then((res) => {
                if (timeoutHandle) {
                  clearTimeout(timeoutHandle);
                  timeoutHandle = null;
                }
                return res;
              }),
              new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                  reject(new Error(`Authenticate timeout after ${initTimeout}ms - ${this.transport.agentName} did not respond`));
                }, initTimeout);
              }),
            ]);
            return result;
          } finally {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
          }
        },
        {
          operationName: 'Authenticate',
          maxAttempts: RETRY_CONFIG.maxAttempts,
          baseDelayMs: RETRY_CONFIG.baseDelayMs,
          maxDelayMs: RETRY_CONFIG.maxDelayMs,
        },
      );
      logger.debug(`[AcpBackend] Authenticate completed`);
    }

    return { initTimeout };
  } catch (error) {
    logger.debug('[AcpBackend] Initialization failed; cleaning up process/connection', error);
    const proc = this.process;
    this.process = null;
    this.connection = null;
    this.acpSessionId = null;
    if (proc) {
      try {
        await killProcessTree(proc, { graceMs: 250 });
      } catch {
        // best-effort cleanup
      }
    }
    throw error;
  }
}

  async startSession(initialPrompt?: string): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    this.emit({ type: 'status', status: 'starting' });
    // Reset per-session caches
    this.lastSelectedPermissionOptionIdByToolCallId.clear();
    this.toolCallIdToNameMap.clear();
    this.toolCallIdToInputMap.clear();

    try {
      const { initTimeout } = await this.createConnectionAndInitialize({ operationId: randomUUID() });

      // Create a new session with retry
      const newSessionRequest: NewSessionRequest = {
        cwd: this.options.cwd,
        mcpServers: this.buildAcpMcpServersForSessionRequest(),
      };

      logger.debug(`[AcpBackend] Creating new session...`);

      const sessionResponse = await withRetry(
        async () => {
          let timeoutHandle: NodeJS.Timeout | null = null;
          try {
            const result = await Promise.race([
              this.connection!.newSession(newSessionRequest).then((res) => {
                if (timeoutHandle) {
                  clearTimeout(timeoutHandle);
                  timeoutHandle = null;
                }
                return res;
              }),
              new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                  reject(new Error(`New session timeout after ${initTimeout}ms - ${this.transport.agentName} did not respond`));
                }, initTimeout);
              }),
            ]);
            return result;
          } finally {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
          }
        },
        {
          operationName: 'NewSession',
          maxAttempts: RETRY_CONFIG.maxAttempts,
          baseDelayMs: RETRY_CONFIG.baseDelayMs,
          maxDelayMs: RETRY_CONFIG.maxDelayMs,
        }
      );
      this.acpSessionId = sessionResponse.sessionId;
      const sessionId = sessionResponse.sessionId;
      logger.debug(`[AcpBackend] Session created: ${sessionId}`);

      this.seedSessionModesFromSessionResponse(sessionResponse);
      this.seedSessionModelsFromSessionResponse(sessionResponse);
      this.seedSessionConfigOptionsFromSessionResponse(sessionResponse);

      this.emitIdleStatus();

      // Send initial prompt if provided
      if (initialPrompt) {
        this.sendPrompt(sessionId, initialPrompt).catch((error) => {
          // Log to file only, not console
          logger.debug('[AcpBackend] Error sending initial prompt:', error);
          this.emit({ type: 'status', status: 'error', detail: String(error) });
        });
      }

      return { sessionId };

    } catch (error) {
      // Log to file only, not console
      logger.debug('[AcpBackend] Error starting session:', error);
      this.emit({ 
        type: 'status', 
        status: 'error', 
        detail: error instanceof Error ? error.message : String(error) 
      });
      throw error;
    }
  }

  async loadSession(sessionId: SessionId): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalized) {
      throw new Error('Session ID is required');
    }

    this.emit({ type: 'status', status: 'starting' });
    // Reset per-session caches
    this.lastSelectedPermissionOptionIdByToolCallId.clear();
    this.toolCallIdToNameMap.clear();
    this.toolCallIdToInputMap.clear();

    try {
      const { initTimeout } = await this.createConnectionAndInitialize({ operationId: randomUUID() });

      const loadSessionRequest: LoadSessionRequest = {
        sessionId: normalized,
        cwd: this.options.cwd,
        mcpServers: this.buildAcpMcpServersForSessionRequest() as unknown as LoadSessionRequest['mcpServers'],
      };

      logger.debug(`[AcpBackend] Loading session: ${normalized}`);

      const sessionResponse = await withRetry(
        async () => {
          let timeoutHandle: NodeJS.Timeout | null = null;
          try {
            const result = await Promise.race([
              this.connection!.loadSession(loadSessionRequest).then((res) => {
                if (timeoutHandle) {
                  clearTimeout(timeoutHandle);
                  timeoutHandle = null;
                }
                return res;
              }),
              new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                  reject(new Error(`Load session timeout after ${initTimeout}ms - ${this.transport.agentName} did not respond`));
                }, initTimeout);
              }),
            ]);
            return result;
          } finally {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
          }
        },
        {
          operationName: 'LoadSession',
          maxAttempts: RETRY_CONFIG.maxAttempts,
          baseDelayMs: RETRY_CONFIG.baseDelayMs,
          maxDelayMs: RETRY_CONFIG.maxDelayMs,
        }
      );

      this.acpSessionId = normalized;
      logger.debug(`[AcpBackend] Session loaded: ${normalized}`);

      this.seedSessionModesFromSessionResponse(sessionResponse);
      this.seedSessionModelsFromSessionResponse(sessionResponse);
      this.seedSessionConfigOptionsFromSessionResponse(sessionResponse);

      this.emitIdleStatus();
      return { sessionId: normalized };
    } catch (error) {
      logger.debug('[AcpBackend] Error loading session:', error);
      this.emit({
        type: 'status',
        status: 'error',
        detail: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async loadSessionWithReplayCapture(sessionId: SessionId): Promise<StartSessionResult & { replay: AcpReplayEvent[] }> {
    this.replayCapture = new AcpReplayCapture();
    try {
      const result = await this.loadSession(sessionId);
      const replay = this.replayCapture.finalize();
      return { ...result, replay };
    } finally {
      this.replayCapture = null;
    }
  }

  /**
   * Create handler context for session update processing
   */
  private createHandlerContext(): HandlerContext {
    return {
      transport: this.transport,
      activeToolCalls: this.activeToolCalls,
      toolCallStartTimes: this.toolCallStartTimes,
      toolCallTimeouts: this.toolCallTimeouts,
      toolCallIdToNameMap: this.toolCallIdToNameMap,
      toolCallIdToInputMap: this.toolCallIdToInputMap,
      idleTimeout: this.idleTimeout,
      toolCallCountSincePrompt: this.toolCallCountSincePrompt,
      emit: (msg) => this.emit(msg),
      emitIdleStatus: () => this.emitIdleStatus(),
      clearIdleTimeout: () => {
        if (this.idleTimeout) {
          clearTimeout(this.idleTimeout);
          this.idleTimeout = null;
        }
      },
      setIdleTimeout: (callback, ms) => {
        this.idleTimeout = setTimeout(() => {
          callback();
          this.idleTimeout = null;
        }, ms);
      },
    };
  }

  private handleSessionUpdate(params: SessionNotification): void {
    const raw = asRecord(params) ?? {};
    const updateCandidates: unknown[] = [];

    const maxUpdatesPerNotification = (() => {
      const rawMax =
        process.env.HAPPIER_ACP_MAX_UPDATES_PER_NOTIFICATION ??
        process.env.HAPPY_ACP_MAX_UPDATES_PER_NOTIFICATION ??
        '';
      const parsed = Number.parseInt(String(rawMax).trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 10_000);
      return 1000;
    })();

    const pushUpdateCandidate = (value: unknown): boolean => {
      if (updateCandidates.length >= maxUpdatesPerNotification) return false;
      updateCandidates.push(value);
      return true;
    };

    if (raw.update !== undefined) {
      const updateField = raw.update;
      if (Array.isArray(updateField)) {
        for (const item of updateField) {
          if (!pushUpdateCandidate(item)) {
            logger.warn(
              `[AcpBackend] Received ${updateField.length} updates in a single notification; truncating to ${maxUpdatesPerNotification}`
            );
            break;
          }
        }
      } else {
        pushUpdateCandidate(updateField);
      }
    } else if (Array.isArray(raw.updates)) {
      for (const item of raw.updates) {
        if (!pushUpdateCandidate(item)) {
          logger.warn(
            `[AcpBackend] Received ${raw.updates.length} updates in a single notification; truncating to ${maxUpdatesPerNotification}`
          );
          break;
        }
      }
    }

    if (updateCandidates.length === 0) {
      logger.debug('[AcpBackend] Received session update without update field:', params);
      return;
    }

    const isGeminiAcpDebugEnabled = (() => {
      const flag = process.env.HAPPIER_STACK_GEMINI_ACP_DEBUG;
      return flag === '1' || flag === 'true';
    })();

    const sanitizeForLogs = (value: unknown, depth = 0): unknown => {
      if (depth > 4) return '[truncated depth]';
      if (typeof value === 'string') {
        const max = 400;
        if (value.length <= max) return value;
        return `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
      }
      if (Array.isArray(value)) {
        if (value.length > 50) {
          return [...value.slice(0, 50).map((v) => sanitizeForLogs(v, depth + 1)), `… [truncated ${value.length - 50} items]`];
        }
        return value.map((v) => sanitizeForLogs(v, depth + 1));
      }
      if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (/(token|secret|authorization|cookie|api[_-]?key|password)/i.test(k)) {
            out[k] = '[redacted]';
            continue;
          }
          out[k] = sanitizeForLogs(v, depth + 1);
        }
        return out;
      }
      return value;
    };

    const handleOneUpdate = (update: SessionUpdate): void => {
      const sessionUpdateType = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined;

      if (this.replayCapture) {
        try {
          this.replayCapture.handleUpdate(update as SessionUpdate);
        } catch (error) {
          logger.debug('[AcpBackend] Replay capture failed (non-fatal)', { error });
        }

        // Suppress transcript-affecting updates during loadSession replay.
        const suppress = sessionUpdateType === 'user_message_chunk'
          || sessionUpdateType === 'agent_message_chunk'
          || sessionUpdateType === 'agent_thought_chunk'
          || sessionUpdateType === 'tool_call'
          || sessionUpdateType === 'tool_call_update'
          || sessionUpdateType === 'plan';
        if (suppress) {
          return;
        }
      }

      // Log session updates for debugging (but not every chunk to avoid log spam)
      if (sessionUpdateType !== 'agent_message_chunk') {
        logger.debug(`[AcpBackend] Received session update: ${sessionUpdateType}`, JSON.stringify({
          sessionUpdate: sessionUpdateType,
          toolCallId: update.toolCallId,
          status: update.status,
          kind: update.kind,
          hasContent: !!update.content,
          hasLocations: !!update.locations,
        }, null, 2));
      }

      // Gemini ACP deep debug: dump raw terminal tool updates to verify where tool outputs live.
      if (
        isGeminiAcpDebugEnabled &&
        this.transport.agentName === 'gemini' &&
        (sessionUpdateType === 'tool_call_update' || sessionUpdateType === 'tool_call') &&
        (update.status === 'completed' || update.status === 'failed' || update.status === 'cancelled')
      ) {
        const keys = Object.keys(update);
        logger.debug('[AcpBackend] [GeminiACP] Terminal tool update keys:', keys);
        logger.debug('[AcpBackend] [GeminiACP] Terminal tool update payload:', JSON.stringify(sanitizeForLogs(update), null, 2));
      }

      const ctx = this.createHandlerContext();

      // Dispatch to appropriate handler based on update type
      if (sessionUpdateType === 'agent_message_chunk') {
        handleAgentMessageChunk(update, ctx);
        return;
      }

      if (sessionUpdateType === 'user_message_chunk') {
        handleUserMessageChunk(update, ctx);
        return;
      }

      if (sessionUpdateType === 'tool_call_update') {
        const result = handleToolCallUpdate(update, ctx);
        if (result.toolCallCountSincePrompt !== undefined) {
          this.toolCallCountSincePrompt = result.toolCallCountSincePrompt;
        }
        return;
      }

      if (sessionUpdateType === 'agent_thought_chunk') {
        handleAgentThoughtChunk(update, ctx);
        return;
      }

      if (sessionUpdateType === 'tool_call') {
        handleToolCall(update, ctx);
        return;
      }

      if (sessionUpdateType === 'available_commands_update') {
        handleAvailableCommandsUpdate(update, ctx);
        return;
      }

      if (sessionUpdateType === 'current_mode_update') {
        const modeId = typeof update.currentModeId === 'string' ? update.currentModeId : null;
        if (modeId && this.sessionModeState) {
          this.sessionModeState = {
            ...this.sessionModeState,
            currentModeId: modeId,
          };
        }
        handleCurrentModeUpdate(update, ctx);
        return;
      }

      if (sessionUpdateType === 'current_model_update') {
        const modelId =
          typeof (update as any).currentModelId === 'string'
            ? (update as any).currentModelId
            : (typeof (update as any).currentModel === 'string' ? (update as any).currentModel : null);
        if (modelId && this.sessionModelState) {
          this.sessionModelState = {
            ...this.sessionModelState,
            currentModelId: modelId,
          };
        }
        this.emit({ type: 'event', name: 'current_model_update', payload: { currentModelId: modelId ?? '' } });
        return;
      }

      if (sessionUpdateType === 'config_option_update') {
        const configOptionsCandidate = (update as any).configOptions;
        const configOptionsRaw = Array.isArray(configOptionsCandidate) ? configOptionsCandidate : null;
        if (configOptionsRaw) {
          const next = normalizeSessionConfigOptions(configOptionsRaw);
          this.sessionConfigOptionsState = next;
        }
        this.emit({
          type: 'event',
          name: 'config_options_update',
          payload: { configOptions: this.sessionConfigOptionsState ?? [] },
        });
        return;
      }

      if (sessionUpdateType === 'plan') {
        handlePlanUpdate(update, ctx);
        return;
      }

      if (sessionUpdateType === 'usage_update') {
        const usedRaw = (update as any).used;
        const sizeRaw = (update as any).size;
        const asNum = (value: unknown): number | null =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
        const used = asNum(usedRaw);
        const size = asNum(sizeRaw);
        if (used != null || size != null) {
          const tokens: Record<string, number> = { total: used ?? 0 };
          if (used != null) tokens.used = used;
          if (size != null) tokens.size = size;
          this.emit({
            type: 'token-count',
            key: 'acp-usage-update',
            tokens,
            source: 'acp-usage-update',
          });
        }
        // Some ACP providers report per-turn usage via usage_update with OpenAI-like fields.
        // Accept these best-effort and convert them into token-count telemetry.
        if (used == null && size == null) {
          const input = asNum((update as any).input_tokens) ?? asNum((update as any).prompt_tokens);
          const output = asNum((update as any).output_tokens) ?? asNum((update as any).completion_tokens);
          const cacheRead =
            asNum((update as any).cache_read_input_tokens) ?? asNum((update as any).cache_read_tokens);
          const cacheCreation =
            asNum((update as any).cache_creation_input_tokens) ?? asNum((update as any).cache_creation_tokens);

          const anyPresent = input != null || output != null || cacheRead != null || cacheCreation != null;
          if (anyPresent) {
            const total = (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);
            const tokens: Record<string, number> = { total };
            if (input != null) tokens.input = input;
            if (output != null) tokens.output = output;
            if (cacheRead != null) tokens.cache_read = cacheRead;
            if (cacheCreation != null) tokens.cache_creation = cacheCreation;
            this.emit({
              type: 'token-count',
              key: 'acp-usage-update',
              tokens,
              source: 'acp-usage-update',
            });
          }
        }
        return;
      }

      // Best-effort: some ACP providers attach usage to non-usage session updates (e.g. task_complete).
      const usageCandidate = (update as any).usage;
      if (usageCandidate && typeof usageCandidate === 'object' && !Array.isArray(usageCandidate)) {
        const record = usageCandidate as Record<string, unknown>;
        const asNum = (value: unknown): number | null =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

        const input =
          asNum(record.input_tokens) ??
          asNum(record.inputTokens) ??
          asNum(record.prompt_tokens) ??
          asNum(record.promptTokens);
        const output =
          asNum(record.output_tokens) ??
          asNum(record.outputTokens) ??
          asNum(record.completion_tokens) ??
          asNum(record.completionTokens);
        const thought = asNum(record.thought_tokens) ?? asNum(record.thoughtTokens);
        const cacheRead =
          asNum(record.cached_read_tokens) ??
          asNum(record.cachedReadTokens) ??
          asNum(record.cache_read_tokens) ??
          asNum(record.cacheReadTokens);
        const cacheWrite =
          asNum(record.cached_write_tokens) ??
          asNum(record.cachedWriteTokens) ??
          asNum(record.cache_creation_tokens) ??
          asNum(record.cacheCreationTokens);
        const totalFromResponse =
          asNum(record.total_tokens) ??
          asNum(record.totalTokens);
        const total =
          totalFromResponse ??
          (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) + (thought ?? 0);

        const anyPresent =
          totalFromResponse != null ||
          input != null ||
          output != null ||
          cacheRead != null ||
          cacheWrite != null ||
          thought != null;

        if (anyPresent) {
          const tokens: Record<string, number> = { total };
          if (input != null) tokens.input = input;
          if (output != null) tokens.output = output;
          if (cacheRead != null) tokens.cache_read = cacheRead;
          if (cacheWrite != null) tokens.cache_creation = cacheWrite;
          if (thought != null) tokens.thought = thought;
          this.emit({
            type: 'token-count',
            key: 'acp-session-update-usage',
            tokens,
            source: 'acp-session-update-usage',
          });
        }
      }

      // Handle legacy and auxiliary update types
      handleLegacyMessageChunk(update, ctx);
      handlePlanUpdate(update, ctx);
      handleThinkingUpdate(update, ctx);

      // Log unhandled session update types for debugging
      // Cast to string to avoid TypeScript errors (SDK types don't include all Gemini-specific update types)
      const updateTypeStr = sessionUpdateType as string;
      const handledTypes = [
        'agent_message_chunk',
        'user_message_chunk',
        'tool_call_update',
        'agent_thought_chunk',
        'tool_call',
        'available_commands_update',
        'current_mode_update',
        'current_model_update',
        'config_option_update',
        'plan',
        'usage_update',
      ];
      if (updateTypeStr &&
        !handledTypes.includes(updateTypeStr) &&
        !update.messageChunk &&
        !update.plan &&
        !update.thinking &&
        !update.availableCommands &&
        !update.currentModeId &&
        !update.entries) {
        logger.debug(
          `[AcpBackend] Unhandled session update type: ${updateTypeStr}`,
          JSON.stringify(
            {
              // Avoid logging payloads: content/tool outputs can contain secrets.
              keys: Object.keys(update as unknown as Record<string, unknown>).slice(0, 50),
            },
            null,
            2
          )
        );
      }
    };

    for (const candidate of updateCandidates) {
      const update = (asRecord(candidate) ?? {}) as SessionUpdate;
      if (Object.keys(update).length === 0) continue;
      handleOneUpdate(update);
    }
  }

  private seedSessionModesFromSessionResponse(sessionResponse: unknown): void {
    const response = asRecord(sessionResponse);
    if (!response) return;
    const modesRaw = asRecord(response.modes);
    if (!modesRaw) return;

    const currentModeId = getString(modesRaw, 'currentModeId');
    const availableModesRaw = Array.isArray(modesRaw.availableModes) ? modesRaw.availableModes : null;
    if (!currentModeId || !availableModesRaw) return;

    const availableModes: SessionMode[] = availableModesRaw
      .map((mode) => asRecord(mode))
      .filter((mode): mode is Record<string, unknown> => Boolean(mode))
      .map((mode) => {
        const id = getString(mode, 'id');
        const name = getString(mode, 'name');
        if (!id || !name) return null;
        const description = getString(mode, 'description');
        return { id, name, ...(description ? { description } : {}) };
      })
      .filter((mode): mode is SessionMode => Boolean(mode));

    if (availableModes.length === 0) return;

    this.sessionModeState = { currentModeId, availableModes };
    this.emit({ type: 'event', name: 'session_modes_state', payload: this.sessionModeState });
  }

  private seedSessionModelsFromSessionResponse(sessionResponse: unknown): void {
    const response = asRecord(sessionResponse);
    if (!response) return;
    const modelsRaw = asRecord(response.models);
    if (!modelsRaw) return;

    const currentModelId = getString(modelsRaw, 'currentModelId');
    const availableModelsCandidate = (modelsRaw as { availableModels?: unknown }).availableModels;
    const availableModelsRaw: unknown[] | null = Array.isArray(availableModelsCandidate) ? availableModelsCandidate : null;
    if (!currentModelId || !availableModelsRaw) return;

    const availableModels: SessionModel[] = availableModelsRaw
      .map((model: unknown) => asRecord(model))
      .filter((model): model is Record<string, unknown> => Boolean(model))
      .map((model) => {
        const id = getString(model, 'id');
        const name = getString(model, 'name');
        if (!id || !name) return null;
        const description = getString(model, 'description');
        return { id, name, ...(description ? { description } : {}) };
      })
      .filter((model): model is SessionModel => Boolean(model));

    if (availableModels.length === 0) return;

    this.sessionModelState = { currentModelId, availableModels };
    this.emit({ type: 'event', name: 'session_models_state', payload: this.sessionModelState });
  }

  private seedSessionConfigOptionsFromSessionResponse(sessionResponse: unknown): void {
    const response = asRecord(sessionResponse);
    if (!response) return;

    const configOptionsCandidate = (response as { configOptions?: unknown }).configOptions;
    const configOptionsRaw: unknown[] | null = Array.isArray(configOptionsCandidate) ? configOptionsCandidate : null;
    if (!configOptionsRaw) return;

    const configOptions = normalizeSessionConfigOptions(configOptionsRaw);
    this.sessionConfigOptionsState = configOptions;
    this.emit({ type: 'event', name: 'config_options_state', payload: { configOptions } });
  }

  async setSessionConfigOption(sessionId: SessionId, configId: string, valueId: string): Promise<void> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }
    if (!this.connection || !this.acpSessionId) {
      throw new Error('Session not started');
    }

    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      throw new Error('Session ID is required');
    }
    if (normalizedSessionId !== this.acpSessionId) {
      throw new Error('Session ID does not match the active ACP session');
    }

    const normalizedConfigId = typeof configId === 'string' ? configId.trim() : '';
    if (!normalizedConfigId) {
      throw new Error('Config ID is required');
    }

    const normalizedValueId = typeof valueId === 'string' ? valueId.trim() : '';
    if (!normalizedValueId) {
      throw new Error('Config value is required');
    }

    const connectionAny = this.connection as any;
    if (typeof connectionAny.setSessionConfigOption !== 'function') {
      throw new Error('ACP SDK does not support session/set_config_option');
    }

    const response = await connectionAny.setSessionConfigOption({
      sessionId: normalizedSessionId,
      configId: normalizedConfigId,
      value: normalizedValueId,
    });

    const configOptionsCandidate = response?.configOptions;
    const configOptionsRaw = Array.isArray(configOptionsCandidate) ? configOptionsCandidate : null;
    if (configOptionsRaw) {
      const next = normalizeSessionConfigOptions(configOptionsRaw);
      this.sessionConfigOptionsState = next;
    }

    this.emit({
      type: 'event',
      name: 'config_options_update',
      payload: { configOptions: this.sessionConfigOptionsState ?? [] },
    });
  }

  // Promise resolver for waitForIdle - set when waiting for response to complete
  private idleResolver: (() => void) | null = null;
  private idleRejecter: ((error: Error) => void) | null = null;
  private waitingForResponse = false;
  private responseCompletionError: Error | null = null;

  private failPendingResponseWait(error: Error): void {
    // Multiple sources can surface the same underlying failure (stderr parsing, transport errors, process exit).
    // Preserve the first error to keep `waitForResponseComplete()` deterministic and avoid churn.
    if (this.responseCompletionError) {
      logger.debug('[AcpBackend] Additional response completion error observed (ignored)', error);
      return;
    }
    this.responseCompletionError = error;
    this.waitingForResponse = false;
    if (this.idleRejecter) {
      this.idleRejecter(error);
    }
    this.idleResolver = null;
    this.idleRejecter = null;
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    // Check if prompt contains change_title instruction (via optional callback)
    const promptHasChangeTitle = this.options.hasChangeTitleInstruction?.(prompt) ?? false;

    // Reset tool call counter and set flag
    this.toolCallCountSincePrompt = 0;
    this.recentPromptHadChangeTitle = promptHasChangeTitle;
    
    if (promptHasChangeTitle) {
      logger.debug('[AcpBackend] Prompt contains change_title instruction - will auto-approve first "other" tool call if it matches pattern');
    }
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    if (!this.connection || !this.acpSessionId) {
      throw new Error('Session not started');
    }

    this.emit({ type: 'status', status: 'running' });
    this.waitingForResponse = true;
    this.responseCompletionError = null;

    try {
      // Never log prompt contents (can include secrets).
      logger.debug(`[AcpBackend] Sending prompt (length: ${prompt.length})`);

      const contentBlock: ContentBlock = {
        type: 'text',
        text: prompt,
      };

      const promptRequest: PromptRequest = {
        sessionId: this.acpSessionId,
        prompt: [contentBlock],
      };

      const promptResponse: any = await this.connection.prompt(promptRequest);
      logger.debug('[AcpBackend] Prompt request sent to ACP connection');

      // Best-effort: emit token usage when the ACP agent reports it in the PromptResponse.
      // ACP standardizes per-turn usage under `usage` (RFC: session-usage).
      const usage = promptResponse?.usage;
      if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
        const record = usage as Record<string, unknown>;
        const asNum = (value: unknown): number | null =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

        const input = asNum(record.input_tokens);
        const output = asNum(record.output_tokens);
        const thought = asNum(record.thought_tokens);
        const cacheRead = asNum(record.cached_read_tokens);
        const cacheWrite = asNum(record.cached_write_tokens);
        const totalFromResponse = asNum(record.total_tokens);
        const total =
          totalFromResponse ??
          (input ?? 0) +
            (output ?? 0) +
            (cacheRead ?? 0) +
            (cacheWrite ?? 0) +
            (thought ?? 0);

        const tokens: Record<string, number> = { total };
        if (input != null) tokens.input = input;
        if (output != null) tokens.output = output;
        if (cacheRead != null) tokens.cache_read = cacheRead;
        if (cacheWrite != null) tokens.cache_creation = cacheWrite;
        if (thought != null) tokens.thought = thought;

        const modelId = typeof promptResponse?.modelId === 'string'
          ? String(promptResponse.modelId)
          : (typeof promptResponse?.model === 'string' ? String(promptResponse.model) : undefined);

        this.emit({
          type: 'token-count',
          key: 'acp-prompt-usage',
          tokens,
          ...(modelId ? { modelId } : null),
          source: 'acp-prompt-usage',
        });
      }
      
      // Don't emit 'idle' here - it will be emitted after all message chunks are received
      // The idle timeout in handleSessionUpdate will emit 'idle' after the last chunk

    } catch (error) {
      logger.debug('[AcpBackend] Error sending prompt:', error);
      this.failPendingResponseWait(error instanceof Error ? error : new Error(String(error)));
      
      // Extract error details for better error handling
      let errorDetail: string;
      if (error instanceof Error) {
        errorDetail = error.message;
      } else if (typeof error === 'object' && error !== null) {
        const errObj = error as Record<string, unknown>;
        // Try to extract structured error information
        const fallbackMessage = (typeof errObj.message === 'string' ? errObj.message : undefined) || String(error);
        if (errObj.code !== undefined) {
          errorDetail = JSON.stringify({ code: errObj.code, message: fallbackMessage });
        } else if (typeof errObj.message === 'string') {
          errorDetail = errObj.message;
        } else {
          errorDetail = String(error);
        }
      } else {
        errorDetail = String(error);
      }
      
      this.emit({ 
        type: 'status', 
        status: 'error', 
        detail: errorDetail
      });
      throw error;
    }
  }

  async sendSteerPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }
    if (!this.connection || !this.acpSessionId) {
      throw new Error('Session not started');
    }

    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      throw new Error('Session ID is required');
    }
    if (normalizedSessionId !== this.acpSessionId) {
      throw new Error('Session ID does not match the active ACP session');
    }

    const contentBlock: ContentBlock = {
      type: 'text',
      text: prompt,
    };

    const promptRequest: PromptRequest = {
      sessionId: this.acpSessionId,
      prompt: [contentBlock],
    };

    // Intentionally do not toggle `waitingForResponse` or tool-call counters here.
    // This method is used for in-flight steering while a primary prompt is already running.
    await this.connection.prompt(promptRequest);
  }

  async setSessionMode(sessionId: SessionId, modeId: string): Promise<void> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }
    if (!this.connection || !this.acpSessionId) {
      throw new Error('Session not started');
    }

    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      throw new Error('Session ID is required');
    }
    if (normalizedSessionId !== this.acpSessionId) {
      throw new Error('Session ID does not match the active ACP session');
    }
    const normalizedModeId = typeof modeId === 'string' ? modeId.trim() : '';
    if (!normalizedModeId) {
      throw new Error('Mode ID is required');
    }

    const request: SetSessionModeRequest = { sessionId: normalizedSessionId, modeId: normalizedModeId };
    await this.connection.setSessionMode(request);

    if (this.sessionModeState) {
      this.sessionModeState = { ...this.sessionModeState, currentModeId: normalizedModeId };
    }

    this.emit({ type: 'event', name: 'current_mode_update', payload: { currentModeId: normalizedModeId } });
  }

  async setSessionModel(sessionId: SessionId, modelId: string): Promise<void> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }
    if (!this.connection || !this.acpSessionId) {
      throw new Error('Session not started');
    }

    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      throw new Error('Session ID is required');
    }
    if (normalizedSessionId !== this.acpSessionId) {
      throw new Error('Session ID does not match the active ACP session');
    }

    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalizedModelId) {
      throw new Error('Model ID is required');
    }

    const connectionAny = this.connection as any;
    const setModel =
      typeof connectionAny.unstable_setSessionModel === 'function'
        ? connectionAny.unstable_setSessionModel.bind(connectionAny)
        : (typeof connectionAny.setSessionModel === 'function' ? connectionAny.setSessionModel.bind(connectionAny) : null);
    if (!setModel) {
      throw new Error('ACP SDK does not support session/set_model');
    }

    await setModel({ sessionId: normalizedSessionId, modelId: normalizedModelId });

    if (this.sessionModelState) {
      this.sessionModelState = { ...this.sessionModelState, currentModelId: normalizedModelId };
    }

    this.emit({ type: 'event', name: 'current_model_update', payload: { currentModelId: normalizedModelId } });
  }

  /**
   * Wait for the response to complete (idle status after all chunks received)
   * Call this after sendPrompt to wait for Gemini to finish responding
   */
  private clearTrackedToolCall(toolCallId: string, reason: string): void {
    const wasActive = this.activeToolCalls.delete(toolCallId);
    this.toolCallStartTimes.delete(toolCallId);
    this.toolCallIdToNameMap.delete(toolCallId);
    this.toolCallIdToInputMap.delete(toolCallId);

    const timeout = this.toolCallTimeouts.get(toolCallId);
    if (timeout) {
      clearTimeout(timeout);
      this.toolCallTimeouts.delete(toolCallId);
    }

    if (wasActive || timeout) {
      logger.debug(
        `[AcpBackend] Cleared tracked tool call ${toolCallId} after ${reason}. Active tool calls: ${this.activeToolCalls.size}`,
      );
    }

    if (this.activeToolCalls.size === 0) {
      this.emitIdleStatus();
    }
  }

  async waitForResponseComplete(timeoutMs: number = 120000): Promise<void> {
    if (this.responseCompletionError) {
      throw this.responseCompletionError;
    }
    if (!this.waitingForResponse) {
      return; // Already completed or no prompt sent
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.idleResolver = null;
        this.idleRejecter = null;
        this.waitingForResponse = false;
        reject(new Error('Timeout waiting for response to complete'));
      }, timeoutMs);

      this.idleResolver = () => {
        clearTimeout(timeout);
        this.idleResolver = null;
        this.idleRejecter = null;
        this.waitingForResponse = false;
        resolve();
      };
      this.idleRejecter = (error: Error) => {
        clearTimeout(timeout);
        this.idleResolver = null;
        this.idleRejecter = null;
        this.waitingForResponse = false;
        reject(error);
      };
    });
  }

  /**
   * Helper to emit idle status and resolve any waiting promises
   */
  private emitIdleStatus(): void {
    this.emit({ type: 'status', status: 'idle' });
    // Avoid races where the idle signal arrives before `waitForResponseComplete()` starts waiting.
    // In that case, `idleResolver` is still null, so we must also clear `waitingForResponse` here.
    this.waitingForResponse = false;
    // Resolve any waiting promises
    if (this.idleResolver) {
      logger.debug('[AcpBackend] Resolving idle waiter');
      this.idleResolver();
    }
  }

  async cancel(sessionId: SessionId): Promise<void> {
    if (!this.connection || !this.acpSessionId) {
      return;
    }

    try {
      await this.connection.cancel({ sessionId: this.acpSessionId });
      this.emit({ type: 'status', status: 'stopped', detail: 'Cancelled by user' });
    } catch (error) {
      // Log to file only, not console
      logger.debug('[AcpBackend] Error cancelling:', error);
    }
  }

  /**
   * Emit permission response event for UI/logging purposes.
   *
   * **IMPORTANT:** For ACP backends, this method does NOT send the actual permission
   * response to the agent. The ACP protocol requires synchronous permission handling,
   * which is done inside the `requestPermission` RPC handler via `this.options.permissionHandler`.
   *
   * This method only emits a `permission-response` event for:
   * - UI updates (e.g., closing permission dialogs)
   * - Logging and debugging
   * - Other parts of the CLI that need to react to permission decisions
   *
   * @param requestId - The ID of the permission request
   * @param approved - Whether the permission was granted
   */
  async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    logger.debug(`[AcpBackend] Permission response event (UI only): ${requestId} = ${approved}`);
    this.emit({ type: 'permission-response', id: requestId, approved });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    
    logger.debug('[AcpBackend] Disposing backend');
    this.disposed = true;

    // Try graceful shutdown first
    if (this.connection && this.acpSessionId) {
      try {
        // Send cancel to stop any ongoing work
        await Promise.race([
          this.connection.cancel({ sessionId: this.acpSessionId }),
          new Promise((resolve) => setTimeout(resolve, 2000)), // 2s timeout for graceful shutdown
        ]);
      } catch (error) {
        logger.debug('[AcpBackend] Error during graceful shutdown:', error);
      }
    }

    // Kill the whole process tree (some ACP CLIs spawn child processes).
    if (this.process) {
      try {
        await killProcessTree(this.process, { graceMs: 1000 });
      } catch (error) {
        logger.debug('[AcpBackend] Failed to kill process tree (non-fatal):', error);
      } finally {
        this.process = null;
      }
    }

    // Clear timeouts
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }

    // Clear state
    this.listeners = [];
    this.connection = null;
    this.acpSessionId = null;
    this.activeToolCalls.clear();
    // Clear all tool call timeouts
    for (const timeout of this.toolCallTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.toolCallTimeouts.clear();
    this.toolCallStartTimes.clear();
    this.pendingPermissions.clear();
    this.permissionToToolCallMap.clear();
    this.toolCallIdToNameMap.clear();
    this.toolCallIdToInputMap.clear();
    this.lastSelectedPermissionOptionIdByToolCallId.clear();
  }
}
