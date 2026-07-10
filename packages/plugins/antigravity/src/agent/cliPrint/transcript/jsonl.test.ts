import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  parseAntigravityTranscriptJsonl,
  readAntigravityTranscriptTail,
} from './jsonl.js';

describe('Antigravity cliPrint transcript JSONL', () => {
  it('parses complete JSONL records and fails on malformed complete lines', () => {
    expect(parseAntigravityTranscriptJsonl('{"type":"user_input","text":"hi"}\n{"type":"planner_response","text":"hello"}\n'))
      .toEqual([
        { type: 'user_input', text: 'hi' },
        { type: 'planner_response', text: 'hello' },
      ]);

    expect(() => parseAntigravityTranscriptJsonl('{"type":"user_input"}\nnot-json\n')).toThrow(/Malformed Antigravity transcript JSONL/);
  });

  it('skips a malformed partial tail line while tailing', () => {
    expect(parseAntigravityTranscriptJsonl('{"type":"user_input","text":"hi"}\n{"type":', {
      allowPartialLastLine: true,
    })).toEqual([{ type: 'user_input', text: 'hi' }]);
  });

  it('reads appended transcript lines, deduplicates stable records, and tolerates missing or rotated files', async () => {
    const dir = await mkdir(join(tmpdir(), `antigravity-jsonl-${Date.now()}-`), { recursive: true });
    const path = join(dir, 'transcript_full.jsonl');

    await expect(readAntigravityTranscriptTail({ path })).resolves.toMatchObject({
      records: [],
      missing: true,
    });

    await writeFile(path, [
      '{"id":"step-1","type":"planner_response","text":"hello"}',
      '{"id":"step-1","type":"planner_response","text":"hello duplicate"}',
      '{"id":"step-2","type":"run_command","command":"pwd"}',
      '{"type":',
    ].join('\n'));

    const first = await readAntigravityTranscriptTail({ path });
    expect(first.records).toEqual([
      { id: 'step-1', type: 'planner_response', text: 'hello' },
      { id: 'step-2', type: 'run_command', command: 'pwd' },
    ]);

    await writeFile(path, '{"id":"step-3","type":"planner_response","text":"after rotation"}\n');
    const rotated = await readAntigravityTranscriptTail({ path, cursor: first.cursor });
    expect(rotated.records).toEqual([
      { id: 'step-3', type: 'planner_response', text: 'after rotation' },
    ]);
  });

  it('does not re-emit id-less records when a rotated transcript repeats history', async () => {
    const dir = await mkdir(join(tmpdir(), `antigravity-jsonl-idless-${Date.now()}-`), { recursive: true });
    const path = join(dir, 'transcript_full.jsonl');

    await writeFile(path, [
      '{"type":"planner_response","text":"history"}',
      `{"type":"system_message","text":"${'old-only-padding'.repeat(20)}"}`,
      '',
    ].join('\n'));
    const first = await readAntigravityTranscriptTail({ path });
    expect(first.records).toEqual([
      { type: 'planner_response', text: 'history' },
      { type: 'system_message', text: 'old-only-padding'.repeat(20) },
    ]);

    await writeFile(path, [
      '{"type":"planner_response","text":"history"}',
      '{"type":"planner_response","text":"new"}',
      '',
    ].join('\n'));
    await expect(readAntigravityTranscriptTail({ path, cursor: first.cursor })).resolves.toMatchObject({
      records: [{ type: 'planner_response', text: 'new' }],
    });
  });

  it('resets the tail cursor when a compacted transcript regrows past the previous offset', async () => {
    const dir = await mkdir(join(tmpdir(), `antigravity-jsonl-regrow-${Date.now()}-`), { recursive: true });
    const path = join(dir, 'transcript_full.jsonl');

    await writeFile(path, [
      '{"id":"old-1","type":"planner_response","text":"old"}',
      `{"id":"old-2","type":"system_message","text":"${'old-padding'.repeat(20)}"}`,
      '',
    ].join('\n'));
    const first = await readAntigravityTranscriptTail({ path });

    await writeFile(path, [
      `{"type":"system_message","text":"${'compacted-history'.repeat(20)}"}`,
      '{"id":"new-1","type":"planner_response","text":"after compaction"}',
      '',
    ].join('\n'));

    await expect(readAntigravityTranscriptTail({ path, cursor: first.cursor })).resolves.toMatchObject({
      records: [
        { type: 'system_message', text: 'compacted-history'.repeat(20) },
        { id: 'new-1', type: 'planner_response', text: 'after compaction' },
      ],
    });
  });
});
