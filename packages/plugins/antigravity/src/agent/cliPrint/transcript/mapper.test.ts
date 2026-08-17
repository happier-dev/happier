import { readFileSync } from 'node:fs';

import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/plugin-sdk/sessions/external';
import { describe, expect, it } from 'vitest';

import { parseAntigravityTranscriptJsonl } from './jsonl.js';
import {
  mapAntigravityTranscriptRecordToStep,
  mapAntigravityTranscriptRecordsToSteps,
  mapAntigravityTranscriptRecordToSteps,
  mapAntigravityTranscriptStepsToRuntimeEvents,
  projectAntigravityTranscriptRecordsToExternalItems,
} from './mapper.js';

describe('Antigravity cliPrint transcript mapper', () => {
  it('projects only canonical transcript events and omits source-only checkpoint/system records', () => {
    const items = projectAntigravityTranscriptRecordsToExternalItems({
      conversationId: 'conversation-canonical',
      records: [
        { record: { step_index: 1, type: 'USER_INPUT', text: 'inspect' }, startOffsetBytes: 0, endOffsetBytes: 10 },
        {
          record: {
            step_index: 2,
            type: 'PLANNER_RESPONSE',
            text: 'working',
            tool_calls: [{ name: 'list_dir', args: { path: '.' } }],
          },
          startOffsetBytes: 10,
          endOffsetBytes: 20,
        },
        { record: { step_index: 3, type: 'LIST_DIRECTORY', content: ['README.md'] }, startOffsetBytes: 20, endOffsetBytes: 30 },
        { record: { step_index: 4, type: 'checkpoint', checkpointId: 'cp-1' }, startOffsetBytes: 30, endOffsetBytes: 40 },
        { record: { step_index: 5, type: 'system_message', text: 'compacted' }, startOffsetBytes: 40, endOffsetBytes: 50 },
        { record: { step_index: 6, type: 'error', message: 'boom' }, startOffsetBytes: 50, endOffsetBytes: 60 },
      ],
    });

    expect(items.map((item) => item.messageRole)).toEqual([
      'user',
      'agent',
      'event',
      'event',
      'event',
    ]);
    expect(items.map((item) => {
      const parsed = AgentExternalSessionTranscriptRawRecordSchema.safeParse(item.raw);
      return parsed.success ? 'parsed' : `unparsed:${JSON.stringify(item.raw)}`;
    })).toEqual(items.map(() => 'parsed'));
    expect(items.at(-1)).toMatchObject({
      id: 'antigravity-turn-conversation-canonical-byte-50-step-6',
      messageRole: 'event',
      raw: {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'antigravity',
          data: { type: 'turn_failed', id: 'antigravity-turn-conversation-canonical-byte-50-step-6' },
        },
      },
    });
  });

  it('classifies the sanitized source fixture once for cliPrint, external, and terminal consumers', () => {
    const records = parseAntigravityTranscriptJsonl(readFileSync(
      new URL('./__fixtures__/transcript_full.semantic.sanitized.jsonl', import.meta.url),
      'utf8',
    ));
    const classify = () => mapAntigravityTranscriptRecordsToSteps(records, {
      generatedIdNamespace: 'fixture-conversation',
    });
    const expected = [
      {
        id: 'antigravity-turn-fixture-conversation-step-1',
        kind: 'user_message',
        text: 'Inspect the demo workspace.',
      },
      {
        id: 'antigravity-turn-fixture-conversation-step-2',
        kind: 'assistant_message',
        text: 'I will inspect the demo files.',
      },
      {
        id: 'antigravity-turn-fixture-conversation-step-2-tool-1',
        kind: 'tool_call',
        toolName: 'list_dir',
        input: { path: '.' },
      },
      {
        id: 'antigravity-turn-fixture-conversation-step-2-tool-2',
        kind: 'tool_call',
        toolName: 'view_file',
        input: { path: 'README.md' },
      },
      {
        id: 'antigravity-turn-fixture-conversation-step-3',
        kind: 'tool_result',
        toolCallId: 'antigravity-turn-fixture-conversation-step-2-tool-1',
        output: ['README.md', 'src'],
      },
      {
        id: 'antigravity-turn-fixture-conversation-step-5',
        kind: 'tool_result',
        toolCallId: 'antigravity-turn-fixture-conversation-step-2-tool-2',
        output: '# Demo workspace',
      },
      {
        id: 'antigravity-turn-fixture-conversation-step-6',
        kind: 'checkpoint',
        checkpointId: 'checkpoint-redacted',
      },
      {
        id: 'antigravity-turn-fixture-conversation-step-7',
        kind: 'system_message',
        text: 'Compacted sanitized context.',
      },
    ];

    const cliPrintClassification = classify();
    const externalClassification = classify();
    const terminalClassification = classify();

    expect(cliPrintClassification).toEqual(expected);
    expect(externalClassification).toEqual(cliPrintClassification);
    expect(terminalClassification).toEqual(cliPrintClassification);
  });

  it('projects external transcript items from the same semantic classifier with byte-stable fallback ids', () => {
    expect(projectAntigravityTranscriptRecordsToExternalItems({
      conversationId: 'conversation-1',
      records: [
        {
          record: {
            type: 'PLANNER_RESPONSE',
            text: 'I will inspect it.',
            tool_calls: [{ name: 'list_dir', args: { path: '.' } }],
            created_at: '2026-07-23T08:00:00Z',
          },
          startOffsetBytes: 41,
          endOffsetBytes: 200,
        },
      ],
    })).toEqual([
      {
        id: 'antigravity-conversation-1-byte-41-item-1',
        createdAtMs: Date.parse('2026-07-23T08:00:00Z'),
        messageRole: 'agent',
        raw: {
          role: 'agent',
          content: {
            type: 'acp',
            agentId: 'antigravity',
            data: { type: 'message', message: 'I will inspect it.' },
          },
        },
      },
      {
        id: 'antigravity-turn-conversation-1-byte-41-tool-1',
        createdAtMs: Date.parse('2026-07-23T08:00:00Z'),
        localId: 'antigravity-turn-conversation-1-byte-41-tool-1',
        messageRole: 'event',
        raw: {
          role: 'agent',
          content: {
            type: 'acp',
            agentId: 'antigravity',
            data: {
              type: 'tool-call',
              callId: 'antigravity-turn-conversation-1-byte-41-tool-1',
              name: 'list_dir',
              input: { path: '.' },
              id: 'antigravity-turn-conversation-1-byte-41-tool-1',
            },
          },
        },
      },
    ]);
  });

  it('strips Antigravity prompt scaffolding from user steps and projected transcript rows', () => {
    const content = '<USER_REQUEST>\nAudit the link flow\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nopen file: /repo/secret/notes.md\n</ADDITIONAL_METADATA>';

    expect(mapAntigravityTranscriptRecordToStep({ step_index: 0, type: 'USER_INPUT', content })).toEqual({
      id: 'antigravity-step-0',
      kind: 'user_message',
      text: 'Audit the link flow',
    });

    const [item] = projectAntigravityTranscriptRecordsToExternalItems({
      conversationId: 'conversation-scaffolding',
      records: [{ record: { step_index: 0, type: 'USER_INPUT', content }, startOffsetBytes: 0, endOffsetBytes: 10 }],
    });
    expect(item?.raw).toEqual({
      role: 'user',
      content: { type: 'text', text: 'Audit the link flow' },
    });
  });

  it.each([
    {
      name: 'unterminated request',
      content: '<USER_REQUEST>\nAudit the link flow\n<ADDITIONAL_METADATA>\nopen file: /repo/secret/notes.md',
    },
    {
      name: 'metadata before the request',
      content: '<ADDITIONAL_METADATA>\nopen file: /repo/secret/notes.md\n</ADDITIONAL_METADATA>\n<USER_REQUEST>\nAudit\n',
    },
    {
      name: 'repeated request tags',
      content: '<USER_REQUEST>\nAudit\n<USER_REQUEST>\nmore\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nopen file: /repo/secret/notes.md\n</ADDITIONAL_METADATA>',
    },
    {
      name: 'repeated close tags',
      content: '<USER_REQUEST>\nAudit\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nopen file: /repo/secret/notes.md\n</ADDITIONAL_METADATA>\n</USER_REQUEST>',
    },
    {
      name: 'metadata without any request scaffold',
      content: 'Audit\n<ADDITIONAL_METADATA>\nopen file: /repo/secret/notes.md\n</ADDITIONAL_METADATA>',
    },
    {
      name: 'truncated mid-metadata',
      content: '<USER_REQUEST>\nAudit\n<ADDITIONAL_METADATA>\nopen file: /repo/sec',
    },
  ])('drops the user row instead of leaking Antigravity workspace metadata on a $name', ({ content }) => {
    expect(mapAntigravityTranscriptRecordToStep({ step_index: 0, type: 'USER_INPUT', content })).toBeNull();

    expect(projectAntigravityTranscriptRecordsToExternalItems({
      conversationId: 'conversation-malformed-scaffolding',
      records: [{ record: { step_index: 0, type: 'USER_INPUT', content }, startOffsetBytes: 0, endOffsetBytes: 10 }],
    })).toEqual([]);
  });

  it('maps observed user, assistant, tool, checkpoint, and system records to Antigravity steps', () => {
    expect([
      mapAntigravityTranscriptRecordToStep({ type: 'user_input', text: 'hello' }),
      mapAntigravityTranscriptRecordToStep({ type: 'planner_response', text: 'hi there', id: 'assistant-1' }),
      mapAntigravityTranscriptRecordToStep({ type: 'run_command', command: 'pwd', id: 'tool-1' }),
      mapAntigravityTranscriptRecordToStep({ type: 'code_action', action: 'write_file', path: 'a.txt', id: 'tool-2' }),
      mapAntigravityTranscriptRecordToStep({ type: 'list_directory', path: '.', id: 'tool-3' }),
      mapAntigravityTranscriptRecordToStep({ type: 'checkpoint', checkpointId: 'cp-1' }),
      mapAntigravityTranscriptRecordToStep({ type: 'system_message', text: 'done' }),
      mapAntigravityTranscriptRecordToStep({ type: 'error', message: 'boom' }),
    ]).toEqual([
      { kind: 'user_message', text: 'hello' },
      { id: 'assistant-1', kind: 'assistant_message', text: 'hi there' },
      { id: 'tool-1', kind: 'tool_result', toolCallId: 'tool-1', output: '' },
      { id: 'tool-2', kind: 'tool_result', toolCallId: 'tool-2', output: '' },
      { id: 'tool-3', kind: 'tool_result', toolCallId: 'tool-3', output: '' },
      { kind: 'checkpoint', checkpointId: 'cp-1' },
      { kind: 'system_message', text: 'done' },
      { kind: 'error', message: 'boom' },
    ]);
  });

  it('maps planner tool calls separately from typed tool result records', () => {
    expect(mapAntigravityTranscriptRecordToSteps({
      id: 'planner-1',
      type: 'planner_response',
      text: 'I will inspect the workspace.',
      tool_calls: [
        { id: 'call-1', name: 'list_dir', args: { path: '.' } },
        { tool_call_id: 'call-2', tool_name: 'view_file', input: { path: 'README.md' } },
      ],
    })).toEqual([
      { id: 'planner-1', kind: 'assistant_message', text: 'I will inspect the workspace.' },
      { id: 'call-1', kind: 'tool_call', toolName: 'list_dir', input: { path: '.' } },
      { id: 'call-2', kind: 'tool_call', toolName: 'view_file', input: { path: 'README.md' } },
    ]);

    expect(mapAntigravityTranscriptRecordToSteps({
      id: 'result-1',
      type: 'list_directory',
      toolCallId: 'call-1',
      content: ['src', 'package.json'],
    })).toEqual([
      {
        id: 'result-1',
        kind: 'tool_result',
        toolCallId: 'call-1',
        output: ['src', 'package.json'],
      },
    ]);
  });

  it('pairs source-real id-less typed result records with preceding planner tool calls by order', () => {
    const steps = mapAntigravityTranscriptRecordsToSteps([
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        text: 'I will inspect the workspace.',
        tool_calls: [
          { name: 'list_dir', args: { path: '.' } },
          { name: 'view_file', args: { path: 'README.md' } },
        ],
      },
      {
        content: ['src', 'package.json'],
        created_at: '2026-06-20T10:00:00Z',
        source: 'tool',
        status: 'completed',
        step_index: 4,
        type: 'LIST_DIRECTORY',
      },
      {
        content: 'hello from readme',
        created_at: '2026-06-20T10:00:01Z',
        source: 'tool',
        status: 'completed',
        step_index: 5,
        type: 'VIEW_FILE',
      },
    ]);

    expect(steps).toEqual([
      { id: 'antigravity-step-3', kind: 'assistant_message', text: 'I will inspect the workspace.' },
      { id: 'antigravity-step-3-tool-1', kind: 'tool_call', toolName: 'list_dir', input: { path: '.' } },
      { id: 'antigravity-step-3-tool-2', kind: 'tool_call', toolName: 'view_file', input: { path: 'README.md' } },
      {
        id: 'antigravity-step-4',
        kind: 'tool_result',
        toolCallId: 'antigravity-step-3-tool-1',
        output: ['src', 'package.json'],
      },
      {
        id: 'antigravity-step-5',
        kind: 'tool_result',
        toolCallId: 'antigravity-step-3-tool-2',
        output: 'hello from readme',
      },
    ]);
  });

  it('namespaces generated step-index ids by runtime turn to avoid cross-turn transcript overwrites', () => {
    const steps = mapAntigravityTranscriptRecordsToSteps([
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        text: 'follow-up response',
        tool_calls: [
          { name: 'list_dir', args: { path: '.' } },
        ],
      },
      {
        content: ['README.md'],
        step_index: 3,
        type: 'LIST_DIRECTORY',
      },
      {
        id: 'provider-owned-step',
        type: 'PLANNER_RESPONSE',
        text: 'provider id stays stable',
      },
    ], { generatedIdNamespace: 'turn-2' });

    expect(steps).toEqual([
      {
        id: 'antigravity-turn-turn-2-step-2',
        kind: 'assistant_message',
        text: 'follow-up response',
      },
      {
        id: 'antigravity-turn-turn-2-step-2-tool-1',
        kind: 'tool_call',
        toolName: 'list_dir',
        input: { path: '.' },
      },
      {
        id: 'antigravity-turn-turn-2-step-3',
        kind: 'tool_result',
        toolCallId: 'antigravity-turn-turn-2-step-2-tool-1',
        output: ['README.md'],
      },
      {
        id: 'provider-owned-step',
        kind: 'assistant_message',
        text: 'provider id stays stable',
      },
    ]);
  });

  it('keeps id-less typed result content with a step-index fallback when no planner call is available', () => {
    expect(mapAntigravityTranscriptRecordToSteps({
      content: 'command stdout',
      created_at: '2026-06-20T10:00:02Z',
      source: 'tool',
      status: 'completed',
      step_index: 9,
      type: 'RUN_COMMAND',
    })).toEqual([
      {
        id: 'antigravity-step-9',
        kind: 'tool_result',
        toolCallId: 'antigravity-step-9',
        output: 'command stdout',
      },
    ]);
  });

  it('accepts source-real uppercase step families from agy transcripts', () => {
    expect(mapAntigravityTranscriptRecordToSteps({
      id: 'planner-2',
      type: 'PLANNER_RESPONSE',
      text: 'I will inspect the workspace.',
      tool_calls: [
        { id: 'call-3', name: 'list_dir', args: { path: '.' } },
      ],
    })).toEqual([
      { id: 'planner-2', kind: 'assistant_message', text: 'I will inspect the workspace.' },
      { id: 'call-3', kind: 'tool_call', toolName: 'list_dir', input: { path: '.' } },
    ]);

    expect(mapAntigravityTranscriptRecordToSteps({
      id: 'result-2',
      type: 'LIST_DIRECTORY',
      toolCallId: 'call-3',
      content: ['src'],
    })).toEqual([
      {
        id: 'result-2',
        kind: 'tool_result',
        toolCallId: 'call-3',
        output: ['src'],
      },
    ]);
  });

  it('does not re-emit transcript user echoes as committed session user messages', () => {
    const events = mapAntigravityTranscriptStepsToRuntimeEvents({
      sessionId: 'session-1',
      turnId: 'turn-1',
      emittedAtMs: 123,
      steps: [
        { kind: 'user_message', text: 'hello' },
      ],
    });

    expect(events).toEqual([]);
  });

  it('emits canonical Agent runtime event inputs without pretending cliPrint has live permissions', () => {
    const events = mapAntigravityTranscriptStepsToRuntimeEvents({
      sessionId: 'session-1',
      turnId: 'turn-1',
      emittedAtMs: 123,
      steps: [
        { kind: 'user_message', text: 'hello' },
        { id: 'assistant-1', kind: 'assistant_message', text: 'hi there' },
        { id: 'tool-1', kind: 'tool_call', toolName: 'run_command', input: { command: 'pwd' } },
        { id: 'tool-1-result', kind: 'tool_result', toolCallId: 'tool-1', output: 'ok' },
      ],
    });

    expect(events.map((event) => event.kind)).toEqual([
      'transcript-message-committed',
      'tool-call',
      'tool-result',
    ]);
    expect(events[0]).toMatchObject({
      messageId: 'assistant-1',
      role: 'assistant',
      text: 'hi there',
      turnId: 'turn-1',
    });
  });

  it('maps transcript error records to a canonical failed-turn event', () => {
    const events = mapAntigravityTranscriptStepsToRuntimeEvents({
      sessionId: 'session-1',
      turnId: 'turn-1',
      emittedAtMs: 123,
      steps: [
        { id: 'error-1', kind: 'error', message: 'agy failed while applying changes' },
      ],
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'turn-failed',
        turnId: 'turn-1',
        diagnostic: expect.objectContaining({
          code: 'antigravity_cliprint_transcript_error',
          message: 'agy failed while applying changes',
        }),
      }),
    ]);
  });

  it('does not retain generic progress payloads that cannot be represented by the canonical Agent event', () => {
    const events = mapAntigravityTranscriptStepsToRuntimeEvents({
      sessionId: 'session-1',
      turnId: 'turn-1',
      emittedAtMs: 123,
      steps: [
        { id: 'checkpoint-1', kind: 'checkpoint', checkpointId: 'cp-1' },
        { id: 'system-1', kind: 'system_message', text: 'Resuming from a compaction' },
      ],
    });

    expect(events).toEqual([]);
  });
});
