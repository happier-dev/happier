import { describe, expect, it } from 'vitest';

import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

import {
  getStorage,
  registerLocalVoiceEngineHarnessHooks,
} from './localVoiceEngine.testHarness';

describe('local voice engine agent tool roundtrip', () => {
  registerLocalVoiceEngineHarnessHooks();

  it('sends discovery tool results back to the agent for follow-up turns', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_conversation',
          adapters: {
            ...storage.getState().settings.voice.adapters,
            local_conversation: {
              ...storage.getState().settings.voice.adapters.local_conversation,
              conversationMode: 'agent',
              stt: {
                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                baseUrl: 'http://localhost:8000',
              },
              tts: {
                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                autoSpeakReplies: false,
                baseUrl: 'http://localhost:8001',
              },
              agent: {
                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                backend: 'openai_compat',
                openaiCompat: {
                  ...storage.getState().settings.voice.adapters.local_conversation.agent.openaiCompat,
                  chatBaseUrl: 'http://localhost:8002',
                  chatApiKey: null,
                  chatModel: 'fast-model',
                  commitModel: 'commit-model',
                },
              },
            },
          },
        },
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

    (globalThis.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'show me available agent backends and claude models' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: `Let me check.\n\n${actionBlock}` } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Found them.' } }] }),
      });

    const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');

    await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
    await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

    const chatCalls = (globalThis.fetch as any).mock.calls.filter((call: any[]) =>
      String(call?.[0] ?? '').includes('/chat/completions'),
    );

    expect(chatCalls).toHaveLength(2);

    const toolResultsCarrier = chatCalls
      .map((call: any[]) => JSON.parse(String(call?.[1]?.body ?? '{}')))
      .flatMap((body: any) => (Array.isArray(body?.messages) ? body.messages : []))
      .find(
        (message: any) =>
          message?.role === 'user' &&
          typeof message?.content === 'string' &&
          message.content.startsWith('VOICE_TOOL_RESULTS_JSON:'),
      );

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
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_conversation',
          adapters: {
            ...storage.getState().settings.voice.adapters,
            local_conversation: {
              ...storage.getState().settings.voice.adapters.local_conversation,
              conversationMode: 'agent',
              stt: {
                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                baseUrl: 'http://localhost:8000',
              },
              tts: {
                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                autoSpeakReplies: false,
                baseUrl: 'http://localhost:8001',
              },
              agent: {
                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                backend: 'openai_compat',
                openaiCompat: {
                  ...storage.getState().settings.voice.adapters.local_conversation.agent.openaiCompat,
                  chatBaseUrl: 'http://localhost:8002',
                  chatApiKey: null,
                  chatModel: 'fast-model',
                  commitModel: 'commit-model',
                },
              },
            },
          },
        },
      },
    });

    const actionBlock = [
      '<voice_actions>',
      JSON.stringify({
        actions: [{ t: 'listAgentBackends', args: { limit: 10 } }],
      }),
      '</voice_actions>',
    ].join('\n');

    (globalThis.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'list the available agent backends' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: `Let me check.\n\n${actionBlock}` } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Found them.' } }] }),
      });

    const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');

    await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
    await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

    const chatCalls = (globalThis.fetch as any).mock.calls.filter((call: any[]) =>
      String(call?.[0] ?? '').includes('/chat/completions'),
    );

    const toolResultsCarrier = chatCalls
      .map((call: any[]) => JSON.parse(String(call?.[1]?.body ?? '{}')))
      .flatMap((body: any) => (Array.isArray(body?.messages) ? body.messages : []))
      .find(
        (message: any) =>
          message?.role === 'user' &&
          typeof message?.content === 'string' &&
          message.content.startsWith('VOICE_TOOL_RESULTS_JSON:'),
      );

    expect(toolResultsCarrier?.content).toContain('"agentId":"claude"');
    expect(toolResultsCarrier?.content).toContain('"label":"Claude"');
    expect(toolResultsCarrier?.content).toContain('"summary":"Available backends:');
    expect(toolResultsCarrier?.content).not.toContain('connectedServiceName');
    expect(toolResultsCarrier?.content).not.toContain('connectedServiceId');
    expect(toolResultsCarrier?.content).not.toContain('flavorAliases');
    expect(toolResultsCarrier?.content).not.toContain('supportsModelSelection');
    expect(toolResultsCarrier?.content.length).toBeLessThan(1200);
  });
});
