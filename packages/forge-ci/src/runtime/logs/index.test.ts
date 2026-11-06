import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ForgeCiJobV1Schema } from '@happier-dev/triage-protocol/ci/v1';
import type { ForgeCiLogV1, ForgeCiStepV1 } from '@happier-dev/triage-protocol/ci/v1';
import { buildForgeCiLogIndexV1, decodeForgeCiLogBytesV1 } from './index.js';
import { selectForgeCiLogLinesV1, selectLogLinesV1 } from './selection.js';
import { mergeForgeCiLogPagesV1 } from './page.js';

const job = { selection: { kind: 'run', run: { v: 1, repository: { kind: 'github', deployment: 'https://github.com', repository: 'org/repo' }, runId: '42' } }, jobId: 'job' } as const;
const state = { phase: 'completed', outcome: 'failure', outcomeBucket: 'failed', nativeLabel: 'failure' } as const;
function log(text: string): Extract<ForgeCiLogV1, { kind: 'available' }> {
  return { kind: 'available', job, logId: 'log', text, startLine: 1, startByte: 0, complete: true, continuation: null };
}
function step(id: string, startedAtMs?: number, completedAtMs?: number): ForgeCiStepV1 {
  return { id, name: id, state, ...(startedAtMs === undefined ? {} : { startedAtMs }), ...(completedAtMs === undefined ? {} : { completedAtMs }) };
}

