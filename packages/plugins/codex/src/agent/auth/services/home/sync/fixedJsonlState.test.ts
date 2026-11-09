import { describe, expect, it, vi } from 'vitest';

import { reconcileCodexSharedJsonlState } from './fixedJsonlState.js';

describe('reconcileCodexSharedJsonlState', () => {
  it.each([
    ['history.jsonl', 'equal'], ['session_index.jsonl', 'equal'],
    ['history.jsonl', 'prefix'], ['session_index.jsonl', 'prefix'],
    ['history.jsonl', 'empty'], ['session_index.jsonl', 'empty'],
  ] as const)('does not parse lines on repeated unchanged %s reconciliation (%s)', (entryPath, relation) => {
    const contents = Array.from({ length: 10_000 }, (_, id) =>
      JSON.stringify({ id: String(id), updated_at: '2026-10-23T10:00:00Z', text: 'fixture history' }),
    ).join('\n') + '\n';
    const currentContents = relation === 'prefix'
      ? contents + '{"id":"new-native-session","updated_at":"2026-10-24T10:00:00Z"}\n' : contents;
    const incomingContents = relation === 'empty' ? '' : contents;
    // Observe parser work without replacing either the parser or the real codec.
    const parse = vi.spyOn(JSON, 'parse');
    const split = vi.spyOn(String.prototype, 'split');
    let noOps = 0;
    let parsedLines = 0;
    let splitCalls = 0;
    try {
      for (let invocation = 0; invocation < 20; invocation++) {
        const result = reconcileCodexSharedJsonlState({ entryPath, currentContents, incomingContents });
        if (result?.appendText === '') noOps++;
      }
      parsedLines = parse.mock.calls.length;
      splitCalls = split.mock.calls.length;
    } finally { parse.mockRestore(); split.mockRestore(); }
    expect(noOps).toBe(20);
    expect(parsedLines).toBe(0);
    expect(splitCalls).toBe(0);
  });

  it('keeps rewritten and truncated fixed state current without metadata shortcuts', () => {
    const oldIndex = '{"id":"session","updated_at":"2026-10-22"}\n';
    const rewrittenIndex = '{"id":"session","updated_at":"2026-10-23"}\n';
    expect(rewrittenIndex.length).toBe(oldIndex.length);
    expect(reconcileCodexSharedJsonlState({ entryPath: 'session_index.jsonl',
      currentContents: oldIndex, incomingContents: rewrittenIndex })).toEqual({ appendText: rewrittenIndex });
    expect(reconcileCodexSharedJsonlState({ entryPath: 'session_index.jsonl',
      currentContents: oldIndex + rewrittenIndex, incomingContents: oldIndex })).toEqual({ appendText: '' });
    expect(reconcileCodexSharedJsonlState({ entryPath: 'history.jsonl',
      currentContents: 'old history\n', incomingContents: 'new history\n' })).toEqual({ appendText: 'new history\n' });
    expect(reconcileCodexSharedJsonlState({ entryPath: 'history.jsonl',
      currentContents: 'old history\nnew history\n', incomingContents: 'old history\n' })).toEqual({ appendText: '' });
    expect(reconcileCodexSharedJsonlState({ entryPath: 'history.jsonl',
      currentContents: 'partial prefix suffix\n', incomingContents: 'partial prefix' })).toEqual({ appendText: 'partial prefix\n' });
  });

  it('declines text merging for compressed rollout bytes', () => {
    // Valid zstd raw-block frame containing '{}\n'; the final newline must not
    // let binary content enter the UTF-8 append path instead of binary import.
    const compressed = Buffer.from('28b52ffd20031900007b7d0a', 'hex');
    expect(reconcileCodexSharedJsonlState({
      entryPath: 'sessions/rollout-2026-10-19T15-51-26-01a1546e-701a-7b41-8277-bdf4e72f2b28.jsonl.zst',
      currentContents: null,
      incomingContents: compressed.toString('utf8'),
    })).toBeNull();
  });

  it('adopts only exact complete-line extensions of the same rollout', () => {
    const entryPath = 'sessions/2026/10/19/rollout-2026-10-19T15-51-26-01a1546e-701a-7b41-8277-bdf4e72f2b28.jsonl';
    const metadata = '{"type":"session_meta","payload":{"id":"01a1546e-701a-7b41-8277-bdf4e72f2b28"}}\n';
    const answer = '{"type":"response_item","payload":{"role":"assistant"}}\n';
    expect(reconcileCodexSharedJsonlState({ entryPath, currentContents: metadata, incomingContents: metadata + answer }))
      .toEqual({ appendText: answer });
    expect(reconcileCodexSharedJsonlState({ entryPath, currentContents: metadata + answer, incomingContents: metadata }))
      .toEqual({ appendText: '' });
    expect(reconcileCodexSharedJsonlState({ entryPath, currentContents: metadata + answer, incomingContents: metadata + answer }))
      .toEqual({ appendText: '' });
    expect(reconcileCodexSharedJsonlState({ entryPath, currentContents: metadata, incomingContents: metadata + '{"type":' }))
      .toBeNull();
    expect(reconcileCodexSharedJsonlState({ entryPath, currentContents: metadata + answer, incomingContents: metadata + '{"type":"other"}\n' }))
      .toBeNull();
  });

  it('appends missing history and only newer per-session index records', () => {
    const historyFirst = '{"session_id":"first","ts":1,"text":"first prompt"}\n';
    const historySecond = '{"session_id":"second","ts":2,"text":"second prompt"}\n';
    const indexFirst = [
      '{"id":"first","thread_name":"First","updated_at":"2026-08-24T10:00:00.000Z"}',
      '{"id":"shared","thread_name":"Old","updated_at":"2026-08-24T09:00:00.000Z"}',
      '',
    ].join('\n');
    const indexSecond = [
      '{"id":"second","thread_name":"Second","updated_at":"2026-08-24T11:00:00.000Z"}',
      '{"id":"shared","thread_name":"New","updated_at":"2026-08-24T12:00:00.000Z"}',
      '',
    ].join('\n');
    let history = '';
    let index = '';
    for (const [incomingHistory, incomingIndex] of [
      [historyFirst, indexFirst], [historySecond, indexSecond], [historyFirst, indexFirst],
    ]) {
      history += reconcileCodexSharedJsonlState({
        entryPath: 'history.jsonl', currentContents: history, incomingContents: incomingHistory!,
      })!.appendText;
      index += reconcileCodexSharedJsonlState({
        entryPath: 'session_index.jsonl', currentContents: index, incomingContents: incomingIndex!,
      })!.appendText;
    }
    expect(history.trimEnd().split('\n')).toEqual([
      '{"session_id":"first","ts":1,"text":"first prompt"}',
      '{"session_id":"second","ts":2,"text":"second prompt"}',
    ]);
    expect(index.trimEnd().split('\n')).toEqual([
      '{"id":"first","thread_name":"First","updated_at":"2026-08-24T10:00:00.000Z"}',
      '{"id":"shared","thread_name":"Old","updated_at":"2026-08-24T09:00:00.000Z"}',
      '{"id":"second","thread_name":"Second","updated_at":"2026-08-24T11:00:00.000Z"}',
      '{"id":"shared","thread_name":"New","updated_at":"2026-08-24T12:00:00.000Z"}',
    ]);
    expect(reconcileCodexSharedJsonlState({
      entryPath: 'sessions/rollout.jsonl', currentContents: null, incomingContents: historyFirst,
    })).toBeNull();
    expect(reconcileCodexSharedJsonlState({
      entryPath: 'history.jsonl', currentContents: 'prior prompt', incomingContents: historyFirst,
    })!.appendText).toBe('\n' + historyFirst);
  });
});
