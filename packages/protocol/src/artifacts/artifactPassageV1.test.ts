import { describe, expect, it } from 'vitest';
import { captureDocPassageV1, docPassageEditTargetV1, locateDocPassageV1, prepareDocEditBodyV1 } from './artifactPassageV1.js';

const ref = { kind: 'doc' as const, artifactId: 'doc', serverId: 'home' };
const revision = { headerVersion: 1, bodyVersion: 2 };
const source = '😀 first **again** / again!';
const start = source.lastIndexOf('again');

describe('revision-qualified Doc source operations', () => {
  it.each([
    { source: '# Plans\n\n😀 Welcome home! Keep prices steady.\n\nNext steps.', selection: 'Welcome', whole: '😀 Welcome home! Keep prices steady.' },
    { source: 'First plans.\n\nWe keep prices steady. The oven pays for itself.\n\nNext steps.',
      selection: 'prices steady. The oven', whole: 'We keep prices steady. The oven pays for itself.' },
    { source: 'Earlier plans.\r\n \r\nDr. Smith will keep prices\r\nsteady for regulars.\r\n\r\nNext steps.',
      selection: 'prices\r\nsteady', whole: 'Dr. Smith will keep prices\r\nsteady for regulars.' },
  ])('keeps the highlight while expanding its containing paragraphs ($selection)', ({ source, selection, whole }) => {
    const start = source.indexOf(selection);
    const passage = captureDocPassageV1({ ref, revision, source, range: { start, end: start + selection.length } });
    expect(passage.quote).toBe(selection);
    expect(passage.range).toEqual({ start, end: start + selection.length });
    const target = docPassageEditTargetV1(passage);
    expect(target.quote).toBe(whole);
    expect(source.slice(target.range.start, target.range.end)).toBe(whole);
    expect(prepareDocEditBodyV1({ ref, revision, source, proposal: { target, baseRevision: revision,
      before: whole, after: 'Rewritten.', reason: '' } })).toBe(source.replace(whole, 'Rewritten.'));
  });

  it('captures the selected second occurrence from UTF-16 source without searching rendered text', () => {
    expect(captureDocPassageV1({ ref, revision, source, range: { start, end: start + 5 } })).toEqual({
      ref, revision, range: { start, end: start + 5 }, quote: 'again', prefix: source.slice(0, start), suffix: '!',
    });
    expect(() => captureDocPassageV1({ ref: { kind: 'doc', artifactId: 'doc' }, revision,
      source, range: { start, end: start + 5 } })).toThrow();
    expect(() => captureDocPassageV1({ ref, revision, source, range: { start: 0, end: source.length + 1 } })).toThrow();
  });

  it('never picks the first duplicate when displaying a changed revision', () => {
    const target = captureDocPassageV1({ ref, revision, source, range: { start, end: start + 5 } });
    expect(locateDocPassageV1({ target, source, revision })).toEqual({ state: 'exact', range: target.range });
    const later = { headerVersion: 2, bodyVersion: 3 };
    expect(locateDocPassageV1({ target, source: `intro ${source}`, revision: later })).toEqual({ state: 'relocated', range: { start: start + 6, end: start + 11 } });
    const { prefix: _prefix, suffix: _suffix, ...legacy } = target;
    expect(locateDocPassageV1({ target: legacy, source: `intro ${source}`, revision: later })).toEqual({ state: 'detached' });
    expect(locateDocPassageV1({ target: { ...target, prefix: ' / ', suffix: '!' },
      source: `intro ${source}`, revision: later })).toEqual({ state: 'relocated', range: { start: start + 6, end: start + 11 } });
    expect(locateDocPassageV1({ target, source: 'gone', revision: later })).toEqual({ state: 'detached' });
  });

  it('replaces exactly the reviewed source occurrence and refuses either version mismatch', () => {
    const target = captureDocPassageV1({ ref, revision, source, range: { start, end: start + 5 } });
    const proposal = { target, baseRevision: revision, before: 'again', after: 'once', reason: 'Avoid repetition' };
    expect(prepareDocEditBodyV1({ proposal, ref, revision, source })).toBe('😀 first **again** / once!');
    for (const changed of [{ ...revision, headerVersion: 2 }, { ...revision, bodyVersion: 3 }]) {
      expect(() => prepareDocEditBodyV1({ proposal, ref, revision: changed, source })).toThrow('version_mismatch');
    }
    expect(() => prepareDocEditBodyV1({ proposal, ref: { ...ref, serverId: 'other' }, revision, source })).toThrow('server_target_mismatch');
    expect(() => prepareDocEditBodyV1({ proposal, ref, revision, source: source.replace(/again/g, 'other') })).toThrow('doc_passage_mismatch');
  });
});
