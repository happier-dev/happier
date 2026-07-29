import { describe, expect, it } from 'vitest';
import {
  describeActionForVoiceTool,
  listVoiceToolActionSpecs,
  zodSchemaToJsonSchemaObject,
} from '@happier-dev/protocol';

import { createXaiRealtimeProtocolAdapter, createXaiSessionUpdate, encodeXaiToolResult } from './protocolAdapter.js';

describe('xAI Realtime protocol adapter', () => {
  it('writes only the documented nested session configuration', () => {
    expect(createXaiSessionUpdate({
      voice: { kind: 'catalog', id: 'eve' },
      instructions: 'Be concise.',
      reasoningEffort: 'high',
      outputSpeed: 1.2,
      transcription: { languageHint: 'es-MX', keyterms: ['Happier'] },
      turnDetection: {
        mode: 'server_vad', threshold: 0.7, silenceDurationMs: 900,
        prefixPaddingMs: 333, idleTimeoutMs: null,
      },
      resumptionEnabled: true,
      model: { kind: 'pinned', id: 'grok-voice-think-fast-1.0' },
    }, [{
      name: 'sendSessionMessage',
      description: 'Send a message to the selected coding session.',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    }])).toEqual({
      type: 'session.update',
      session: {
        voice: 'eve', instructions: 'Be concise.', reasoning: { effort: 'high' },
        tools: [{
          type: 'function',
          name: 'sendSessionMessage',
          description: 'Send a message to the selected coding session.',
          parameters: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
        }],
        turn_detection: { type: 'server_vad', threshold: 0.7, silence_duration_ms: 900, prefix_padding_ms: 333 },
        resumption: { enabled: true },
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'grok-transcribe', language_hint: 'es-MX', keyterms: ['Happier'] },
          },
          output: { format: { type: 'audio/pcm', rate: 24000 }, speed: 1.2 },
        },
      },
    });
  });

  it('omits reasoning for models whose current xAI contract does not support it', () => {
    const update = createXaiSessionUpdate({
      voice: { kind: 'catalog', id: 'eve' }, instructions: null, reasoningEffort: 'high', outputSpeed: 1,
      transcription: { languageHint: null, keyterms: [] },
      turnDetection: { mode: 'server_vad', threshold: null, silenceDurationMs: null, prefixPaddingMs: null, idleTimeoutMs: null },
      resumptionEnabled: false,
      model: { kind: 'pinned', id: 'grok-voice-fast-1.0' },
    }, []);
    expect(update).toMatchObject({ type: 'session.update', session: expect.not.objectContaining({ reasoning: expect.anything() }) });
  });

  it('accepts every canonical voice action as an xAI custom function declaration', () => {
    const actionSpecs = listVoiceToolActionSpecs();
    const update = createXaiSessionUpdate({
      voice: { kind: 'catalog', id: 'eve' }, instructions: null, reasoningEffort: 'none', outputSpeed: 1,
      transcription: { languageHint: null, keyterms: [] },
      turnDetection: { mode: 'server_vad', threshold: null, silenceDurationMs: null, prefixPaddingMs: null, idleTimeoutMs: null },
      resumptionEnabled: false,
      model: { kind: 'pinned', id: 'grok-voice-think-fast-1.0' },
    }, actionSpecs.map((spec) => ({
      name: String(spec.bindings?.voiceClientToolName ?? '').trim(),
      description: describeActionForVoiceTool(spec),
      parameters: zodSchemaToJsonSchemaObject(spec.inputSchema),
    })));
    const tools = (update as Readonly<{
      session: Readonly<{ tools: readonly Readonly<{ name: string; parameters: unknown }>[] }>;
    }>).session.tools;

    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).toEqual(actionSpecs.map((spec) => spec.bindings?.voiceClientToolName));
    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(tools.every((tool) => (
      tool.parameters !== null
      && typeof tool.parameters === 'object'
      && (tool.parameters as Readonly<{ type?: unknown }>).type === 'object'
    ))).toBe(true);
  });

  it('upserts cumulative user transcripts and corrects an already-final item', () => {
    const adapter = createXaiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.updated', event_id: 'e1', item_id: 'u1', transcript: 'hello word',
    })).toContainEqual(expect.objectContaining({
      type: 'transcript', event: expect.objectContaining({ type: 'voice.transcript.updated', itemId: 'u1', text: 'hello word', revision: 1 }),
    }));
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.updated', event_id: 'e-other', item_id: 'u2', transcript: 'independent turn',
    })).toContainEqual(expect.objectContaining({
      type: 'transcript', event: expect.objectContaining({ type: 'voice.transcript.updated', itemId: 'u2', text: 'independent turn', revision: 1 }),
    }));
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.completed', event_id: 'e2', item_id: 'u1', transcript: 'hello world',
    })).toContainEqual(expect.objectContaining({
      type: 'transcript', event: expect.objectContaining({ type: 'voice.transcript.final', itemId: 'u1', text: 'hello world', revision: 2 }),
    }));
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.completed', event_id: 'e3', item_id: 'u1', transcript: 'hello, world',
    })).toContainEqual(expect.objectContaining({
      type: 'transcript', event: expect.objectContaining({ type: 'voice.transcript.corrected', itemId: 'u1', text: 'hello, world', revision: 3 }),
    }));
  });

  it('deduplicates replayed stable event ids without re-emitting provider payloads', () => {
    const adapter = createXaiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    const delta = {
      type: 'response.output_audio_transcript.delta', event_id: 'stable-1', response_id: 'assistant-1', delta: 'hello',
    } as const;
    expect(adapter.decodeControl(delta)).toContainEqual(expect.objectContaining({
      type: 'transcript', event: expect.objectContaining({ text: 'hello', revision: 1 }),
    }));
    expect(adapter.decodeControl(delta)).toEqual([]);
    expect(adapter.decodeControl({
      type: 'response.output_audio_transcript.done', event_id: 'stable-2', response_id: 'assistant-1', transcript: 'hello',
    })).toContainEqual(expect.objectContaining({
      type: 'transcript', event: expect.objectContaining({ text: 'hello', revision: 2 }),
    }));
  });

  it('starts a fresh transcript epoch when the provider replaces a refused or expired conversation identity', () => {
    const adapter = createXaiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    adapter.decodeControl({ type: 'conversation.created', conversation: { id: 'conv-expired' } });
    const event = {
      type: 'conversation.item.input_audio_transcription.updated',
      event_id: 'replayed-event',
      item_id: 'user-1',
      transcript: 'old history',
    } as const;
    expect(adapter.decodeControl(event)).toContainEqual(expect.objectContaining({
      type: 'transcript', event: expect.objectContaining({ revision: 1, text: 'old history' }),
    }));
    expect(adapter.decodeControl(event)).toEqual([]);

    adapter.decodeControl({ type: 'conversation.created', conversation: { id: 'conv-fresh' } });
    expect(adapter.decodeControl({ ...event, transcript: 'fresh turn' })).toContainEqual(expect.objectContaining({
      type: 'transcript', event: expect.objectContaining({ revision: 1, text: 'fresh turn' }),
    }));
  });

  it('does not project unknown provider payloads across the canonical SDK boundary', () => {
    const adapter = createXaiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });

    expect(adapter.decodeControl({
      type: 'future.provider.event',
      token: 'sentinel-secret-token',
      transcript: 'sentinel-private-transcript',
    })).toEqual([]);
  });

  it('buffers all function calls for a response and emits one ordered barrier batch at response.done', () => {
    const adapter = createXaiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    expect(adapter.decodeControl({
      type: 'response.function_call_arguments.done', event_id: 't2', response_id: 'r1', call_id: 'c2', name: 'two', arguments: '{}', output_index: 1,
    })).not.toContainEqual(expect.objectContaining({ type: 'tool_calls' }));
    expect(adapter.decodeControl({
      type: 'response.function_call_arguments.done', event_id: 't1', response_id: 'r1', call_id: 'c1', name: 'one', arguments: '{"x":1}', output_index: 0,
    })).not.toContainEqual(expect.objectContaining({ type: 'tool_calls' }));
    expect(adapter.decodeControl({ type: 'response.done', event_id: 'done', response: { id: 'r1' } })).toContainEqual({
      type: 'tool_calls', responseId: 'r1', calls: [
        { v: 1, responseId: 'r1', callId: 'c1', toolName: 'one', order: 0, arguments: { x: 1 } },
        { v: 1, responseId: 'r1', callId: 'c2', toolName: 'two', order: 1, arguments: {} },
      ],
    });
    expect(adapter.decodeControl({ type: 'response.done', event_id: 'duplicate', response: { id: 'r1' } }))
      .not.toContainEqual(expect.objectContaining({ type: 'tool_calls' }));
  });

  it('keeps xAI force-message and error semantics in the provider leaf', () => {
    const adapter = createXaiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    expect(adapter.encodeTurnControl('send_exact_message', { text: 'Recorded.', interruptible: false })).toEqual({
      type: 'conversation.item.create',
      item: { type: 'force_message', role: 'assistant', interruptible: false, content: [{ type: 'output_text', text: 'Recorded.' }] },
    });
    expect(adapter.encodeTurnControl('cancel_response')).toEqual({ type: 'response.cancel' });
    expect(adapter.encodeTurnControl('clear_input')).toEqual({ type: 'input_audio_buffer.clear' });
    expect(adapter.decodeControl({ type: 'error', error: { code: 'invalid_client_secret' } })).toContainEqual({ type: 'auth_expired' });
  });

  it('encodes only turn controls supported by the documented xAI wire adapter', () => {
    const adapter = createXaiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    expect(adapter.encodeTurnControl('stop_session')).toBeNull();
    expect(adapter.encodeTurnControl('truncate_playback', { itemId: 'assistant-1', audioEndMs: 120 })).toBeNull();
  });

  it('encodes one function output per result without requesting continuation itself', () => {
    expect(encodeXaiToolResult({
      v: 1, responseId: 'r1', callId: 'c1', toolName: 'lookup', order: 0, status: 'success', output: { ok: true },
    })).toEqual({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' },
    });
  });

  it('bounds completed response dedupe state for long-running sessions', () => {
    const adapter = createXaiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    for (let index = 0; index < 513; index += 1) {
      adapter.decodeControl({
        type: 'response.function_call_arguments.done', response_id: `r${index}`, call_id: `c${index}`, name: 'noop', arguments: '{}',
      });
      adapter.decodeControl({ type: 'response.done', response: { id: `r${index}` } });
    }
    adapter.decodeControl({
      type: 'response.function_call_arguments.done', response_id: 'r0', call_id: 'c-new', name: 'noop', arguments: '{}',
    });
    expect(adapter.decodeControl({ type: 'response.done', response: { id: 'r0' } })).toContainEqual(
      expect.objectContaining({ type: 'tool_calls', responseId: 'r0' }),
    );
  });

  it('projects provider wire activity into provider-neutral speech and output edges', () => {
    const adapter = createXaiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });

    expect(adapter.decodeControl({ type: 'input_audio_buffer.speech_started', event_id: 'speech-1' }))
      .toContainEqual({ type: 'input_speech_started' });
    expect(adapter.decodeControl({ type: 'input_audio_buffer.speech_stopped', event_id: 'speech-2' }))
      .toContainEqual({ type: 'input_speech_stopped' });
    expect(adapter.decodeControl({
      type: 'response.output_audio.delta', event_id: 'audio-1', response_id: 'response-1', item_id: 'assistant-1', delta: 'AA==',
    })).toContainEqual({ type: 'assistant_output_started', itemId: 'assistant-1' });
    expect(adapter.decodeControl({
      type: 'response.output_audio.delta', event_id: 'audio-2', response_id: 'response-1', item_id: 'assistant-1', delta: 'AA==',
    })).not.toContainEqual({ type: 'assistant_output_started' });
    expect(adapter.decodeControl({
      type: 'response.output_audio.done', event_id: 'audio-3', response_id: 'response-1', item_id: 'assistant-1',
    })).toContainEqual({ type: 'assistant_output_stopped' });
    adapter.decodeControl({
      type: 'response.output_audio.delta', event_id: 'audio-4', response_id: 'response-2', item_id: 'assistant-2', delta: 'AA==',
    });
    expect(adapter.decodeControl({
      type: 'response.output_audio.delta', event_id: 'audio-5', response_id: 'response-2', item_id: 'assistant-3', delta: 'AA==',
    })).toContainEqual({ type: 'assistant_output_started' });
    expect(adapter.decodeControl({
      type: 'response.output_audio.done', event_id: 'audio-6', response_id: 'response-2', item_id: 'assistant-2',
    })).not.toContainEqual({ type: 'assistant_output_stopped' });
    expect(adapter.decodeControl({ type: 'response.done', event_id: 'audio-7', response: { id: 'response-2' } }))
      .toContainEqual({ type: 'assistant_output_stopped' });
  });
});
