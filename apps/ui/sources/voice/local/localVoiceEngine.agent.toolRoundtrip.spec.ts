import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { VOICE_TOOL_RESULTS_JSON_PREFIX } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createTransferRecipientKeyPair } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import {
  readLocalConversationVoiceSettings,
  writeLocalConversationVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';

import {
  getStorage,
  loadLocalVoiceEngineWithCompatState,
  machineRpcWithServerScope,
  machineContributionRegistryProjectionDescribe,
  registerLocalVoiceEngineHarnessHooks,
} from './localVoiceEngine.testHarness';

const machineCapabilitiesBoundary = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@/sync/ops/capabilities', () => ({
  machineCapabilitiesInvoke: (...args: unknown[]) => machineCapabilitiesBoundary.invoke(...args),
}));

function findToolResultsCarrier() {
  return machineRpcWithServerScope.mock.calls
    .filter(([request]) => request?.method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_CHAT)
    .flatMap(([request]) => Array.isArray(request?.payload?.messages) ? request.payload.messages : [])
    .find((message: any) =>
      message?.role === 'user'
      && typeof message?.content === 'string'
      && message.content.startsWith(VOICE_TOOL_RESULTS_JSON_PREFIX));
}

function queueOpenAiCompatDaemonRoundTrip(
  transcript: string,
  initialAgentReply: string,
  followUpAgentReply: string,
) {
  const transcripts = [transcript];
  const chatReplies = [initialAgentReply, followUpAgentReply];
  machineRpcWithServerScope.mockImplementation(async (request: any) => {
    switch (request?.method) {
      case RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_INIT: {
        const recipient = createTransferRecipientKeyPair();
        return {
          success: true,
          uploadId: 'tool-roundtrip-upload',
          chunkSizeBytes: 64 * 1024,
          recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
        };
      }
      case RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_CHUNK:
        return { success: true };
      case RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_FINALIZE:
        return {
          success: true,
          uploadId: 'tool-roundtrip-upload',
          sizeBytes: 3,
          sha256: 'a'.repeat(64),
        };
      case RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE: {
        const text = transcripts.shift();
        if (!text) throw new Error('unexpected extra OpenAI-compatible transcription request');
        return { ok: true, text };
      }
      case RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_CHAT: {
        const text = chatReplies.shift();
        if (!text) throw new Error('unexpected extra OpenAI-compatible chat request');
        return { ok: true, text };
      }
      default:
        throw new Error(`unexpected machine RPC method: ${String(request?.method)}`);
    }
  });
}

function configureOpenAiCompatAgentVoice(voice: VoiceSettings): VoiceSettings {
  const current = readLocalConversationVoiceSettings(voice);
  return writeLocalConversationVoiceSettings(
    { ...voice, providerId: 'local_conversation' },
    {
      ...current,
      conversationMode: 'agent',
      stt: {
        ...current.stt,
        provider: 'openai_compat',
        openaiCompat: { ...current.stt.openaiCompat, baseUrl: 'http://localhost:8000' },
      },
      tts: {
        ...current.tts,
        provider: 'openai_compat',
        autoSpeakReplies: false,
        openaiCompat: { ...current.tts.openaiCompat, baseUrl: 'http://localhost:8001' },
      },
      agent: {
        ...current.agent,
        backend: 'openai_compat',
        openaiCompat: {
          ...current.agent.openaiCompat,
          chatBaseUrl: 'http://localhost:8002',
          chatApiKey: null,
          chatModel: 'fast-model',
          commitModel: 'commit-model',
        },
      },
    },
  );
}

