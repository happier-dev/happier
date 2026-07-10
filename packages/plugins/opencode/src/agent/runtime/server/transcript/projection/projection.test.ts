import { describe, expect, it } from 'vitest';

import {
  classifyOpenCodeAssistantCompletion,
  classifyOpenCodeMessageForProjection,
  classifyOpenCodePartForProjection,
  extractOpenCodeProjectedText,
} from './index.js';

describe('OpenCode transcript projection', () => {
  it('classifies assistant summary compaction as internal', () => {
    const projection = classifyOpenCodeMessageForProjection({
      info: {
        id: 'msg_compaction',
        role: 'assistant',
        summary: 'true',
        mode: 'worker',
        agent: 'worker',
      },
    });

    expect(projection.kind).toBe('compaction_internal');
  });

  it('requires paired mode and agent compaction fallback evidence', () => {
    expect(classifyOpenCodeMessageForProjection({
      info: { id: 'msg_pair', role: 'assistant', mode: 'compaction', agent: 'compaction' },
    }).kind).toBe('compaction_internal');

    expect(classifyOpenCodeMessageForProjection({
      info: { id: 'msg_custom_mode', role: 'assistant', mode: 'compaction', agent: 'worker' },
    }).kind).toBe('assistant_transcript');

    expect(classifyOpenCodeMessageForProjection({
      info: { id: 'msg_custom_agent', role: 'assistant', mode: 'worker', agent: 'compaction' },
    }).kind).toBe('assistant_transcript');
  });

  it('does not classify user messages as compaction internals', () => {
    const projection = classifyOpenCodeMessageForProjection({
      info: {
        id: 'msg_user',
        role: 'user',
        summary: true,
        mode: 'compaction',
        agent: 'compaction',
      },
    });

    expect(projection.kind).toBe('user_transcript');
  });

  it('classifies unknown roles as unknown instead of transcript content', () => {
    const projection = classifyOpenCodeMessageForProjection({
      info: {
        id: 'msg_system',
        role: 'system',
        time: { created: 12 },
      },
    });

    expect(projection).toMatchObject({
      kind: 'unknown',
      role: null,
      messageId: 'msg_system',
      createdAtMs: 12_000,
    });
  });

  it('filters internal parts from history text projection', () => {
    expect(extractOpenCodeProjectedText([
      { type: 'text', text: 'SYNTHETIC', synthetic: true },
      { type: 'step', text: 'IGNORED', ignored: true },
      { type: 'text', text: 'INTERNAL', internal: true },
      { type: 'reasoning', text: 'REASONING' },
      { type: 'tool', text: 'TOOL' },
      { type: 'step', text: 'VISIBLE_STEP' },
      { type: 'text', text: 'VISIBLE_TEXT' },
    ], { context: 'history_import' })).toBe('VISIBLE_STEPVISIBLE_TEXT');

    expect(classifyOpenCodePartForProjection(
      { type: 'text', text: 'SYNTHETIC', synthetic: true },
      { context: 'history_import' },
    ).kind).toBe('ignored_internal');
  });

  it('projects reasoning text only for live transcript streaming', () => {
    expect(classifyOpenCodePartForProjection(
      { type: 'reasoning', text: 'thinking out loud' },
      { context: 'live_transcript' },
    )).toMatchObject({
      kind: 'reasoning_text',
      text: 'thinking out loud',
    });

    expect(classifyOpenCodePartForProjection(
      { type: 'reasoning', text: 'hidden history reasoning' },
      { context: 'history_import' },
    ).kind).toBe('non_transcript');
  });

  it('classifies assistant completion only after completed time and non-continuation finish', () => {
    expect(classifyOpenCodeAssistantCompletion({
      info: {
        id: 'msg_tool_calls',
        role: 'assistant',
        finish: 'tool-calls',
        time: { completed: 10 },
      },
    }).kind).toBe('continuation');

    expect(classifyOpenCodeAssistantCompletion({
      info: {
        id: 'msg_stop_without_completed',
        role: 'assistant',
        finish: 'stop',
        time: { created: 9 },
      },
    }).kind).toBe('non_terminal');

    expect(classifyOpenCodeAssistantCompletion({
      info: {
        id: 'msg_done',
        role: 'assistant',
        finish: 'stop',
        time: { completed: 11 },
      },
    }).kind).toBe('terminal_success');
  });

  it('never treats compaction internals as assistant completion', () => {
    expect(classifyOpenCodeAssistantCompletion({
      info: {
        id: 'msg_compaction_done',
        role: 'assistant',
        summary: true,
        finish: 'stop',
        time: { completed: 12 },
      },
    }).kind).toBe('ignored_internal');
  });
});