describe('shared hosted log index', () => {
  it('selects an excerpt only from the admitted original lines without changing their identity', () => {
    const index = buildForgeCiLogIndexV1({ log: log('first\nsecond\nthird\nlast') });
    const selected = selectForgeCiLogLinesV1(index, { kind: 'excerpt', startLine: 2, endLine: 3 });
    expect(selected).toMatchObject({ kind: 'value', lines: [index.lines[1], index.lines[2]], olderRemaining: true });
    expect(index.lines).toHaveLength(4);
  });

  it('rejects a zero-line tail instead of expanding it to every admitted line', () => {
    const index = buildForgeCiLogIndexV1({ log: log('first\nlast') });
    expect(selectLogLinesV1(index, { kind: 'tail', lines: 0 })).toMatchObject({ kind: 'unavailable' });
  });

  it('covers the captured GitHub step seconds while preserving tied candidates, groups and original anchors', () => {
    // The exact job Action payload is captured in this package; reuse the existing 3,113-byte native log fixture.
    const captured = ForgeCiJobV1Schema.parse(JSON.parse(readFileSync('src/runtime/logs/github-failed-job.fixture.json', 'utf8')));
    if (captured.steps.kind !== 'available') throw new Error('Captured job must contain its native steps');
    const text = readFileSync('../plugins/scm-github/src/ui/forge/actions/ActionsPage.failed-job.fixture.txt', 'utf8');
    expect(new TextEncoder().encode(text)).toHaveLength(3113);
    const source = { ...log(text), job: captured.ref };
    const exact = buildForgeCiLogIndexV1({ log: source, steps: captured.steps.values });
    // The native mapper supplies this source-precision fact, not a guessed sub-second completion time.
    const steps = captured.steps.values.map(value => ({ ...value, timestampPrecision: 'second' as const }));
    const index = buildForgeCiLogIndexV1({ log: source, steps, baseline: exact });
    expect(index.lines).toHaveLength(51);
    expect(index.lines.every(line => line.attribution.kind === 'ambiguous' && line.attribution.stepIds.join(',') === '1,2,3,4')).toBe(true);
    expect(index.lines[48]).toMatchObject({ number: 49, plainText: '##[error]Fake test failure for QA' });
    expect(index.lines.map(line => line.originalText).join('')).toBe(text);
    expect(index.groups).toHaveLength(6);
    expect(index.groups.every(group => group.closed)).toBe(true);
    const details = index.groups.find(group => group.title === 'forge-qa test details');
    expect(index.lines.find(line => line.plainText === 'forge-qa shard two')?.groupIds).toContain(details?.id);
    const selected = selectForgeCiLogLinesV1(index, { kind: 'steps', stepIds: ['2'] });
    expect(selected).toMatchObject({ kind: 'value', ambiguous: true, unattributed: false });
    if (selected.kind === 'value') expect(selected.lines).toContain(index.lines[48]);
    expect(index.work).toEqual({ decodedLines: 0, tokenizedLines: 0, indexedLines: 51 });
    expect(index.lines[48]?.tokens).toBe(exact.lines[48]?.tokens);
    expect(index.groups).toBe(exact.groups);
    expect(buildForgeCiLogIndexV1({ log: source, steps, baseline: index })).toBe(index);
  });

  it('includes the end of a coarse second but leaves exact sub-second windows and outside context unchanged', () => {
    const t = Date.parse('2026-01-01T00:00:01Z');
    const text = [t - 1, t, t + 999, t + 1000].map(at => `${new Date(at).toISOString()} line`).join('\n');
    const steps = [{ ...step('coarse', t, t), timestampPrecision: 'second' as const }, step('precise', t + 100, t + 200)];
    const index = buildForgeCiLogIndexV1({ log: log(text), steps });
    expect(index.lines.map(line => line.attribution)).toEqual([
      { kind: 'unattributed', stepIds: [] }, { kind: 'step', stepIds: ['coarse'] },
      { kind: 'step', stepIds: ['coarse'] }, { kind: 'unattributed', stepIds: [] },
    ]);
  });

  it('decodes split UTF-8/BOM/CRLF and preserves original line/byte anchors and plain offsets', () => {
    const text = '\ufeff2026-01-01T00:00:01.000Z \u001b[31m😀failure\u001b[0m\r\nnext\r\n';
    const bytes = new TextEncoder().encode(text);
    const decoded = decodeForgeCiLogBytesV1([bytes.slice(0, 2), bytes.slice(2, 32), bytes.slice(32, 34), bytes.slice(34)]);
    const index = buildForgeCiLogIndexV1({ log: log(decoded) });
    expect(index.lines.map(line => line.plainText)).toEqual(['😀failure', 'next']);
    expect(index.lines[0]).toMatchObject({ number: 1, startByte: 3, plainOffset: 0, timestampMs: Date.parse('2026-01-01T00:00:01Z') });
    expect(index.lines[1]).toMatchObject({ number: 2, startByte: new TextEncoder().encode(text.split('\n')[0] + '\n').length, plainOffset: 10 });
    expect(index.lines[0]?.tokens[0]).toMatchObject({ text: '😀failure', start: 0, end: 9, style: { foreground: '#800000' } });
  });

  it('keeps sparse native steps, same-second ties, missing times and pre/postamble truthful', () => {
    const t = Date.parse('2026-01-01T00:00:01Z');
    const index = buildForgeCiLogIndexV1({
      log: log('preamble\n2026-01-01T00:00:01Z tied\n2026-01-01T00:00:03Z last\npostamble'),
      steps: [step('s2', t, t + 1000), step('s9', t, t + 1000), step('s40', t + 2000, t + 3000), step('missing')],
    });
    expect(index.lines.map(line => line.attribution)).toEqual([
      { kind: 'unattributed', stepIds: [] }, { kind: 'ambiguous', stepIds: ['s2', 's9'] },
      { kind: 'step', stepIds: ['s40'] }, { kind: 'unattributed', stepIds: [] },
    ]);
    const selected = selectForgeCiLogLinesV1(index, { kind: 'steps', stepIds: ['s2'] });
    expect(selected.kind).toBe('value');
    if (selected.kind === 'value') {
      expect(selected.lines.map(line => line.number)).toEqual([1, 2, 4]);
      expect(selected.ambiguous).toBe(true);
      expect(selected.unattributed).toBe(true);
    }
    expect(selectForgeCiLogLinesV1(index, { kind: 'steps', stepIds: ['unknown'] })).toMatchObject({ kind: 'unavailable', failure: { code: 'invalid_step_selection' } });
    expect(selectForgeCiLogLinesV1(index, { kind: 'tail', lines: 2 })).toMatchObject({ lines: [index.lines[2], index.lines[3]], olderRemaining: true });
  });

  it('retains nested/unclosed/unmatched groups as hints and keeps their original lines', () => {
    const index = buildForgeCiLogIndexV1({ log: log('##[endgroup]\n##[group]outer\n##[group]inner\nbody\n##[endgroup]\nlast') });
    expect(index.lines).toHaveLength(6);
    expect(index.groups.map(group => ({ title: group.title, parentId: group.parentId, closed: group.closed }))).toEqual([
      { title: 'outer', parentId: null, closed: false }, { title: 'inner', parentId: index.groups[0]?.id, closed: true },
    ]);
    expect(index.lines[3]?.groupIds).toEqual(index.groups.map(group => group.id));
    expect(index.issues).toContain('unmatched_group_end:1');
    expect(index.issues).toContain('unclosed_group:2');
  });

  it('indexes 100k lines once and reuses content, tokens and groups through equal wrappers and step changes', () => {
    const text = Array.from({ length: 100_000 }, (_, i) => `2026-01-01T00:00:01Z line ${i}`.padEnd(100, 'x')).join('\n');
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThanOrEqual(10_000_000);
    const first = buildForgeCiLogIndexV1({ log: log(text), steps: [step('s2', 0, Date.parse('2026-01-02T00:00:01Z'))] });
    expect(first.work).toEqual({ decodedLines: 100_000, tokenizedLines: 100_000, indexedLines: 100_000 });
    const equal = buildForgeCiLogIndexV1({ log: { ...log(text) }, steps: [step('s2', 0, Date.parse('2026-01-02T00:00:01Z'))], baseline: first });
    expect(equal === first).toBe(true);
    const changed = buildForgeCiLogIndexV1({ log: log(text), steps: [step('s9', 0, Date.parse('2026-01-02T00:00:01Z'))], baseline: equal });
    expect(changed.work).toEqual({ decodedLines: 0, tokenizedLines: 0, indexedLines: 100_000 });
    expect(changed.lines[0]?.tokens).toBe(first.lines[0]?.tokens);
    expect(changed.groups).toBe(first.groups);
    expect(selectForgeCiLogLinesV1(equal, { kind: 'all' })).toMatchObject({ lines: first.lines });
    expect(buildForgeCiLogIndexV1({ log: log(text), steps: [{ ...step('s2', 0, Date.parse('2026-01-02T00:00:01Z')), name: 'renamed' }], baseline: first })).toBe(first);
    const coverage = buildForgeCiLogIndexV1({ log: { ...log(text), complete: false, continuation: 'older' }, steps: [step('s2', 0, Date.parse('2026-01-02T00:00:01Z'))], baseline: first });
    expect(coverage.lines).toBe(first.lines);
    expect(coverage.work).toEqual({ decodedLines: 0, tokenizedLines: 0, indexedLines: 0 });
  });

  it('reuses unchanged admitted fragments when a new range arrives and never joins across a gap', () => {
    const base = { ...log(''), fragments: [{ text: '\u001b[31mred\n', startLine: 20, startByte: 90 }], complete: false, continuation: 'older' };
    const { text: _text, ...fragmentLog } = base;
    const first = buildForgeCiLogIndexV1({ log: fragmentLog });
    const next = buildForgeCiLogIndexV1({ log: { ...fragmentLog, fragments: [...fragmentLog.fragments, { text: 'plain', startLine: 40, startByte: 1000 }] }, baseline: first });
    expect(next.lines.map(line => line.number)).toEqual([20, 40]);
    expect(next.lines[0]).toBe(first.lines[0]);
    expect(next.lines[1]?.tokens[0]?.style).toEqual({});
    expect(next.work.decodedLines).toBe(1);
    expect(selectForgeCiLogLinesV1(next, { kind: 'all' })).toMatchObject({ olderRemaining: true });
  });

  it.each([100, 1000])('indexes only appended lines after %i retained lines', count => {
    const text = Array.from({ length: count }, (_, i) => `retained ${i}\n`).join('');
    for (const fragmented of [false, true]) {
      const original = fragmented
        ? { kind: 'available' as const, job, logId: 'log', startLine: 1, startByte: 0, complete: true, continuation: null,
          fragments: [{ text, startLine: 1, startByte: 0 }] }
        : log(text);
      const first = buildForgeCiLogIndexV1({ log: original });
      let retainedReads = 0;
      for (const line of first.lines.slice(0, -1)) {
        for (const key of ['id', 'number', 'rawText', 'plainText', 'timestampMs'] as const) {
          const value = line[key];
          Object.defineProperty(line, key, { get: () => { retainedReads += 1; return value; } });
        }
      }
      const appended = 'fragments' in original
        ? { ...original, fragments: [...original.fragments, { text: 'arrived\n', startLine: count + 1, startByte: new TextEncoder().encode(text).length }] }
        : log(text + 'arrived\n');
      const next = buildForgeCiLogIndexV1({ log: appended, baseline: first });
      expect(next.work).toEqual({ decodedLines: 1, tokenizedLines: 1, indexedLines: 1 });
      expect(retainedReads).toBe(0);
      expect(next.lines[0]).toBe(first.lines[0]);
      expect(next.plainText).toBe(text + 'arrived');
      expect(selectForgeCiLogLinesV1(next, { kind: 'tail', lines: 1 })).toMatchObject({ lines: [{ number: count + 1, plainText: 'arrived' }] });
    }
  });

  it('continues partial ANSI/group lines and closes retained groups without changing earlier observations', () => {
    const steps = [step('s2', Date.parse('2026-01-01T00:00:01Z'), Date.parse('2026-01-01T00:00:02Z'))];
    const first = buildForgeCiLogIndexV1({ log: log('##[group]outer\n\u001b[31mred\n##[end'), steps });
    const text = '##[group]outer\n\u001b[31mred\n##[endgroup]\n2026-01-01T00:00:01Z next';
    const next = buildForgeCiLogIndexV1({ log: log(text), steps, baseline: first });
    const fresh = buildForgeCiLogIndexV1({ log: log(text), steps });
    expect(next.lines).toEqual(fresh.lines);
    expect(next.groups).toEqual(fresh.groups);
    expect(next.issues).toEqual([]);
    expect(first.groups[0]?.closed).toBe(false);
    expect(first.issues).toEqual(['unclosed_group:1']);
    expect(next.work.indexedLines).toBe(2);
    expect(next.lines[1]?.tokens).toBe(first.lines[1]?.tokens);
    expect(next.lines.at(-1)?.attribution).toEqual({ kind: 'step', stepIds: ['s2'] });
    const changedSteps = [{ ...steps[0]!, id: 's9' }];
    const reattributed = buildForgeCiLogIndexV1({ log: log(text), steps: changedSteps, baseline: next });
    expect(reattributed.work).toEqual({ decodedLines: 0, tokenizedLines: 0, indexedLines: 4 });
    expect(reattributed.lines.at(-1)?.attribution).toEqual({ kind: 'step', stepIds: ['s9'] });
    const followed = buildForgeCiLogIndexV1({ log: log(text + '\nmore'), steps: changedSteps, baseline: reattributed });
    expect(followed.work).toEqual({ decodedLines: 1, tokenizedLines: 1, indexedLines: 2 });
    expect(followed.lines).toEqual(buildForgeCiLogIndexV1({ log: log(text + '\nmore'), steps: changedSteps }).lines);
  });

  it('indexes only the new page when the page merger converts a text carrier to fragments', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `retained ${i}\n`).join('');
    const source = { ...log(text), complete: false, continuation: 'next' };
    const first = buildForgeCiLogIndexV1({ log: source });
    const merged = mergeForgeCiLogPagesV1({ previous: source,
      page: { ...log('arrived\n'), startLine: 1001, startByte: new TextEncoder().encode(text).length } });
    if (merged.kind !== 'value' || merged.value.kind !== 'available') throw new Error('Expected an admitted page');
    const next = buildForgeCiLogIndexV1({ log: merged.value, baseline: first });
    expect(next.work).toEqual({ decodedLines: 1, tokenizedLines: 1, indexedLines: 1 });
    expect(next.lines[0]).toBe(first.lines[0]);
    expect(next.lines.at(-1)?.plainText).toBe('arrived');
    expect(next.plainText).toBe(text + 'arrived');
  });

  it('matches a fresh index through repeated partial appends, forks, corrections and replacement', () => {
    let index = buildForgeCiLogIndexV1({ log: log('') });
    const observations = ['\ufeff##[group]out', '\ufeff##[group]outer\r\n\u001b[3',
      '\ufeff##[group]outer\r\n\u001b[31mred\n##[group]inn',
      '\ufeff##[group]outer\r\n\u001b[31mred\n##[group]inner\nbody\n##[endgroup]\n##[endgroup]\n',
      'replacement\nlast', 'replacement\ncorrected', ''];
    for (const text of observations) {
      const next = buildForgeCiLogIndexV1({ log: log(text), baseline: index });
      const fresh = buildForgeCiLogIndexV1({ log: log(text) });
      expect({ ...next, work: null }).toEqual({ ...fresh, work: null });
      const forkText = text + '\nindependent branch';
      const fork = buildForgeCiLogIndexV1({ log: log(forkText), baseline: index });
      expect(fork.lines).toEqual(buildForgeCiLogIndexV1({ log: log(forkText) }).lines);
      index = next;
    }
  });

  it('keeps one original line when a carrier splits it and qualifies group ids by exact job', () => {
    const pieces = { kind: 'available', job, logId: 'log', startLine: 1, startByte: 0, complete: true, continuation: null,
      fragments: [{ text: '##[group]title\nvery ', startLine: 1, startByte: 0 }, { text: 'long😀 line', startLine: 2, startByte: 20 }] } as const;
    const firstPieceBytes = new TextEncoder().encode(pieces.fragments[0].text).length;
    const first = buildForgeCiLogIndexV1({ log: { ...pieces, fragments: [pieces.fragments[0], { ...pieces.fragments[1], startByte: firstPieceBytes }] } });
    expect(first.lines.map(line => line.plainText)).toEqual(['##[group]title', 'very long😀 line']);
    expect(first.lines.map(line => line.number)).toEqual([1, 2]);
    const other = buildForgeCiLogIndexV1({ log: { ...log('##[group]title'), job: { ...job, jobId: 'other' } } });
    expect(other.groups[0]?.id).not.toBe(first.groups[0]?.id);
  });

  it('rebuilds one changed line while preserving peers and refuses to infer group continuity across unread ranges', () => {
    const first = buildForgeCiLogIndexV1({ log: log('a\nb\nc') });
    const changed = buildForgeCiLogIndexV1({ log: log('a\nB\nc'), baseline: first });
    expect(changed.work).toEqual({ decodedLines: 1, tokenizedLines: 1, indexedLines: 3 });
    expect(changed.lines[0]).toBe(first.lines[0]);
    expect(changed.lines[2]).toBe(first.lines[2]);
    const gap = buildForgeCiLogIndexV1({ log: { kind: 'available', job, logId: 'gap', startLine: 1, startByte: 0, complete: false, continuation: 'missing', fragments: [
      { text: '##[group]first\ninside\n', startLine: 1, startByte: 0 },
      { text: 'after gap', startLine: 20, startByte: 1000 },
    ] } });
    expect(gap.lines[2]?.groupIds).toEqual([]);
    expect(gap.issues).toContain('group_coverage_gap:20');
  });

  it('preserves exact EOL metadata and token identity when only carrier line endings change', () => {
    const first = buildForgeCiLogIndexV1({ log: log('a\r\n😀b\nlast') });
    expect(first.lines.map(line => line.lineEnding)).toEqual(['\r\n', '\n', '']);
    const changed = buildForgeCiLogIndexV1({ log: log('a\n😀b\nlast'), baseline: first });
    expect(changed.lines[0]?.lineEnding).toBe('\n');
    expect(changed.lines.map(line => line.tokens)).toEqual(first.lines.map(line => line.tokens));
    expect(changed.lines[1]?.tokens).toBe(first.lines[1]?.tokens);
    expect(changed.lines[1]?.startByte).toBe(2);
    expect(changed.work.tokenizedLines).toBe(0);
  });
});
