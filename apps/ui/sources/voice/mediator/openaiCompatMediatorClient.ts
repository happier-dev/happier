import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { buildOpenAiChatCompletionRequest, parseOpenAiChatCompletionAssistantText, type OpenAiCompatChatMessage } from '@/voice/local/openaiCompatChat';

import type { VoiceMediatorClient, VoiceMediatorStartParams, VoiceMediatorStartResult } from './types';

type MediatorState = {
  sessionId: string;
  chatModelId: string;
  commitModelId: string;
  messages: OpenAiCompatChatMessage[];
  temperature: number;
  maxTokens: number | null;
  apiKey: string | null;
  baseUrl: string;
};

export class OpenAiCompatMediatorClient implements VoiceMediatorClient {
  private readonly mediators = new Map<string, MediatorState>();

  async start(params: VoiceMediatorStartParams): Promise<VoiceMediatorStartResult> {
    const settings: any = storage.getState().settings;
    const baseUrl = String(settings.voiceLocalChatBaseUrl ?? '').trim();
    if (!baseUrl) throw new Error('missing_chat_base_url');

    const apiKey = settings.voiceLocalChatApiKey ? (sync.decryptSecretValue(settings.voiceLocalChatApiKey) ?? null) : null;
    const temperatureRaw = settings.voiceLocalChatTemperature;
    const temperature = typeof temperatureRaw === 'number' && Number.isFinite(temperatureRaw) ? temperatureRaw : 0.4;
    const maxTokensRaw = settings.voiceLocalChatMaxTokens;
    const maxTokens = typeof maxTokensRaw === 'number' && Number.isFinite(maxTokensRaw) ? Math.floor(maxTokensRaw) : null;

    const mediatorId =
      typeof (globalThis as any)?.crypto?.randomUUID === 'function'
        ? (globalThis as any).crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const verbosity = params.verbosity === 'balanced' ? 'balanced' : 'short';
    const system: OpenAiCompatChatMessage = {
      role: 'system',
      content: [
        'You are a fast voice mediator for an AI coding agent.',
        verbosity === 'balanced'
          ? 'Keep replies conversational; be concise but include enough detail to be helpful.'
          : 'Keep replies short and conversational.',
        '',
        params.initialContext,
      ].join('\n'),
    };

    this.mediators.set(mediatorId, {
      sessionId: params.sessionId,
      chatModelId: params.chatModelId,
      commitModelId: params.commitModelId,
      messages: [system],
      temperature: Math.max(0, Math.min(2, temperature)),
      maxTokens,
      apiKey,
      baseUrl,
    });

    return { mediatorId, effective: { chatModelId: params.chatModelId, commitModelId: params.commitModelId, permissionPolicy: params.permissionPolicy } };
  }

  async sendTurn(params: Readonly<{ sessionId: string; mediatorId: string; userText: string }>): Promise<{ assistantText: string }> {
    const state = this.mediators.get(params.mediatorId);
    if (!state || state.sessionId !== params.sessionId) throw new Error('VOICE_MEDIATOR_NOT_FOUND');

    const userMessage: OpenAiCompatChatMessage = { role: 'user', content: params.userText };
    const req = buildOpenAiChatCompletionRequest({
      baseUrl: state.baseUrl,
      apiKey: state.apiKey,
      model: state.chatModelId,
      messages: [...state.messages, userMessage],
      temperature: state.temperature,
      maxTokens: state.maxTokens,
    });

    const res = await fetch(req.url, req.init);
    if (!res.ok) throw new Error('chat_failed');
    const assistantText = await parseOpenAiChatCompletionAssistantText(res);
    state.messages.push(userMessage);
    state.messages.push({ role: 'assistant', content: assistantText });
    return { assistantText };
  }

  async commit(params: Readonly<{ sessionId: string; mediatorId: string; kind: 'session_instruction'; maxChars?: number }>): Promise<{ commitText: string }> {
    const state = this.mediators.get(params.mediatorId);
    if (!state || state.sessionId !== params.sessionId) throw new Error('VOICE_MEDIATOR_NOT_FOUND');

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

    const res = await fetch(req.url, req.init);
    if (!res.ok) throw new Error('commit_failed');
    const commitText = await parseOpenAiChatCompletionAssistantText(res);
    if (!commitText) throw new Error('commit_empty_response');
    return { commitText };
  }

  async stop(params: Readonly<{ sessionId: string; mediatorId: string }>): Promise<{ ok: true }> {
    const state = this.mediators.get(params.mediatorId);
    if (!state || state.sessionId !== params.sessionId) throw new Error('VOICE_MEDIATOR_NOT_FOUND');
    this.mediators.delete(params.mediatorId);
    return { ok: true };
  }

  async getModels(_params: Readonly<{ sessionId: string }>): Promise<{ availableModels: Array<{ id: string; name: string; description?: string }>; supportsFreeform: boolean }> {
    // Best-effort only; many OSS servers do not implement /v1/models.
    return { availableModels: [], supportsFreeform: true };
  }
}
