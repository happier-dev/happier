import { buildElevenLabsVoiceAgentPrompt } from '@happier-dev/agents';
import {
  actionSpecToElevenLabsClientToolParameters,
  describeActionForVoiceTool,
  type ActionSpec,
} from '@happier-dev/protocol';

import type { ElevenLabsProvisionRequest } from '../../protocol/voice/index.js';

export type ElevenLabsTtsConfigInput = Readonly<{
  voiceId?: string | null;
  modelId?: string | null;
  voiceSettings?: Readonly<{
    stability?: number | null;
    similarityBoost?: number | null;
    style?: number | null;
    useSpeakerBoost?: boolean | null;
    speed?: number | null;
  }> | null;
}>;

type ProvisionClient = Readonly<{
  provision(request: ElevenLabsProvisionRequest): Promise<Readonly<Record<string, unknown>>>;
}>;

export function createElevenLabsAutoprovision(input: Readonly<{
  client: ProvisionClient;
  defaultVoiceId: string;
  buildContext(): Promise<Readonly<{
    disabledActionIds: readonly string[];
    extraSystemAppendBlocks: readonly string[];
    actionSpecs: readonly ActionSpec[];
  }>>;
}>) {
  const buildProvisionInput = async (tts?: ElevenLabsTtsConfigInput | null) => {
    const context = await input.buildContext();
    const prompt = buildElevenLabsVoiceAgentPrompt({
      disabledActionIds: context.disabledActionIds,
      extraSystemAppendBlocks: context.extraSystemAppendBlocks,
    }).replace(/Claude Code/giu, 'the coding assistant');
    const availableActionIds = context.actionSpecs.map((spec) => spec.id);
    const tools = context.actionSpecs.map((spec) => Object.freeze({
      name: String(spec.bindings?.voiceClientToolName ?? '').trim(),
      description: describeActionForVoiceTool(spec).trim(),
      parameters: actionSpecToElevenLabsClientToolParameters(spec, {
        disabledActionIds: context.disabledActionIds,
        availableActionIds,
      }),
    })) satisfies Extract<ElevenLabsProvisionRequest, { kind: 'create' }>['tools'];
    return Object.freeze({
      prompt,
      tools,
      tts: Object.freeze({
        voiceId: typeof tts?.voiceId === 'string' && tts.voiceId.trim() ? tts.voiceId.trim() : input.defaultVoiceId,
        modelId: typeof tts?.modelId === 'string' && tts.modelId.trim() ? tts.modelId.trim() : null,
        voiceSettings: Object.freeze({
          stability: tts?.voiceSettings?.stability ?? null,
          similarityBoost: tts?.voiceSettings?.similarityBoost ?? null,
          style: tts?.voiceSettings?.style ?? null,
          useSpeakerBoost: tts?.voiceSettings?.useSpeakerBoost ?? null,
          speed: tts?.voiceSettings?.speed ?? null,
        }),
      }),
    });
  };

  return Object.freeze({
    async findExistingAgents(): Promise<Array<{ agentId: string; name: string }>> {
      const response = await input.client.provision({ kind: 'list' });
      return Array.isArray(response.agents)
        ? response.agents.flatMap((row) => row && typeof row === 'object'
          && typeof (row as { agentId?: unknown }).agentId === 'string'
          && typeof (row as { name?: unknown }).name === 'string'
          ? [{ agentId: (row as { agentId: string }).agentId, name: (row as { name: string }).name }]
          : [])
        : [];
    },
    async createAgent(params: { tts?: ElevenLabsTtsConfigInput | null }): Promise<{ agentId: string }> {
      const provision = await buildProvisionInput(params.tts);
      const response = await input.client.provision({ kind: 'create', ...provision });
      if (typeof response.agentId !== 'string') throw new Error('provider_response_invalid');
      return { agentId: response.agentId };
    },
    async updateAgent(params: { agentId: string; tts?: ElevenLabsTtsConfigInput | null }): Promise<void> {
      const provision = await buildProvisionInput(params.tts);
      const response = await input.client.provision({ kind: 'update', agentId: params.agentId, ...provision });
      if (response.updated !== true) throw new Error('provider_response_invalid');
    },
  });
}
