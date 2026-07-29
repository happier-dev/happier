import { storage } from '@/sync/domains/state/storage';
import { extractVoiceActionsFromAssistantText, type VoiceAssistantAction } from '@happier-dev/protocol';
import { buildLocalVoiceAgentSystemPrompt } from '@happier-dev/agents';
import { resolveDisabledVoiceActionIdsFromState } from '@/voice/tools/resolveDisabledVoiceActionIds';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveUiMemoryRecallGuidanceEnabled } from '@/sync/domains/memory/resolveUiMemoryRecallGuidanceEnabled';
import { resolveUiVoicePromptStackBlocks } from '@/voice/agent/resolveUiVoicePromptStackBlocks';
import { readLocalConversationSettingsFromAccountSettings } from '@/voice/local/localVoiceSettings';
import { OpenAiCompatDaemonClient } from '@/voice/local/openaiCompat/client';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

import type { VoiceAgentClient, VoiceAgentStartParams, VoiceAgentStartResult, VoiceAgentTurnStreamEvent } from './types';

type OpenAiCompatChatMessage = Readonly<{
  role: 'system' | 'user' | 'assistant';
  content: string;
}>;

type VoiceAgentState = {
  sessionId: string;
  chatModelId: string;
  commitModelId: string;
  messages: OpenAiCompatChatMessage[];
  temperature: number;
  maxTokens: number | null;
  baseUrl: string;
  insecureLocalOriginConsent: string | null;
  insecureLocalConsentMachineId: string | null;
};

export class OpenAiCompatVoiceAgentClient implements VoiceAgentClient {
  private readonly daemonClient: Pick<OpenAiCompatDaemonClient, 'chat' | 'listModels'>;
  private readonly voiceAgents = new Map<string, VoiceAgentState>();
  private readonly streams = new Map<string, { sessionId: string; voiceAgentId: string; events: VoiceAgentTurnStreamEvent[]; done: boolean }>();
  private static readonly MAX_TURNS_IN_MEMORY = 24;
  private static readonly STREAM_DELTA_CHUNK_CHARS = 180;

  constructor(options?: Readonly<{ daemonClient?: Pick<OpenAiCompatDaemonClient, 'chat' | 'listModels'> }>) {
    this.daemonClient = options?.daemonClient ?? new OpenAiCompatDaemonClient();
  }

  private capMessages(messages: OpenAiCompatChatMessage[]): OpenAiCompatChatMessage[] {
    if (messages.length <= 1) return messages;
    const system = messages[0];
    const tail = messages.slice(1);
    const maxTail = OpenAiCompatVoiceAgentClient.MAX_TURNS_IN_MEMORY * 2;
    if (tail.length <= maxTail) return messages;
    return [system, ...tail.slice(tail.length - maxTail)];
  }

  async start(params: VoiceAgentStartParams): Promise<VoiceAgentStartResult> {
    const settings: any = storage.getState().settings;
    const localConversation = readLocalConversationSettingsFromAccountSettings(settings);
    const cfg = localConversation.agent.openaiCompat;
    const baseUrl = String(cfg?.chatBaseUrl ?? '').trim();
    if (!baseUrl) throw new Error('missing_chat_base_url');

    const temperatureRaw = cfg?.temperature;
    const temperature = typeof temperatureRaw === 'number' && Number.isFinite(temperatureRaw) ? temperatureRaw : 0.4;
    const maxTokensRaw = cfg?.maxTokens;
    const maxTokens = typeof maxTokensRaw === 'number' && Number.isFinite(maxTokensRaw) ? Math.floor(maxTokensRaw) : null;

    const voiceAgentId =
      typeof (globalThis as any)?.crypto?.randomUUID === 'function'
        ? (globalThis as any).crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const verbosity = params.verbosity === 'balanced' ? 'balanced' : 'short';
    const disabledActionIds = Array.isArray(params.disabledActionIds)
      ? params.disabledActionIds
      : resolveDisabledVoiceActionIdsFromState(storage.getState() as any);
    const sessionMetadata = readVoiceSessionOwnerMetadataFromState(storage.getState() as any, params.sessionId);
    const memoryRecallGuidanceEnabled = await resolveUiMemoryRecallGuidanceEnabled({
      settings,
      serverId: getActiveServerSnapshot().serverId,
      machineId: typeof sessionMetadata?.machineId === 'string' ? sessionMetadata.machineId : null,
      surfaces: ['voice'],
    });
    const systemAppendBlocks = await resolveUiVoicePromptStackBlocks({
      profileId: params.profileId ?? null,
    });
    const system: OpenAiCompatChatMessage = {
      role: 'system',
      content: [buildLocalVoiceAgentSystemPrompt({
        verbosity,
        sessionId: params.sessionId,
        disabledActionIds,
        memoryRecallGuidanceEnabled,
        extraSystemAppendBlocks: systemAppendBlocks,
      }), '', params.initialContext].join('\n'),
    };

    this.voiceAgents.set(voiceAgentId, {
      sessionId: params.sessionId,
      chatModelId: params.chatModelId,
      commitModelId: params.commitModelId,
      messages: [system],
      temperature: Math.max(0, Math.min(2, temperature)),
      maxTokens,
      baseUrl,
      insecureLocalOriginConsent: cfg?.insecureLocalOriginConsent ?? null,
      insecureLocalConsentMachineId: cfg?.insecureLocalConsentMachineId ?? null,
    });

    return { voiceAgentId, effective: { chatModelId: params.chatModelId, commitModelId: params.commitModelId, permissionIntent: params.permissionIntent } };
  }

