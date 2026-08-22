import { buildElevenLabsVoiceAgentPrompt } from '@happier-dev/agents';
import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import type { VoiceClientToolDefinition } from '@happier-dev/plugin-sdk/voice/client';

import {
  ElevenLabsProvisionToolSchema,
  type ElevenLabsProvisionRequest,
} from '../../protocol/voice/index.js';

export type ElevenLabsTtsConfigInput = Readonly<{
  voiceId?: string | null;
  modelId?: string | null;
  voiceSettings?: Readonly<{
    stability?: number | null;
    similarityBoost?: number | null;
    speed?: number | null;
  }> | null;
}>;

type ProvisionClient = Readonly<{
  provision(
    request: ElevenLabsProvisionRequest,
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>>;
}>;

export function createElevenLabsAutoprovision(input: Readonly<{
  client: ProvisionClient;
  defaultVoiceId: string;
  tools: readonly VoiceClientToolDefinition[];
}>) {
  const buildProvisionInput = async (
    signal: AbortSignal,
    tts?: ElevenLabsTtsConfigInput | null,
  ) => {
    throwIfAborted(signal);
    const prompt = buildElevenLabsVoiceAgentPrompt().replace(/Claude Code/giu, 'the coding assistant');
    const tools = ElevenLabsProvisionToolSchema.array().parse(input.tools.map((tool) => Object.freeze({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })));
    return Object.freeze({
      prompt,
      tools,
      tts: Object.freeze({
        voiceId: typeof tts?.voiceId === 'string' && tts.voiceId.trim() ? tts.voiceId.trim() : input.defaultVoiceId,
        modelId: typeof tts?.modelId === 'string' && tts.modelId.trim() ? tts.modelId.trim() : null,
        voiceSettings: Object.freeze({
          stability: tts?.voiceSettings?.stability ?? null,
          similarityBoost: tts?.voiceSettings?.similarityBoost ?? null,
          speed: tts?.voiceSettings?.speed ?? null,
        }),
      }),
    });
  };

  return Object.freeze({
    async findExistingAgents(signal: AbortSignal): Promise<Array<{ agentId: string; name: string }>> {
      throwIfAborted(signal);
      const response = await input.client.provision({ kind: 'list' }, signal);
      throwIfAborted(signal);
      return Array.isArray(response.agents)
        ? response.agents.flatMap((row) => row && typeof row === 'object'
          && typeof (row as { agentId?: unknown }).agentId === 'string'
          && typeof (row as { name?: unknown }).name === 'string'
          ? [{ agentId: (row as { agentId: string }).agentId, name: (row as { name: string }).name }]
          : [])
        : [];
    },
    async createAgent(
      params: { tts?: ElevenLabsTtsConfigInput | null },
      signal: AbortSignal,
    ): Promise<{ agentId: string }> {
      const provision = await buildProvisionInput(signal, params.tts);
      throwIfAborted(signal);
      const response = await input.client.provision({ kind: 'create', ...provision }, signal);
      throwIfAborted(signal);
      if (typeof response.agentId !== 'string') throw new Error('provider_response_invalid');
      return { agentId: response.agentId };
    },
    async updateAgent(
      params: { agentId: string; tts?: ElevenLabsTtsConfigInput | null },
      signal: AbortSignal,
    ): Promise<void> {
      const provision = await buildProvisionInput(signal, params.tts);
      throwIfAborted(signal);
      const response = await input.client.provision(
        { kind: 'update', agentId: params.agentId, ...provision },
        signal,
      );
      throwIfAborted(signal);
      if (response.updated !== true) throw new Error('provider_response_invalid');
    },
  });
}
