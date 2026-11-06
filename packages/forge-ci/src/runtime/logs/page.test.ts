import { describe, expect, it } from 'vitest';
import { ForgeCiLogV1Schema, type ForgeCiLogV1, type ForgeCiStepV1 } from '@happier-dev/triage-protocol/ci/v1';
import { buildForgeCiLogIndexV1 } from './index.js';
import { mergeForgeCiLogPagesV1, projectForgeCiLogPageV1, type ForgeCiLogPagePositionV1 } from './page.js';

const job = { selection: { kind: 'run', run: { v: 1, repository: { kind: 'github', deployment: 'https://github.com', repository: 'org/repo' }, runId: '42' } }, jobId: 'job' } as const;
type AvailableLog = Extract<ForgeCiLogV1, { kind: 'available' }>;
function log(text: string): AvailableLog { return { kind: 'available', job, logId: 'immutable', text, startLine: 1, startByte: 0, complete: true, continuation: null }; }
const measureSerializedBytes = (result: unknown) => new TextEncoder().encode(JSON.stringify(result)).byteLength;
const mintContinuation = (position: ForgeCiLogPagePositionV1) => JSON.stringify(position);

describe('shared immutable log carrier projection', () => {
  it('preserves exact BOM, CRLF, ANSI and original byte/line anchors through the canonical log consumer', () => {
    const source = log('\ufeff2026-01-01T00:00:01Z \u001b[31m😀failure\u001b[0m\r\nnext\nlast');
    const index = buildForgeCiLogIndexV1({ log: source });
    const result = projectForgeCiLogPageV1({ index, selection: { kind: 'all' }, mintContinuation, maxSerializedBytes: 10_000, measureSerializedBytes });
    expect(result.kind).toBe('value');
    if (result.kind !== 'value' || result.value.kind !== 'available') throw new Error('expected available page');
    expect(ForgeCiLogV1Schema.safeParse(result.value).success).toBe(true);
    const fragments = 'text' in result.value ? [{ text: result.value.text, startLine: result.value.startLine, startByte: result.value.startByte }] : result.value.fragments;
    expect(fragments.map(fragment => fragment.text).join('')).toBe(source.text);
    expect(fragments[0]).toMatchObject({ startLine: 1, startByte: 0 });
    expect(buildForgeCiLogIndexV1({ log: result.value }).plainText).toBe(index.plainText);
    expect(buildForgeCiLogIndexV1({ log: result.value }).complete).toBe(true);
  });

  it('pages an oversized Unicode line without loss and merges original immutable ranges into one complete index', () => {
    const text = '\ufeff2026-01-01T00:00:01Z \u001b[31m' + '😀error '.repeat(400) + '\u001b[0m\r\nlast';
    const source = log(text);
    const index = buildForgeCiLogIndexV1({ log: source });
    let position: ForgeCiLogPagePositionV1 | undefined;
    let merged: AvailableLog | undefined;
    const pages: AvailableLog[] = [];
    do {
      const result = projectForgeCiLogPageV1({ index, selection: { kind: 'all' }, ...(position === undefined ? {} : { position }), mintContinuation, maxSerializedBytes: 650, measureSerializedBytes });
      if (result.kind !== 'value' || result.value.kind !== 'available') throw new Error('expected paged log');
      const page = result.value;
      expect(measureSerializedBytes(result)).toBeLessThanOrEqual(650);
      expect(ForgeCiLogV1Schema.safeParse(page).success).toBe(true);
      for (const fragment of 'text' in page ? [{ text: page.text }] : page.fragments) expect(fragment.text).not.toMatch(/[\ud800-\udbff]$/u);
      pages.push(page);
      const combined = mergeForgeCiLogPagesV1({ previous: merged, page });
      if (combined.kind !== 'value' || combined.value.kind !== 'available') throw new Error('expected merged log');
      merged = combined.value;
      position = page.continuation === null ? undefined : JSON.parse(page.continuation) as ForgeCiLogPagePositionV1;
    } while (position !== undefined);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.at(-1)?.complete).toBe(true);
    expect(buildForgeCiLogIndexV1({ log: pages.at(-1)! }).complete).toBe(false);
    expect(merged).toBeDefined();
    const combinedIndex = buildForgeCiLogIndexV1({ log: merged! });
    expect(combinedIndex.complete).toBe(true);
    expect(combinedIndex.lines.map(line => line.rawText)).toEqual(index.lines.map(line => line.rawText));
    expect(combinedIndex.lines.map(line => [line.number, line.startByte, line.endByte])).toEqual(index.lines.map(line => [line.number, line.startByte, line.endByte]));
    expect(combinedIndex.plainText).toBe(index.plainText);
  });

  it('keeps explicit tail/step projections exact and never invents newline bytes between disjoint ranges', () => {
    const t = Date.parse('2026-01-01T00:00:01Z');
    const state = { phase: 'completed', outcome: 'failure', nativeLabel: 'failure', outcomeBucket: 'failed' } as const;
    const steps: ForgeCiStepV1[] = [{ id: 's2', name: 'failed', state, startedAtMs: t, completedAtMs: t + 1000 }, { id: 's9', name: 'other', state, startedAtMs: t + 2000, completedAtMs: t + 3000 }];
    const source = log('before\r\n2026-01-01T00:00:01Z failed\r\n2026-01-01T00:00:03Z other\nlast');
    const index = buildForgeCiLogIndexV1({ log: source, steps });
    const tail = projectForgeCiLogPageV1({ index, selection: { kind: 'tail', lines: 1 }, mintContinuation });
    if (tail.kind !== 'value' || tail.value.kind !== 'available') throw new Error('expected tail');
    expect(tail.value).toMatchObject({ complete: false, continuation: null, startLine: 4, startByte: index.lines[3]?.startByte });
    expect('fragments' in tail.value ? tail.value.fragments.map(fragment => fragment.text).join('') : tail.value.text).toBe('last');
    const selected = projectForgeCiLogPageV1({ index, selection: { kind: 'steps', stepIds: ['s2'] }, mintContinuation });
    if (selected.kind !== 'value' || selected.value.kind !== 'available' || !('fragments' in selected.value)) throw new Error('expected fragments');
    expect(selected.value.fragments.map(fragment => [fragment.startLine, fragment.text])).toEqual([
      [1, 'before\r\n2026-01-01T00:00:01Z failed\r\n'], [4, 'last'],
    ]);
    expect(buildForgeCiLogIndexV1({ log: selected.value }).complete).toBe(false);
  });

  it('rejects invalid native selections, surrogate-splitting resume positions and carrier/cursor identity failures', () => {
    const index = buildForgeCiLogIndexV1({ log: log('😀line') });
    expect(projectForgeCiLogPageV1({ index, selection: { kind: 'all' }, position: { lineIndex: 0, utf16Offset: 1 }, mintContinuation })).toMatchObject({ kind: 'unavailable', failure: { code: 'invalid_log_page_position' } });
    expect(projectForgeCiLogPageV1({ index, selection: { kind: 'steps', stepIds: ['absent'] }, mintContinuation })).toMatchObject({ kind: 'unavailable' });
    expect(projectForgeCiLogPageV1({ index, selection: { kind: 'all' }, mintContinuation, maxSerializedBytes: 1, measureSerializedBytes })).toMatchObject({ kind: 'unavailable', failure: { code: 'insufficient_log_page_budget' } });
    const oversized = buildForgeCiLogIndexV1({ log: log('😀'.repeat(500)) });
    expect(projectForgeCiLogPageV1({ index: oversized, selection: { kind: 'all' }, mintContinuation: () => null, maxSerializedBytes: 650, measureSerializedBytes })).toMatchObject({ kind: 'unavailable', failure: { code: 'log_page_cursor_unavailable' } });
  });

  it('retains repeated pages and gaps while rejecting immutable identity, byte-overlap and native-line mismatches', () => {
    const first: AvailableLog = { kind: 'available', job, logId: 'immutable', fragments: [{ text: 'a\r\n', startLine: 1, startByte: 0 }], startLine: 1, startByte: 0, complete: false, continuation: 'next' };
    expect(mergeForgeCiLogPagesV1({ previous: first, page: { ...first } })).toEqual({ kind: 'value', value: first });
    const equalText = log('same native bytes');
    expect(mergeForgeCiLogPagesV1({ previous: equalText, page: { ...equalText, complete: false, continuation: 'already-covered' } })).toEqual({ kind: 'value', value: equalText });
    expect(mergeForgeCiLogPagesV1({ previous: first, page: { ...first, logId: 'other' } })).toMatchObject({ kind: 'unavailable', failure: { code: 'log_page_identity_mismatch' } });
    const next = { ...first, fragments: [{ text: 'b', startLine: 2, startByte: 3 }], startLine: 2, startByte: 3, complete: true, continuation: null };
    const combined = mergeForgeCiLogPagesV1({ previous: first, page: next });
    if (combined.kind !== 'value' || combined.value.kind !== 'available') throw new Error('expected merge');
    expect(buildForgeCiLogIndexV1({ log: combined.value }).complete).toBe(true);
    expect(mergeForgeCiLogPagesV1({ previous: combined.value, page: first })).toEqual({ kind: 'value', value: combined.value });
    expect(mergeForgeCiLogPagesV1({ previous: first, page: { ...next, fragments: [{ text: 'X', startLine: 1, startByte: 1 }] } })).toMatchObject({ kind: 'unavailable', failure: { code: 'log_page_content_mismatch' } });
    expect(mergeForgeCiLogPagesV1({ previous: first, page: { ...next, fragments: [{ text: 'b', startLine: 7, startByte: 3 }] } })).toMatchObject({ kind: 'unavailable', failure: { code: 'log_page_position_mismatch' } });
    const gap = mergeForgeCiLogPagesV1({ previous: first, page: { ...next, fragments: [{ text: 'b', startLine: 20, startByte: 20 }] } });
    if (gap.kind !== 'value' || gap.value.kind !== 'available') throw new Error('expected honest partial merge');
    expect(buildForgeCiLogIndexV1({ log: gap.value }).complete).toBe(false);
    expect(buildForgeCiLogIndexV1({ log: gap.value }).lines.map(line => line.number)).toEqual([1, 20]);
  });

  it('keeps an empty EOF resume at its original end rather than claiming an empty complete log', () => {
    const index = buildForgeCiLogIndexV1({ log: log('first\nlast') });
    for (const position of [{ lineIndex: 2, utf16Offset: 0 }, { lineIndex: 1, utf16Offset: 4 }]) {
      const result = projectForgeCiLogPageV1({ index, selection: { kind: 'all' }, position, mintContinuation });
      if (result.kind !== 'value' || result.value.kind !== 'available') throw new Error('expected EOF page');
      expect(result.value).toMatchObject({ text: '', startLine: 2, startByte: 10, complete: true, continuation: null });
      expect(buildForgeCiLogIndexV1({ log: result.value }).complete).toBe(false);
    }
  });
});
