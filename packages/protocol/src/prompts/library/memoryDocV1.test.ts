import { describe, expect, it } from 'vitest';
import { MemoryDocBodyV1Schema, MemoryDocBodyV1StoredSchema, MemoryFactV1Schema, MemoryTopicReadV1Schema,
  isMemoryFactRenewableV1, readMemoryDocTopicV1, projectMemoryDocIndexV1, renderMemoryDocV1 } from './memoryDocV1.js';

const fact = (id: string, text = id) => ({ id, text, createdAtMs: 1, sourceSessionRef: null });

describe('memory document content', () => {
  it('projects mutation archive membership without persisting it and tolerates unknown read fields', () => {
    const expired = { ...fact('expired'), expiresAtMs: 5 };
    const forgotten = { ...fact('forgotten'), expiresAtMs: 5 };
    const body = MemoryDocBodyV1Schema.parse({ v: 1, index: [expired], topics: [
      { title: 'archive', summary: 'History', facts: [forgotten] },
    ] });
    const before = JSON.stringify(body);
    const projection = readMemoryDocTopicV1(body, 'archive', 10)!;
    const read = MemoryTopicReadV1Schema.parse({ ...projection, futureTopicField: true,
      facts: projection.facts.map(entry => ({ ...entry, futureFactField: true })) });
    expect(read).toEqual({ title: 'archive', summary: 'History', facts: [
      { ...forgotten, archivedByMutation: true }, { ...expired, archivedByMutation: false },
    ] });
    expect(read.facts.map(entry => isMemoryFactRenewableV1(entry, 10))).toEqual([false, true]);
    expect(isMemoryFactRenewableV1(expired, 4)).toBe(false);
    expect(MemoryFactV1Schema.safeParse(read.facts[0]).success).toBe(false);
    expect(MemoryDocBodyV1StoredSchema.parse({ ...body, topics: body.topics.map(topic => ({ ...topic,
      facts: topic.facts.map(entry => ({ ...entry, archivedByMutation: true, futureFactField: true })),
    })) })).toEqual(body);
    expect(JSON.stringify(body)).toBe(before);
    expect(MemoryTopicReadV1Schema.safeParse({ ...projection, facts: [{ ...forgotten, archivedByMutation: 'true' }] }).success).toBe(false);
  });
  it('retains decision source and actual approval in stored reads while keeping decision detail out of prepared context', () => {
    const decision = { reason: 'The team reviewed the migration', sourceMessageRef: { kind: 'session',
      session: { serverId: 'home', sessionId: 'session' }, messageId: 'committed' },
      approvedBy: { accountId: 'person', atMs: 10 } };
    const body = { v: 1, index: [], topics: [{ title: 'Storage', summary: 'Database choice', facts: [{ ...fact('decision', 'Use PostgreSQL'), decision }] }] };
    const stored = MemoryDocBodyV1StoredSchema.parse({ ...body, topics: [{ ...body.topics[0], facts: [{
      ...body.topics[0]!.facts[0], decision: { ...decision, futureAnnotation: true },
    }] }] });
    expect(stored).toEqual(body);
    const prepared = renderMemoryDocV1({ body: stored, nowMs: 20 });
    expect(prepared.markdown).toContain('Database choice');
    expect(prepared.markdown).not.toContain('Use PostgreSQL');
    expect(prepared.markdown).not.toContain(decision.reason);
    expect(MemoryDocBodyV1StoredSchema.safeParse({ ...body, topics: [{ ...body.topics[0], facts: [{
      ...body.topics[0]!.facts[0], decision: { ...decision, approvedBy: 'person' },
    }] }] }).success).toBe(false);
  });
  it('renders each loaded fact as one id-keyed AMR line with host provenance', () => {
    const body = MemoryDocBodyV1Schema.parse({ v: 1, index: [{
      ...fact('current', 'Prefer tea\nwith milk'), createdAtMs: Date.UTC(2026, 9, 8),
      sourceSessionRef: { serverId: 'home/a', sessionId: 'session b' },
      expiresAtMs: Date.UTC(2026, 10, 8), supersedes: 'previous',
    }], topics: [{ title: 'archive', summary: 'Earlier facts', facts: [fact('previous', 'Coffee')] }] });
    const rendered = renderMemoryDocV1({ body, nowMs: Date.UTC(2026, 9, 8) });
    expect(rendered.markdown.split('\n').filter(line => line.includes('[id:'))).toHaveLength(1);
    expect(rendered.markdown).toContain('- Prefer tea with milk [id: current;');
    expect(rendered.markdown).toContain('source: happier://session/home%2Fa/session%20b');
    expect(rendered.markdown).toContain('added: 2026-10-08');
    expect(rendered.markdown).toContain('expires: 2026-11-08');
    expect(rendered.markdown).toContain('supersedes: previous');
    expect(rendered.markdown).not.toContain('Coffee');
  });

  it('validates identities, dates and archived supersedes links without arbitrary text/count caps', () => {
    const body = { v: 1, index: [{ ...fact('new'), supersedes: 'old' }], topics: [{ title: 'archive', summary: 'Earlier facts', facts: [fact('old')] }] };
    expect(MemoryDocBodyV1Schema.safeParse(body).success).toBe(true);
    for (const invalid of [
      { ...body, index: [fact('old')] },
      { ...body, topics: [] },
      { ...body, index: [{ ...fact('new'), expiresAtMs: -1 }] },
      { ...body, index: [{ ...fact('new'), sourceSessionRef: { sessionId: 's' } }] },
      { ...body, topics: [...body.topics, { title: 'detail', summary: 'Details', facts: [fact('new')] }] },
      { ...body, topics: [...body.topics, { title: 'archive', summary: 'Duplicate title', facts: [] }] },
      { ...body, index: [fact('new')], topics: [{ title: 'detail', summary: 'Not\none line', facts: [] }] },
    ]) expect(MemoryDocBodyV1Schema.safeParse(invalid).success).toBe(false);
    expect(MemoryDocBodyV1Schema.parse({ v: 1, index: [fact('large', 'x'.repeat(100_000))], topics: [] }).index[0]?.text.length).toBe(100_000);
    expect(MemoryDocBodyV1StoredSchema.parse({ ...body, future: true, index: [{ ...body.index[0], future: true }] })).toEqual(body);
  });

  it('normalizes retained flat and index-only stored documents without accepting malformed known fields', () => {
    const legacy = { v: 1, facts: [fact('key')], archive: [fact('old')], future: true };
    expect(MemoryDocBodyV1StoredSchema.parse(legacy)).toMatchObject({ v: 1, index: [fact('key')],
      topics: [{ title: 'archive', facts: [fact('old')] }] });
    expect(MemoryDocBodyV1StoredSchema.parse({ v: 1, index: [fact('key')] })).toEqual({ v: 1, index: [fact('key')], topics: [] });
    expect(MemoryDocBodyV1StoredSchema.parse({ v: 1, facts: [fact('key')], archive: [] })).toEqual({ v: 1, index: [fact('key')], topics: [] });
    expect(MemoryDocBodyV1StoredSchema.safeParse({ v: 1, index: [fact('key')], topics: 'broken' }).success).toBe(false);
    // A legacy-looking suffix must not turn a malformed current document into an empty index.
    expect(MemoryDocBodyV1StoredSchema.safeParse({ v: 1, index: [fact('key')], topics: 'broken', facts: [], archive: [] }).success).toBe(false);
    expect(MemoryDocBodyV1StoredSchema.safeParse({ v: 1, index: 'broken', facts: [], archive: [] }).success).toBe(false);
    expect(MemoryDocBodyV1Schema.safeParse(legacy).success).toBe(false);
  });

  it('budgets whole index facts and topic summaries without loading detail, archive or expired fact text', () => {
    const body = MemoryDocBodyV1Schema.parse({ v: 1, index: [fact('a'), fact('b', 'second'), { ...fact('expired'), expiresAtMs: 5 }], topics: [
      { title: 'Build', summary: 'Build conventions', facts: [fact('detail', 'Only read on demand')] },
      { title: 'archive', summary: 'Earlier facts', facts: [fact('forgotten', 'Forgotten detail')] },
    ] });
    const all = renderMemoryDocV1({ body, nowMs: 5 });
    expect(all.loadedFactIds).toEqual(['a', 'b']);
    expect(all.markdown).not.toContain('expired');
    expect(all.markdown).not.toContain('forgotten');
    expect(all.markdown).not.toContain('Only read on demand');
    expect(all.markdown).toContain('Build conventions');
    expect(all.markdown).toContain('Earlier facts');
    expect(all).toMatchObject({ loadedTopicTitles: ['Build', 'archive'], notLoadedTopicTitles: [] });
    const first = renderMemoryDocV1({ body: { v: 1, index: [body.index[0]!], topics: [] }, nowMs: 5 });
    const budgeted = renderMemoryDocV1({ body, nowMs: 5, maxChars: first.markdown.length });
    expect(budgeted.markdown).toBe(first.markdown);
    expect(budgeted.loadedFactIds).toEqual(['a']);
    expect(budgeted.notLoadedFactIds).toEqual(['b']);
    expect(budgeted).toMatchObject({ loadedTopicTitles: [], notLoadedTopicTitles: ['Build', 'archive'] });
    expect(renderMemoryDocV1({ body, nowMs: 5, maxChars: 1 })).toMatchObject({ markdown: '', loadedFactIds: [], notLoadedFactIds: ['a', 'b'], notLoadedTopicTitles: ['Build', 'archive'] });
    expect(body.topics[1]?.facts[0]?.id).toBe('forgotten');
    expect(renderMemoryDocV1({ body: { v: 1, index: [], topics: [] }, nowMs: 5 }).markdown).toBe('');
    const distant = MemoryDocBodyV1Schema.parse({ v: 1, index: [{ ...fact('distant'), createdAtMs: Number.MAX_SAFE_INTEGER }], topics: [] });
    expect(renderMemoryDocV1({ body: distant, nowMs: 5 })).toMatchObject({ loadedFactIds: ['distant'] });
  });

  it('lists the archive after the named topics, wherever it was stored', () => {
    const body = MemoryDocBodyV1Schema.parse({ v: 1, index: [], topics: [
      { title: 'archive', summary: 'Expired, replaced and forgotten facts.', facts: [] },
      { title: 'Releases', summary: 'How a release is cut.', facts: [fact('r1')] },
    ] });
    expect(projectMemoryDocIndexV1(body, 5).topics.map(topic => topic.title)).toEqual(['Releases', 'archive']);
  });
});