  async sendTurn(
    params: Readonly<{ sessionId: string; voiceAgentId: string; userText: string; displayUserText?: string }>,
  ): Promise<{ assistantText: string; actions?: VoiceAssistantAction[] }> {
    const state = this.voiceAgents.get(params.voiceAgentId);
    if (!state || state.sessionId !== params.sessionId) throw new Error('VOICE_AGENT_NOT_FOUND');
    const userMessage: OpenAiCompatChatMessage = { role: 'user', content: params.userText };
    let assistantTextRaw: string;
    try {
      assistantTextRaw = await this.daemonClient.chat({
        baseUrl: state.baseUrl,
        insecureLocalOriginConsent: state.insecureLocalOriginConsent,
        insecureLocalConsentMachineId: state.insecureLocalConsentMachineId,
        credentialKind: 'chat_api_key',
        model: state.chatModelId,
        messages: [...state.messages, userMessage],
        temperature: state.temperature,
        ...(state.maxTokens !== null ? { maxTokens: state.maxTokens } : {}),
      });
    } catch {
      throw new Error('chat_failed');
    }
    const extracted = extractVoiceActionsFromAssistantText(assistantTextRaw);
    const assistantText = extracted.assistantText;
    state.messages.push(userMessage);
    state.messages.push({ role: 'assistant', content: assistantText });
    state.messages = this.capMessages(state.messages);
    return extracted.actions.length > 0 ? { assistantText, actions: extracted.actions } : { assistantText };
  }

  async commitUserTranscript(_params: Readonly<{
    sessionId: string;
    voiceAgentId: string;
    text: string;
    displayText?: string;
    localId: string;
  }>): Promise<{ ok: true }> {
    // The OpenAI-compatible backend is UI-owned and does not write a daemon transcript.
    return { ok: true };
  }

  async welcome(_params: Readonly<{ sessionId: string; voiceAgentId: string; welcomeText?: string }>): Promise<{ assistantText: string }> {
    const state = this.voiceAgents.get(_params.voiceAgentId);
    if (!state || state.sessionId !== _params.sessionId) throw new Error('VOICE_AGENT_NOT_FOUND');
    const override = typeof _params.welcomeText === 'string' ? _params.welcomeText.trim() : '';
    const assistantText = override || 'Hey! What are we working on today?';
    state.messages.push({ role: 'assistant', content: assistantText });
    state.messages = this.capMessages(state.messages);
    return { assistantText };
  }

  async startTurnStream(params: Readonly<{ sessionId: string; voiceAgentId: string; userText: string; displayUserText?: string; resume?: boolean }>): Promise<{ streamId: string }> {
    const streamId =
      typeof (globalThis as any)?.crypto?.randomUUID === 'function'
        ? (globalThis as any).crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const events: VoiceAgentTurnStreamEvent[] = [];
    try {
      const { assistantText, actions } = await this.sendTurn(params);
      let outputSeq = 0;
      let segmentIndex = 0;
      for (let i = 0; i < assistantText.length; i += OpenAiCompatVoiceAgentClient.STREAM_DELTA_CHUNK_CHARS) {
        const textDelta = assistantText.slice(i, i + OpenAiCompatVoiceAgentClient.STREAM_DELTA_CHUNK_CHARS);
        if (!textDelta) continue;
        events.push({
          t: 'voice_output',
          output: {
            v: 1,
            kind: 'speech_segment',
            turnId: streamId,
            seq: outputSeq,
            segmentId: `${streamId}:segment:${segmentIndex}`,
            text: textDelta,
          },
        });
        outputSeq += 1;
        segmentIndex += 1;
      }
      for (const [actionIndex, action] of (actions ?? []).entries()) {
        events.push({
          t: 'voice_output',
          output: {
            v: 1,
            kind: 'side_effect',
            turnId: streamId,
            seq: outputSeq,
            effectId: `${streamId}:effect:${actionIndex}`,
            action,
          },
        });
        outputSeq += 1;
      }
      events.push({
        t: 'voice_output',
        output: { v: 1, kind: 'turn_final', turnId: streamId, seq: outputSeq, text: assistantText },
      });
    } catch (error) {
      events.push({
        t: 'error',
        error: error instanceof Error ? error.message : 'stream_failed',
      });
    }
    this.streams.set(streamId, {
      sessionId: params.sessionId,
      voiceAgentId: params.voiceAgentId,
      events,
      done: true,
    });
    return { streamId };
  }

