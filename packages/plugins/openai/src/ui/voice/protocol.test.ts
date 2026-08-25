import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import {
  describeActionForVoiceTool,
} from '@happier-dev/plugin-sdk/voice/client';
import {
  listVoiceSdkSafeToolActionSpecs,
  zodSchemaToJsonSchemaObject,
} from '@happier-dev/protocol';

import {
  createOpenAiRealtimeProtocolAdapter,
  createOpenAiToolSessionUpdate,
  encodeOpenAiRealtimeClientEvent,
  encodeOpenAiToolResult,
} from './protocol.js';

const TRANSCRIPTION_USAGE = Object.freeze({
  type: 'duration' as const,
  seconds: 1,
});

describe('OpenAI Realtime protocol adapter', () => {
  it('uses public Voice composition at raw OpenAI JSON seams', async () => {
    const source = await readFile(new URL('./protocol.ts', import.meta.url), 'utf8');

    expect(source).toContain('createVoiceRecordSchema');
    expect(source).toContain('withVoiceSchemaField');
    expect(source).toContain('VoiceRealtimeJsonValueSchema');
    expect(source).not.toContain('JsonValueZodAdapter');
    expect(source).not.toContain('z.custom');
    expect(source).not.toContain('@happier-dev/plugin-sdk/protocol-authoring');
  });

  it('rejects server JSON that exceeds the canonical Voice value budget before processing sibling calls', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({
      prepare: async () => ({ kind: 'declined', code: 'unused' }),
    });

    expect(adapter.decodeControl({
      type: 'response.done',
      event_id: 'bounded-output',
      response: {
        id: 'response-1',
        status: 'completed',
        output: [
          { type: 'function_call', call_id: 'call-1', name: 'one', arguments: '{}' },
          { detail: 'x'.repeat(64 * 1024 + 1) },
        ],
      },
    })).toEqual([]);
  });

  it('advertises every canonical voice action in the documented Realtime session tool shape', () => {
    const actionSpecs = listVoiceSdkSafeToolActionSpecs();
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

  it('never lets a late interim provider event supersede an already-final transcript item', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'c1',
      item_id: 'u1',
      content_index: 0,
      transcript: 'hello, please reply out loud.',
      usage: TRANSCRIPTION_USAGE,
    })).toContainEqual(expect.objectContaining({
      type: 'transcript',
      event: expect.objectContaining({ itemId: 'u1', text: 'hello, please reply out loud.', type: 'voice.transcript.final' }),
    }));
    // A late interim delta for a completed item must be dropped, never concatenated
    // onto (or relabeled as a correction of) the authoritative transcript.
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'u-late',
      item_id: 'u1',
      content_index: 0,
      delta: ' hello, please reply out loud.',
    })).toEqual([]);
    // A later provider-final still supersedes the item.
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'c2',
      item_id: 'u1',
      content_index: 0,
      transcript: 'hello, please reply out loud with exactly these words.',
      usage: TRANSCRIPTION_USAGE,
    })).toContainEqual(expect.objectContaining({
      type: 'transcript',
      event: expect.objectContaining({
        itemId: 'u1',
        text: 'hello, please reply out loud with exactly these words.',
        type: 'voice.transcript.corrected',
      }),
    }));
  });

  it('never appends a late assistant transcript delta onto an already-final item', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    adapter.decodeControl({
      type: 'response.output_audio_transcript.delta',
      event_id: 'a-d0',
      response_id: 'r1',
      item_id: 'a1',
      output_index: 0,
      content_index: 0,
      delta: 'Voice canary alpha seven confirmed.',
    });
    expect(adapter.decodeControl({
      type: 'response.output_audio_transcript.done',
      event_id: 'a-done',
      response_id: 'r1',
      item_id: 'a1',
      output_index: 0,
      content_index: 0,
      transcript: 'Voice canary alpha seven confirmed.',
    })).toContainEqual(expect.objectContaining({
      type: 'transcript',
      event: expect.objectContaining({ itemId: 'a1', text: 'Voice canary alpha seven confirmed.', type: 'voice.transcript.final' }),
    }));
    expect(adapter.decodeControl({
      type: 'response.output_audio_transcript.delta',
      event_id: 'a-d1',
      response_id: 'r1',
      item_id: 'a1',
      output_index: 0,
      content_index: 0,
      delta: ' Voice canary alpha seven confirmed.',
    })).toEqual([]);
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

  it.each(['cancelled', 'failed', 'incomplete'] as const)(
    'does not emit tool calls from a %s response',
    (status) => {
      const adapter = createOpenAiRealtimeProtocolAdapter({
        prepare: async () => ({ kind: 'declined', code: 'unused' }),
      });

      expect(adapter.decodeControl({
        type: 'response.done',
        event_id: `done-${status}`,
        response: {
          id: `response-${status}`,
          status,
          output: [{
            type: 'function_call',
            call_id: `call-${status}`,
            name: 'happier_noop',
            arguments: '{}',
          }],
        },
      })).not.toContainEqual(expect.objectContaining({ type: 'tool_calls' }));
    },
  );

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

  it('correlates a WebRTC output buffer to its later assistant transcript item', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({
      prepare: async () => ({ kind: 'declined', code: 'unused' }),
    });

    expect(adapter.decodeControl({
      type: 'output_audio_buffer.started',
      event_id: 'output-started',
      response_id: 'response-1',
    })).toEqual([{ type: 'assistant_output_started' }]);

    expect(adapter.decodeControl({
      type: 'response.output_audio_transcript.done',
      event_id: 'output-transcript',
      response_id: 'response-1',
      item_id: 'assistant-1',
      transcript: 'The persisted assistant reply.',
    })).toEqual([
      { type: 'assistant_output_started', itemId: 'assistant-1' },
      expect.objectContaining({
        type: 'transcript',
        event: expect.objectContaining({
          itemId: 'assistant-1',
          role: 'assistant',
          type: 'voice.transcript.final',
        }),
      }),
    ]);
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

  it('projects WebRTC output-buffer edges and ignores direct audio-delta events', () => {
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
      type: 'output_audio_buffer.started', event_id: 'audio-buffer-1', response_id: 'response-1',
    })).toEqual([{ type: 'assistant_output_started' }]);
    expect(adapter.decodeControl({
      type: 'response.output_audio.delta', event_id: 'audio-1', response_id: 'response-1',
      item_id: 'assistant-1', output_index: 0, content_index: 0, delta: 'AA==',
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'response.output_audio.done', event_id: 'audio-2', response_id: 'response-1',
      item_id: 'assistant-1', output_index: 0, content_index: 0,
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'output_audio_buffer.stopped', event_id: 'audio-buffer-2', response_id: 'response-1',
    })).toEqual([{ type: 'assistant_output_stopped' }]);
    expect(adapter.decodeControl({
      type: 'output_audio_buffer.started', event_id: 'audio-buffer-3', response_id: 'response-2',
    })).toEqual([{ type: 'assistant_output_started' }]);
    expect(adapter.decodeControl({
      type: 'output_audio_buffer.cleared', event_id: 'audio-buffer-4', response_id: 'response-2',
    })).toEqual([{ type: 'assistant_output_stopped' }]);
  });

  it('resets decoder state on a session boundary and ignores unattributable events', () => {
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
    // The event type is the session boundary; the session body is upstream-owned
    // and never read, so it cannot decide whether the boundary is honored.
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
      event: expect.objectContaining({ revision: 1, epoch: 1 }),
    }));

    // Provider event identity is consumed for replay fencing, so an event that
    // cannot be identified is refused rather than guessed at.
    expect(adapter.decodeControl({
      type: 'input_audio_buffer.speech_started',
      item_id: 'user-2',
      audio_start_ms: 0,
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'transcript-4',
      delta: 'orphan',
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-1',
      item_id: 'user-2',
      audio_start_ms: 0,
    })).toEqual([{ type: 'input_speech_started' }]);
  });

  it('does not synthesize WebRTC output edges from direct-audio or response completion events', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });

    expect(adapter.decodeControl({
      type: 'response.output_audio.delta',
      event_id: 'audio-delta',
      response_id: 'response-1',
      item_id: 'assistant-1',
      output_index: 0,
      content_index: 0,
      delta: 'AA==',
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'response.output_audio.done',
      event_id: 'audio-done',
      response_id: 'response-1',
      item_id: 'assistant-1',
      content_index: 0,
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'response.done',
      event_id: 'response-done',
      response: { id: 'response-1' },
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'output_audio_buffer.started', event_id: 'buffer-start', response_id: 'response-1',
    })).toEqual([{ type: 'assistant_output_started' }]);
    expect(adapter.decodeControl({
      type: 'output_audio_buffer.stopped', event_id: 'buffer-stop', response_id: 'response-1',
    })).toEqual([{ type: 'assistant_output_stopped' }]);
  });

  it('does not let incomplete response.done events block a later completed response', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });

    expect(adapter.decodeControl({
      type: 'response.done',
      event_id: 'response-done-1a',
      response: { id: 'response-1', object: 'realtime.response', status: 'in_progress', output: [] },
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'response.done',
      event_id: 'response-done-1b',
      response: { id: 'response-1', object: 'realtime.response', status: 'completed', output: [] },
    })).toEqual([]);

    // One unrecognized output entry is skipped as a tool call; it must not cost
    // the well-formed sibling tool call.
    expect(adapter.decodeControl({
      type: 'response.done',
      event_id: 'response-done-2',
      response: {
        id: 'response-2',
        object: 'realtime.response',
        status: 'completed',
        output: ['not-an-item', {
          type: 'function_call',
          call_id: 'call-survivor',
          name: 'happier_noop',
          arguments: '{}',
          status: 'completed',
          unreleased_provider_field: 'ignored',
        }],
      },
    })).toEqual([
      expect.objectContaining({
        type: 'tool_calls',
        responseId: 'response-2',
        calls: [expect.objectContaining({ callId: 'call-survivor', toolName: 'happier_noop' })],
      }),
    ]);
  });

  it('keeps authoritative finals when the provider omits or adds fields the adapter never reads', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });

    // Billing/index/logprob fields are never read by this adapter. Their
    // absence or evolution must not destroy the words the user actually said.
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'input-final-no-usage',
      item_id: 'user-1',
      content_index: 0,
      transcript: 'voice canary alpha seven confirmed',
    })).toContainEqual(expect.objectContaining({
      type: 'transcript',
      event: expect.objectContaining({
        role: 'user',
        text: 'voice canary alpha seven confirmed',
      }),
    }));
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'input-final-additive',
      item_id: 'user-2',
      content_index: 0,
      transcript: 'additive user final',
      usage: {
        type: 'tokens',
        input_tokens: 17,
        output_tokens: 9,
        total_tokens: 26,
        input_token_details: { text_tokens: 0, audio_tokens: 17, cached_tokens: 0 },
      },
      unreleased_provider_field: { any: 'shape' },
    })).toContainEqual(expect.objectContaining({
      type: 'transcript',
      event: expect.objectContaining({ role: 'user', text: 'additive user final' }),
    }));
    expect(adapter.decodeControl({
      type: 'response.output_audio_transcript.done',
      event_id: 'output-final-additive',
      response_id: 'response-1',
      item_id: 'assistant-1',
      transcript: 'additive assistant final',
      unreleased_provider_field: 1,
    })).toContainEqual(expect.objectContaining({
      type: 'transcript',
      event: expect.objectContaining({
        role: 'assistant',
        text: 'additive assistant final',
      }),
    }));
    // Speech edges and the epoch reset must survive the same evolution.
    expect(adapter.decodeControl({
      type: 'input_audio_buffer.speech_started',
      event_id: 'speech-additive',
      item_id: 'user-3',
      unreleased_provider_field: true,
    })).toEqual([{ type: 'input_speech_started' }]);
  });

  it('does not publish or retain malformed input/output transcription finals', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });

    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'input-final',
      item_id: 'user-1',
      content_index: 0,
      transcript: 42,
    })).toEqual([]);
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'input-final-no-item',
      content_index: 0,
      transcript: 'unattributable',
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

  it('seals the accumulated transcript when a final restates no text of its own', () => {
    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });

    adapter.decodeControl({
      type: 'response.output_audio_transcript.delta',
      event_id: 'assistant-delta',
      item_id: 'assistant-1',
      delta: 'history canary delta 9 2',
    });

    // An empty/blank provider transcript is not an empty transcript: it is a
    // final that carries no text of its own. Replacing the accumulated text
    // with it erases the turn, and an empty canonical final is discarded by the
    // host writer with no row and no record.
    expect(adapter.decodeControl({
      type: 'response.output_audio_transcript.done',
      event_id: 'assistant-final',
      response_id: 'response-1',
      item_id: 'assistant-1',
      transcript: '',
    })).toContainEqual(expect.objectContaining({
      type: 'transcript',
      event: expect.objectContaining({
        type: 'voice.transcript.final',
        text: 'history canary delta 9 2',
      }),
    }));

    adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.delta',
      event_id: 'user-delta',
      item_id: 'user-1',
      delta: 'please reply out loud',
    });
    expect(adapter.decodeControl({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'user-final',
      item_id: 'user-1',
      transcript: '   ',
    })).toContainEqual(expect.objectContaining({
      type: 'transcript',
      event: expect.objectContaining({
        type: 'voice.transcript.final',
        text: 'please reply out loud',
      }),
    }));
  });

  it('strict-validates provider-owned outbound session, tool, and control shapes', () => {
    expect(() => createOpenAiToolSessionUpdate([{
      name: '',
      description: 'invalid empty provider tool name',
      parameters: {},
    }])).toThrow();
    expect(() => createOpenAiToolSessionUpdate([{
      name: 'tool',
      description: 'reject non-JSON provider tool parameters',
      parameters: { generatedAt: new Date() },
    }])).toThrow();
    // Tool parameters use the r0.45 data-only composition path, but this
    // entry point returns the canonical Protocol Voice transport DTO. Its
    // final parse retains the Protocol-owned wire bound rather than reviving
    // the removed SDK helper profile.
    expect(() => createOpenAiToolSessionUpdate([{
      name: 'tool',
      description: 'respect the canonical Voice transport envelope',
      parameters: { description: 'x'.repeat(64 * 1024 + 1) },
    }])).toThrow();
    expect(() => encodeOpenAiRealtimeClientEvent({
      type: 'response.create',
      response: { generatedAt: new Date() },
    })).toThrow();
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
    expect(() => encodeOpenAiRealtimeClientEvent({ type: 'session.update' })).toThrow();
    expect(encodeOpenAiRealtimeClientEvent({ type: 'response.create' }))
      .toEqual({ type: 'response.create' });

    const adapter = createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) });
    expect(adapter.encodeTurnControl('cancel_response')).toEqual({ type: 'response.cancel' });
    expect(adapter.encodeTurnControl('clear_input')).toEqual({ type: 'input_audio_buffer.clear' });
  });
});
