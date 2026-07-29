import { describe, expect, it } from 'vitest';
import {
  describeActionForVoiceTool,
  listVoiceToolActionSpecs,
  zodSchemaToJsonSchemaObject,
} from '@happier-dev/protocol';

import {
  createOpenAiRealtimeProtocolAdapter,
  createOpenAiToolSessionUpdate,
  encodeOpenAiRealtimeClientEvent,
  encodeOpenAiToolResult,
} from './protocolAdapter.js';

const TRANSCRIPTION_USAGE = Object.freeze({
  type: 'duration' as const,
  seconds: 1,
});

describe('OpenAI Realtime protocol adapter', () => {
  it('advertises every canonical voice action in the documented Realtime session tool shape', () => {
    const actionSpecs = listVoiceToolActionSpecs();
    const update = createOpenAiToolSessionUpdate(actionSpecs.map((spec) => ({
      name: String(spec.bindings?.voiceClientToolName ?? '').trim(),
      description: describeActionForVoiceTool(spec),
      parameters: zodSchemaToJsonSchemaObject(spec.inputSchema),
    })));
    const session = (update as Readonly<{
      session: Readonly<{
        type: string;
        tool_choice: string;
        tools: readonly Readonly<{ type: string; name: string; parameters: unknown }>[];
      }>;
    }>).session;
    const toolNames = session.tools.map((tool) => tool.name);

    expect(session.type).toBe('realtime');
    expect(session.tool_choice).toBe('auto');
    expect(session.tools.every((tool) => tool.type === 'function')).toBe(true);
    expect(toolNames).toEqual(actionSpecs.map((spec) => spec.bindings?.voiceClientToolName));
    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(session.tools.every((tool) => (
      tool.parameters !== null
      && typeof tool.parameters === 'object'
      && (tool.parameters as Readonly<{ type?: unknown }>).type === 'object'
    ))).toBe(true);
  });

  it('projects stable partial/final transcript revisions', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    expect(adapter).not.toHaveProperty('turnControls');
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'e1',
      item_id: 'u1',
      content_index: 0,
      delta: 'hel',
    })).toContainEqual(expect.objectContaining({ type: 'transcript', event: expect.objectContaining({ itemId: 'u1', text: 'hel', type: 'voice.transcript.delta' }) }));
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'e2',
      item_id: 'u1',
      content_index: 0,
      transcript: 'hello',
      usage: TRANSCRIPTION_USAGE,
    })).toContainEqual(expect.objectContaining({ type: 'transcript', event: expect.objectContaining({ itemId: 'u1', text: 'hello', type: 'voice.transcript.final', revision: 2 }) }));
  });

  it('deduplicates replayed provider event ids before mutating transcript state', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    const event = {
      type: 'response.output_audio_transcript.delta',
      event_id: 'duplicate-event',
      response_id: 'r1',
      item_id: 'a1',
      output_index: 0,
      content_index: 0,
      delta: 'hello',
    } as const;

    expect(adapter.decodeControl(event)).toContainEqual(expect.objectContaining({
      type: 'transcript', event: expect.objectContaining({ text: 'hello', revision: 1 }),
    }));
    expect(adapter.decodeControl(event)).toEqual([]);

    expect(adapter.decodeControl({
      type: 'response.output_audio_transcript.done',
      event_id: 'done-event',
      response_id: 'r1',
      item_id: 'a1',
      output_index: 0,
      content_index: 0,
      transcript: 'hello',
    })).toContainEqual(expect.objectContaining({
      type: 'transcript', event: expect.objectContaining({ text: 'hello', revision: 2 }),
    }));
  });

  it('bounds transcript revision state for long-running sessions', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    for (let index = 0; index <= 2_048; index += 1) {
      adapter.decodeControl({
        type: 'conversation.item.input_audio_transcription.delta',
        event_id: `event-${index}`,
        item_id: `item-${index}`,
        content_index: 0,
        delta: 'partial',
      });
    }

    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'event-first-final',
      item_id: 'item-0',
      content_index: 0,
      transcript: 'final',
      usage: TRANSCRIPTION_USAGE,
    })).toContainEqual(expect.objectContaining({
      type: 'transcript',
      event: expect.objectContaining({ itemId: 'item-0', revision: 1, text: 'final' }),
    }));
  });

  it('emits all completed function calls as one response barrier batch', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    const events = adapter.decodeControl({
      type: 'response.done', event_id: 'done-1', response: {
        id: 'r1', object: 'realtime.response', status: 'completed', output: [
          { type: 'function_call', call_id: 'c1', name: 'one', arguments: '{"x":1}' },
          { type: 'function_call', call_id: 'c2', name: 'two', arguments: '{}' },
        ],
      },
    });
    expect(events).toContainEqual({
      type: 'tool_calls', responseId: 'r1', calls: [
        { v: 1, responseId: 'r1', callId: 'c1', toolName: 'one', order: 0, arguments: { x: 1 } },
        { v: 1, responseId: 'r1', callId: 'c2', toolName: 'two', order: 1, arguments: {} },
      ],
    });
  });

  it('maps auth expiry and advertises only controls the OpenAI wire protocol can honor', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    expect(adapter.decodeControl({
      type: 'error',
      event_id: 'error-1',
      error: {
        type: 'invalid_request_error',
        message: 'The client secret is invalid.',
        code: 'invalid_client_secret',
      },
    })).toContainEqual({ type: 'auth_expired' });
    expect(adapter).not.toHaveProperty('id');
    expect(adapter.encodeTurnControl('cancel_response')).toEqual({ type: 'response.cancel' });
    expect(adapter.encodeTurnControl('stop_session')).toBeNull();
    expect(adapter.encodeTurnControl('send_exact_message', { text: 'hello' })).toBeNull();
  });

  it('does not project unknown provider payloads across the canonical SDK boundary', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });

    expect(adapter.decodeControl({
      type: 'future.provider.event',
      event_id: 'future-event',
      token: 'sentinel-secret-token',
      transcript: 'sentinel-private-transcript',
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'input_audio_buffer.speech_started',
      event_id: 'future-event',
      item_id: 'user-1',
      audio_start_ms: 0,
    })).toEqual([{ type: 'input_speech_started' }]);
  });

  it('projects provider wire activity into provider-neutral speech and output edges', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });

    expect(adapter.decodeControl({
      type: 'input_audio_buffer.speech_started', event_id: 'speech-1', item_id: 'user-1', audio_start_ms: 0,
    }))
      .toContainEqual({ type: 'input_speech_started' });
    expect(adapter.decodeControl({
      type: 'input_audio_buffer.speech_stopped', event_id: 'speech-2', item_id: 'user-1', audio_end_ms: 250,
    }))
      .toContainEqual({ type: 'input_speech_stopped' });
    expect(adapter.decodeControl({
      type: 'response.output_audio.delta', event_id: 'audio-1', response_id: 'response-1',
      item_id: 'assistant-1', output_index: 0, content_index: 0, delta: 'AA==',
    })).toContainEqual({ type: 'assistant_output_started', itemId: 'assistant-1' });
    expect(adapter.decodeControl({
      type: 'response.output_audio.delta', event_id: 'audio-2', response_id: 'response-1',
      item_id: 'assistant-1', output_index: 0, content_index: 0, delta: 'AA==',
    })).not.toContainEqual({ type: 'assistant_output_started' });
    expect(adapter.decodeControl({
      type: 'response.output_audio.done', event_id: 'audio-3', response_id: 'response-1',
      item_id: 'assistant-1', output_index: 0, content_index: 0,
    })).toContainEqual({ type: 'assistant_output_stopped' });
    adapter.decodeControl({
      type: 'response.output_audio.delta', event_id: 'audio-4', response_id: 'response-2',
      item_id: 'assistant-2', output_index: 0, content_index: 0, delta: 'AA==',
    });
    expect(adapter.decodeControl({
      type: 'response.output_audio.delta', event_id: 'audio-5', response_id: 'response-2',
      item_id: 'assistant-3', output_index: 1, content_index: 0, delta: 'AA==',
    })).toContainEqual({ type: 'assistant_output_started' });
    expect(adapter.decodeControl({
      type: 'response.output_audio.done', event_id: 'audio-6', response_id: 'response-2',
      item_id: 'assistant-2', output_index: 0, content_index: 0,
    })).not.toContainEqual({ type: 'assistant_output_stopped' });
    expect(adapter.decodeControl({
      type: 'response.done',
      event_id: 'audio-7',
      response: { id: 'response-2', object: 'realtime.response', status: 'completed', output: [] },
    }))
      .toContainEqual({ type: 'assistant_output_stopped' });
  });

  it('does not let malformed session or speech events mutate decoder state', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });

    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'transcript-1',
      item_id: 'user-1',
      content_index: 0,
      delta: 'hello',
    })).toContainEqual(expect.objectContaining({
      type: 'transcript',
      event: expect.objectContaining({ revision: 1 }),
    }));
    expect(adapter.decodeControl({ type: 'session.created', event_id: 'session-1' })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'transcript-2',
      item_id: 'user-1',
      content_index: 0,
      transcript: 'hello',
      usage: TRANSCRIPTION_USAGE,
    })).toContainEqual(expect.objectContaining({
      type: 'transcript',
      event: expect.objectContaining({ revision: 2 }),
    }));
    expect(adapter.decodeControl({
      type: 'session.created',
      event_id: 'session-1',
      session: { type: 'realtime' },
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'transcript-3',
      item_id: 'user-1',
      content_index: 0,
      delta: 'new',
    })).toContainEqual(expect.objectContaining({
      type: 'transcript',
      event: expect.objectContaining({ revision: 1 }),
    }));

    expect(adapter.decodeControl({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-malformed',
      item_id: 'user-2',
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-malformed',
      item_id: 'user-2',
      audio_start_ms: 0,
    })).toEqual([{ type: 'input_speech_started' }]);
  });

  it('does not let malformed audio edges or response completion mutate output state', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });

    expect(adapter.decodeControl({
      type: 'response.output_audio.delta',
      event_id: 'audio-start',
      response_id: 'response-1',
      item_id: 'assistant-1',
      output_index: 0,
      content_index: 0,
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'response.output_audio.delta',
      event_id: 'audio-start',
      response_id: 'response-1',
      item_id: 'assistant-1',
      output_index: 0,
      content_index: 0,
      delta: 'AA==',
    })).toEqual([{ type: 'assistant_output_started', itemId: 'assistant-1' }]);
    expect(adapter.decodeControl({
      type: 'response.output_audio.done',
      event_id: 'audio-done',
      response_id: 'response-1',
      item_id: 'assistant-1',
      content_index: 0,
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'response.output_audio.done',
      event_id: 'audio-done',
      response_id: 'response-1',
      item_id: 'assistant-1',
      output_index: 0,
      content_index: 0,
    })).toEqual([{ type: 'assistant_output_stopped' }]);
    expect(adapter.decodeControl({
      type: 'response.output_audio.delta',
      event_id: 'audio-start-2',
      response_id: 'response-2',
      item_id: 'assistant-2',
      output_index: 0,
      content_index: 0,
      delta: 'AA==',
    })).toEqual([{ type: 'assistant_output_started', itemId: 'assistant-2' }]);
    expect(adapter.decodeControl({
      type: 'response.done',
      event_id: 'response-done',
      response: { id: 'response-2' },
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'response.done',
      event_id: 'response-done',
      response: { id: 'response-2', object: 'realtime.response', status: 'completed', output: [] },
    })).toEqual([{ type: 'assistant_output_stopped' }]);
  });

  it('rejects nonterminal or structurally invalid response.done without closing output', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    const startOutput = (responseId: string, itemId: string, eventId: string) => adapter.decodeControl({
      type: 'response.output_audio.delta',
      event_id: eventId,
      response_id: responseId,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: 'AA==',
    });

    expect(startOutput('response-1', 'assistant-1', 'audio-start-1'))
      .toEqual([{ type: 'assistant_output_started', itemId: 'assistant-1' }]);
    expect(adapter.decodeControl({
      type: 'response.done',
      event_id: 'response-done-1',
      response: { id: 'response-1', object: 'realtime.response', status: 'in_progress', output: [] },
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'response.done',
      event_id: 'response-done-1',
      response: { id: 'response-1', object: 'realtime.response', status: 'completed', output: [] },
    })).toEqual([{ type: 'assistant_output_stopped' }]);

    expect(startOutput('response-2', 'assistant-2', 'audio-start-2'))
      .toEqual([{ type: 'assistant_output_started', itemId: 'assistant-2' }]);
    expect(adapter.decodeControl({
      type: 'response.done',
      event_id: 'response-done-2',
      response: { id: 'response-2', object: 'realtime.response', status: 'completed', output: ['not-an-item'] },
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'response.done',
      event_id: 'response-done-2',
      response: { id: 'response-2', object: 'realtime.response', status: 'completed', output: [] },
    })).toEqual([{ type: 'assistant_output_stopped' }]);
  });

  it('does not publish or retain malformed input/output transcription finals', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });

    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'input-final',
      item_id: 'user-1',
      content_index: 0,
      transcript: 'malformed',
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'input-final',
      item_id: 'user-1',
      content_index: 0,
      transcript: 'valid',
      usage: TRANSCRIPTION_USAGE,
    })).toContainEqual(expect.objectContaining({
      type: 'transcript',
      event: expect.objectContaining({ revision: 1, text: 'valid' }),
    }));

    expect(adapter.decodeControl({
      type: 'response.output_audio_transcript.done',
      event_id: 'output-final',
      response_id: 'response-1',
      item_id: 'assistant-1',
      output_index: 0,
      transcript: 'malformed',
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'response.output_audio_transcript.done',
      event_id: 'output-final',
      response_id: 'response-1',
      item_id: 'assistant-1',
      output_index: 0,
      content_index: 0,
      transcript: 'valid',
    })).toContainEqual(expect.objectContaining({
      type: 'transcript',
      event: expect.objectContaining({ revision: 1, text: 'valid' }),
    }));
  });

  it('strict-validates provider-owned outbound session, tool, and control shapes', () => {
    expect(() => createOpenAiToolSessionUpdate([{
      name: '',
      description: 'invalid empty provider tool name',
      parameters: {},
    }])).toThrow();
    expect(() => encodeOpenAiToolResult({
      v: 1,
      responseId: 'response-1',
      callId: '',
      toolName: 'tool',
      order: 0,
      status: 'success',
      output: {},
    })).toThrow();
    expect(() => encodeOpenAiRealtimeClientEvent({
      type: 'response.cancel',
      response_id: 42,
    })).toThrow();

    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    expect(adapter.encodeTurnControl('cancel_response')).toEqual({ type: 'response.cancel' });
    expect(adapter.encodeTurnControl('clear_input')).toEqual({ type: 'input_audio_buffer.clear' });
  });
});
