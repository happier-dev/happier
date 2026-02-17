import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import readline from 'node:readline';
import { join } from 'node:path';

import spawn from 'cross-spawn';

import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
} from '@/agent/core';
import { logger } from '@/ui/logger';
import { redactBugReportSensitiveText } from '@happier-dev/protocol';

import { mapPiRpcEventToAgentMessages } from './eventMapping';
import type {
  PiRpcCommand,
  PiRpcCommandWithoutId,
  PiRpcCommandsData,
  PiRpcModelsData,
  PiRpcResponse,
  PiRpcSessionStatsData,
  PiRpcStateData,
} from './types';

type PendingRpcRequest = {
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  commandType: PiRpcCommandWithoutId['type'];
};

type PendingTurn = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

export type PiRpcSpawnOptions = {
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export class PiRpcBackend implements AgentBackend {
  readonly options: Readonly<{
    cwd: string;
    command: string;
    args: string[];
    env: Record<string, string>;
  }>;

  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutLineReader: readline.Interface | null = null;
  private stderrLineReader: readline.Interface | null = null;
  private readonly messageHandlers = new Set<AgentMessageHandler>();
  private readonly pendingRequests = new Map<string, PendingRpcRequest>();
  private readonly openPromptRequestIds = new Set<string>();
  private pendingTurn: PendingTurn | null = null;
  private sessionId: string | null = null;
  private lastAuthJsonMtimeMs: number | null = null;
  private currentModelProvider: string | null = null;
  private readonly modelProviderById = new Map<string, string>();
  private sessionModelState: { currentModelId: string; availableModels: Array<{ id: string; name: string; description?: string }> } | null =
    null;
  private lastPublishedUsageKey: string | null = null;
  private disposed = false;

  constructor(options: PiRpcSpawnOptions) {
    this.options = {
      cwd: options.cwd,
      command: options.command,
      args: [...options.args],
      env: { ...(options.env ?? {}) },
    };
  }

  onMessage(handler: AgentMessageHandler): void {
    this.messageHandlers.add(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.messageHandlers.delete(handler);
  }

  async startSession(): Promise<StartSessionResult> {
    await this.ensureProcess();
    this.emitMessage({ type: 'status', status: 'starting' });

    const stateBefore = await this.getState();
    const existingSessionId = asNonEmptyString(stateBefore.sessionId);
    if (existingSessionId) {
      this.sessionId = existingSessionId;
      await this.captureAuthJsonSnapshot();
      await this.publishRuntimeState(stateBefore);
      this.emitMessage({ type: 'status', status: 'idle' });
      return { sessionId: existingSessionId };
    }

    const created = await this.sendCommand({ type: 'new_session' }, 60_000);
    if ((asRecord(created.data)?.cancelled ?? false) === true) {
      throw new Error('Pi cancelled new_session');
    }

    const stateAfter = await this.getState();
    const nextSessionId = asNonEmptyString(stateAfter.sessionId);
    if (!nextSessionId) {
      throw new Error('Pi did not return a session id');
    }

    this.sessionId = nextSessionId;
    await this.captureAuthJsonSnapshot();
    await this.publishRuntimeState(stateAfter);
    this.emitMessage({ type: 'status', status: 'idle' });
    return { sessionId: nextSessionId };
  }

  /**
   * Exposed for best-effort model probing (see `capabilities/probes/agentModelsProbe.ts`).
   * This mirrors the ACP `getSessionModelState` shape.
   */
  getSessionModelState(): { currentModelId: string; availableModels: Array<{ id: string; name: string; description?: string }> } | null {
    return this.sessionModelState;
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    this.assertSession(sessionId);
    const maybeRestart = this.maybeRestartForUpdatedAuthJson();
    if (maybeRestart) await maybeRestart;
    const message = prompt.trim();
    if (!message) return;

    const turn = this.createPendingTurn(240_000);
    try {
      await this.sendCommand({ type: 'prompt', message });
    } catch (error) {
      const promptError = asError(error);
      const normalizedError = promptError.message.toLowerCase();
      const canFallbackToSteer =
        normalizedError.includes('already processing') || normalizedError.includes('streamingbehavior');

      if (canFallbackToSteer) {
        try {
          await this.sendCommand({ type: 'steer', message });
          await turn;
          return;
        } catch (steerError) {
          const resolvedSteerError = asError(steerError);
          this.rejectPendingTurn(resolvedSteerError);
          await turn.catch(() => undefined);
          throw resolvedSteerError;
        }
      }

      this.rejectPendingTurn(promptError);
      await turn.catch(() => undefined);
      throw promptError;
    }
    await turn;
  }

  async sendSteerPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    this.assertSession(sessionId);
    const maybeRestart = this.maybeRestartForUpdatedAuthJson();
    if (maybeRestart) await maybeRestart;
    const message = prompt.trim();
    if (!message) return;
    await this.sendCommand({ type: 'steer', message });
  }

  async setSessionModel(sessionId: SessionId, modelId: string): Promise<void> {
    this.assertSession(sessionId);
    const maybeRestart = this.maybeRestartForUpdatedAuthJson();
    if (maybeRestart) await maybeRestart;
    const normalized = modelId.trim();
    if (!normalized) return;

    const selection = await this.resolveModelSelection(normalized);
    await this.sendCommand({ type: 'set_model', provider: selection.provider, modelId: selection.modelId }, 60_000);
    this.currentModelProvider = selection.provider;
    await this.publishRuntimeState(await this.getState());
  }

  async cancel(sessionId: SessionId): Promise<void> {
    this.assertSession(sessionId);
    await this.sendCommand({ type: 'abort' });
    this.resolvePendingTurn();
    this.emitMessage({ type: 'status', status: 'idle' });
  }

  async waitForResponseComplete(timeoutMs = 120_000): Promise<void> {
    if (!this.pendingTurn) return;
    const turn = this.pendingTurn;

    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        turn.promise,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('Timed out waiting for Pi response completion'));
          }, timeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    this.rejectAllPending(new Error('Pi backend disposed'));
    this.rejectPendingTurn(new Error('Pi backend disposed'));

    if (this.stdoutLineReader) {
      this.stdoutLineReader.close();
      this.stdoutLineReader = null;
    }
    if (this.stderrLineReader) {
      this.stderrLineReader.close();
      this.stderrLineReader = null;
    }

    const child = this.process;
    this.process = null;
    if (!child) return;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 2_000);
      timeout.unref?.();

      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  private async ensureProcess(): Promise<void> {
    if (this.disposed) {
      throw new Error('Pi backend is disposed');
    }
    if (this.process) return;
    if (this.sessionId) {
      // Once a session is established, never silently respawn a new RPC process.
      // A respawn would desynchronize the session id and any pending turn state.
      throw new Error('Pi RPC process is not running');
    }

    this.spawnRpcProcess({ args: this.options.args });
  }

  private spawnRpcProcess(params: Readonly<{ args: string[] }>): void {
    const child = spawn(this.options.command, params.args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.env,
      },
      stdio: 'pipe',
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error('Failed to start Pi RPC process with piped stdio');
    }

    this.process = child as ChildProcessWithoutNullStreams;
    this.stdoutLineReader = readline.createInterface({ input: child.stdout });
    this.stdoutLineReader.on('line', (line) => this.handleStdoutLine(line));
    this.stderrLineReader = readline.createInterface({ input: child.stderr });
    this.stderrLineReader.on('line', (line) => this.handleStderrLine(line));

    child.on('error', (error) => {
      this.emitMessage({
        type: 'status',
        status: 'error',
        detail: `Pi process error: ${error instanceof Error ? error.message : String(error)}`,
      });
      this.rejectAllPending(new Error(`Pi process error: ${error instanceof Error ? error.message : String(error)}`));
      this.rejectPendingTurn(new Error('Pi process terminated'));
    });

    child.on('exit', (code, signal) => {
      if (!this.disposed) {
        const detail = `Pi process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
        this.emitMessage({
          type: 'status',
          status: code === 0 ? 'stopped' : 'error',
          detail,
        });
      }
      this.rejectAllPending(new Error('Pi process exited'));
      this.rejectPendingTurn(new Error('Pi process exited'));
      this.process = null;
    });
  }

  private resolveAuthJsonPath(): string | null {
    const agentDir = asNonEmptyString(this.options.env.PI_CODING_AGENT_DIR);
    if (!agentDir) return null;
    return join(agentDir, 'auth.json');
  }

  private async captureAuthJsonSnapshot(): Promise<void> {
    const authPath = this.resolveAuthJsonPath();
    if (!authPath) return;
    try {
      const s = await stat(authPath);
      this.lastAuthJsonMtimeMs = typeof s.mtimeMs === 'number' && Number.isFinite(s.mtimeMs) ? s.mtimeMs : null;
    } catch {
      this.lastAuthJsonMtimeMs = null;
    }
  }

  private maybeRestartForUpdatedAuthJson(): Promise<void> | void {
    if (this.disposed) return;
    if (!this.sessionId) return;
    if (!this.process) return;

    const authPath = this.resolveAuthJsonPath();
    if (!authPath) return;

    return (async () => {
      let nextMtimeMs: number | null = null;
      try {
        const s = await stat(authPath);
        nextMtimeMs = typeof s.mtimeMs === 'number' && Number.isFinite(s.mtimeMs) ? s.mtimeMs : null;
      } catch {
        return;
      }

      if (this.lastAuthJsonMtimeMs === null) {
        this.lastAuthJsonMtimeMs = nextMtimeMs;
        return;
      }
      if (nextMtimeMs === null || nextMtimeMs === this.lastAuthJsonMtimeMs) return;

      this.lastAuthJsonMtimeMs = nextMtimeMs;
      await this.restartAndContinue();
      await this.captureAuthJsonSnapshot();
    })();
  }

  private async restartAndContinue(): Promise<void> {
    const expectedSessionId = this.sessionId;
    if (!expectedSessionId) return;
    if (this.pendingTurn) {
      throw new Error('Cannot restart Pi while a turn is in-flight');
    }

    await this.stopRpcProcessForRestart();
    this.spawnRpcProcess({ args: [...this.options.args, '--continue'] });

    const state = await this.getState();
    const nextSessionId = asNonEmptyString(state.sessionId);
    if (!nextSessionId) {
      throw new Error('Pi did not return a session id after --continue');
    }
    if (nextSessionId !== expectedSessionId) {
      throw new Error(`Pi session mismatch after --continue (expected ${expectedSessionId}, got ${nextSessionId})`);
    }
    await this.publishRuntimeState(state);
    this.emitMessage({ type: 'status', status: 'idle' });
  }

  private async stopRpcProcessForRestart(): Promise<void> {
    this.rejectAllPending(new Error('Pi restarting'));
    this.rejectPendingTurn(new Error('Pi restarting'));

    if (this.stdoutLineReader) {
      this.stdoutLineReader.close();
      this.stdoutLineReader = null;
    }
    if (this.stderrLineReader) {
      this.stderrLineReader.close();
      this.stderrLineReader = null;
    }

    const child = this.process;
    this.process = null;
    if (!child) return;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 2_000);
      timeout.unref?.();

      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    const parsed = (() => {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        this.emitMessage({ type: 'terminal-output', data: line });
        return null;
      }
    })();
    if (!parsed) return;

    const record = asRecord(parsed);
    if (!record) return;

    if (record.type === 'response') {
      this.handleResponse(record as PiRpcResponse);
      return;
    }

    this.handleEvent(record);
  }

  private handleResponse(response: PiRpcResponse): void {
    const id = asNonEmptyString(response.id);
    if (!id) return;
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      if (response.command === 'prompt' && !response.success && this.openPromptRequestIds.has(id)) {
        this.openPromptRequestIds.delete(id);
        const detail = asNonEmptyString(response.error) ?? 'Pi prompt failed';
        this.rejectPendingTurn(new Error(detail));
        this.emitMessage({ type: 'status', status: 'error', detail });
      }
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(id);

    if (!response.success) {
      this.openPromptRequestIds.delete(id);
      pending.reject(new Error(asNonEmptyString(response.error) ?? `Pi RPC command failed: ${response.command}`));
      return;
    }
    if (pending.commandType === 'prompt') {
      this.openPromptRequestIds.add(id);
    }
    pending.resolve(response);
  }

  private handleEvent(event: Record<string, unknown>): void {
    for (const msg of mapPiRpcEventToAgentMessages(event)) {
      this.emitMessage(msg);
    }

    if (event.type === 'turn_end' || event.type === 'agent_end') {
      this.resolvePendingTurn();
      void this.publishUsageStatsBestEffort();
    }

    if (event.type === 'message_update') {
      const assistant = asRecord(event.assistantMessageEvent);
      const assistantType = asNonEmptyString(assistant?.type);
      if (assistantType === 'thinking_start') {
        this.emitMessage({ type: 'event', name: 'thinking_update', payload: { thinking: true } });
      } else if (assistantType === 'thinking_end' || assistantType === 'text_start' || assistantType === 'text_delta') {
        this.emitMessage({ type: 'event', name: 'thinking_update', payload: { thinking: false } });
      }
    }
  }

  private async publishUsageStatsBestEffort(): Promise<void> {
    if (this.disposed) return;
    if (!this.process) return;

    try {
      const stats = await this.getSessionStats();
      const sessionId = asNonEmptyString((stats as any).sessionId);
      if (!sessionId) return;

      const assistantMessagesRaw = (stats as any).assistantMessages;
      const assistantMessages =
        typeof assistantMessagesRaw === 'number' && Number.isFinite(assistantMessagesRaw) ? assistantMessagesRaw : null;
      const rawKey = assistantMessages !== null ? `${sessionId}:${assistantMessages}` : sessionId;
      if (this.lastPublishedUsageKey === rawKey) return;
      this.lastPublishedUsageKey = rawKey;

      const tokensRecord = asRecord((stats as any).tokens) ?? {};
      const asNonNegative = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

      const input = asNonNegative(tokensRecord.input);
      const output = asNonNegative(tokensRecord.output);
      const cacheRead = asNonNegative(tokensRecord.cacheRead);
      const cacheWrite = asNonNegative(tokensRecord.cacheWrite);
      const total = asNonNegative(tokensRecord.total);

      const tokens: Record<string, number> = {};
      if (input !== null) tokens.input = input;
      if (output !== null) tokens.output = output;
      if (cacheRead !== null) tokens.cache_read = cacheRead;
      if (cacheWrite !== null) tokens.cache_creation = cacheWrite;
      if (total !== null) tokens.total = total;
      if (Object.keys(tokens).length === 0) return;

      const costRaw = (stats as any).cost;
      const costTotal = typeof costRaw === 'number' && Number.isFinite(costRaw) && costRaw >= 0 ? costRaw : null;

      this.emitMessage({
        type: 'token-count',
        key: `pi:${rawKey}`,
        tokens,
        ...(costTotal !== null ? { cost: { total: costTotal } } : {}),
      } as any);
    } catch {
      // best-effort
    }
  }

  private handleStderrLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.emitMessage({ type: 'terminal-output', data: trimmed });

    const normalized = trimmed.toLowerCase();
    if (normalized.includes('api key') || normalized.includes('unauthorized') || normalized.includes('authentication')) {
      this.emitMessage({
        type: 'status',
        status: 'error',
        detail: 'Pi authentication error. Check your API credentials for the configured provider.',
      });
    }
  }

  private emitMessage(message: AgentMessage): void {
    const safeMessage: AgentMessage =
      message.type === 'terminal-output'
        ? ({ ...message, data: redactBugReportSensitiveText(String(message.data ?? '')) } as AgentMessage)
        : message;

    for (const handler of this.messageHandlers) {
      try {
        handler(safeMessage);
      } catch (error) {
        logger.debug('[pi] Message handler failed (non-fatal)', error);
      }
    }
  }

  private async sendCommand(
    command: PiRpcCommandWithoutId,
    timeoutMs = 30_000,
  ): Promise<PiRpcResponse> {
    await this.ensureProcess();
    const child = this.process;
    if (!child?.stdin) {
      throw new Error('Pi process stdin is unavailable');
    }

    const id = randomUUID();
    const payload: PiRpcCommand = { ...command, id } as PiRpcCommand;
    const encoded = JSON.stringify(payload);

    const response = await new Promise<PiRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        this.openPromptRequestIds.delete(id);
        reject(new Error(`Timed out waiting for Pi RPC response (${command.type})`));
      }, timeoutMs);
      timeout.unref?.();

      this.pendingRequests.set(id, { resolve, reject, timeout, commandType: command.type });
      child.stdin.write(`${encoded}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        this.openPromptRequestIds.delete(id);
        reject(new Error(`Failed to write Pi RPC command (${command.type}): ${error.message}`));
      });
    });

    return response;
  }

  private createPendingTurn(timeoutMs: number): Promise<void> {
    this.rejectPendingTurn(new Error('replaced by newer turn'));
    let resolveTurn: (() => void) | null = null;
    let rejectTurn: ((error: Error) => void) | null = null;

    const promise = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });

    const timeout = setTimeout(() => {
      if (this.pendingTurn?.timeout === timeout) {
        this.pendingTurn = null;
      }
      this.openPromptRequestIds.clear();
      rejectTurn?.(new Error('Timed out waiting for Pi turn completion'));
    }, timeoutMs);
    timeout.unref?.();

    if (!resolveTurn || !rejectTurn) {
      clearTimeout(timeout);
      throw new Error('Failed to initialize Pi pending turn');
    }

    this.pendingTurn = { promise, resolve: resolveTurn, reject: rejectTurn, timeout };
    return promise;
  }

  private resolvePendingTurn(): void {
    if (!this.pendingTurn) return;
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    clearTimeout(pending.timeout);
    this.openPromptRequestIds.clear();
    pending.resolve();
  }

  private rejectPendingTurn(error: Error): void {
    if (!this.pendingTurn) return;
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    clearTimeout(pending.timeout);
    this.openPromptRequestIds.clear();
    pending.reject(error);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private async getState(): Promise<PiRpcStateData> {
    const response = await this.sendCommand({ type: 'get_state' }, 30_000);
    return (asRecord(response.data) ?? {}) as PiRpcStateData;
  }

  private async getAvailableModels(): Promise<PiRpcModelsData> {
    const response = await this.sendCommand({ type: 'get_available_models' }, 60_000);
    return (asRecord(response.data) ?? {}) as PiRpcModelsData;
  }

  private async getSessionStats(): Promise<PiRpcSessionStatsData> {
    const response = await this.sendCommand({ type: 'get_session_stats' }, 30_000);
    return (asRecord(response.data) ?? {}) as PiRpcSessionStatsData;
  }

  private async getCommands(): Promise<PiRpcCommandsData> {
    const response = await this.sendCommand({ type: 'get_commands' }, 30_000);
    return (asRecord(response.data) ?? {}) as PiRpcCommandsData;
  }

  private async publishRuntimeState(state: PiRpcStateData): Promise<void> {
    const modelRecord = asRecord(state.model);
    const currentModelId = asNonEmptyString(modelRecord?.id) ?? '';
    const currentModelProvider = asNonEmptyString(modelRecord?.provider);
    if (currentModelProvider) {
      this.currentModelProvider = currentModelProvider;
    }

    const available = await this.getAvailableModels();
    const models = Array.isArray(available.models) ? available.models : [];
    this.modelProviderById.clear();
    const normalized = models
      .map((entry) => {
        const model = asRecord(entry);
        const id = asNonEmptyString(model?.id);
        const provider = asNonEmptyString(model?.provider);
        if (!id || !provider) return null;
        const name = asNonEmptyString(model?.name) ?? `${provider}/${id}`;
        this.modelProviderById.set(id, provider);
        this.modelProviderById.set(`${provider}/${id}`, provider);
        return { id, name, description: provider };
      })
      .filter((entry): entry is { id: string; name: string; description: string } => entry !== null);

    this.sessionModelState = {
      currentModelId,
      availableModels: normalized,
    };

    this.emitMessage({
      type: 'event',
      name: 'session_models_state',
      payload: {
        currentModelId,
        availableModels: normalized,
      },
    });

    const commands = await this.getCommands();
    const commandList = Array.isArray(commands.commands) ? commands.commands : [];
    const availableCommands = commandList
      .map((entry) => {
        const item = asRecord(entry);
        const name = asNonEmptyString(item?.name);
        if (!name) return null;
        const description = asNonEmptyString(item?.description) ?? undefined;
        return {
          command: name.startsWith('/') ? name : `/${name}`,
          ...(description ? { description } : {}),
        };
      })
      .filter((entry): entry is { command: string; description?: string } => entry !== null);

    this.emitMessage({
      type: 'event',
      name: 'available_commands_update',
      payload: { availableCommands },
    });
  }

  private async resolveModelSelection(modelIdRaw: string): Promise<{ provider: string; modelId: string }> {
    if (modelIdRaw.includes('/')) {
      const [provider, ...rest] = modelIdRaw.split('/');
      const modelId = rest.join('/').trim();
      const normalizedProvider = provider.trim();
      if (normalizedProvider && modelId) {
        this.modelProviderById.set(modelId, normalizedProvider);
        this.modelProviderById.set(`${normalizedProvider}/${modelId}`, normalizedProvider);
        return { provider: normalizedProvider, modelId };
      }
    }

    const fromKnownMap = this.modelProviderById.get(modelIdRaw);
    if (fromKnownMap) {
      return { provider: fromKnownMap, modelId: modelIdRaw };
    }

    if (this.currentModelProvider) {
      return { provider: this.currentModelProvider, modelId: modelIdRaw };
    }

    const state = await this.getState();
    const model = asRecord(state.model);
    const provider = asNonEmptyString(model?.provider);
    if (provider) {
      this.currentModelProvider = provider;
      return { provider, modelId: modelIdRaw };
    }

    throw new Error(`Cannot resolve Pi provider for model "${modelIdRaw}"`);
  }

  private assertSession(sessionId: SessionId): void {
    if (!this.sessionId) {
      throw new Error('Pi session was not started');
    }
    if (this.sessionId !== sessionId) {
      throw new Error(`Pi session mismatch (expected ${this.sessionId}, got ${sessionId})`);
    }
  }

}
