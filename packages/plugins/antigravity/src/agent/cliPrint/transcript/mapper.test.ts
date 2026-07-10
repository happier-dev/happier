import { describe, expect, it } from 'vitest';

import {
  mapAntigravityTranscriptRecordToStep,
  mapAntigravityTranscriptRecordsToSteps,
  mapAntigravityTranscriptRecordToSteps,
  mapAntigravityTranscriptStepsToRuntimeEvents,
} from './mapper.js';

describe('Antigravity cliPrint transcript mapper', () => {
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

  it('emits canonical runtime events without pretending cliPrint has live permissions', () => {
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
      'transcript-agent-message-committed',
      'tool-call',
      'tool-result',
    ]);
    expect(events[0]).toMatchObject({
      agentId: 'antigravity',
      localId: 'assistant-1',
      body: { type: 'message', message: 'hi there' },
    });
  });

  it('maps transcript error records to a failed turn event', () => {
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
        sessionId: 'session-1',
        turnId: 'turn-1',
        issue: expect.objectContaining({
          code: 'antigravity_cliprint_transcript_error',
          sanitizedPreview: 'agy failed while applying changes',
        }),
      }),
    ]);
  });

  it('keeps checkpoint and system records observable as provider progress', () => {
    const events = mapAntigravityTranscriptStepsToRuntimeEvents({
      sessionId: 'session-1',
      turnId: 'turn-1',
      emittedAtMs: 123,
      steps: [
        { id: 'checkpoint-1', kind: 'checkpoint', checkpointId: 'cp-1' },
        { id: 'system-1', kind: 'system_message', text: 'Resuming from a compaction' },
      ],
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'turn-progress',
        sessionId: 'session-1',
        turnId: 'turn-1',
        agentId: 'antigravity',
        source: 'cliprint_transcript',
        detail: {
          type: 'checkpoint',
          checkpointId: 'cp-1',
          localId: 'checkpoint-1',
        },
      }),
      expect.objectContaining({
        kind: 'turn-progress',
        sessionId: 'session-1',
        turnId: 'turn-1',
        agentId: 'antigravity',
        source: 'cliprint_transcript',
        detail: {
          type: 'system_message',
          text: 'Resuming from a compaction',
          localId: 'system-1',
        },
      }),
    ]);
  });
});
