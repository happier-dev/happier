import { randomUUID } from 'node:crypto';

import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import {
  type HostSessionRuntimeLifecycleHooks,
  type HostSessionRuntimeRunOptions,
  type HostSessionRuntimeConfig,
} from '@/agent/runtime/session/loop/runHostSessionRuntime';
import {
  HOST_SESSION_RUNTIME_PLAN_KIND,
  type HostSessionRuntimePlan,
} from '@/agent/runtime/session/loop/lifecycle';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { logger } from '@/ui/logger';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createGeminiAcpRuntime } from '@/backends/gemini/acp/runtime';
import { DEFAULT_GEMINI_MODEL } from '@/backends/gemini/constants';
import { GeminiTerminalDisplay } from '@/backends/gemini/ui/GeminiTerminalDisplay';
import { readGeminiLocalConfig } from '@/backends/gemini/utils/config';
import { parseOptionsFromText } from '@/backends/gemini/utils/optionsParser';

async function resolveCurrentUserEmailBestEffort(credentials: HostSessionRuntimeRunOptions['credentials']): Promise<string | null> {
  try {
    const api = await ApiClient.create(credentials);
    const records = await resolveConnectedServiceCredentials({
      credentials,
      api,
      bindings: [{ serviceId: 'gemini', profileId: 'default' }],
    });
    const record = records.get('gemini');
    if (record?.kind === 'oauth' && record.oauth.idToken) {
      const payload = decodeJwtPayload(record.oauth.idToken);
      const email = payload && typeof payload.email === 'string' ? payload.email : null;
      return email ?? null;
    }
  } catch (error) {
    logger.debug('[gemini] Failed to fetch connected-services metadata (non-fatal):', error);
  }
  return null;
}

function resolveInitialModelSelection(): { modelId?: string; modelUpdatedAt?: number } | null {
  try {
    const local = readGeminiLocalConfig();
    if (typeof local.model === 'string' && local.model.trim().length > 0) {
      return { modelId: local.model.trim(), modelUpdatedAt: Date.now() };
    }
  } catch {
    // ignore
  }

  return { modelId: DEFAULT_GEMINI_MODEL, modelUpdatedAt: Date.now() };
}

function extractLastAssistantTextFromBuffer(messageBuffer: MessageBuffer): string | null {
  const messages = messageBuffer.getMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === 'assistant') {
      const trimmed = String(m.content ?? '').trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return null;
}

export function createGeminiSessionRuntimePlan(opts: HostSessionRuntimeRunOptions): HostSessionRuntimePlan {
  let sessionRuntimeForSwap: Readonly<{ isTurnInFlight?: () => boolean }> | null = null;
  let messageBufferRef: MessageBuffer | null = null;

  const lifecycleHooks: HostSessionRuntimeLifecycleHooks = {
    resolveInitialModelSelection: ({ opts: runOpts }) => {
      const explicit = typeof runOpts.modelId === 'string' ? runOpts.modelId.trim() : '';
      if (explicit.length > 0) return null;
      return resolveInitialModelSelection();
    },
    createSessionSwapStrategy: ({ applySessionSwap }) => {
      let pending: ApiSessionClient | null = null;
      return {
        requestSessionSwap: async ({ nextSession, applyImmediately }) => {
          const inFlight = sessionRuntimeForSwap?.isTurnInFlight?.() === true;
          if (inFlight) {
            pending = nextSession;
            return;
          }
          pending = null;
          await applyImmediately();
        },
        flushPendingSessionSwap: async () => {
          if (!pending) return;
          const next = pending;
          pending = null;
          await applySessionSwap(next);
        },
      };
    },
    onRuntimeCreated: ({ runtime }) => {
      sessionRuntimeForSwap = runtime;
    },
    onAfterLoopBoundary: ({ reason, session }) => {
      if (reason !== 'turn_completed') return;
      const buffer = messageBufferRef;
      if (!buffer) return;

      const text = extractLastAssistantTextFromBuffer(buffer);
      if (!text) return;

      const parsed = parseOptionsFromText(text);
      if (!parsed.options || parsed.options.length === 0) return;

      // Keep terminal UI cleaner: replace the last assistant message without the options block.
      buffer.removeLastMessage('assistant');
      buffer.addMessage(parsed.text, 'assistant');

      const payload: Parameters<ApiSessionClient['sendAgentMessage']>[1] = {
        type: 'message',
        message: parsed.text,
        id: randomUUID(),
        options: parsed.options,
      } as unknown as Parameters<ApiSessionClient['sendAgentMessage']>[1];
      session.sendAgentMessage('gemini', payload);
    },
    onBeforeReset: ({ reason }) => {
      logger.debug(`[gemini] Reset requested (${reason})`);
    },
  };

  return {
    kind: HOST_SESSION_RUNTIME_PLAN_KIND,
    providerId: 'gemini',
    opts,
    config: {
      flavor: 'gemini',
      policyAgentId: 'gemini',
      backendDisplayName: 'Gemini',
      uiLogPrefix: '[Gemini]',
      providerName: 'Gemini',
      waitingForCommandLabel: 'Gemini',
      agentMessageType: 'gemini',
      machineMetadata: initialMachineMetadata,
      terminalDisplay: GeminiTerminalDisplay as unknown as HostSessionRuntimeConfig['terminalDisplay'],
      lifecycleHooks,
      createSessionRuntime: async ({
          directory,
          machineId,
          session,
          transcriptSession,
          messageBuffer,
          mcpServers,
          permissionHandler,
          setThinking,
          getPermissionMode,
          memoryRecallGuidanceEnabled,
          accountSettings,
          pendingQueueDrainMaxPopPerWake,
        }) => {
          const currentUserEmail = await resolveCurrentUserEmailBestEffort(opts.credentials);
          messageBufferRef = messageBuffer;
          const nativeRuntime = createGeminiAcpRuntime({
            directory,
            machineId,
            session,
            transcriptSession,
            messageBuffer,
            mcpServers,
            permissionHandler,
            onThinkingChange: setThinking,
            memoryRecallGuidanceEnabled,
            accountSettings,
            pendingQueueDrainMaxPopPerWake,
            getPermissionMode,
            backendOptions: {
              ...(currentUserEmail ? { currentUserEmail } : {}),
              ...(typeof opts.modelId === 'string' && opts.modelId.trim().length > 0 ? { model: opts.modelId.trim() } : {}),
            },
          });
          sessionRuntimeForSwap = nativeRuntime;
          return {
            operations: nativeRuntime,
            nativeRuntime,
          };
        },
      onAttachMetadataSnapshotMissing: (error) => {
        logger.debug(
          '[gemini] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal):',
          error ?? undefined,
        );
      },
      formatPromptErrorMessage: (error) => formatProviderPromptErrorMessage(error, {
        authHint: 'If this is an auth error, verify your Gemini CLI login and any GEMINI_API_KEY/GOOGLE_API_KEY settings.',
      }),
    },
  };
}