describe('local voice engine agent tool roundtrip', () => {
  registerLocalVoiceEngineHarnessHooks();

  beforeEach(() => {
    machineContributionRegistryProjectionDescribe.mockReset();
    machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });
    machineRpcWithServerScope.mockReset();
    machineCapabilitiesBoundary.invoke.mockReset();
    machineCapabilitiesBoundary.invoke.mockResolvedValue({ supported: false, reason: 'not-supported' });
  });

  it('sends discovery tool results back to the agent for follow-up turns', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: configureOpenAiCompatAgentVoice(storage.getState().settings.voice),
      },
      sessions: {
        ...storage.getState().sessions,
        s1: {
          id: 's1',
          metadata: { path: '/tmp/project-a', host: 'test-machine' },
        },
      },
    });

    const actionBlock = [
      '<voice_actions>',
      JSON.stringify({
        actions: [
          { t: 'listAgentBackends', args: {} },
          { t: 'listAgentModels', args: { agentId: 'claude' } },
        ],
      }),
      '</voice_actions>',
    ].join('\n');

    expect(readLocalConversationVoiceSettings(storage.getState().settings.voice).agent.backend)
      .toBe('openai_compat');

    queueOpenAiCompatDaemonRoundTrip(
      'show me available agent backends and claude models',
      `Let me check.\n\n${actionBlock}`,
      'Found them.',
    );

    const { toggleLocalVoiceTurn } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
    await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

    expect(machineRpcWithServerScope.mock.calls.filter(
      ([request]) => request?.method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_CHAT,
    )).toHaveLength(2);
    const toolResultsCarrier = findToolResultsCarrier();

    expect(toolResultsCarrier?.content).toContain('"t":"listAgentBackends"');
    expect(toolResultsCarrier?.content).toContain('"t":"listAgentModels"');
    expect(toolResultsCarrier?.content).toContain('"agentId":"claude"');
    expect(toolResultsCarrier?.content).toContain('"source":"static"');
    expect(toolResultsCarrier?.content).toContain('"summary":"Available backends:');
    expect(toolResultsCarrier?.content).toContain('"summary":"Available Claude models:');
  });

  it('compacts discovery tool results before replaying them to the follow-up turn', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        backendEnabledById: {
          claude: true,
          codex: true,
          opencode: true,
        },
        voice: configureOpenAiCompatAgentVoice(storage.getState().settings.voice),
      },
    });

    const actionBlock = [
      '<voice_actions>',
      JSON.stringify({
        actions: [{ t: 'listAgentBackends', args: { limit: 10 } }],
      }),
      '</voice_actions>',
    ].join('\n');

    queueOpenAiCompatDaemonRoundTrip(
      'list the available agent backends',
      `Let me check.\n\n${actionBlock}`,
      'Found them.',
    );

    expect(readLocalConversationVoiceSettings(storage.getState().settings.voice)).toMatchObject({
      conversationMode: 'agent',
      stt: { provider: 'openai_compat', openaiCompat: { baseUrl: 'http://localhost:8000' } },
      agent: { backend: 'openai_compat' },
    });

    const { toggleLocalVoiceTurn } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
    await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

    expect(machineRpcWithServerScope.mock.calls.map(([request]) => request?.method)).toContain(
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_INIT,
    );
    const toolResultsCarrier = findToolResultsCarrier();

    expect(toolResultsCarrier?.content).toContain('"agentId":"claude"');
    expect(toolResultsCarrier?.content).toContain('"label":"Claude"');
    expect(toolResultsCarrier?.content).toContain('"summary":"Available backends:');
    expect(toolResultsCarrier?.content).not.toContain('uiConnectedService');
    expect(toolResultsCarrier?.content).not.toContain('flavorAliases');
    expect(toolResultsCarrier?.content).not.toContain('supportsModelSelection');
    expect(toolResultsCarrier?.content.length).toBeLessThan(1200);
  });

	  it('preserves configured ACP backend target keys in follow-up backend discovery results', async () => {
	    const storage = await getStorage();
	    const reviewBotTargetKey = resolveBackendTargetKeyV2({
	      kind: 'backend',
	      backendId: 'review-bot',
	      configuredBackendId: 'review-bot',
	    });
	    storage.__setState({
	      settings: {
	        ...storage.getState().settings,
	        backendEnabledByTargetKey: {
	          [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' })]: false,
	          [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' })]: false,
	          [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'opencode' })]: false,
	          [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini' })]: false,
	          [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'auggie' })]: false,
	          [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'qwen' })]: false,
	          [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'kimi' })]: false,
	          [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'kilo' })]: false,
	          [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'kiro' })]: false,
	          [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'ohMyPi' })]: false,
	          [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'pi' })]: false,
	          [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'copilot' })]: false,
	        },
	        acpCatalogSettingsV1: {
	          v: 2,
	          backends: [
            {
              id: 'review-bot',
              name: 'review-bot',
              title: 'Review bot',
              description: 'Configured ACP backend for review automation',
              command: 'review-bot',
              args: ['acp'],
              env: {},
              transportProfile: 'generic',
              capabilities: {
                supportsLoadSession: false,
                supportsModes: 'unknown',
                supportsModels: 'unknown',
                supportsConfigOptions: 'unknown',
                promptImageSupport: 'unknown',
              },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
        voice: configureOpenAiCompatAgentVoice(storage.getState().settings.voice),
      },
    });

    const actionBlock = [
      '<voice_actions>',
      JSON.stringify({
        actions: [{ t: 'listAgentBackends', args: { limit: 10 } }],
      }),
      '</voice_actions>',
    ].join('\n');

    queueOpenAiCompatDaemonRoundTrip(
      'list the available configured backends',
      `Let me check.\n\n${actionBlock}`,
      'Found them.',
    );

    const { toggleLocalVoiceTurn } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
    await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

    const toolResultsCarrier = findToolResultsCarrier();

	    expect(toolResultsCarrier?.content).toContain('"label":"Review bot"');
	    expect(toolResultsCarrier?.content).toContain(`\"targetKey\":\"${reviewBotTargetKey}\"`);
	  });

	  it('preserves canonical plugin backend target keys in follow-up backend discovery results', async () => {
	    const storage = await getStorage();
	    storage.__setState({
	      settings: {
	        ...storage.getState().settings,
	        backendEnabledByTargetKey: {
	          [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'plugin-review-bot' })]: true,
	        },
	        voice: configureOpenAiCompatAgentVoice(storage.getState().settings.voice),
      },
    });

    machineContributionRegistryProjectionDescribe.mockResolvedValue({
      supported: true,
      projection: {
        v: 1,
        agentsById: {
          'plugin:review-bot': {
            id: 'plugin:review-bot',
            title: 'Review Bot Plugin',
            subtitle: undefined,
            channel: 'plugin',
            isBuiltIn: false,
            catalogAgentId: 'claude',
            iconAgentId: 'claude',
          },
        },
        backendsById: {
          'plugin-review-bot': {
            id: 'plugin-review-bot',
            backendId: 'plugin-review-bot',
            agentId: 'plugin:review-bot',
            title: 'Review Bot (plugin)',
            subtitle: undefined,
            catalogAgentId: 'claude',
            iconAgentId: 'claude',
          },
        },
      },
    });
    const actionBlock = [
      '<voice_actions>',
      JSON.stringify({
        actions: [{ t: 'listAgentBackends', args: { machineId: 'm1', includeDisabled: true } }],
      }),
      '</voice_actions>',
    ].join('\n');

    queueOpenAiCompatDaemonRoundTrip(
      'list the available plugin backends',
      `Let me check.\n\n${actionBlock}`,
      'Found them.',
    );

    const { toggleLocalVoiceTurn } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
    await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

    const toolResultsCarrier = findToolResultsCarrier();

    expect(toolResultsCarrier?.content).toContain('"label":"Review Bot (plugin)"');
    expect(toolResultsCarrier?.content).toContain('"targetKey":"backend:plugin-review-bot"');
    expect(toolResultsCarrier?.content).toContain('"agentId":"claude"');
  });

  it('round-trips canonical plugin backend targets into plugin model discovery follow-up turns', async () => {
	    const storage = await getStorage();
	    storage.__setState({
	      settings: {
	        ...storage.getState().settings,
	        backendEnabledByTargetKey: {
	          [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'plugin-review-bot' })]: true,
	        },
	        voice: configureOpenAiCompatAgentVoice(storage.getState().settings.voice),
      },
    });

    machineContributionRegistryProjectionDescribe.mockResolvedValue({
      supported: true,
      projection: {
        v: 1,
        agentsById: {
          'plugin:review-bot': {
            id: 'plugin:review-bot',
            title: 'Review Bot Plugin',
            subtitle: undefined,
            channel: 'plugin',
            isBuiltIn: false,
            catalogAgentId: 'claude',
            iconAgentId: 'claude',
          },
        },
        backendsById: {
          'plugin-review-bot': {
            id: 'plugin-review-bot',
            backendId: 'plugin-review-bot',
            agentId: 'plugin:review-bot',
            title: 'Review Bot (plugin)',
            subtitle: undefined,
            catalogAgentId: 'claude',
            iconAgentId: 'claude',
          },
        },
      },
    });
    machineCapabilitiesBoundary.invoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [
            { id: 'default', name: 'Default' },
            { id: 'review-model', name: 'Review Model' },
          ],
          supportsFreeform: true,
        },
      },
    });

    const actionBlock = [
      '<voice_actions>',
      JSON.stringify({
        actions: [
          { t: 'listAgentBackends', args: { machineId: 'm1', includeDisabled: true } },
          {
            t: 'listAgentModels',
            args: {
              agentId: 'claude',
              backendTargetKey: 'backend:plugin-review-bot',
              machineId: 'm1',
              limit: 2,
            },
          },
        ],
      }),
      '</voice_actions>',
    ].join('\n');

    queueOpenAiCompatDaemonRoundTrip(
      'list plugin backends and the plugin models',
      `Let me check.\n\n${actionBlock}`,
      'Found them.',
    );

    const { toggleLocalVoiceTurn } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
    await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

    const toolResultsCarrier = findToolResultsCarrier();

    expect(toolResultsCarrier?.content).toContain('"targetKey":"backend:plugin-review-bot"');
    expect(toolResultsCarrier?.content).toContain('"agentId":"claude"');
    expect(toolResultsCarrier?.content).toContain('"t":"listAgentModels"');
    expect(toolResultsCarrier?.content).toContain('Available Plugin review bot models');
  });
});
