import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { buildOpenAiChatCompletionRequest, parseOpenAiChatCompletionAssistantText, type OpenAiCompatChatMessage } from '@/voice/local/openaiCompatChat';
import { fetchWithTimeout, resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import { extractVoiceActionsFromAssistantText, type VoiceAssistantAction } from '@happier-dev/protocol';
import { buildLocalVoiceAgentSystemPrompt } from '@happier-dev/agents';

import type { VoiceAgentClient, VoiceAgentStartParams, VoiceAgentStartResult, VoiceAgentTurnStreamEvent } from './types';

type VoiceAgentState = {
  sessionId: string;
  chatModelId: string;
  commitModelId: string;
  messages: OpenAiCompatChatMessage[];
  temperature: number;
  maxTokens: number | null;
  apiKey: string | null;
  baseUrl: string;
};

export class OpenAiCompatVoiceAgentClient implements VoiceAgentClient {
  private readonly voiceAgents = new Map<string, VoiceAgentState>();
  private readonly streams = new Map<string, { sessionId: string; voiceAgentId: string; events: VoiceAgentTurnStreamEvent[]; done: boolean }>();
  private static readonly MAX_TURNS_IN_MEMORY = 24;
  private static readonly STREAM_DELTA_CHUNK_CHARS = 180;

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
    const cfg = settings?.voice?.adapters?.local_conversation?.agent?.openaiCompat ?? null;
    const baseUrl = String(cfg?.chatBaseUrl ?? '').trim();
    if (!baseUrl) throw new Error('missing_chat_base_url');

    const apiKey = cfg?.chatApiKey ? (sync.decryptSecretValue(cfg.chatApiKey) ?? null) : null;
    const temperatureRaw = cfg?.temperature;
    const temperature = typeof temperatureRaw === 'number' && Number.isFinite(temperatureRaw) ? temperatureRaw : 0.4;
    const maxTokensRaw = cfg?.maxTokens;
    const maxTokens = typeof maxTokensRaw === 'number' && Number.isFinite(maxTokensRaw) ? Math.floor(maxTokensRaw) : null;

    const voiceAgentId =
      typeof (globalThis as any)?.crypto?.randomUUID === 'function'
        ? (globalThis as any).crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const verbosity = params.verbosity === 'balanced' ? 'balanced' : 'short';
    const system: OpenAiCompatChatMessage = {
      role: 'system',
      content: [buildLocalVoiceAgentSystemPrompt({ verbosity, sessionId: params.sessionId }), '', params.initialContext].join('\n'),
    };

    this.voiceAgents.set(voiceAgentId, {
      sessionId: params.sessionId,
      chatModelId: params.chatModelId,
      commitModelId: params.commitModelId,
      messages: [system],
      temperature: Math.max(0, Math.min(2, temperature)),
      maxTokens,
      apiKey,
      baseUrl,
    });

    return { voiceAgentId, effective: { chatModelId: params.chatModelId, commitModelId: params.commitModelId, permissionPolicy: params.permissionPolicy } };
  }

  async sendTurn(
    params: Readonly<{ sessionId: string; voiceAgentId: string; userText: string }>,
  ): Promise<{ assistantText: string; actions?: VoiceAssistantAction[] }> {
    const state = this.voiceAgents.get(params.voiceAgentId);
    if (!state || state.sessionId !== params.sessionId) throw new Error('VOICE_AGENT_NOT_FOUND');
    const timeoutMs = resolveVoiceNetworkTimeoutMs(
      (storage.getState().settings as any)?.voice?.adapters?.local_conversation?.networkTimeoutMs,
      15_000,
    );

    const userMessage: OpenAiCompatChatMessage = { role: 'user', content: params.userText };
    const req = buildOpenAiChatCompletionRequest({
      baseUrl: state.baseUrl,
      apiKey: state.apiKey,
      model: state.chatModelId,
      messages: [...state.messages, userMessage],
      temperature: state.temperature,
      maxTokens: state.maxTokens,
    });

    const res = await fetchWithTimeout(req.url, req.init, timeoutMs, 'chat_timeout');
    if (!res.ok) throw new Error('chat_failed');
    const assistantTextRaw = await parseOpenAiChatCompletionAssistantText(res);
    const extracted = extractVoiceActionsFromAssistantText(assistantTextRaw);
    const assistantText = extracted.assistantText;
    state.messages.push(userMessage);
    state.messages.push({ role: 'assistant', content: assistantText });
    state.messages = this.capMessages(state.messages);
    return extracted.actions.length > 0 ? { assistantText, actions: extracted.actions } : { assistantText };
  }

  async welcome(_params: Readonly<{ sessionId: string; voiceAgentId: string; welcomeText?: string }>): Promise<{ assistantText: string }> {
    // OpenAI-compatible mode does not have a daemon-side bootstrap action.
    return { assistantText: '' };
  }

  async startTurnStream(params: Readonly<{ sessionId: string; voiceAgentId: string; userText: string; resume?: boolean }>): Promise<{ streamId: string }> {
    const streamId =
      typeof (globalThis as any)?.crypto?.randomUUID === 'function'
        ? (globalThis as any).crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const events: VoiceAgentTurnStreamEvent[] = [];
    try {
      const { assistantText, actions } = await this.sendTurn(params);
      for (let i = 0; i < assistantText.length; i += OpenAiCompatVoiceAgentClient.STREAM_DELTA_CHUNK_CHARS) {
        const textDelta = assistantText.slice(i, i + OpenAiCompatVoiceAgentClient.STREAM_DELTA_CHUNK_CHARS);
        if (!textDelta) continue;
        events.push({ t: 'delta', textDelta });
      }
      events.push(actions && actions.length > 0 ? { t: 'done', assistantText, actions } : { t: 'done', assistantText });
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
    const timeoutMs = resolveVoiceNetworkTimeoutMs((storage.getState().settings as any).voiceLocalNetworkTimeoutMs, 15_000);

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

    const req = buildOpenAiChatCompletionRequest({
      baseUrl: state.baseUrl,
      apiKey: state.apiKey,
      model: state.commitModelId,
      messages: commitMessages,
      temperature: 0.2,
      maxTokens: state.maxTokens,
    });

    const res = await fetchWithTimeout(req.url, req.init, timeoutMs, 'commit_timeout');
    if (!res.ok) throw new Error('commit_failed');
    const commitText = await parseOpenAiChatCompletionAssistantText(res);
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
    // Best-effort only; many OSS servers do not implement /v1/models.
    return { availableModels: [], supportsFreeform: true };
  }
}
