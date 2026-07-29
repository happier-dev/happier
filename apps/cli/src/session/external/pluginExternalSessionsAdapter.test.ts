import { describe, expect, it, vi } from 'vitest';
import { MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION, type ExternalSessionsSource } from '@happier-dev/protocol';

import {
  createPluginExternalSessionsAdapter,
  mapPluginExternalTranscriptItem,
} from './pluginExternalSessionsAdapter';
import { ExternalSessionProviderFailureError } from './providerOps';

const ref = { agentId: 'codex', remoteSessionId: 'remote-1', sourceId: 'source-1' } as const;
const target = {
  ref,
  source: { kind: 'codexHome', home: 'user' },
} as const;

describe('createPluginExternalSessionsAdapter', () => {
  it('preserves the canonical top-level transcript role when raw provider data has no role', () => {
    expect(mapPluginExternalTranscriptItem({
      id: 'antigravity-user-1',
      createdAtMs: 2,
      messageRole: 'user',
      raw: { type: 'text', text: 'hello' },
    })).toMatchObject({
      id: 'antigravity-user-1',
      kind: 'user',
      data: { type: 'text', text: 'hello' },
    });
    expect(mapPluginExternalTranscriptItem({
      id: 'canonical-role-wins',
      createdAtMs: 3,
      messageRole: 'agent',
      raw: { type: 'text', role: 'user', text: 'hello' },
    })).toMatchObject({
      id: 'canonical-role-wins',
      kind: 'agent',
    });
  });

  it('delegates list, attach, takeover, and transcript through explicit canonical owners', async () => {
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => ({ candidates: [{ remoteSessionId: 'remote-1', title: 'Remote', updatedAtMs: 1 }], nextCursor: null }),
        pageTranscript: async () => ({ items: [{ id: 'm1', createdAtMs: 2, raw: { role: 'user', text: 'hi' } }], nextCursor: 'next', tailCursor: 'tail', hasMore: false, truncated: false }),
      }),
      attach: vi.fn(async () => ({ sessionId: 'linked-1' })),
      takeover: vi.fn(async () => ({ sessionId: 'linked-1', status: 'takenOver' as const })),
    });
    expect((await adapter.list()).items[0]).toMatchObject({ ref, capabilities: ['attach', 'takeover', 'transcript'] });
    await expect(adapter.attach(ref)).resolves.toEqual({ sessionId: 'linked-1' });
    await expect(adapter.takeover(ref)).resolves.toEqual({ sessionId: 'linked-1', status: 'takenOver' });
    await expect(adapter.readTranscript(ref)).resolves.toMatchObject({ items: [{ id: 'm1', kind: 'user' }], nextCursor: 'next' });
    await expect(adapter.followTranscript(target, {}, vi.fn())).resolves.toEqual({
      status: 'unavailable', code: 'plugin_external_follow_unavailable',
    });
  });

  it('resolves one exact follow target from configured sources without listing candidates', async () => {
    const listCandidates = vi.fn(async () => ({ candidates: [], nextCursor: null }));
    const resolveLinkIdentity = vi.fn(async ({
      source,
      remoteSessionId,
    }: Readonly<{ source: ExternalSessionsSource; remoteSessionId: string }>) => {
      if (source.slot === 'one') {
        throw new ExternalSessionProviderFailureError({
          code: 'candidate_not_found',
          message: 'not in this configured source',
          operation: 'resolveLinkIdentity',
        });
      }
      return {
        source: { ...source, conversationId: remoteSessionId },
        remoteSessionId,
      };
    });
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [
        {
          agentId: 'codex',
          sourceId: 'source-1',
          source: { kind: 'codexHome', home: 'user', slot: 'one' },
          supportsFollow: true,
        },
        {
          agentId: 'codex',
          sourceId: 'source-2',
          source: { kind: 'codexHome', home: 'user', slot: 'two' },
          supportsFollow: true,
        },
      ],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({
          ok: true as const,
          source: Object.hasOwn(source, 'conversationId')
            ? {
                kind: source.kind,
                home: source.home,
                slot: source.slot,
              }
            : source,
        }),
        listCandidates,
        resolveLinkIdentity,
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
      }),
    });

    await expect(adapter.resolveFollowTarget({
      agentId: 'codex',
      remoteSessionId: 'remote-1',
    })).resolves.toEqual({
      status: 'resolved',
      ref: {
        agentId: 'codex',
        sourceId: 'source-2',
        remoteSessionId: 'remote-1',
      },
      source: {
        kind: 'codexHome',
        home: 'user',
        slot: 'two',
        conversationId: 'remote-1',
      },
    });
    expect(resolveLinkIdentity).toHaveBeenCalledTimes(2);
    expect(listCandidates).not.toHaveBeenCalled();
  });

  it('fails closed when exact follow identity is ambiguous across configured sources', async () => {
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [
        {
          agentId: 'codex',
          sourceId: 'source-1',
          source: { kind: 'codexHome', home: 'user', slot: 'one' },
          supportsFollow: true,
        },
        {
          agentId: 'codex',
          sourceId: 'source-2',
          source: { kind: 'codexHome', home: 'user', slot: 'two' },
          supportsFollow: true,
        },
      ],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({
          ok: true as const,
          source,
        }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
          source,
          remoteSessionId,
        }),
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
      }),
    });

    await expect(adapter.resolveFollowTarget({
      agentId: 'codex',
      remoteSessionId: 'remote-1',
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_identity_ambiguous',
    });
  });

  it('does not infer uniqueness when one configured source cannot be resolved authoritatively', async () => {
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [
        {
          agentId: 'codex',
          sourceId: 'source-1',
          source: { kind: 'codexHome', home: 'user', slot: 'one' },
          supportsFollow: true,
        },
        {
          agentId: 'codex',
          sourceId: 'source-2',
          source: { kind: 'codexHome', home: 'user', slot: 'two' },
          supportsFollow: true,
        },
      ],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({
          ok: true as const,
          source,
        }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        resolveLinkIdentity: async ({ source, remoteSessionId }) => {
          if (source.slot === 'one') {
            throw new ExternalSessionProviderFailureError({
              code: 'agent_unavailable',
              message: 'source could not be checked',
              operation: 'resolveLinkIdentity',
              retryable: true,
            });
          }
          return { source, remoteSessionId };
        },
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
      }),
    });

    await expect(adapter.resolveFollowTarget({
      agentId: 'codex',
      remoteSessionId: 'remote-1',
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_identity_unavailable',
    });
  });

  it('does not relabel a committed takeover when abort or retirement races its successful return', async () => {
    let current = true;
    const controller = new AbortController();
    const takeover = vi.fn(async () => {
      current = false;
      controller.abort();
      return { sessionId: 'linked-1', status: 'takenOver' as const };
    });
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => current,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
      takeover,
    });

    await expect(adapter.takeover(ref, { signal: controller.signal })).resolves.toEqual({
      sessionId: 'linked-1',
      status: 'takenOver',
    });
    expect(takeover).toHaveBeenCalledOnce();
  });

  it('reports frozen typed unavailable capabilities and rejects before invocation', async () => {
    const resolveProviderOps = vi.fn();
    const adapter = createPluginExternalSessionsAdapter({ isCurrent: () => true, sources: [], resolveProviderOps });
    const capabilities = adapter.capabilities();
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(capabilities.attach).toEqual({ status: 'unavailable', code: 'plugin_external_attach_unavailable' });
    await expect(adapter.attach(ref)).rejects.toMatchObject({ code: 'plugin_external_attach_unavailable' });
    await expect(adapter.list()).rejects.toMatchObject({ code: 'plugin_external_list_unavailable' });
    expect(resolveProviderOps).not.toHaveBeenCalled();
  });

  it('rejects an undeclared follow capability before provider invocation', async () => {
    const resolveProviderOps = vi.fn();
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps,
    });
    await expect(adapter.followTranscript(target, {}, vi.fn())).resolves.toEqual({
      status: 'unavailable', code: 'plugin_external_follow_unavailable',
    });
    expect(resolveProviderOps).not.toHaveBeenCalled();
  });

  it('uses an opaque stable cursor without draining provider sources before page one', async () => {
    const calls: string[] = [];
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [
        { agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } },
        { agentId: 'codex', sourceId: 'source-2', source: { kind: 'codexHome', home: 'user' } },
      ],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async ({ cursor, source }) => {
          calls.push(`${JSON.stringify(source)}:${cursor ?? 'first'}`);
          return cursor
            ? {
                candidates: [
                  { remoteSessionId: `${cursor}-tail-a`, updatedAtMs: 1 },
                  { remoteSessionId: `${cursor}-tail-b`, updatedAtMs: 0 },
                ],
                nextCursor: null,
              }
            : {
                candidates: [
                  { remoteSessionId: `head-${calls.length}-a`, updatedAtMs: 3 },
                  { remoteSessionId: `head-${calls.length}-b`, updatedAtMs: 2 },
                ],
                nextCursor: `cursor-${calls.length}`,
              };
        },
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
        readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
      }),
    });
    const first = await adapter.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
    expect(calls).toHaveLength(2);
    const second = await adapter.list({ cursor: first.nextCursor, limit: 2 });
    expect(second.items).toHaveLength(2);
    expect(calls).toHaveLength(3);
    const third = await adapter.list({ cursor: second.nextCursor, limit: 2 });
    expect(third.items).toHaveLength(2);
    expect(calls).toHaveLength(4);
  });

  it('clamps a 10k SDK list request to one source-bounded provider page', async () => {
    const corpus = Array.from({ length: 10_000 }, (_, index) => ({
      remoteSessionId: `remote-${index}`,
      updatedAtMs: 10_000 - index,
    }));
    const listCandidates = vi.fn(async ({ cursor, limit }: Readonly<{
      cursor?: string;
      limit: number;
    }>) => {
      const offset = cursor ? Number(cursor) : 0;
      const nextOffset = Math.min(corpus.length, offset + limit);
      return {
        candidates: corpus.slice(offset, nextOffset),
        nextCursor: nextOffset < corpus.length ? String(nextOffset) : null,
      };
    });
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates,
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    const page = await adapter.list({ limit: 10_000, maxBytes: 10 * 1024 * 1024 });

    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
    expect(listCandidates).toHaveBeenCalledOnce();
    expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({
      limit: 50,
      maxBytes: 1_048_576,
      signal: expect.any(AbortSignal),
    }));
  });

  it('withholds every selected source while any candidate index is still preparing', async () => {
    let indexedSourceReady = false;
    const directListCandidates = vi.fn(async () => ({
      candidates: [{ remoteSessionId: 'bypass', updatedAtMs: 99 }],
      nextCursor: null,
    }));
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [
        { agentId: 'codex', sourceId: 'indexed', source: { kind: 'codexHome', home: 'user' } },
        { agentId: 'codex', sourceId: 'native', source: { kind: 'codexHome', home: 'connectedService' } },
      ],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: directListCandidates,
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
      queryCandidates: async ({ entry }) => {
        if (entry.sourceId === 'indexed' && !indexedSourceReady) {
          indexedSourceReady = true;
          return {
            candidates: [],
            nextCursor: null,
            preparation: { kind: 'building_candidate_index', scanned: 50 },
          };
        }
        return {
          candidates: [{
            remoteSessionId: entry.sourceId,
            updatedAtMs: entry.sourceId === 'indexed' ? 2 : 1,
          }],
          nextCursor: null,
        };
      },
    });

    await expect(adapter.list()).resolves.toEqual({ items: [] });
    await expect(adapter.list()).resolves.toMatchObject({
      items: [
        { ref: { remoteSessionId: 'indexed' } },
        { ref: { remoteSessionId: 'native' } },
      ],
    });
    expect(directListCandidates).not.toHaveBeenCalled();
  });

  it('reserves one initial provider read per source before refilling an empty source page', async () => {
    const calls: string[] = [];
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [
        { agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } },
        { agentId: 'codex', sourceId: 'source-2', source: { kind: 'codexHome', home: 'connectedService' } },
      ],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async ({ cursor, source }) => {
          const sourceId = source.home === 'user' ? 'source-1' : 'source-2';
          calls.push(`${sourceId}:${cursor ?? 'first'}`);
          if (sourceId === 'source-1' && !cursor) {
            return { candidates: [], nextCursor: 'source-1-next' };
          }
          return {
            candidates: [{
              remoteSessionId: `${sourceId}-candidate`,
              updatedAtMs: sourceId === 'source-1' ? 2 : 1,
            }],
            nextCursor: null,
          };
        },
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    const page = await adapter.list({ limit: 1 });

    expect(calls.slice(0, 2)).toEqual(['source-1:first', 'source-2:first']);
    expect(calls).toEqual(['source-1:first', 'source-2:first', 'source-1:source-1-next']);
    expect(page.items[0]?.ref.remoteSessionId).toBe('source-1-candidate');
  });

  it('caps empty provider-page refills and reports only the offending source', async () => {
    let page = 0;
    const listCandidates = vi.fn(async () => ({
      candidates: [],
      nextCursor: `empty-${++page}`,
    }));
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates,
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    let cursor: string | undefined;
    let result: Awaited<ReturnType<typeof adapter.list>> | undefined;
    do {
      result = await adapter.list({ limit: 100, ...(cursor ? { cursor } : {}) });
      cursor = result.nextCursor;
    } while (cursor);

    expect(listCandidates).toHaveBeenCalledTimes(8);
    expect(result).toMatchObject({
      items: [],
      diagnostics: [expect.objectContaining({
        code: 'plugin_external_inventory_capacity_exceeded',
        details: { agentId: 'codex', sourceId: 'source-1' },
      })],
    });
  });

  it('emits a ready source head while retaining an empty source behind the continuation cursor', async () => {
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [
        { agentId: 'codex', sourceId: 'source-ready', source: { kind: 'codexHome', home: 'user' } },
        { agentId: 'codex', sourceId: 'source-empty', source: { kind: 'codexHome', home: 'connectedService' } },
      ],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async ({ cursor, source }) => source.home === 'user'
          ? { candidates: [{ remoteSessionId: 'ready', updatedAtMs: 1 }], nextCursor: null }
          : { candidates: [], nextCursor: `empty-${cursor ?? 'first'}` },
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    const result = await adapter.list({ limit: 1 });

    expect(result.items.map((item) => item.ref.remoteSessionId)).toEqual(['ready']);
    expect(result.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: 'plugin_external_source_page_empty',
      details: { agentId: 'codex', sourceId: 'source-empty' },
    })]);
  });

  it('propagates and enforces the serialized candidate response ceiling', async () => {
    const listCandidates = vi.fn(async () => ({
      candidates: [{ remoteSessionId: 'remote-large', title: 'x'.repeat(2_000), updatedAtMs: 1 }],
      nextCursor: null,
    }));
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates,
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    await expect(adapter.list({ limit: 1, maxBytes: 256 } as never)).rejects.toMatchObject({
      code: 'plugin_external_response_capacity_exceeded',
    });
    expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 256 }));
  });

  it('rejects a late provider result at the host-owned operation deadline', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => await never,
    });

    try {
      const pending = adapter.list();
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'plugin_operation_deadline_exceeded',
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an in-flight provider result immediately when its generation retires', async () => {
    const retirement = new AbortController();
    const never = new Promise<never>(() => undefined);
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => !retirement.signal.aborted,
      retirementSignal: retirement.signal,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => await never,
    });

    const pending = adapter.list();
    retirement.abort();
    await expect(pending).rejects.toMatchObject({ code: 'plugin_generation_retired' });
  });

  it('rejects source fan-out above the canonical transcript-source ceiling before provider invocation', async () => {
    const resolveProviderOps = vi.fn();
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: Array.from({ length: MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION + 1 }, (_, index) => ({
        agentId: 'codex' as const,
        sourceId: `source-${index}`,
        source: { kind: 'codexHome' as const, home: 'user' as const },
      })),
      resolveProviderOps,
    });

    await expect(adapter.list({ limit: 1 })).rejects.toMatchObject({
      code: 'plugin_external_inventory_capacity_exceeded',
    });
    expect(resolveProviderOps).not.toHaveBeenCalled();
  });

  it('rechecks generation after async resolution and rejects non-finite bounds', async () => {
    let current = true;
    const validateSource = vi.fn();
    const listCandidates = vi.fn();
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => current,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => {
        current = false;
        return { validateSource, listCandidates } as never;
      },
    });
    await expect(adapter.list()).rejects.toMatchObject({ code: 'plugin_generation_retired' });
    expect(validateSource).not.toHaveBeenCalled();
    expect(listCandidates).not.toHaveBeenCalled();

    current = true;
    await expect(adapter.list({ limit: Number.NaN })).rejects.toMatchObject({ code: 'plugin_external_limit_invalid' });
  });

  it('selects read-after explicitly and propagates its cursor and bounds', async () => {
    const pageTranscript = vi.fn(async () => ({
      items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
    }));
    const readAfterTranscript = vi.fn(async () => ({
      outcome: 'advanced' as const,
      items: [{ id: 'm2', createdAtMs: 2, raw: { role: 'agent', text: 'after' } }],
      nextCursor: 'cursor-2',
      boundary: 'm2',
    }));
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript,
        readAfterTranscript,
      }),
    });

    await expect(adapter.readTranscript(ref, {
      mode: 'readAfter', cursor: 'cursor-1', limit: 2, maxBytes: 1_024,
    } as never)).resolves.toMatchObject({
      items: [{ id: 'm2', kind: 'agent' }],
      nextCursor: 'cursor-2',
    });
    expect(pageTranscript).not.toHaveBeenCalled();
    expect(readAfterTranscript).toHaveBeenCalledWith(expect.objectContaining({
      cursor: 'cursor-1', maxItems: 2, maxBytes: 1_024,
    }));
  });

  it('clamps a 10k SDK transcript request to one source-bounded provider read', async () => {
    const pageTranscript = vi.fn(async ({ maxItems }: Readonly<{ maxItems: number }>) => ({
      items: Array.from({ length: maxItems }, (_, index) => ({
        id: `m${index}`,
        createdAtMs: index,
        raw: { role: 'agent', text: `message-${index}` },
      })),
      nextCursor: 'cursor-2',
      tailCursor: 'tail',
      hasMore: true,
      truncated: false,
    }));
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript,
      }),
    });

    const page = await adapter.readTranscript(ref, {
      mode: 'page',
      limit: 10_000,
      maxBytes: 10 * 1024 * 1024,
    });

    expect(page.items).toHaveLength(200);
    expect(page.nextCursor).toBe('cursor-2');
    expect(pageTranscript).toHaveBeenCalledOnce();
    expect(pageTranscript).toHaveBeenCalledWith(expect.objectContaining({
      maxItems: 200,
      maxBytes: 524_288,
      signal: expect.any(AbortSignal),
    }));
  });

  it('rejects a transcript provider item overrun rather than slicing it at the host', async () => {
    const pageTranscript = vi.fn(async () => ({
      items: Array.from({ length: 201 }, (_, index) => ({
        id: `m${index}`,
        createdAtMs: index,
        raw: { role: 'agent', text: 'message' },
      })),
      nextCursor: 'cursor-2',
      tailCursor: 'tail',
      hasMore: true,
      truncated: false,
    }));
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript,
      }),
    });

    await expect(adapter.readTranscript(ref)).rejects.toMatchObject({
      code: 'plugin_external_inventory_capacity_exceeded',
    });
    expect(pageTranscript).toHaveBeenCalledOnce();
  });

  it('rejects a transcript response above the requested serialized-byte ceiling', async () => {
    const pageTranscript = vi.fn(async () => ({
      items: [{ id: 'large', createdAtMs: 2, raw: { role: 'agent', text: 'x'.repeat(2_000) } }],
      nextCursor: null,
      tailCursor: 'tail',
      hasMore: false,
      truncated: false,
    }));
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript,
      }),
    });

    await expect(adapter.readTranscript(ref, { mode: 'page', maxBytes: 256 })).rejects.toMatchObject({
      code: 'plugin_external_response_capacity_exceeded',
    });
    expect(pageTranscript).toHaveBeenCalledWith(expect.objectContaining({
      maxBytes: 256,
      signal: expect.any(AbortSignal),
    }));
  });

  it('delegates follow acquisition with the exact validated target source and caller listener', async () => {
    const canonicalSource = { kind: 'codexHome', home: 'user', canonical: true } as const;
    const listener = vi.fn();
    const subscription = Object.freeze({ dispose: vi.fn(async () => undefined) });
    const followTranscript = vi.fn(async () => Object.freeze({
      status: 'following' as const,
      startingCursor: 'cursor-1',
      subscription,
    }));
    const providerAcquireFollowLease = vi.fn();
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{
        agentId: 'codex',
        sourceId: 'source-1',
        source: { kind: 'codexHome', home: 'user' },
        supportsFollow: true,
      }],
      resolveProviderOps: async () => ({
        validateSource: async () => ({ ok: true as const, source: canonicalSource }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: 'cursor-1',
          hasMore: false,
          truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
        acquireFollowLease: providerAcquireFollowLease,
      }) as never,
      followTranscript,
    });

    await expect(adapter.followTranscript({
      ref,
      source: canonicalSource,
    }, { cursor: 'cursor-1' }, listener)).resolves.toEqual({
      status: 'following',
      startingCursor: 'cursor-1',
      subscription,
    });
    expect(followTranscript).toHaveBeenCalledOnce();
    expect(followTranscript).toHaveBeenCalledWith({
      ref,
      source: canonicalSource,
      options: {
        cursor: 'cursor-1',
        signal: expect.any(AbortSignal),
      },
      listener,
    });
    expect(providerAcquireFollowLease).not.toHaveBeenCalled();
  });

  it('validates the current source before delegating follow and rejects unavailable read-after support', async () => {
    const followTranscript = vi.fn();
    const validateSource = vi.fn(async () => ({
      ok: false as const,
      error: 'source_unavailable',
    }));
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{
        agentId: 'codex',
        sourceId: 'source-1',
        source: { kind: 'codexHome', home: 'user' },
        supportsFollow: true,
      }],
      resolveProviderOps: async () => ({
        validateSource,
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
      }),
      followTranscript,
    });

    await expect(adapter.followTranscript(target, {}, vi.fn())).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_source_unavailable',
    });
    expect(validateSource).toHaveBeenCalledOnce();
    expect(followTranscript).not.toHaveBeenCalled();
  });

  it('fences follow delegation when the generation retires after source validation', async () => {
    let current = true;
    const followTranscript = vi.fn();
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => current,
      sources: [{
        agentId: 'codex',
        sourceId: 'source-1',
        source: { kind: 'codexHome', home: 'user' },
        supportsFollow: true,
      }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => {
          current = false;
          return { ok: true as const, source };
        },
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
      }),
      followTranscript,
    });

    await expect(adapter.followTranscript(target, {}, vi.fn())).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_generation_retired',
    });
    expect(followTranscript).not.toHaveBeenCalled();
  });

  it('returns promptly on caller abort during host acquisition and normalizes host failures', async () => {
    const caller = new AbortController();
    let beginHost!: () => void;
    const hostStarted = new Promise<void>((resolve) => { beginHost = resolve; });
    const followTranscript = vi.fn(async () => {
      beginHost();
      return await new Promise<never>(() => undefined);
    });
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{
        agentId: 'codex',
        sourceId: 'source-1',
        source: { kind: 'codexHome', home: 'user' },
        supportsFollow: true,
      }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({
          ok: true as const,
          source,
        }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
      }),
      followTranscript,
    });

    const acquisition = adapter.followTranscript(
      target,
      { signal: caller.signal },
      vi.fn(),
    );
    await hostStarted;
    caller.abort();
    await expect(acquisition).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_operation_aborted',
    });

    const failing = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{
        agentId: 'codex',
        sourceId: 'source-1',
        source: { kind: 'codexHome', home: 'user' },
        supportsFollow: true,
      }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({
          ok: true as const,
          source,
        }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
      }),
      followTranscript: async () => {
        throw new Error('host details must not escape');
      },
    });
    await expect(failing.followTranscript(target, {}, vi.fn())).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_acquisition_failed',
    });
  });

  it('delegates the canonical source returned by provider validation', async () => {
    const canonicalSource = { kind: 'codexHome', home: 'user', canonical: true } as const;
    const listCandidates = vi.fn(async () => ({ candidates: [], nextCursor: null }));
    const attach = vi.fn(async () => ({ sessionId: 'linked' }));
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async () => ({ ok: true as const, source: canonicalSource }),
        listCandidates,
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
        readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
      }),
      attach,
    });
    await adapter.list();
    await adapter.attach(ref);
    expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({ source: canonicalSource }));
    expect(attach).toHaveBeenCalledWith(ref, canonicalSource, {
      signal: expect.any(AbortSignal),
    });
  });

  it('normalizes untyped provider and domain failures at every rejecting service boundary', async () => {
    const providerFailure = new Error('provider internals must not become a stringly service failure');
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => { throw providerFailure; },
        pageTranscript: async () => { throw providerFailure; },
      }),
      attach: async () => { throw providerFailure; },
      takeover: async () => { throw providerFailure; },
    });

    await expect(adapter.list()).rejects.toMatchObject({
      name: 'PluginError',
      code: 'plugin_external_list_failed',
    });
    await expect(adapter.attach(ref)).rejects.toMatchObject({
      name: 'PluginError',
      code: 'plugin_external_attach_failed',
    });
    await expect(adapter.takeover(ref)).rejects.toMatchObject({
      name: 'PluginError',
      code: 'plugin_external_takeover_failed',
    });
    await expect(adapter.readTranscript(ref)).rejects.toMatchObject({
      name: 'PluginError',
      code: 'plugin_external_transcript_read_failed',
    });
  });

  it('rejects aborted operations before invoking effectful host or provider owners', async () => {
    const resolveProviderOps = vi.fn(async () => null);
    const attach = vi.fn(async () => ({ sessionId: 'must-not-attach' }));
    const controller = new AbortController();
    controller.abort();
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps,
      attach,
    });

    await expect(adapter.attach(ref, { signal: controller.signal })).rejects.toMatchObject({
      code: 'plugin_operation_aborted',
    });
    await expect(adapter.readTranscript(ref, { signal: controller.signal })).rejects.toMatchObject({
      code: 'plugin_operation_aborted',
    });
    expect(resolveProviderOps).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it('does not report a successful attach after the caller aborts in flight', async () => {
    const controller = new AbortController();
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
      }) as never,
      attach: async () => {
        controller.abort();
        return { sessionId: 'linked-after-abort' };
      },
    });

    await expect(adapter.attach(ref, { signal: controller.signal })).rejects.toMatchObject({
      code: 'plugin_operation_aborted',
    });
  });

  it('stops a read-only provider scan when its signal aborts in flight', async () => {
    const controller = new AbortController();
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => {
          controller.abort();
          return { candidates: [{ remoteSessionId: 'late' }], nextCursor: null };
        },
      }) as never,
    });

    await expect(adapter.list({ signal: controller.signal })).rejects.toMatchObject({
      code: 'plugin_operation_aborted',
    });
  });

  it('rejects non-JSON transcript data', async () => {
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        pageTranscript: async () => ({
          items: [{ id: 'invalid', createdAtMs: 1, raw: 1n as never }],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
      }) as never,
    });

    await expect(adapter.readTranscript(ref)).rejects.toMatchObject({
      code: 'plugin_external_transcript_invalid',
    });
  });
});
