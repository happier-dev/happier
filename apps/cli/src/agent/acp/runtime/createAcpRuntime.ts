import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import type { AgentBackend, AgentMessage, McpServerConfig } from '@/agent';
import type { ApiSessionClient } from '@/api/apiSession';
import type { CatalogAgentId } from '@/backends/types';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import {
  handleAcpModelOutputDelta,
  handleAcpStatusRunning,
  forwardAcpPermissionRequest,
  forwardAcpTerminalOutput,
} from '@/agent/acp/bridge/acpCommonHandlers';
import { normalizeAvailableCommands, publishSlashCommandsToMetadata } from '@/agent/acp/commands/publishSlashCommands';
import { importAcpReplayHistoryV1 } from '@/agent/acp/history/importAcpReplayHistory';

export type AcpRuntime = Readonly<{
  getSessionId: () => string | null;
  beginTurn: () => void;
  cancel: () => Promise<void>;
  reset: () => Promise<void>;
  startOrLoad: (opts: { resumeId?: string | null }) => Promise<string>;
  sendPrompt: (prompt: string) => Promise<void>;
  flushTurn: () => void;
}>;

export function createAcpRuntime(params: {
  provider: CatalogAgentId;
  directory: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  ensureBackend: () => Promise<AgentBackend>;
  /**
   * Optional hook to publish vendor session id metadata after start/load/prompt.
   */
  onSessionIdChange?: (sessionId: string | null) => void;
}): AcpRuntime {
  let backend: AgentBackend | null = null;
  let sessionId: string | null = null;

  let accumulatedResponse = '';
  let isResponseInProgress = false;
  let taskStartedSent = false;
  let turnAborted = false;
  let loadingSession = false;

  const resetTurnState = () => {
    accumulatedResponse = '';
    isResponseInProgress = false;
    taskStartedSent = false;
    turnAborted = false;
  };

  const publishSessionId = () => {
    params.onSessionIdChange?.(sessionId);
  };

  const attachMessageHandler = (b: AgentBackend) => {
    b.onMessage((msg: AgentMessage) => {
      if (loadingSession) {
        if (msg.type === 'status' && msg.status === 'error') {
          turnAborted = true;
          params.session.sendAgentMessage(params.provider, { type: 'turn_aborted', id: randomUUID() });
        }
        return;
      }

      switch (msg.type) {
        case 'model-output': {
          handleAcpModelOutputDelta({
            delta: msg.textDelta ?? '',
            messageBuffer: params.messageBuffer,
            getIsResponseInProgress: () => isResponseInProgress,
            setIsResponseInProgress: (value) => { isResponseInProgress = value; },
            appendToAccumulatedResponse: (delta) => { accumulatedResponse += delta; },
          });
          break;
        }

        case 'status': {
          if (msg.status === 'running') {
            handleAcpStatusRunning({
              session: params.session,
              agent: params.provider,
              messageBuffer: params.messageBuffer,
              onThinkingChange: params.onThinkingChange,
              getTaskStartedSent: () => taskStartedSent,
              setTaskStartedSent: (value) => { taskStartedSent = value; },
              makeId: () => randomUUID(),
            });
          }

          if (msg.status === 'error') {
            turnAborted = true;
            params.session.sendAgentMessage(params.provider, { type: 'turn_aborted', id: randomUUID() });
          }
          break;
        }

        case 'tool-call': {
          params.messageBuffer.addMessage(`Executing: ${msg.toolName}`, 'tool');
          params.session.sendAgentMessage(params.provider, {
            type: 'tool-call',
            callId: msg.callId,
            name: msg.toolName,
            input: msg.args,
            id: randomUUID(),
          });
          break;
        }

        case 'tool-result': {
          const maybeStream =
            msg.result
            && typeof msg.result === 'object'
            && !Array.isArray(msg.result)
            && (typeof (msg.result as any).stdoutChunk === 'string' || (msg.result as any)._stream === true);
          if (!maybeStream) {
            const outputText = typeof msg.result === 'string'
              ? msg.result
              : JSON.stringify(msg.result ?? '').slice(0, 200);
            params.messageBuffer.addMessage(`Result: ${outputText}`, 'result');
          }
          params.session.sendAgentMessage(params.provider, {
            type: 'tool-result',
            callId: msg.callId,
            output: msg.result,
            id: randomUUID(),
          });
          break;
        }

        case 'fs-edit': {
          params.messageBuffer.addMessage(`File edit: ${msg.description}`, 'tool');
          params.session.sendAgentMessage(params.provider, {
            type: 'file-edit',
            description: msg.description,
            diff: msg.diff,
            filePath: msg.path || 'unknown',
            id: randomUUID(),
          });
          break;
        }

        case 'terminal-output': {
          forwardAcpTerminalOutput({
            msg,
            messageBuffer: params.messageBuffer,
            session: params.session,
            agent: params.provider,
            getCallId: () => randomUUID(),
          });
          break;
        }

        case 'permission-request': {
          forwardAcpPermissionRequest({ msg, session: params.session, agent: params.provider });
          break;
        }

        case 'event': {
          const name = (msg as any).name as string | undefined;
          if (name === 'available_commands_update') {
            const payload = (msg as any).payload;
            const details = normalizeAvailableCommands(payload?.availableCommands ?? payload);
            publishSlashCommandsToMetadata({ session: params.session, details });
          }
          if (name === 'thinking') {
            const text = ((msg as any).payload?.text ?? '') as string;
            if (text) {
              params.session.sendAgentMessage(params.provider, { type: 'thinking', text });
            }
          }
          break;
        }
      }
    });
  };

  const ensureBackend = async (): Promise<AgentBackend> => {
    if (backend) return backend;
    const created = await params.ensureBackend();
    backend = created;
    attachMessageHandler(created);
    logger.debug(`[${params.provider}] ACP backend created`);
    return created;
  };

  return {
    getSessionId: () => sessionId,

    beginTurn(): void {
      turnAborted = false;
    },

    async cancel(): Promise<void> {
      if (!sessionId) return;
      const b = await ensureBackend();
      await b.cancel(sessionId);
    },

    async reset(): Promise<void> {
      sessionId = null;
      resetTurnState();
      loadingSession = false;
      publishSessionId();

      if (backend) {
        try {
          await backend.dispose();
        } catch (e) {
          logger.debug(`[${params.provider}] Failed to dispose backend (non-fatal)`, e);
        }
        backend = null;
      }
    },

    async startOrLoad(opts: { resumeId?: string | null }): Promise<string> {
      const b = await ensureBackend();

      const resumeId = typeof opts.resumeId === 'string' ? opts.resumeId.trim() : '';
      if (resumeId) {
        if (!b.loadSession && !b.loadSessionWithReplayCapture) {
          throw new Error(`${params.provider} ACP backend does not support loading sessions`);
        }

        loadingSession = true;
        let replay: unknown[] | null = null;
        try {
          if (b.loadSessionWithReplayCapture) {
            const loaded = await b.loadSessionWithReplayCapture(resumeId);
            sessionId = loaded.sessionId ?? resumeId;
            replay = Array.isArray(loaded.replay) ? loaded.replay : null;
          } else if (b.loadSession) {
            const loaded = await b.loadSession(resumeId);
            sessionId = loaded.sessionId ?? resumeId;
          } else {
            throw new Error(`${params.provider} ACP backend does not support loading sessions`);
          }
        } finally {
          loadingSession = false;
        }

        if (replay) {
          importAcpReplayHistoryV1({
            session: params.session,
            provider: params.provider,
            remoteSessionId: resumeId,
            replay: replay as any[],
            permissionHandler: params.permissionHandler,
          }).catch((e) => {
            logger.debug(`[${params.provider}] Failed to import replay history (non-fatal)`, e);
          });
        }
      } else {
        const started = await b.startSession();
        sessionId = started.sessionId;
      }

      publishSessionId();
      return sessionId!;
    },

    async sendPrompt(prompt: string): Promise<void> {
      if (!sessionId) {
        throw new Error(`${params.provider} ACP session was not started`);
      }

      const b = await ensureBackend();
      await b.sendPrompt(sessionId, prompt);
      if (b.waitForResponseComplete) {
        await b.waitForResponseComplete(120_000);
      }
      publishSessionId();
    },

    flushTurn(): void {
      if (accumulatedResponse.trim()) {
        params.session.sendAgentMessage(params.provider, { type: 'message', message: accumulatedResponse });
      }

      if (!turnAborted) {
        params.session.sendAgentMessage(params.provider, { type: 'task_complete', id: randomUUID() });
      }

      resetTurnState();
    },
  };
}

