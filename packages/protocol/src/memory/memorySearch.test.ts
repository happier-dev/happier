import { describe, expect, it, vi } from 'vitest';

import {
  MEMORY_SEARCH_QUERY_MAX_LENGTH,
  MemorySearchErrorCodeSchema,
  MemorySearchQueryV1Schema,
  MemorySearchResultV1Schema,
  negotiateMemorySearchV1,
  type MemorySearchQueryV1,
} from './memorySearch.js';
import { RPC_ERROR_CODES } from '../rpc/errors.js';

describe('memory_search_result.v1 schema', () => {
  it('accepts native transcript hits with opaque locators and rejects fake sequence ranges', () => {
    const hit = {
      type: 'external_transcript',
      source: { type: 'external_transcript', agentId: 'claude', sourceKey: '/native/log.jsonl', nativeSessionId: 'native-1' },
      sourceItemId: 'message-uuid', cursor: 'opaque:page:3',
      createdAtFromMs: 10, createdAtToMs: 20, summary: 'A native conversation', score: 0.5,
    };
    expect(MemorySearchResultV1Schema.safeParse({ v: 1, ok: true, hits: [hit] }).success).toBe(true);
    expect(MemorySearchResultV1Schema.safeParse({ v: 1, ok: true, hits: [{ ...hit, seqFrom: 1 }] }).success).toBe(false);
  });
  const documentHit = {
    type: 'artifact',
    ref: { kind: 'doc', artifactId: 'memory_1', serverId: 'home_1' },
    revision: { headerVersion: 2, bodyVersion: 4 },
    location: 'archive',
    factId: 'fact_1',
    summary: 'An archived fact remains searchable.',
    score: 0.8,
  };

  it('parses document hits without inventing transcript ranges', () => {
    const parsed = MemorySearchResultV1Schema.safeParse({
      v: 1, ok: true, hits: [documentHit], documents: { state: 'ready' },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || !parsed.data.ok) throw new Error('Expected success');
    expect(parsed.data.hits[0]).toEqual(documentHit);
    expect(parsed.data.hits[0]).not.toHaveProperty('seqFrom');
  });

  it('rejects document hits with unqualified or malformed navigation facts', () => {
    for (const invalid of [
      { ...documentHit, ref: { kind: 'doc', artifactId: 'memory_1' } },
      { ...documentHit, revision: 4 },
      { ...documentHit, revision: { headerVersion: -1, bodyVersion: 4 } },
      { ...documentHit, factId: '' },
      { ...documentHit, location: { type: 'topic', title: '' } },
      { ...documentHit, location: { type: 'topic' } },
      { ...documentHit, location: { type: 'topic', title: 'Engineering', artifactId: 'other' } },
      { ...documentHit, location: { type: 'section', title: 'Engineering' } },
      { ...documentHit, seqFrom: 1, seqTo: 2 },
    ]) {
      expect(MemorySearchResultV1Schema.safeParse({ v: 1, ok: true, hits: [invalid] }).success).toBe(false);
    }
  });

  it('retains a named topic and fact identity for document navigation', () => {
    const hit = { ...documentHit, location: { type: 'topic', title: 'Engineering / "部署"' } };
    const parsed = MemorySearchResultV1Schema.parse({
      v: 1, ok: true, hits: [hit], documents: { state: 'ready' },
    });
    if (!parsed.ok) throw new Error('Expected success');
    expect(parsed.hits).toEqual([hit]);
  });

  it('keeps fact identity optional for each document location', () => {
    for (const location of ['facts', 'archive', 'document', { type: 'topic', title: 'Engineering' }]) {
      const parsed = MemorySearchResultV1Schema.safeParse({
        v: 1, ok: true, hits: [{ ...documentHit, location, factId: undefined }],
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('keeps the legacy transcript arm untagged alongside a document arm', () => {
    const transcript = {
      sessionId: 'sess_1', seqFrom: 1, seqTo: 2, createdAtFromMs: 1, createdAtToMs: 2,
      summary: 'A past Session', score: 0.6,
    };
    const parsed = MemorySearchResultV1Schema.safeParse({
      v: 1, ok: true, hits: [transcript, documentHit], documents: { state: 'pending' },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || !parsed.data.ok) throw new Error('Expected success');
    expect(parsed.data.hits[0]).toEqual(transcript);
    expect(parsed.data.hits[0]).not.toHaveProperty('type');
    expect(MemorySearchResultV1Schema.safeParse({
      v: 1, ok: true, hits: [{ ...transcript, type: 'artifact' }],
    }).success).toBe(false);
  });

  it('rejects malformed document coverage rather than presenting it as ready', () => {
    expect(MemorySearchResultV1Schema.safeParse({
      v: 1, ok: true, hits: [], documents: { state: 'complete' },
    }).success).toBe(false);
  });
  it('parses a success result', () => {
    const parsed = MemorySearchResultV1Schema.parse({
      v: 1,
      ok: true,
      hits: [
        {
          sessionId: 'sess_1',
          seqFrom: 10,
          seqTo: 25,
          createdAtFromMs: 1000,
          createdAtToMs: 2000,
          summary: 'We discussed OpenClaw memory indexing.',
          score: 0.42,
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    expect((parsed as any).hits).toHaveLength(1);
  });

  it('parses a failure result with stable error codes', () => {
    expect(MemorySearchErrorCodeSchema.parse('memory_disabled')).toBe('memory_disabled');
    const parsed = MemorySearchResultV1Schema.parse({
      v: 1,
      ok: false,
      errorCode: 'memory_disabled',
      error: 'Memory search is disabled.',
    });
    expect(parsed.ok).toBe(false);
  });
});

describe('negotiateMemorySearchV1', () => {
  const query = { v: 1 as const, query: 'fact', scope: { type: 'global' as const }, mode: 'auto' as const };
  const transcript = {
    sessionId: 'session-1', seqFrom: 1, seqTo: 2, createdAtFromMs: 1, createdAtToMs: 2,
    summary: 'Retained transcript', score: 0.5,
  };

  it.each(['project', 'documents'] as const)('preserves temporary %s support-probe failure until an explicit retry', async kind => {
    const request = MemorySearchQueryV1Schema.parse({ ...query,
      scope: kind === 'project' ? { type: 'project', projectRef: { serverId: 'home', projectKey: 'payments' } } : query.scope,
      corpora: kind === 'documents' ? ['documents'] : ['sessions'] });
    const failure = Object.assign(new Error('Discovery failed'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
    let probes = 0;
    const readSupport = async () => { if (++probes === 1) throw failure; return true; };
    const search = vi.fn(async () => ({ v: 1, ok: true, hits: [], documents: { state: 'ready' } }));
    const input = { query: request, readProjectSearchSupport: readSupport, readDocumentSearchSupport: readSupport, search };
    await expect(negotiateMemorySearchV1(input)).rejects.toBe(failure);
    expect(probes).toBe(1);
    expect(search).not.toHaveBeenCalled();
    await expect(negotiateMemorySearchV1(input)).resolves.toMatchObject({ ok: true });
    expect(probes).toBe(2);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('refuses Project queries before dispatch unless the exact peer advertises support', async () => {
    const projectQuery = MemorySearchQueryV1Schema.parse({ ...query,
      corpora: ['sessions'],
      scope: { type: 'project', projectRef: { serverId: 'home', projectKey: 'payments' } } });
    const search = vi.fn(async () => ({ v: 1, ok: true, hits: [] }));
    for (const readProjectSearchSupport of [undefined, async () => false, async () => {
      throw Object.assign(new Error('Old peer'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
    }]) {
      expect(await negotiateMemorySearchV1({ query: projectQuery, search,
        readDocumentSearchSupport: async () => true, readProjectSearchSupport })).toMatchObject({
        ok: false, errorCode: 'memory_project_scope_unsupported',
      });
    }
    expect(search).not.toHaveBeenCalled();
    const result = await negotiateMemorySearchV1({ query: projectQuery,
      readDocumentSearchSupport: async () => true, readProjectSearchSupport: async () => true,
      search: async request => {
        expect(request).toEqual(projectQuery);
        return { v: 1, ok: true, hits: [], project: { state: 'partial' } };
      } });
    expect(result).toEqual({ v: 1, ok: true, hits: [], project: { state: 'partial' } });
    expect(await negotiateMemorySearchV1({ query: projectQuery,
      readDocumentSearchSupport: async () => true, readProjectSearchSupport: async () => true, search }))
      .toEqual({ v: 1, ok: true, hits: [], project: { state: 'unavailable' } });
  });

  it('defaults new Project queries to Sessions and documents while preserving the legacy omitted corpus', async () => {
    const projectQuery = MemorySearchQueryV1Schema.parse({ ...query,
      scope: { type: 'project', projectRef: { serverId: 'home', projectKey: 'payments' } } });
    const requests: MemorySearchQueryV1[] = [];
    const readDocumentSearchSupport = vi.fn(async () => true);
    const result = await negotiateMemorySearchV1({ query: projectQuery,
      readDocumentSearchSupport, readProjectSearchSupport: async () => true,
      search: async request => {
        requests.push(request);
        return { v: 1, ok: true, hits: [], documents: { state: 'ready' }, project: { state: 'ready' } };
      } });
    expect(requests).toEqual([{ ...projectQuery, corpora: ['sessions', 'documents'] }]);
    expect(readDocumentSearchSupport).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, documents: { state: 'ready' }, project: { state: 'ready' } });
    requests.length = 0;
    expect(await negotiateMemorySearchV1({ query: projectQuery,
      readDocumentSearchSupport: async () => false, readProjectSearchSupport: async () => true,
      search: async request => {
        requests.push(request);
        return { v: 1, ok: true, hits: [], project: { state: 'ready' } };
      } })).toMatchObject({ ok: true, documents: { state: 'unavailable' } });
    expect(requests).toEqual([{ ...projectQuery, corpora: ['sessions'] }]);
  });

  it('degrades an old-peer mixed request without sending an ignorable document corpus', async () => {
    const search = vi.fn(async (_query: MemorySearchQueryV1) => ({ v: 1, ok: true, hits: [transcript] }));
    const result = await negotiateMemorySearchV1({
      query: { ...query, corpora: ['sessions', 'documents'] },
      readDocumentSearchSupport: async () => false,
      search,
    });
    expect(search.mock.calls[0]?.[0]).toEqual(query);
    expect(result).toEqual({ v: 1, ok: true, hits: [transcript], documents: { state: 'unavailable' } });
  });

  it('never searches transcripts for unsupported documents-only requests, including missing old status methods', async () => {
    const search = vi.fn();
    const result = await negotiateMemorySearchV1({
      query: { ...query, corpora: ['documents'] },
      readDocumentSearchSupport: async () => {
        throw Object.assign(new Error('Missing status'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
      },
      search,
    });
    expect(result).toEqual({ v: 1, ok: true, hits: [], documents: { state: 'unavailable' } });
    expect(search).not.toHaveBeenCalled();
  });

  it('retains an explicit native corpus when document coverage is unavailable', async () => {
    const native = { type: 'external_transcript', source: { type: 'external_transcript', agentId: 'pi', sourceKey: 'local', nativeSessionId: 'native' },
      sourceItemId: 'message', createdAtFromMs: 1, createdAtToMs: 1, summary: 'native fact', score: 0.5 };
    const requests: MemorySearchQueryV1[] = [];
    const result = await negotiateMemorySearchV1({
      query: { ...query, corpora: ['external_transcripts', 'documents'] },
      readDocumentSearchSupport: async () => false,
      search: async request => { requests.push(request); return { v: 1, ok: true, hits: [native] }; },
    });
    expect(requests).toEqual([{ ...query, corpora: ['external_transcripts'] }]);
    expect(result).toEqual({ v: 1, ok: true, hits: [native], documents: { state: 'unavailable' } });
    expect(await negotiateMemorySearchV1({
      query: { ...query, corpora: ['external_transcripts'] },
      readDocumentSearchSupport: async () => false,
      // The predecessor ignores additive corpora and returns Session-only hits.
      search: async () => ({ v: 1, ok: true, hits: [transcript] }),
    })).toEqual({ v: 1, ok: true, hits: [] });
  });

  it('requires document coverage even from an advertised peer and leaves legacy requests unprobed', async () => {
    const readDocumentSearchSupport = vi.fn(async () => true);
    const readProjectSearchSupport = vi.fn(async () => true);
    const search = vi.fn(async (_query: MemorySearchQueryV1) => ({ v: 1, ok: true, hits: [transcript] }));
    expect(await negotiateMemorySearchV1({ query, readDocumentSearchSupport, readProjectSearchSupport, search }))
      .toEqual({ v: 1, ok: true, hits: [transcript] });
    expect(readDocumentSearchSupport).not.toHaveBeenCalled();
    expect(readProjectSearchSupport).not.toHaveBeenCalled();
    expect(await negotiateMemorySearchV1({
      query: { ...query, corpora: ['sessions', 'documents'] }, readDocumentSearchSupport, search,
    })).toEqual({ v: 1, ok: true, hits: [transcript], documents: { state: 'unavailable' } });
    expect(await negotiateMemorySearchV1({
      query: { ...query, corpora: ['documents'] }, readDocumentSearchSupport, search,
    })).toEqual({ v: 1, ok: true, hits: [], documents: { state: 'unavailable' } });
  });

  it('honors cancellation after probing and propagates genuine status failures', async () => {
    const controller = new AbortController();
    const search = vi.fn();
    await expect(negotiateMemorySearchV1({
      query: { ...query, corpora: ['documents'] },
      readDocumentSearchSupport: async () => { controller.abort(); return true; },
      search, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(search).not.toHaveBeenCalled();
    const unavailable = new Error('Disconnected');
    await expect(negotiateMemorySearchV1({
      query: { ...query, corpora: ['documents'] },
      readDocumentSearchSupport: async () => { throw unavailable; }, search,
    })).rejects.toBe(unavailable);
  });
});

describe('MemorySearchQueryV1Schema', () => {
  it('requires a closed qualified Project scope and admits honest partial coverage', () => {
    const query = { v: 1, query: 'decision', mode: 'auto',
      scope: { type: 'project', projectRef: { serverId: 'home', projectKey: 'payments' } } };
    expect(MemorySearchQueryV1Schema.parse(query)).toEqual(query);
    for (const scope of [
      { type: 'project', projectRef: { projectKey: 'payments' } },
      { ...query.scope, sessionId: 'other' },
      { type: 'project', projectRef: { ...query.scope.projectRef, rootPath: '/payments' } },
    ]) expect(MemorySearchQueryV1Schema.safeParse({ ...query, scope }).success).toBe(false);
    expect(MemorySearchResultV1Schema.parse({ v: 1, ok: true, hits: [],
      project: { state: 'partial' }, documents: { state: 'partial' } })).toMatchObject({
      project: { state: 'partial' }, documents: { state: 'partial' },
    });
    expect(MemorySearchResultV1Schema.safeParse({ v: 1, ok: true, hits: [],
      project: { state: 'ready', projectKey: 'other' } }).success).toBe(false);
  });
  it('validates paging and date filters rather than treating malformed filters as annotations', () => {
    const query = { v: 1, query: 'handoff', scope: { type: 'global' }, mode: 'deep' };
    expect(MemorySearchQueryV1Schema.safeParse(query).success).toBe(true);
    expect(MemorySearchQueryV1Schema.safeParse({ ...query, cursor: '' }).success).toBe(false);
    expect(MemorySearchQueryV1Schema.safeParse({ ...query, createdAfterMs: -1 }).success).toBe(false);
    expect(MemorySearchQueryV1Schema.safeParse({ ...query, createdAfterMs: 20, createdBeforeMs: 10 }).success).toBe(false);
    expect(MemorySearchQueryV1Schema.safeParse({ ...query, cursor: 'opaque', createdAfterMs: 10, createdBeforeMs: 20 }).success).toBe(true);
    const sourceQuery = { ...query, externalSource: { agentId: 'pi', sourceKey: 'local' } };
    expect(MemorySearchQueryV1Schema.parse(sourceQuery).externalSource).toEqual(sourceQuery.externalSource);
    expect(MemorySearchQueryV1Schema.safeParse({ ...query, externalSource: { agentId: 'pi' } }).success).toBe(false);
    expect(MemorySearchQueryV1Schema.safeParse({ ...sourceQuery, externalSource: { ...sourceQuery.externalSource, nativeSessionId: 'unscoped' } }).success).toBe(false);
  });
  it('admits only named nonempty corpora and leaves legacy omission untouched', () => {
    const legacy = { v: 1, query: 'fact', scope: { type: 'global' }, mode: 'auto' };
    expect(MemorySearchQueryV1Schema.parse(legacy)).not.toHaveProperty('corpora');
    expect(MemorySearchQueryV1Schema.parse({ ...legacy, corpora: ['sessions', 'documents'] }).corpora)
      .toEqual(['sessions', 'documents']);
    expect(MemorySearchQueryV1Schema.safeParse({ ...legacy, corpora: [] }).success).toBe(false);
    expect(MemorySearchQueryV1Schema.safeParse({ ...legacy, corpora: ['library'] }).success).toBe(false);
  });
  it('parses a basic query', () => {
    const parsed = MemorySearchQueryV1Schema.parse({
      v: 1,
      query: 'openclaw',
      scope: { type: 'global' },
      mode: 'auto',
      maxResults: 20,
      minScore: 0.15,
    });
    expect(parsed.query).toBe('openclaw');
  });

  it('parses an additive eligible Session identity filter', () => {
    const parsed = MemorySearchQueryV1Schema.parse({
      v: 1,
      query: 'openclaw',
      scope: { type: 'global' },
      mode: 'auto',
      eligibleSessionIds: ['archived-1', 'archived-2'],
    });

    expect(parsed.eligibleSessionIds).toEqual(['archived-1', 'archived-2']);
  });

  it('rejects a query past the shared length bound that blocks the FTS boundary', () => {
    const atBound = {
      v: 1,
      query: 'x'.repeat(MEMORY_SEARCH_QUERY_MAX_LENGTH),
      scope: { type: 'global' },
      mode: 'auto',
    };
    expect(MemorySearchQueryV1Schema.safeParse(atBound).success).toBe(true);
    expect(MemorySearchQueryV1Schema.safeParse({
      ...atBound,
      query: 'x'.repeat(MEMORY_SEARCH_QUERY_MAX_LENGTH + 1),
    }).success).toBe(false);
  });
});