  async readTurnStream(
    params: Readonly<{ sessionId: string; voiceAgentId: string; streamId: string; cursor: number; maxEvents?: number }>,
  ): Promise<{ streamId: string; events: VoiceAgentTurnStreamEvent[]; nextCursor: number; done: boolean }> {
    const stream = this.streams.get(params.streamId);
    if (!stream || stream.sessionId !== params.sessionId || stream.voiceAgentId !== params.voiceAgentId) {
      throw new Error('VOICE_AGENT_NOT_FOUND');
    }
    const cursor = Number.isFinite(params.cursor) && params.cursor >= 0 ? Math.floor(params.cursor) : 0;
    const maxEvents =
      typeof params.maxEvents === 'number' && Number.isFinite(params.maxEvents) && params.maxEvents > 0
        ? Math.min(128, Math.floor(params.maxEvents))
        : 32;
    const end = Math.min(stream.events.length, cursor + maxEvents);
    const events = stream.events.slice(cursor, end);
    const done = stream.done && end >= stream.events.length;
    if (done) {
      this.streams.delete(params.streamId);
    }
    return {
      streamId: params.streamId,
      events,
      nextCursor: end,
      done,
    };
  }

  async cancelTurnStream(params: Readonly<{ sessionId: string; voiceAgentId: string; streamId: string }>): Promise<{ ok: true }> {
    const stream = this.streams.get(params.streamId);
    if (!stream || stream.sessionId !== params.sessionId || stream.voiceAgentId !== params.voiceAgentId) {
      throw new Error('VOICE_AGENT_NOT_FOUND');
    }
    this.streams.delete(params.streamId);
    return { ok: true };
  }

  async commit(params: Readonly<{ sessionId: string; voiceAgentId: string; kind: 'session_instruction'; maxChars?: number }>): Promise<{ commitText: string }> {
    const state = this.voiceAgents.get(params.voiceAgentId);
    if (!state || state.sessionId !== params.sessionId) throw new Error('VOICE_AGENT_NOT_FOUND');
    const maxChars = typeof params.maxChars === 'number' && Number.isFinite(params.maxChars) ? Math.floor(params.maxChars) : 4000;
    const commitMessages: OpenAiCompatChatMessage[] = [
      ...state.messages,
      {
        role: 'user',
        content: [
          'Based on the conversation so far, write ONE instruction message for an AI coding agent.',
          `Return ONLY the instruction text (no preamble). Max ${maxChars} characters.`,
        ].join('\n'),
      },
    ];

    let commitText: string;
    try {
      commitText = await this.daemonClient.chat({
        baseUrl: state.baseUrl,
        insecureLocalOriginConsent: state.insecureLocalOriginConsent,
        insecureLocalConsentMachineId: state.insecureLocalConsentMachineId,
        credentialKind: 'chat_api_key',
        model: state.commitModelId,
        messages: commitMessages,
        temperature: 0.2,
        ...(state.maxTokens !== null ? { maxTokens: state.maxTokens } : {}),
      });
    } catch {
      throw new Error('commit_failed');
    }
    if (!commitText) throw new Error('commit_empty_response');
    return { commitText };
  }

  async stop(params: Readonly<{ sessionId: string; voiceAgentId: string }>): Promise<{ ok: true }> {
    const state = this.voiceAgents.get(params.voiceAgentId);
    if (!state || state.sessionId !== params.sessionId) throw new Error('VOICE_AGENT_NOT_FOUND');
    this.voiceAgents.delete(params.voiceAgentId);
    for (const [streamId, stream] of this.streams.entries()) {
      if (stream.sessionId === params.sessionId && stream.voiceAgentId === params.voiceAgentId) {
        this.streams.delete(streamId);
      }
    }
    return { ok: true };
  }

  async getModels(_params: Readonly<{ sessionId: string }>): Promise<{ availableModels: Array<{ id: string; name: string; description?: string }>; supportsFreeform: boolean }> {
    const cfg = readLocalConversationSettingsFromAccountSettings(storage.getState().settings).agent.openaiCompat;
    const baseUrl = String(cfg?.chatBaseUrl ?? '').trim();
    if (!baseUrl) return { availableModels: [], supportsFreeform: true };
    try {
      const models = await this.daemonClient.listModels({
        baseUrl,
        insecureLocalOriginConsent: cfg?.insecureLocalOriginConsent ?? null,
        insecureLocalConsentMachineId: cfg?.insecureLocalConsentMachineId ?? null,
        credentialKind: 'chat_api_key',
      });
      return {
        availableModels: models.map(({ id }) => ({ id, name: id })),
        supportsFreeform: true,
      };
    } catch {
      return { availableModels: [], supportsFreeform: true };
    }
  }
}
