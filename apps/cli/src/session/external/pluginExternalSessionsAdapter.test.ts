import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  ExternalSessionsSourceSchema,
  MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION,
  type ExternalSessionAgentId,
  type ExternalSessionRef,
  type ExternalSessionsSource,
} from '@happier-dev/protocol';

import {
  createPluginExternalSessionsAdapter,
  mapPluginExternalTranscriptItem,
} from './pluginExternalSessionsAdapter';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from './agentExternalSessionsInvocation';
import type {
  ExternalSessionsCompositionPort,
  HostExternalTranscriptFollowEvent,
} from './privateContract';
import { ExternalSessionProviderFailureError } from './providerOps';

const ref = { agentId: 'codex', remoteSessionId: 'remote-1', sourceId: 'source-1' } as const;
const requireListCursor = (page: Readonly<{ nextCursor?: string | null }>): string => {
  expect(page.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
  if (!page.nextCursor) throw new Error('Expected an External Sessions list cursor');
  return page.nextCursor;
};
const isAbortedSignal = (signal: AbortSignal | null): boolean => signal?.aborted === true;
const createCandidatesAtSettledListBytes = (targetBytes: number, sourceId: string) => {
  const candidates = Array.from({ length: 50 }, (_, index) => ({
    remoteSessionId: `remote-${String(index).padStart(2, '0')}`,
    title: 'a',
    updatedAtMs: 1,
  }));
  const project = () => ({
    items: candidates.map((candidate) => ({
      ref: {
        agentId: 'codex',
        remoteSessionId: candidate.remoteSessionId,
        sourceId,
      },
      title: candidate.title,
      updatedAtMs: candidate.updatedAtMs,
      capabilities: ['transcript'],
    })),
  });
  const byteLength = () => new TextEncoder().encode(JSON.stringify(project())).byteLength;
  let remainingBytes = targetBytes - byteLength();
  for (const candidate of candidates) {
    const threeByteCodeUnits = Math.min(9_999, Math.floor(remainingBytes / 3));
    candidate.title += '界'.repeat(threeByteCodeUnits);
    remainingBytes -= threeByteCodeUnits * 3;
  }
  const remainderTarget = candidates.find((candidate) => candidate.title.length < 10_000);
  if (!remainderTarget || remainingBytes < 0 || remainingBytes > 2) {
    throw new Error('Unable to build exact bounded page fixture');
  }
  if (remainingBytes === 1) remainderTarget.title += 'b';
  if (remainingBytes === 2) remainderTarget.title += 'é';
  expect(byteLength()).toBe(targetBytes);
  expect(candidates.every((candidate) => candidate.title.length <= 10_000)).toBe(true);
  return candidates;
};
const target = {
  ref,
  source: { kind: 'codexHome', home: 'user' },
} as const;

describe('createPluginExternalSessionsAdapter', () => {
  it('returns separate domain-author and source-bearing composition authorities', () => {
    const composition = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [],
      resolveProviderOps: async () => null,
    });

    expect(Reflect.ownKeys(composition).sort()).toEqual([
      'authorService',
      'compositionPort',
    ]);
    expect(Reflect.ownKeys(composition.authorService).sort()).toEqual([
      'attach',
      'capabilities',
      'followTranscript',
      'list',
      'readTranscript',
    ]);
    expect(Reflect.get(composition.authorService, 'resolveFollowTarget')).toBeUndefined();
    expect(Reflect.ownKeys(composition.compositionPort).sort()).toEqual([
      'followTranscript',
      'resolveFollowTarget',
    ]);
    expect(Reflect.get(composition.compositionPort, 'list')).toBeUndefined();
    expectTypeOf<Parameters<ExternalSessionsCompositionPort['resolveFollowTarget']>[0]>()
      .toEqualTypeOf<{
        agentId: ExternalSessionAgentId;
        remoteSessionId: ExternalSessionRef['remoteSessionId'];
        boundSource?: ExternalSessionsSource;
        admissionDeadlineAtMs?: number;
        signal?: AbortSignal;
      }>();
    expectTypeOf<Parameters<ExternalSessionsCompositionPort['followTranscript']>[1]>()
      .toEqualTypeOf<{
        cursor?: string;
        initialReplay?: boolean;
        admissionDeadlineAtMs?: number;
        signal?: AbortSignal;
      }>();
  });

  it('follows an author ref through its exact current source', async () => {
    const resolveLinkIdentity = vi.fn(async ({
      source,
      remoteSessionId,
    }: Readonly<{
      source: ExternalSessionsSource;
      remoteSessionId: string;
    }>) => ({
      source,
      remoteSessionId,
    }));
    const followTranscript = vi.fn(async (input: Readonly<{
      source: ExternalSessionsSource;
    }>) => ({
      status: 'following' as const,
      startingCursor: null,
      subscription: { dispose: vi.fn(async () => undefined) },
    }));
    const composition = createPluginExternalSessionsAdapter({
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
        listCandidates: vi.fn(),
        resolveLinkIdentity,
        pageTranscript: vi.fn(),
        readAfterTranscript: vi.fn(),
      }),
      followTranscript,
    });

    const authorFollow = Reflect.get(composition.authorService, 'followTranscript');
    expect(authorFollow).toBeTypeOf('function');
    await expect(authorFollow.call(
      composition.authorService,
      { agentId: 'codex', sourceId: 'source-2', remoteSessionId: 'remote-1' },
      {},
      vi.fn(),
    )).resolves.toMatchObject({ status: 'following' });
    expect(resolveLinkIdentity).toHaveBeenCalledOnce();
    expect(resolveLinkIdentity).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ slot: 'two' }),
      remoteSessionId: 'remote-1',
    }));
    expect(followTranscript).toHaveBeenCalledWith(expect.objectContaining({
      ref: {
        agentId: 'codex',
        sourceId: 'source-2',
        remoteSessionId: 'remote-1',
      },
      source: expect.objectContaining({ slot: 'two' }),
    }));
  });

  it('projects the canonically admitted raw envelope and rejects contradictory compatibility roles', () => {
    const raw = { role: 'user' as const, content: { type: 'text' as const, text: 'hello' } };
    const absentCompatibilityRole = mapPluginExternalTranscriptItem({
      id: 'antigravity-user-1',
      localId: 'provider-fact-user-1',
      createdAtMs: 2,
      userProjection: 'source_fact',
      raw,
    });
    const nullCompatibilityRole = mapPluginExternalTranscriptItem({
      id: 'antigravity-user-1',
      localId: 'provider-fact-user-1',
      createdAtMs: 2,
      messageRole: null,
      userProjection: 'source_fact',
      raw,
    });

    expect(nullCompatibilityRole).toEqual(absentCompatibilityRole);
    expect(nullCompatibilityRole).toMatchObject({
      id: 'antigravity-user-1',
      localId: 'provider-fact-user-1',
      kind: 'user',
      userProjection: 'source_fact',
      data: { role: 'user', content: { type: 'text', text: 'hello' } },
    });
    expect(() => mapPluginExternalTranscriptItem({
      id: 'contradictory-role',
      createdAtMs: 3,
      messageRole: 'agent',
      raw: { role: 'user', content: { type: 'text', text: 'hello' } },
    })).toThrow('plugin_external_transcript_invalid');
    expect(() => mapPluginExternalTranscriptItem({
      id: 'broad-current-envelope',
      createdAtMs: 4,
      raw: {
        role: 'user',
        content: { type: 'text', text: 'hello', providerTag: 'legacy' },
      },
    })).toThrow('plugin_external_transcript_invalid');
    expect(() => mapPluginExternalTranscriptItem({
      id: 'unknown-user-projection',
      createdAtMs: 5,
      raw: { role: 'user', content: { type: 'text', text: 'hello' } },
      userProjection: 'guessed_from_text',
    })).toThrow('plugin_external_transcript_invalid');
    for (const content of [
      { type: 'message', message: 'bare semantic body' },
      { type: 'acp', data: { type: 'message', message: 'missing agent identity' } },
    ]) {
      expect(() => mapPluginExternalTranscriptItem({
        id: 'non-canonical-agent-envelope',
        createdAtMs: 6,
        raw: { role: 'agent', content },
      })).toThrow('plugin_external_transcript_invalid');
    }
  });

  it('applies the one bounded transcript identity owner to localId as well as id', () => {
    // Two parse sites for one DTO are only safe while they share one identity
    // policy: an over-long `localId` must refuse here exactly as it refuses at
    // `agentExternalSessionsInvocation`. Unknown keys are deliberately NOT the
    // same concept — this projector strips host-private carrier fields.
    const raw = { role: 'user' as const, content: { type: 'text' as const, text: 'hello' } };
    expect(() => mapPluginExternalTranscriptItem({
      id: 'over-long-local-id',
      createdAtMs: 1,
      localId: 'x'.repeat(2_001),
      raw,
    })).toThrow('plugin_external_transcript_invalid');
    expect(mapPluginExternalTranscriptItem({
      id: 'exact-local-id',
      createdAtMs: 1,
      localId: 'x'.repeat(2_000),
      raw,
    })).toMatchObject({ id: 'exact-local-id', localId: 'x'.repeat(2_000), kind: 'user' });
  });

  it('omits a transcript timestamp the retained-runner DTO would reject instead of forwarding it', () => {
    // A negative or fractional millisecond value is admitted in-process today and
    // then rejects the whole retained-runner result. One canonical numeric owner
    // makes both placements agree.
    const raw = { role: 'user', content: { type: 'text', text: 'hi' } };
    expect(mapPluginExternalTranscriptItem({ id: 'item-1', createdAtMs: 0, raw }).timestampMs).toBe(0);
    expect(mapPluginExternalTranscriptItem({ id: 'item-1', createdAtMs: 1_700_000_000_000, raw }).timestampMs)
      .toBe(1_700_000_000_000);
    for (const createdAtMs of [-5, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(mapPluginExternalTranscriptItem({ id: 'item-1', createdAtMs, raw }).timestampMs).toBeUndefined();
    }
  });

  it('admits the exact transcript item id bound and rejects first-over or non-trim-equal ids', () => {
    // One identity contract for every execution placement: 2,000 code units,
    // punctuation preserved, noncanonical whitespace rejected not normalized.
    const raw = { role: 'user', content: { type: 'text', text: 'hi' } };
    const exact = 'x'.repeat(2_000);
    expect(mapPluginExternalTranscriptItem({ id: exact, createdAtMs: 1, raw }).id).toBe(exact);
    const punctuated = "external::/%?=+#[]@!$&'()*+,;\u{1F642}";
    expect(mapPluginExternalTranscriptItem({ id: punctuated, createdAtMs: 1, raw }).id).toBe(punctuated);
    for (const id of ['x'.repeat(2_001), ' padded ', '\tleading', '']) {
      expect(() => mapPluginExternalTranscriptItem({ id, createdAtMs: 1, raw }))
        .toThrow('plugin_external_transcript_invalid');
    }
  });

  it('admits Protocol-valid transcript nesting and still refuses non-JSON item data', () => {
    let payload: unknown = 'leaf';
    for (let index = 0; index < 40; index += 1) payload = { nested: payload };
    const mapped = mapPluginExternalTranscriptItem({
      id: 'deep-agent-1',
      createdAtMs: 7,
      raw: {
        role: 'agent',
        content: { type: 'acp', agentId: 'codex', data: { type: 'tool-result', payload } },
      },
    });
    expect(mapped.kind).toBe('event');
    let readback: unknown = mapped.data;
    for (const key of ['content', 'data', 'payload']) {
      readback = (readback as Readonly<Record<string, unknown>>)[key];
    }
    for (let index = 0; index < 40; index += 1) {
      readback = (readback as Readonly<Record<string, unknown>>).nested;
    }
    expect(readback).toBe('leaf');

    const cyclic: Record<string, unknown> = {
      id: 'cyclic-item',
      createdAtMs: 8,
      raw: { role: 'user', content: { type: 'text', text: 'hello' } },
    };
    cyclic.self = cyclic;
    expect(() => mapPluginExternalTranscriptItem(cyclic))
      .toThrow('plugin_external_transcript_invalid');
  });

  it('sizes a deeply nested transcript page through the iterative byte owner instead of rejecting it', async () => {
    // The canonical strict-JSON contract admits arbitrary nesting under its byte
    // ceiling; response sizing must not reintroduce a recursion-depth bound.
    let payload: unknown = 'leaf';
    for (let index = 0; index < 7_000; index += 1) payload = { nested: payload };
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript: async () => ({
          items: [{
            id: 'deep-1',
            createdAtMs: 2,
            raw: {
              role: 'agent',
              content: { type: 'acp', agentId: 'codex', data: { type: 'tool-result', payload } },
            },
          }],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
      }),
    });

    await expect(adapter.authorService.readTranscript(ref)).resolves.toMatchObject({
      items: [{ id: 'deep-1', kind: 'event' }],
    });
  });

  it('delegates list, attach, and transcript through explicit canonical owners', async () => {
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => ({ candidates: [{ remoteSessionId: 'remote-1', title: 'Remote', updatedAtMs: 1 }], nextCursor: null }),
        pageTranscript: async () => ({ items: [{ id: 'm1', createdAtMs: 2, raw: { role: 'user', content: { type: 'text', text: 'hi' } } }], nextCursor: 'next', tailCursor: 'tail', hasMore: false, truncated: false }),
      }),
      attach: vi.fn(async () => ({ sessionId: 'linked-1' })),
    });
    expect((await adapter.authorService.list()).items[0]).toMatchObject({ ref, capabilities: ['attach', 'transcript'] });
    await expect(adapter.authorService.attach(ref)).resolves.toEqual({ sessionId: 'linked-1' });
    await expect(adapter.authorService.readTranscript(ref)).resolves.toMatchObject({ items: [{ id: 'm1', kind: 'user' }], nextCursor: 'next' });
    await expect(adapter.compositionPort.followTranscript(target, {}, vi.fn())).resolves.toEqual({
      status: 'unavailable', code: 'plugin_external_follow_unavailable',
    });
  });

  it('derives row Follow capability from the same live currentness decision as the global capability', async () => {
    let followInstalled = false;
    const followTranscript = vi.fn(async () => ({
      status: 'following' as const,
      startingCursor: null,
      subscription: { dispose: vi.fn(async () => undefined) },
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
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => ({
          candidates: [{ remoteSessionId: 'remote-1', title: 'Remote', updatedAtMs: 1 }],
          nextCursor: null,
        }),
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
      canFollowNow: () => followInstalled,
    });

    // Host operations were never installed: the global capability already refuses.
    expect(adapter.authorService.capabilities().follow).toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_unavailable',
    });
    // A row must not advertise an operation the same live decision refuses.
    expect((await adapter.authorService.list()).items[0]).toMatchObject({
      ref,
      capabilities: ['transcript'],
    });
    // Acquisition rechecks the same live decision instead of the static snapshot.
    await expect(adapter.compositionPort.followTranscript(target, {}, vi.fn())).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_unavailable',
    });
    expect(followTranscript).not.toHaveBeenCalled();

    // Once a generation is installed the same decision turns the row on.
    followInstalled = true;
    expect(adapter.authorService.capabilities().follow).toEqual({ status: 'available' });
    expect((await adapter.authorService.list()).items[0]).toMatchObject({
      ref,
      capabilities: ['transcript', 'follow'],
    });
    await expect(adapter.compositionPort.followTranscript(target, {}, vi.fn()))
      .resolves.toMatchObject({ status: 'following' });
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

    await expect(adapter.compositionPort.resolveFollowTarget({
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

  it('settles private target resolution at an inherited admission deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let releaseIdentity!: () => void;
    const identity = new Promise<{
      source: ExternalSessionsSource;
      remoteSessionId: string;
    }>((resolve) => {
      releaseIdentity = () => resolve({
        source: { kind: 'codexHome', home: 'user' },
        remoteSessionId: 'remote-1',
      });
    });
    let resolveStarted!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolverSignal: AbortSignal | null = null;
    const listCandidates = vi.fn(async () => {
      throw new Error('private target resolution must not list candidates');
    });
    const resolveLinkIdentity = vi.fn(async ({ signal }: Readonly<{
      signal?: AbortSignal;
    }>) => {
      resolverSignal = signal ?? null;
      resolveStarted();
      return await identity;
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
        validateSource: async ({ source }: Readonly<{
          source: ExternalSessionsSource;
        }>) => ({ ok: true as const, source }),
        listCandidates,
        resolveLinkIdentity,
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
      }),
    });
    const caller = new AbortController();
    const pending = adapter.compositionPort.resolveFollowTarget({
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      admissionDeadlineAtMs: 10_001,
      signal: caller.signal,
    });
    let outcome: unknown = null;
    void pending.then((value) => {
      outcome = value;
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      await resolverStarted;
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();

      expect(outcome).toEqual({
        status: 'unavailable',
        code: 'plugin_operation_deadline_exceeded',
      });
      expect(isAbortedSignal(resolverSignal)).toBe(true);
      expect(resolveLinkIdentity).toHaveBeenCalledOnce();
      expect(listCandidates).not.toHaveBeenCalled();
    } finally {
      caller.abort();
      releaseIdentity();
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      vi.useRealTimers();
    }
  });

  it('clamps private follow re-resolution to the inherited admission deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(24_999);
    let releaseIdentity!: () => void;
    const reResolvedIdentity = new Promise<{
      source: ExternalSessionsSource;
      remoteSessionId: string;
    }>((resolve) => {
      releaseIdentity = () => resolve({
        source: {
          kind: 'antigravityCliPrint',
          brainDir: '/home/user/.gemini/antigravity-cli/brain',
          conversationId: 'remote-1',
          sourceRevision: 'revision-1',
        },
        remoteSessionId: 'remote-1',
      });
    });
    let reResolveStarted!: () => void;
    const reResolveStartedPromise = new Promise<void>((resolve) => {
      reResolveStarted = resolve;
    });
    let reResolveSignal: AbortSignal | null = null;
    let identityCalls = 0;
    const listCandidates = vi.fn(async () => {
      throw new Error('private follow must not list candidates');
    });
    const resolveLinkIdentity = vi.fn(async ({ signal }: Readonly<{
      signal?: AbortSignal;
    }>) => {
      identityCalls += 1;
      if (identityCalls === 1) {
        return {
          source: {
            kind: 'antigravityCliPrint' as const,
            brainDir: '/home/user/.gemini/antigravity-cli/brain',
            conversationId: 'remote-1',
            sourceRevision: 'revision-1',
          },
          remoteSessionId: 'remote-1',
        };
      }
      reResolveSignal = signal ?? null;
      reResolveStarted();
      return await reResolvedIdentity;
    });
    const followTranscript = vi.fn(async () => {
      throw new Error('follow host must not start after admission expiry');
    });
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{
        agentId: 'antigravity',
        sourceId: 'source-1',
        source: { kind: 'antigravityCliPrint' },
        validatedAtAdmission: true,
        supportsFollow: true,
      }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{
          source: ExternalSessionsSource;
        }>) => ({ ok: true as const, source }),
        listCandidates,
        resolveLinkIdentity,
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
    const caller = new AbortController();
    const target = await adapter.compositionPort.resolveFollowTarget({
      agentId: 'antigravity',
      remoteSessionId: 'remote-1',
      signal: caller.signal,
    });
    if (target.status !== 'resolved') {
      throw new Error('private target resolution did not yield an exact target');
    }
    const pending = adapter.compositionPort.followTranscript(
      target,
      {
        admissionDeadlineAtMs: 25_000,
        signal: caller.signal,
      },
      vi.fn(),
    );
    let outcome: unknown = null;
    void pending.then((value) => {
      outcome = value;
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      await reResolveStartedPromise;
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();

      expect(outcome).toEqual({
        status: 'unavailable',
        code: 'plugin_operation_deadline_exceeded',
      });
      expect(isAbortedSignal(reResolveSignal)).toBe(true);
      expect(resolveLinkIdentity).toHaveBeenCalledTimes(2);
      expect(listCandidates).not.toHaveBeenCalled();
      expect(followTranscript).not.toHaveBeenCalled();
    } finally {
      caller.abort();
      releaseIdentity();
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: 'same-kind source rewrite',
      resolveIdentity: () => ({
        source: { kind: 'codexHome', home: 'rewritten' },
        remoteSessionId: 'remote-1',
      }),
    },
    {
      name: 'remote-session id rewrite',
      resolveIdentity: () => ({
        source: { kind: 'codexHome', home: 'user' },
        remoteSessionId: 'remote-2',
      }),
    },
  ])('returns typed unavailable for a private follow $name', async ({ resolveIdentity }) => {
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
        listCandidates: vi.fn(),
        resolveLinkIdentity: async () => resolveIdentity(),
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
      }),
    });

    await expect(adapter.compositionPort.resolveFollowTarget({
      agentId: 'codex',
      remoteSessionId: 'remote-1',
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_identity_unavailable',
    });
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

    await expect(adapter.compositionPort.resolveFollowTarget({
      agentId: 'codex',
      remoteSessionId: 'remote-1',
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_identity_ambiguous',
    });
    const resolveWithLegacyExtra = adapter.compositionPort.resolveFollowTarget as (
      input: Readonly<{
        agentId: 'codex';
        sourceId: 'source-2';
        remoteSessionId: 'remote-1';
      }>,
    ) => ReturnType<ExternalSessionsCompositionPort['resolveFollowTarget']>;
    await expect(resolveWithLegacyExtra({
      agentId: 'codex',
      sourceId: 'source-2',
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

    await expect(adapter.compositionPort.resolveFollowTarget({
      agentId: 'codex',
      remoteSessionId: 'remote-1',
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_identity_unavailable',
    });
  });

  it('reports frozen typed unavailable capabilities and rejects before invocation', async () => {
    const resolveProviderOps = vi.fn();
    const adapter = createPluginExternalSessionsAdapter({ isCurrent: () => true, sources: [], resolveProviderOps });
    const capabilities = adapter.authorService.capabilities();
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(capabilities.attach).toEqual({ status: 'unavailable', code: 'plugin_external_attach_unavailable' });
    await expect(adapter.authorService.attach(ref)).rejects.toMatchObject({ code: 'plugin_external_attach_unavailable' });
    await expect(adapter.authorService.list()).rejects.toMatchObject({ code: 'plugin_external_list_unavailable' });
    expect(resolveProviderOps).not.toHaveBeenCalled();
  });

  it('rejects an undeclared follow capability before provider invocation', async () => {
    const resolveProviderOps = vi.fn();
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps,
    });
    await expect(adapter.compositionPort.followTranscript(target, {}, vi.fn())).resolves.toEqual({
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
    const first = await adapter.authorService.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    const firstCursor = requireListCursor(first);
    expect(calls).toHaveLength(2);
    const second = await adapter.authorService.list({ cursor: firstCursor, limit: 2 });
    expect(second.items).toHaveLength(2);
    expect(calls).toHaveLength(2);
    const third = await adapter.authorService.list({ cursor: requireListCursor(second), limit: 2 });
    expect(third.items).toHaveLength(2);
    expect(calls).toHaveLength(4);
  });

  it('resolves a colliding public ref through its identity owner without re-listing candidates', async () => {
    const source = {
      kind: 'claudeConfig' as const,
      configDir: '/fixtures/.claude',
    };
    const resolveLinkIdentity = vi.fn(async ({ remoteSessionId }: Readonly<{
      source: ExternalSessionsSource;
      remoteSessionId: string;
    }>) => {
      return {
        source: {
          ...source,
          projectId: 'project-newer',
        },
        remoteSessionId,
      };
    });
    const attach = vi.fn(async (candidateRef: ExternalSessionRef, candidateSource: ExternalSessionsSource) => {
      expect(candidateSource).toMatchObject({ projectId: 'project-newer' });
      return { sessionId: 'linked-project-newer' };
    });
    const pageTranscript = vi.fn(async ({
      source: candidateSource,
      remoteSessionId,
    }: Readonly<{
      source: ExternalSessionsSource;
      remoteSessionId: string;
      direction: 'older' | 'newer';
      maxBytes: number;
      maxItems: number;
      signal?: AbortSignal;
    }>) => {
      expect(candidateSource).toMatchObject({ projectId: 'project-newer' });
      return {
        items: [],
        nextCursor: null,
        tailCursor: null,
        hasMore: false,
        truncated: false,
      };
    });
    const claudeListCandidates = vi.fn(async ({ cursor }: Readonly<{ cursor?: string }>) => cursor
      ? {
          candidates: [
            {
              remoteSessionId: 'shared-session',
              title: 'older project',
              updatedAtMs: 100,
              linkData: { projectId: 'project-older' },
            },
            { remoteSessionId: 'later-session', updatedAtMs: 1 },
          ],
          nextCursor: null,
        }
      : {
          candidates: [
            {
              remoteSessionId: 'shared-session',
              title: 'older project',
              updatedAtMs: 100,
              linkData: { projectId: 'project-older' },
            },
            {
              remoteSessionId: 'shared-session',
              title: 'newer project',
              updatedAtMs: 200,
              linkData: { projectId: 'project-newer' },
            },
            { remoteSessionId: 'other-session', updatedAtMs: 50 },
          ],
          nextCursor: 'next-page',
        });
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [
        { agentId: 'claude', sourceId: 'claudeConfig:default', source },
        {
          agentId: 'codex',
          sourceId: 'codexHome:filler',
          source: { kind: 'codexHome', home: 'user' },
        },
      ],
      resolveProviderOps: async (agentId) => {
        if (agentId === 'codex') {
          return {
            validateSource: async ({ source: candidateSource }: Readonly<{
              source: ExternalSessionsSource;
            }>) => ({ ok: true as const, source: candidateSource }),
            listCandidates: async () => ({
              candidates: [{ remoteSessionId: 'filler-session', updatedAtMs: 25 }],
              nextCursor: null,
            }),
            pageTranscript: async () => ({
              items: [],
              nextCursor: null,
              tailCursor: null,
              hasMore: false,
              truncated: false,
            }),
          };
        }
        return {
          validateSource: async ({ source: candidateSource }: Readonly<{ source: ExternalSessionsSource }>) => ({
            ok: true as const,
            source: candidateSource,
          }),
          listCandidates: claudeListCandidates,
          resolveLinkIdentity,
          pageTranscript,
        };
      },
      attach,
    });

    const first = await adapter.authorService.list({ limit: 3 });
    expect(first.items).toEqual([
      expect.objectContaining({
        ref: {
          agentId: 'claude',
          sourceId: 'claudeConfig:default',
          remoteSessionId: 'shared-session',
        },
        title: 'newer project',
      }),
      expect.objectContaining({ ref: expect.objectContaining({ remoteSessionId: 'other-session' }) }),
      expect.objectContaining({ ref: expect.objectContaining({ remoteSessionId: 'filler-session' }) }),
    ]);
    expect(first.diagnostics).toEqual([
      expect.objectContaining({
        code: 'plugin_external_public_ref_collision',
        details: { agentId: 'claude', sourceId: 'claudeConfig:default' },
      }),
    ]);
    expect(JSON.stringify(first)).not.toContain('project-newer');
    expect(JSON.stringify(first)).not.toContain('project-older');
    expect(Object.keys(first.items[0]!).sort()).toEqual([
      'capabilities',
      'ref',
      'title',
      'updatedAtMs',
    ]);
    expect(Object.keys(first.items[0]!.ref).sort()).toEqual([
      'agentId',
      'remoteSessionId',
      'sourceId',
    ]);

    const sharedRef = first.items[0]!.ref;
    const listCallsAfterListing = claudeListCandidates.mock.calls.length;
    await expect(adapter.authorService.attach(sharedRef)).resolves.toEqual({
      sessionId: 'linked-project-newer',
    });
    await expect(adapter.authorService.readTranscript(sharedRef, {
      mode: 'page',
      direction: 'older',
    })).resolves.toMatchObject({ mode: 'page', items: [] });
    expect(attach).toHaveBeenCalledWith(sharedRef, {
      ...source,
      projectId: 'project-newer',
    }, expect.anything());
    expect(pageTranscript).toHaveBeenCalledWith(expect.objectContaining({
      source: { ...source, projectId: 'project-newer' },
      remoteSessionId: 'shared-session',
    }));
    expect(resolveLinkIdentity).toHaveBeenCalledTimes(2);
    expect(resolveLinkIdentity.mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({ source, remoteSessionId: 'shared-session' })],
    ]));
    expect(resolveLinkIdentity.mock.calls.every(([request]) => !Reflect.has(request, 'metadata'))).toBe(true);
    expect(claudeListCandidates).toHaveBeenCalledTimes(listCallsAfterListing);

    const second = await adapter.authorService.list({
      cursor: requireListCursor(first),
      limit: 3,
    });
    expect(second.items).toEqual([
      expect.objectContaining({ ref: expect.objectContaining({ remoteSessionId: 'later-session' }) }),
    ]);
    expect(second.items).not.toContainEqual(expect.objectContaining({
      ref: expect.objectContaining({ remoteSessionId: 'shared-session' }),
    }));
    expect(second.diagnostics).toEqual(first.diagnostics);
  });

  it('bounds aggregate cursor snapshots by complete retained state and clears that budget on retirement', async () => {
    let current = true;
    let rootPage = 0;
    const largeButValidTitle = '界'.repeat(780);
    const sources = Array.from({ length: MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION }, (_, index) => ({
      agentId: 'codex' as const,
      sourceId: `source-${String(index).padStart(2, '0')}`,
      source: {
        kind: 'codexHome' as const,
        home: 'user' as const,
        slot: index,
      },
    }));
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => current,
      sources,
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async ({ cursor, source }) => {
          const slot = typeof source.slot === 'number' ? source.slot : -1;
          const pageId = cursor ? `tail-${cursor}` : `root-${rootPage}`;
          return {
            candidates: Array.from({ length: 50 }, (_, candidateIndex) => ({
              remoteSessionId: `${pageId}:remote-${slot}-${String(candidateIndex).padStart(2, '0')}`,
              title: `${rootPage}:${slot}:${largeButValidTitle}`,
              updatedAtMs: 100 - slot,
            })),
            nextCursor: cursor ? null : `root-${rootPage}:next:${slot}:initial`,
          };
        },
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });
    const createRootCursor = async (): Promise<string> => {
      rootPage += 1;
      const result = await adapter.authorService.list({ limit: 50, maxBytes: 1_048_576 });
      expect(result.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
      return result.nextCursor!;
    };

    const cursors: string[] = [];
    for (let index = 0; index < 5; index += 1) cursors.push(await createRootCursor());

    await expect(adapter.authorService.list({ cursor: cursors[0], limit: 50, maxBytes: 1_048_576 })).rejects.toMatchObject({
      code: 'plugin_external_cursor_invalid',
    });
    const latestPage = await adapter.authorService.list({ cursor: cursors.at(-1), limit: 50, maxBytes: 1_048_576 });
    expect(latestPage.items[0]).toEqual(expect.objectContaining({
      ref: expect.objectContaining({ agentId: 'codex' }),
    }));

    current = false;
    await expect(adapter.authorService.list()).rejects.toMatchObject({ code: 'plugin_generation_retired' });
    current = true;
    await expect(adapter.authorService.list({ cursor: cursors.at(-2), limit: 50, maxBytes: 1_048_576 })).rejects.toMatchObject({
      code: 'plugin_external_cursor_invalid',
    });

    const afterClear = [await createRootCursor(), await createRootCursor()];
    const postRetirementPage = await adapter.authorService.list({ cursor: afterClear[0], limit: 50, maxBytes: 1_048_576 });
    expect(postRetirementPage.items[0]).toEqual(expect.objectContaining({
      ref: expect.objectContaining({ agentId: 'codex' }),
    }));
  });

  it('retains exactly 128 small cursor snapshots before evicting the oldest', async () => {
    const createAdapter = () => createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex' as const, sourceId: 'source-1', source: { kind: 'codexHome' as const, home: 'user' as const } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async ({ cursor }) => ({
          candidates: [{ remoteSessionId: cursor ? `tail-${cursor}` : 'head', updatedAtMs: 1 }],
          nextCursor: cursor ? null : 'provider-next',
        }),
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });
    const collectRootCursors = async (adapter: ReturnType<typeof createAdapter>, count: number): Promise<string[]> => {
      const cursors: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const page = await adapter.authorService.list({ limit: 1 });
        if (!page.nextCursor) throw new Error('Expected a cursor snapshot');
        cursors.push(page.nextCursor);
      }
      return cursors;
    };

    const atBoundary = createAdapter();
    const boundaryCursors = await collectRootCursors(atBoundary, 128);
    await expect(atBoundary.authorService.list({ cursor: boundaryCursors[0], limit: 1 })).resolves.toMatchObject({
      items: [expect.objectContaining({ ref: expect.objectContaining({ remoteSessionId: 'tail-provider-next' }) })],
    });

    const overBoundary = createAdapter();
    const overBoundaryCursors = await collectRootCursors(overBoundary, 129);
    await expect(overBoundary.authorService.list({ cursor: overBoundaryCursors[0], limit: 1 })).rejects.toMatchObject({
      code: 'plugin_external_cursor_invalid',
    });
    await expect(overBoundary.authorService.list({ cursor: overBoundaryCursors.at(-1), limit: 1 })).resolves.toMatchObject({
      items: [expect.objectContaining({ ref: expect.objectContaining({ remoteSessionId: 'tail-provider-next' }) })],
    });
  });

  it('consumes cursors once and rejects replay plus query/filter mismatch', async () => {
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async ({ cursor }) => ({
          candidates: [{ remoteSessionId: cursor ? `candidate-${cursor}` : 'candidate-initial', updatedAtMs: 1 }],
          nextCursor: cursor ? null : 'provider-next',
        }),
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    const replayRoot = await adapter.authorService.list({ limit: 1 });
    const replayCursor = requireListCursor(replayRoot);
    await expect(adapter.authorService.list({ cursor: replayCursor, limit: 1 })).resolves.toMatchObject({
      items: [expect.objectContaining({ ref: expect.objectContaining({ remoteSessionId: 'candidate-provider-next' }) })],
    });
    await expect(adapter.authorService.list({ cursor: replayCursor, limit: 1 })).rejects.toMatchObject({
      code: 'plugin_external_cursor_invalid',
    });

    const mismatchRoot = await adapter.authorService.list({ agentId: 'codex', limit: 1 });
    await expect(adapter.authorService.list({ cursor: requireListCursor(mismatchRoot), sourceId: 'source-1', limit: 1 })).rejects.toMatchObject({
      code: 'plugin_external_cursor_invalid',
    });
  });

  it('rejects a repeated provider cursor', async () => {
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: 'repeated-provider-cursor' }),
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    await expect(adapter.authorService.list({ limit: 50 })).rejects.toMatchObject({
      code: 'plugin_external_inventory_capacity_exceeded',
    });
  });

  it('admits 100 provider pages and rejects acquisition of page 101', async () => {
    let calls = 0;
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => {
          calls += 1;
          return {
            candidates: [{ remoteSessionId: `remote-${calls}`, updatedAtMs: calls }],
            nextCursor: `provider-${calls}`,
          };
        },
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await adapter.authorService.list({ ...(cursor ? { cursor } : {}), limit: 1 });
      cursor = requireListCursor(result);
    }
    expect(calls).toBe(100);
    await expect(adapter.authorService.list({ cursor, limit: 1 })).rejects.toMatchObject({
      code: 'plugin_external_inventory_capacity_exceeded',
    });
    expect(calls).toBe(100);
  });

  it('admits caller limits 50 and 51 while clamping both to one 50-item provider page', async () => {
    const corpus = Array.from({ length: 100 }, (_, index) => ({
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

    const atBoundary = await adapter.authorService.list({ limit: 50, maxBytes: 1_048_576 });
    const firstOver = await adapter.authorService.list({ limit: 51, maxBytes: 1_048_576 });

    expect(atBoundary.items).toHaveLength(50);
    expect(firstOver.items).toHaveLength(50);
    expect(listCandidates).toHaveBeenCalledTimes(2);
    expect(listCandidates.mock.calls.map(([input]) => input.limit)).toEqual([50, 50]);
  });

  it('exhausts a 51-item provider page for one cursor snapshot while preserving a healthy source', async () => {
    let oversizedSourceAttempts = 0;
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [
        { agentId: 'codex', sourceId: 'oversized', source: { kind: 'codexHome' as const, home: 'user' as const, slot: 'oversized' } },
        { agentId: 'codex', sourceId: 'healthy', source: { kind: 'codexHome' as const, home: 'user' as const, slot: 'healthy' } },
      ],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async ({ cursor, source }) => {
          if (source.slot === 'oversized') {
            oversizedSourceAttempts += 1;
            return {
              candidates: Array.from({ length: 51 }, (_, index) => ({
                remoteSessionId: `oversized-${index}`,
                updatedAtMs: 1,
              })),
              nextCursor: null,
            };
          }
          return cursor
            ? { candidates: [{ remoteSessionId: 'healthy-older', updatedAtMs: 1 }], nextCursor: null }
            : {
                candidates: Array.from({ length: 50 }, (_, index) => ({
                  remoteSessionId: `healthy-newer-${index}`,
                  updatedAtMs: 2,
                })),
                nextCursor: 'healthy-next',
              };
        },
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    const first = await adapter.authorService.list({ limit: 51 });
    expect(first.items).toHaveLength(50);
    expect(first.items.every((item) => item.ref.remoteSessionId.startsWith('healthy-newer-'))).toBe(true);
    expect(first.diagnostics).toEqual([expect.objectContaining({
      code: 'plugin_external_source_failed',
      details: { agentId: 'codex', sourceId: 'oversized' },
    })]);
    const second = await adapter.authorService.list({ cursor: requireListCursor(first), limit: 51 });
    expect(second.items.map((item) => item.ref.remoteSessionId)).toEqual(['healthy-older']);
    expect(second.diagnostics).toEqual(first.diagnostics);
    expect(oversizedSourceAttempts).toBe(1);

    await adapter.authorService.list({ limit: 51 });
    expect(oversizedSourceAttempts).toBe(2);
  });

  it('admits an exactly 1 MiB settled list source page', async () => {
    const createAdapter = (targetBytes: number) => createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => ({
          candidates: createCandidatesAtSettledListBytes(targetBytes, 'source-1'),
          nextCursor: null,
        }),
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    await expect(createAdapter(1_048_576).authorService.list({ limit: 50, maxBytes: 1_048_576 })).resolves.toMatchObject({
      items: expect.any(Array),
    });
  });

  it('exhausts an oversized source page for one cursor snapshot while preserving a healthy source', async () => {
    let oversizedSourceAttempts = 0;
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [
        { agentId: 'codex', sourceId: 'oversized', source: { kind: 'codexHome' as const, home: 'user' as const, slot: 'oversized' } },
        { agentId: 'codex', sourceId: 'healthy', source: { kind: 'codexHome' as const, home: 'user' as const, slot: 'healthy' } },
      ],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async ({ cursor, source }) => {
          if (source.slot === 'oversized') {
            oversizedSourceAttempts += 1;
            return {
              candidates: createCandidatesAtSettledListBytes(1_048_577, 'oversized'),
              nextCursor: null,
            };
          }
          return cursor
            ? { candidates: [{ remoteSessionId: 'healthy-older', updatedAtMs: 1 }], nextCursor: null }
            : {
                candidates: Array.from({ length: 50 }, (_, index) => ({
                  remoteSessionId: `healthy-newer-${index}`,
                  updatedAtMs: 2,
                })),
                nextCursor: 'healthy-next',
              };
        },
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    const first = await adapter.authorService.list({ limit: 50, maxBytes: 1_048_576 });
    expect(first.items).toHaveLength(50);
    expect(first.items.every((item) => item.ref.remoteSessionId.startsWith('healthy-newer-'))).toBe(true);
    expect(first.diagnostics).toEqual([expect.objectContaining({
      code: 'plugin_external_source_failed',
      details: { agentId: 'codex', sourceId: 'oversized' },
    })]);
    const second = await adapter.authorService.list({
      cursor: requireListCursor(first),
      limit: 50,
      maxBytes: 1_048_576,
    });
    expect(second.items.map((item) => item.ref.remoteSessionId)).toEqual(['healthy-older']);
    expect(second.diagnostics).toEqual(first.diagnostics);
    expect(oversizedSourceAttempts).toBe(1);

    await adapter.authorService.list({ limit: 50, maxBytes: 1_048_576 });
    expect(oversizedSourceAttempts).toBe(2);
  });

  it('admits exactly 4 MiB of retained candidate state and rejects the first byte over', async () => {
    const createFixture = (targetBytes: number) => {
      const candidatesBySource = Array.from(
        { length: MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION },
        (_, sourceIndex) => Array.from({ length: 50 }, (_, candidateIndex) => ({
          remoteSessionId: `remote-${String(candidateIndex).padStart(2, '0')}`,
          title: 'a',
          updatedAtMs: 1,
          sourceId: `source-${String(sourceIndex).padStart(2, '0')}`,
        })),
      );
      const retainedCandidates = candidatesBySource.flatMap((candidates, sourceIndex) => (
        candidates.slice(sourceIndex === 0 ? 50 : 0)
      ));
      const projectRetained = () => retainedCandidates.map((candidate) => ({
        ref: {
          agentId: 'codex',
          remoteSessionId: candidate.remoteSessionId,
          sourceId: candidate.sourceId,
        },
        title: candidate.title,
        updatedAtMs: candidate.updatedAtMs,
        capabilities: ['transcript'],
      }));
      const byteLength = () => new TextEncoder().encode(JSON.stringify(projectRetained())).byteLength;
      let remainingBytes = targetBytes - byteLength();
      const sharedThreeByteCodeUnits = Math.floor(remainingBytes / (3 * retainedCandidates.length));
      for (const candidate of retainedCandidates) {
        candidate.title += '界'.repeat(sharedThreeByteCodeUnits);
        remainingBytes -= sharedThreeByteCodeUnits * 3;
      }
      for (const candidate of retainedCandidates) {
        if (remainingBytes < 3) break;
        candidate.title += '界';
        remainingBytes -= 3;
      }
      const remainderTarget = retainedCandidates.find((candidate) => candidate.title.length < 10_000);
      if (!remainderTarget || remainingBytes < 0 || remainingBytes > 2) throw new Error('Unable to build exact retained-state fixture');
      if (remainingBytes === 1) remainderTarget.title += 'b';
      if (remainingBytes === 2) remainderTarget.title += 'é';
      expect(byteLength()).toBe(targetBytes);
      expect(retainedCandidates.every((candidate) => candidate.title.length <= 10_000)).toBe(true);
      const sources = candidatesBySource.map((_, sourceIndex) => ({
        agentId: 'codex' as const,
        sourceId: `source-${String(sourceIndex).padStart(2, '0')}`,
        source: { kind: 'codexHome' as const, home: 'user' as const, slot: sourceIndex },
      }));
      return { candidatesBySource, sources };
    };
    const createAdapter = (targetBytes: number) => {
      const fixture = createFixture(targetBytes);
      return createPluginExternalSessionsAdapter({
        isCurrent: () => true,
        sources: fixture.sources,
        resolveProviderOps: async () => ({
          validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
          listCandidates: async ({ source }) => ({
            candidates: fixture.candidatesBySource[Number(source.slot)]!,
            nextCursor: `provider-next-${String(source.slot)}`,
          }),
          pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
        }),
      });
    };

    await expect(createAdapter(4 * 1024 * 1024).authorService.list({ limit: 50, maxBytes: 1_048_576 })).resolves.toMatchObject({
      nextCursor: expect.stringMatching(/^plugin_external_sessions_v1_/),
    });
    await expect(createAdapter((4 * 1024 * 1024) + 1).authorService.list({ limit: 50, maxBytes: 1_048_576 })).rejects.toMatchObject({
      code: 'plugin_external_inventory_capacity_exceeded',
    });
  });

  it('keeps candidate-index preparation cursor-bounded without misordering buffered source heads', async () => {
    const indexedCursors: Array<string | undefined> = [];
    const nativeCursors: Array<string | undefined> = [];
    let indexedAttempts = 0;
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
      queryCandidates: async ({ cursor, entry }) => {
        if (entry.sourceId === 'indexed') {
          indexedAttempts += 1;
          indexedCursors.push(cursor);
          if (indexedAttempts === 1) {
            return {
              candidates: [],
              nextCursor: 'indexed-preparing-next',
              preparation: { kind: 'building_candidate_index', scanned: 50 },
            };
          }
          if (cursor !== 'indexed-preparing-next') {
            throw new Error('Expected the preparation continuation to be retained');
          }
          return {
            candidates: [{ remoteSessionId: 'indexed-newer', updatedAtMs: 2 }],
            nextCursor: null,
          };
        }
        nativeCursors.push(cursor);
        return {
          candidates: [{ remoteSessionId: 'native-older', updatedAtMs: 1 }],
          nextCursor: null,
        };
      },
    });

    const first = await adapter.authorService.list({ limit: 1 });
    expect(first.items).toEqual([]);
    expect(indexedCursors).toEqual([undefined]);
    expect(nativeCursors).toEqual([undefined]);

    const second = await adapter.authorService.list({ cursor: requireListCursor(first), limit: 1 });
    expect(second.items.map((item) => item.ref.remoteSessionId)).toEqual(['indexed-newer']);
    expect(indexedCursors).toEqual([undefined, 'indexed-preparing-next']);
    expect(nativeCursors).toEqual([undefined]);

    const third = await adapter.authorService.list({ cursor: requireListCursor(second), limit: 1 });
    expect(third.items.map((item) => item.ref.remoteSessionId)).toEqual(['native-older']);
    expect(third.nextCursor).toBeUndefined();
    expect(directListCandidates).not.toHaveBeenCalled();
  });

  it('publishes ready sources and one source-local diagnostic when an index cannot finish preparing', async () => {
    vi.useFakeTimers();
    let preparationRequests = 0;
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [
        { agentId: 'codex', sourceId: 'indexed', source: { kind: 'codexHome', home: 'user' } },
        { agentId: 'codex', sourceId: 'native', source: { kind: 'codexHome', home: 'connectedService' } },
      ],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
      queryCandidates: async ({ entry, signal }) => {
        if (entry.sourceId !== 'indexed') {
          return { candidates: [{ remoteSessionId: 'native', updatedAtMs: 1 }], nextCursor: null };
        }
        preparationRequests += 1;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('source acquisition aborted', 'AbortError'));
          }, { once: true });
        });
        return {
          candidates: [],
          nextCursor: null,
          preparation: { kind: 'building_candidate_index', scanned: preparationRequests * 50 },
        };
      },
    });

    try {
      const pending = adapter.authorService.list();
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({
        items: [expect.objectContaining({ ref: expect.objectContaining({ remoteSessionId: 'native' }) })],
        diagnostics: [expect.objectContaining({
          code: 'plugin_external_source_timeout',
          details: { agentId: 'codex', sourceId: 'indexed' },
        })],
      });
      expect(preparationRequests).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps empty source continuations live across public cursors without misordering ready heads', async () => {
    const emptyContinuationPages = 10;
    const calls: string[] = [];
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [
        { agentId: 'codex', sourceId: 'deferred', source: { kind: 'codexHome', home: 'user' } },
        { agentId: 'codex', sourceId: 'ready', source: { kind: 'codexHome', home: 'connectedService' } },
      ],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async ({ cursor, source }) => {
          const sourceId = source.home === 'user' ? 'deferred' : 'ready';
          calls.push(`${sourceId}:${cursor ?? 'first'}`);
          if (sourceId === 'ready') {
            return {
              candidates: [{ remoteSessionId: 'ready-older', updatedAtMs: 1 }],
              nextCursor: null,
            };
          }
          const emptyPage = cursor === undefined ? 0 : Number(cursor.slice('empty-'.length));
          if (emptyPage < emptyContinuationPages) {
            return { candidates: [], nextCursor: `empty-${String(emptyPage + 1)}` };
          }
          return {
            candidates: [{ remoteSessionId: 'deferred-newer', updatedAtMs: 2 }],
            nextCursor: null,
          };
        },
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    let page = await adapter.authorService.list({ limit: 1 });
    for (let pageIndex = 0; pageIndex < emptyContinuationPages; pageIndex += 1) {
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
      expect(calls.filter((call) => call.startsWith('deferred:'))).toHaveLength(pageIndex + 1);
      expect(calls.filter((call) => call.startsWith('ready:'))).toHaveLength(1);
      page = await adapter.authorService.list({ cursor: requireListCursor(page), limit: 1 });
    }

    expect(page.items.map((item) => item.ref.remoteSessionId)).toEqual(['deferred-newer']);
    expect(calls.filter((call) => call.startsWith('deferred:'))).toHaveLength(emptyContinuationPages + 1);
    const finalPage = await adapter.authorService.list({ cursor: requireListCursor(page), limit: 1 });
    expect(finalPage.items.map((item) => item.ref.remoteSessionId)).toEqual(['ready-older']);
    expect(finalPage.nextCursor).toBeUndefined();
    expect(calls.filter((call) => call.startsWith('ready:'))).toHaveLength(1);
  });

  it('admits eight empty continuation pages and rejects the ninth', async () => {
    const createAdapter = (emptyContinuations: number) => {
      let providerPage = 0;
      const listCandidates = vi.fn(async () => {
        providerPage += 1;
        if (providerPage > emptyContinuations + 1) {
          return { candidates: [{ remoteSessionId: 'after-empty-pages', updatedAtMs: 1 }], nextCursor: null };
        }
        return { candidates: [], nextCursor: `empty-${providerPage}` };
      });
      return { listCandidates, adapter: createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates,
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
      }) };
    };

    const boundary = createAdapter(8);
    await expect(boundary.adapter.authorService.list({ limit: 50 })).resolves.toMatchObject({
      items: [expect.objectContaining({ ref: expect.objectContaining({ remoteSessionId: 'after-empty-pages' }) })],
    });
    expect(boundary.listCandidates).toHaveBeenCalledTimes(10);

    const overBoundary = createAdapter(9);
    await expect(overBoundary.adapter.authorService.list({ limit: 50 })).resolves.toMatchObject({
      items: [],
      diagnostics: [expect.objectContaining({
        code: 'plugin_external_inventory_capacity_exceeded',
        details: { agentId: 'codex', sourceId: 'source-1' },
      })],
    });
    expect(overBoundary.listCandidates).toHaveBeenCalledTimes(10);
  });

  it('emits a ready source head while exhausting an over-limit empty continuation source', async () => {
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

    const result = await adapter.authorService.list({ limit: 1 });

    expect(result.items.map((item) => item.ref.remoteSessionId)).toEqual(['ready']);
    expect(result.nextCursor).toBeUndefined();
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: 'plugin_external_inventory_capacity_exceeded',
      details: { agentId: 'codex', sourceId: 'source-empty' },
    })]);
  });

  it('orders every equal-timestamp tie field by UTF-16 code units instead of ambient locale collation', async () => {
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [
        { agentId: 'agent', sourceId: 'source', source: { kind: 'codexHome' as const, home: 'user' as const, slot: 'agent' } },
        { agentId: 'Agent', sourceId: 'source', source: { kind: 'codexHome' as const, home: 'user' as const, slot: 'Agent' } },
        { agentId: 'same', sourceId: 'source-a', source: { kind: 'codexHome' as const, home: 'user' as const, slot: 'source-a' } },
        { agentId: 'same', sourceId: 'source-Z', source: { kind: 'codexHome' as const, home: 'user' as const, slot: 'source-Z' } },
        { agentId: 'remote', sourceId: 'source', source: { kind: 'codexHome' as const, home: 'user' as const, slot: 'remote' } },
      ],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async ({ source }) => ({
          candidates: source.slot === 'remote'
            ? [
                { remoteSessionId: 'remote-a', updatedAtMs: 1 },
                { remoteSessionId: 'remote-Z', updatedAtMs: 1 },
              ]
            : [{ remoteSessionId: 'remote', updatedAtMs: 1 }],
          nextCursor: null,
        }),
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    const page = await adapter.authorService.list({ limit: 6 });

    expect(page.items.map((item) => [item.ref.agentId, item.ref.sourceId, item.ref.remoteSessionId])).toEqual([
      ['Agent', 'source', 'remote'],
      ['agent', 'source', 'remote'],
      ['remote', 'source', 'remote-Z'],
      ['remote', 'source', 'remote-a'],
      ['same', 'source-Z', 'remote'],
      ['same', 'source-a', 'remote'],
    ]);
  });

  it('runs at most eight complete head acquisitions concurrently across empty continuations', async () => {
    vi.useFakeTimers();
    const activeAcquisitions = new Set<number>();
    let initialStarts = 0;
    let maximumActiveAcquisitions = 0;
    const sources = Array.from({ length: 9 }, (_, index) => ({
      agentId: 'codex' as const,
      sourceId: `source-${index}`,
      source: { kind: 'codexHome' as const, home: 'user' as const, slot: index },
    }));
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources,
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async ({ cursor, source }) => {
          const slot = Number(source.slot);
          if (!cursor) {
            initialStarts += 1;
            activeAcquisitions.add(slot);
            maximumActiveAcquisitions = Math.max(maximumActiveAcquisitions, activeAcquisitions.size);
            return { candidates: [], nextCursor: `continue-${slot}` };
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          activeAcquisitions.delete(slot);
          return source.slot === 8
            ? { candidates: [{ remoteSessionId: 'ready-last', updatedAtMs: 1 }], nextCursor: null }
            : { candidates: [], nextCursor: null };
        },
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    try {
      const pending = adapter.authorService.list({ limit: 9 });
      await vi.advanceTimersByTimeAsync(0);
      expect(initialStarts).toBe(8);
      expect(maximumActiveAcquisitions).toBe(8);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({
        items: [expect.objectContaining({ ref: expect.objectContaining({ remoteSessionId: 'ready-last' }) })],
      });
      expect(maximumActiveAcquisitions).toBe(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies one 3s source budget across initial and empty-continuation provider pages', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let stalledProviderSignalAborted = false;
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [
        { agentId: 'codex', sourceId: 'slow', source: { kind: 'codexHome' as const, home: 'user' as const, slot: 'slow' } },
        { agentId: 'codex', sourceId: 'ready', source: { kind: 'codexHome' as const, home: 'user' as const, slot: 'ready' } },
      ],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async ({ cursor, source, signal }) => {
          if (source.slot === 'ready') {
            return { candidates: [{ remoteSessionId: 'ready', updatedAtMs: 1 }], nextCursor: null };
          }
          if (!cursor) {
            await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
            return { candidates: [], nextCursor: 'slow-continuation' };
          }
          return await new Promise<never>((_resolve, reject) => {
            if (!signal) throw new Error('Expected a provider source-budget signal');
            signal.addEventListener('abort', () => {
              stalledProviderSignalAborted = true;
              reject(new DOMException('source acquisition aborted', 'AbortError'));
            }, { once: true });
          });
        },
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    try {
      const pending = adapter.authorService.list({ limit: 2, signal: caller.signal }).then(
        (value) => ({ status: 'resolved' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      let settled = false;
      void pending.finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const settledAtSourceBudget = settled;
      const providerAbortedAtSourceBudget = stalledProviderSignalAborted;
      if (!settledAtSourceBudget) caller.abort();
      const outcome = await pending;
      expect(settledAtSourceBudget).toBe(true);
      expect(providerAbortedAtSourceBudget).toBe(true);
      expect(outcome).toMatchObject({
        status: 'resolved',
        value: {
          items: [expect.objectContaining({ ref: expect.objectContaining({ remoteSessionId: 'ready' }) })],
          diagnostics: [expect.objectContaining({ details: { agentId: 'codex', sourceId: 'slow' } })],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not starve a ready source after three full waves of source-local timeouts', async () => {
    vi.useFakeTimers();
    const sources = [
      ...Array.from({ length: 24 }, (_, index) => ({
        agentId: 'codex' as const,
        sourceId: `slow-${index}`,
        source: { kind: 'codexHome' as const, home: 'user' as const, slot: `slow-${index}` },
      })),
      {
        agentId: 'codex' as const,
        sourceId: 'ready-after-three-waves',
        source: { kind: 'codexHome' as const, home: 'user' as const, slot: 'ready' },
      },
    ];
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources,
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async ({ cursor, source }) => {
          if (source.slot === 'ready') {
            return { candidates: [{ remoteSessionId: 'ready', updatedAtMs: 1 }], nextCursor: null };
          }
          if (!cursor) return { candidates: [], nextCursor: `continue-${String(source.slot)}` };
          return await new Promise<never>(() => undefined);
        },
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    try {
      const outcome = adapter.authorService.list({ limit: 25 }).then(
        (value) => ({ status: 'resolved' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      let settledBeforeGlobalDeadline = false;
      void outcome.finally(() => { settledBeforeGlobalDeadline = true; });
      await vi.advanceTimersByTimeAsync(12_000);
      const didSettleBeforeGlobalDeadline = settledBeforeGlobalDeadline;
      if (!didSettleBeforeGlobalDeadline) await vi.advanceTimersByTimeAsync(3_000);
      const settled = await outcome;
      expect(didSettleBeforeGlobalDeadline).toBe(true);
      expect(settled.status).toBe('resolved');
      if (settled.status !== 'resolved') return;
      expect(settled.value.items).toEqual([
        expect.objectContaining({ ref: expect.objectContaining({ remoteSessionId: 'ready' }) }),
      ]);
      expect(settled.value.diagnostics).toHaveLength(24);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['provider failure', 'malformed result'] as const)(
  'exhausts a %s for the cursor snapshot while preserving its diagnostic on later pages', async (failureKind) => {
    let failedSourceAttempts = 0;
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [
        { agentId: 'codex', sourceId: 'failing', source: { kind: 'codexHome' as const, home: 'user' as const, slot: 'failing' } },
        { agentId: 'codex', sourceId: 'ready', source: { kind: 'codexHome' as const, home: 'user' as const, slot: 'ready' } },
      ],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async ({ cursor, source }) => {
          if (source.slot === 'failing') {
            failedSourceAttempts += 1;
            if (failureKind === 'malformed result') return { candidates: null, nextCursor: null } as never;
            throw new ExternalSessionProviderFailureError({
              code: 'agent_unavailable',
              message: 'private provider detail',
              operation: 'listCandidates',
              retryable: true,
            });
          }
          return cursor
            ? { candidates: [{ remoteSessionId: 'older', updatedAtMs: 1 }], nextCursor: null }
            : { candidates: [{ remoteSessionId: 'newer', updatedAtMs: 2 }], nextCursor: 'ready-next' };
        },
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    const first = await adapter.authorService.list({ limit: 1 });
    expect(first).toMatchObject({
      items: [expect.objectContaining({ ref: expect.objectContaining({ remoteSessionId: 'newer' }) })],
      diagnostics: [expect.objectContaining({ details: { agentId: 'codex', sourceId: 'failing' } })],
    });
    const firstCursor = requireListCursor(first);
    const second = await adapter.authorService.list({ cursor: firstCursor, limit: 1 });
    expect(second.items.map((item) => item.ref.remoteSessionId)).toEqual(['older']);
    expect(second.diagnostics).toEqual(first.diagnostics);
    expect(second.diagnostics).toEqual([expect.objectContaining({
      code: expect.any(String),
      details: { agentId: 'codex', sourceId: 'failing' },
    })]);
    expect(Object.keys(second.diagnostics![0]!.details!).sort()).toEqual(['agentId', 'sourceId']);
    expect(failedSourceAttempts).toBe(1);

    await adapter.authorService.list({ limit: 1 });
    expect(failedSourceAttempts).toBe(2);
  });

  it('exhausts a validation-unavailable source for one cursor snapshot and retries it on a fresh query', async () => {
    let failingValidationAttempts = 0;
    const failingListCandidates = vi.fn();
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [
        { agentId: 'codex', sourceId: 'failing', source: { kind: 'codexHome' as const, home: 'user' as const, slot: 'failing' } },
        { agentId: 'codex', sourceId: 'ready', source: { kind: 'codexHome' as const, home: 'user' as const, slot: 'ready' } },
      ],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => {
          if (source.slot === 'failing') {
            failingValidationAttempts += 1;
            return { ok: false as const, error: 'source_unavailable' as const };
          }
          return { ok: true as const, source };
        },
        listCandidates: async ({ cursor, source }) => {
          if (source.slot === 'failing') return await failingListCandidates();
          return cursor
            ? { candidates: [{ remoteSessionId: 'older', updatedAtMs: 1 }], nextCursor: null }
            : { candidates: [{ remoteSessionId: 'newer', updatedAtMs: 2 }], nextCursor: 'ready-next' };
        },
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    const first = await adapter.authorService.list({ limit: 1 });
    expect(first).toMatchObject({
      items: [expect.objectContaining({ ref: expect.objectContaining({ remoteSessionId: 'newer' }) })],
      diagnostics: [expect.objectContaining({
        code: 'plugin_external_source_unavailable',
        details: { agentId: 'codex', sourceId: 'failing' },
      })],
    });
    expect(Object.keys(first.diagnostics![0]!.details!).sort()).toEqual(['agentId', 'sourceId']);
    const second = await adapter.authorService.list({ cursor: requireListCursor(first), limit: 1 });
    expect(second.items.map((item) => item.ref.remoteSessionId)).toEqual(['older']);
    expect(second.diagnostics).toEqual(first.diagnostics);
    expect(failingValidationAttempts).toBe(1);
    expect(failingListCandidates).not.toHaveBeenCalled();

    await adapter.authorService.list({ limit: 1 });
    expect(failingValidationAttempts).toBe(2);
    expect(failingListCandidates).not.toHaveBeenCalled();
  });

  it('returns an empty terminal page with bounded diagnostics when every selected source fails', async () => {
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: Array.from({ length: MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION }, (_, index) => ({
        agentId: 'codex' as const,
        sourceId: `failed-${index}`,
        source: { kind: 'codexHome' as const, home: 'user' as const, slot: index },
      })),
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async ({ source }) => {
          if (source.slot === MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION - 1) {
            return { candidates: null, nextCursor: null } as never;
          }
          throw new ExternalSessionProviderFailureError({
            code: 'agent_unavailable',
            message: 'source unavailable',
            operation: 'listCandidates',
            retryable: true,
          });
        },
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    const page = await adapter.authorService.list({ limit: 50 });
    expect(page).toEqual({
      items: [],
      nextCursor: null,
      diagnostics: expect.any(Array),
    });
    expect(page.diagnostics).toHaveLength(MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION);
    const diagnosticDetails = page.diagnostics!.map((diagnostic) => {
      expect(diagnostic.code).toBe(diagnostic.code.trim());
      expect(diagnostic.code.length).toBeLessThanOrEqual(128);
      expect(Object.keys(diagnostic.details!).sort()).toEqual(['agentId', 'sourceId']);
      return diagnostic.details;
    });
    expect(diagnosticDetails).toEqual(expect.arrayContaining(
      Array.from({ length: MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION }, (_, index) => ({
        agentId: 'codex',
        sourceId: `failed-${index}`,
      })),
    ));
  });

  it('propagates the serialized candidate response ceiling and isolates a source that exceeds it', async () => {
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

    await expect(adapter.authorService.list({ limit: 1, maxBytes: 256 } as never)).resolves.toEqual({
      items: [],
      nextCursor: null,
      diagnostics: [expect.objectContaining({
        code: 'plugin_external_source_failed',
        details: { agentId: 'codex', sourceId: 'source-1' },
      })],
    });
    expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 256 }));
  });

  it('exhausts a stalled source at its source-local budget before the host deadline', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => await never,
    });

    try {
      const pending = adapter.authorService.list();
      const result = expect(pending).resolves.toEqual({
        items: [],
        nextCursor: null,
        diagnostics: [expect.objectContaining({
          code: 'plugin_external_source_timeout',
          details: { agentId: 'codex', sourceId: 'source-1' },
        })],
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns every buffered ready head without starting stalled continuations', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let continuationCalls = 0;
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: Array.from({ length: 6 }, (_, index) => ({
        agentId: 'codex' as const,
        sourceId: `source-${index}`,
        source: { kind: 'codexHome' as const, home: 'user' as const, slot: index },
      })),
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async ({ cursor, source }) => {
          if (cursor) {
            continuationCalls += 1;
            return await new Promise<never>(() => undefined);
          }
          return {
            candidates: [{ remoteSessionId: `head-${String(source.slot)}`, updatedAtMs: 10 - Number(source.slot) }],
            nextCursor: `continue-${String(source.slot)}`,
          };
        },
        pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      }),
    });

    try {
      const pending = adapter.authorService.list({ limit: 6, signal: caller.signal }).then(
        (value) => ({ status: 'resolved' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      let outcome: Awaited<typeof pending> | undefined;
      void pending.then((value) => { outcome = value; });

      await vi.advanceTimersByTimeAsync(0);

      expect(continuationCalls).toBe(0);
      expect(outcome).toMatchObject({
        status: 'resolved',
        value: {
          items: Array.from({ length: 6 }, (_, index) => expect.objectContaining({
            ref: expect.objectContaining({ remoteSessionId: `head-${index}` }),
          })),
          nextCursor: expect.stringMatching(/^plugin_external_sessions_v1_/),
        },
      });
    } finally {
      caller.abort();
      await vi.advanceTimersByTimeAsync(0);
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

    const pending = adapter.authorService.list();
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

    await expect(adapter.authorService.list({ limit: 1 })).rejects.toMatchObject({
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
    await expect(adapter.authorService.list()).rejects.toMatchObject({ code: 'plugin_generation_retired' });
    expect(validateSource).not.toHaveBeenCalled();
    expect(listCandidates).not.toHaveBeenCalled();

    current = true;
    await expect(adapter.authorService.list({ limit: Number.NaN })).rejects.toMatchObject({ code: 'plugin_external_limit_invalid' });
  });

  it('rejects malformed list bounds before provider resolution', async () => {
    const resolveProviderOps = vi.fn();
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps,
    });

    for (const [field, value, code] of [
      ['limit', 0, 'plugin_external_limit_invalid'],
      ['limit', Number.NaN, 'plugin_external_limit_invalid'],
      ['limit', Number.POSITIVE_INFINITY, 'plugin_external_limit_invalid'],
      ['limit', 1.5, 'plugin_external_limit_invalid'],
      ['limit', '1', 'plugin_external_limit_invalid'],
      ['maxBytes', 0, 'plugin_external_max_bytes_invalid'],
      ['maxBytes', Number.NaN, 'plugin_external_max_bytes_invalid'],
      ['maxBytes', Number.POSITIVE_INFINITY, 'plugin_external_max_bytes_invalid'],
      ['maxBytes', 1.5, 'plugin_external_max_bytes_invalid'],
      ['maxBytes', '1', 'plugin_external_max_bytes_invalid'],
    ] as const) {
      await expect(adapter.authorService.list({
        [field]: value,
      } as never)).rejects.toMatchObject({ code });
    }
    expect(resolveProviderOps).not.toHaveBeenCalled();
  });

  it('selects read-after explicitly and propagates its cursor and bounds', async () => {
    const pageTranscript = vi.fn(async () => ({
      items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
    }));
    const readAfterTranscript = vi.fn(async () => ({
      outcome: 'advanced' as const,
      items: [{
        id: 'm2',
        createdAtMs: 2,
        raw: {
          role: 'agent',
          content: { type: 'acp', agentId: 'codex', data: { type: 'message', message: 'after' } },
        },
      }],
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

    await expect(adapter.authorService.readTranscript(ref, {
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

  it('preserves a typed read-after source replacement instead of flattening it into a page', async () => {
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript: async () => ({
          items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'source_replaced' as const }),
      }),
    });

    await expect(adapter.authorService.readTranscript(ref, {
      mode: 'readAfter',
      cursor: 'cursor-1',
    })).resolves.toEqual({
      mode: 'readAfter',
      outcome: 'source_replaced',
    });
  });

  it('clamps a 10k SDK transcript request to one source-bounded provider read', async () => {
    const pageTranscript = vi.fn(async ({ maxItems }: Readonly<{ maxItems: number }>) => ({
      items: Array.from({ length: maxItems }, (_, index) => ({
        id: `m${index}`,
        createdAtMs: index,
        raw: {
          role: 'agent',
          content: { type: 'acp', agentId: 'codex', data: { type: 'message', message: `message-${index}` } },
        },
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

    const page = await adapter.authorService.readTranscript(ref, {
      mode: 'page',
      limit: 10_000,
      maxBytes: 10 * 1024 * 1024,
    });

    expect(page.mode).toBe('page');
    if (page.mode !== 'page') throw new Error('Expected a transcript page');
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
        raw: {
          role: 'agent',
          content: { type: 'acp', agentId: 'codex', data: { type: 'message', message: 'message' } },
        },
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

    await expect(adapter.authorService.readTranscript(ref)).rejects.toMatchObject({
      code: 'plugin_external_inventory_capacity_exceeded',
    });
    expect(pageTranscript).toHaveBeenCalledOnce();
  });

  it('rejects a transcript response above the requested serialized-byte ceiling', async () => {
    const pageTranscript = vi.fn(async () => ({
      items: [{
        id: 'large',
        createdAtMs: 2,
        raw: {
          role: 'agent',
          content: { type: 'acp', agentId: 'codex', data: { type: 'message', message: 'x'.repeat(2_000) } },
        },
      }],
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

    await expect(adapter.authorService.readTranscript(ref, { mode: 'page', maxBytes: 256 })).rejects.toMatchObject({
      code: 'plugin_external_response_capacity_exceeded',
    });
    expect(pageTranscript).toHaveBeenCalledWith(expect.objectContaining({
      maxBytes: 256,
      signal: expect.any(AbortSignal),
    }));
  });

  it('permits additive direct-follow revalidation enrichment while preserving the admitted target source', async () => {
    const admittedSource = {
      kind: 'codexHome',
      home: 'user',
      conversationId: 'remote-1',
    } as const;
    const enrichedSource = { ...admittedSource, canonical: true } as const;
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
        validateSource: async () => ({ ok: true as const, source: enrichedSource }),
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

    await expect(adapter.compositionPort.followTranscript({
      ref,
      source: admittedSource,
    }, { cursor: 'cursor-1' }, listener)).resolves.toEqual({
      status: 'following',
      startingCursor: 'cursor-1',
      subscription,
    });
    expect(followTranscript).toHaveBeenCalledOnce();
    expect(followTranscript).toHaveBeenCalledWith({
      ref,
      source: admittedSource,
      options: {
        cursor: 'cursor-1',
        signal: expect.any(AbortSignal),
      },
      listener,
    });
    expect(providerAcquireFollowLease).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'field removal',
      revalidatedSource: ExternalSessionsSourceSchema.parse({
        kind: 'codexHome',
        home: 'user',
      }),
    },
    {
      name: 'same-kind field rewrite',
      revalidatedSource: ExternalSessionsSourceSchema.parse({
        kind: 'codexHome',
        home: 'other-user',
        conversationId: 'remote-1',
      }),
    },
  ])('rejects direct follow revalidation identity $name before host or listener effects', async ({ revalidatedSource }) => {
    const listener = vi.fn();
    const followTranscript = vi.fn(async (input: Readonly<{
      listener: (event: HostExternalTranscriptFollowEvent) => void | Promise<void>;
    }>) => {
      await input.listener({
        kind: 'terminated',
        reason: 'providerFailure',
        cursor: null,
      });
      return Object.freeze({
        status: 'following' as const,
        startingCursor: 'cursor-1',
        subscription: Object.freeze({ dispose: vi.fn(async () => undefined) }),
      });
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
        validateSource: async () => ({ ok: true as const, source: revalidatedSource }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: 'cursor-1',
          hasMore: false,
          truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
      }),
      followTranscript,
    });

    const result = await adapter.compositionPort.followTranscript({
      ref,
      source: {
        kind: 'codexHome',
        home: 'user',
        conversationId: 'remote-1',
      },
    }, {}, listener);

    expect({
      result,
      hostFollowCalls: followTranscript.mock.calls.length,
      listenerCalls: listener.mock.calls.length,
    }).toEqual({
      result: {
        status: 'unavailable',
        code: 'plugin_external_source_unavailable',
      },
      hostFollowCalls: 0,
      listenerCalls: 0,
    });
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

    await expect(adapter.compositionPort.followTranscript(target, {}, vi.fn())).resolves.toEqual({
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

    await expect(adapter.compositionPort.followTranscript(target, {}, vi.fn())).resolves.toEqual({
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

    const acquisition = adapter.compositionPort.followTranscript(
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
    await expect(failing.compositionPort.followTranscript(target, {}, vi.fn())).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_acquisition_failed',
    });
  });

  it('delegates the canonical source returned by provider validation', async () => {
    const canonicalSource = { kind: 'codexHome', home: 'user', canonical: true } as const;
    const listCandidates = vi.fn(async ({ searchTerm }: Readonly<{
      searchTerm?: string;
    }>) => ({
      candidates: searchTerm === 'remote-1'
        ? [{ remoteSessionId: 'remote-1', updatedAtMs: 1 }]
        : [],
      nextCursor: null,
    }));
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
    await adapter.authorService.list();
    await adapter.authorService.attach(ref);
    expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({ source: canonicalSource }));
    expect(attach).toHaveBeenCalledWith(ref, canonicalSource, {
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    ['padded', ' remote-1 '],
    ['overlong', 'x'.repeat(2_001)],
  ])('rejects a %s logical remote identity before source, link, transcript, or follow effects', async (_name, remoteSessionId) => {
    const validateSource = vi.fn(async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({
      ok: true as const,
      source,
    }));
    const attach = vi.fn(async () => ({ sessionId: 'must-not-link' }));
    const pageTranscript = vi.fn(async () => ({
      items: [],
      nextCursor: null,
      tailCursor: null,
      hasMore: false,
      truncated: false,
    }));
    const followTranscript = vi.fn(async () => ({
      status: 'following' as const,
      startingCursor: null,
      subscription: Object.freeze({ dispose: vi.fn(async () => undefined) }),
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
        pageTranscript,
        readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
      }),
      attach,
      followTranscript,
    });
    const invalidRef = { ...ref, remoteSessionId };

    const [attachOutcome, transcriptOutcome] = await Promise.allSettled([
      adapter.authorService.attach(invalidRef),
      adapter.authorService.readTranscript(invalidRef),
    ]);
    const followOutcome = await adapter.compositionPort.followTranscript({
      ref: invalidRef,
      source: { kind: 'codexHome', home: 'user' },
    }, {}, vi.fn());

    expect({
      attachOutcome,
      transcriptOutcome,
      followOutcome,
      effects: {
        validateSource: validateSource.mock.calls.length,
        attach: attach.mock.calls.length,
        transcript: pageTranscript.mock.calls.length,
        follow: followTranscript.mock.calls.length,
      },
    }).toEqual({
      attachOutcome: {
        status: 'rejected',
        reason: expect.objectContaining({ code: 'plugin_external_source_unavailable' }),
      },
      transcriptOutcome: {
        status: 'rejected',
        reason: expect.objectContaining({ code: 'plugin_external_source_unavailable' }),
      },
      followOutcome: {
        status: 'unavailable',
        code: 'plugin_external_source_unavailable',
      },
      effects: {
        validateSource: 0,
        attach: 0,
        transcript: 0,
        follow: 0,
      },
    });
  });

  it.each([
    ['padded', ' remote-1 '],
    ['overlong', 'x'.repeat(2_001)],
  ])('does not publish a provider candidate with a %s logical remote identity', async (_name, remoteSessionId) => {
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{
        agentId: 'codex',
        sourceId: 'source-1',
        source: { kind: 'codexHome', home: 'user' },
      }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({
          ok: true as const,
          source,
        }),
        listCandidates: async () => ({
          candidates: [{ remoteSessionId, updatedAtMs: 1 }],
          nextCursor: null,
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

    await expect(adapter.authorService.list()).resolves.toEqual({
      items: [],
      nextCursor: null,
      diagnostics: [{
        code: 'plugin_external_source_failed',
        severity: 'warning',
        details: { agentId: 'codex', sourceId: 'source-1' },
      }],
    });
  });

  it.each([
    {
      name: 'field removal',
      revalidatedSource: ExternalSessionsSourceSchema.parse({ kind: 'codexHome' }),
    },
    {
      name: 'same-kind field rewrite',
      revalidatedSource: ExternalSessionsSourceSchema.parse({ kind: 'codexHome', home: 'other-user' }),
    },
  ])('rejects adapter revalidation identity $name before list, read, and follow provider effects', async ({ revalidatedSource }) => {
    const listCandidates = vi.fn(async () => ({ candidates: [], nextCursor: null }));
    const pageTranscript = vi.fn(async () => ({
      items: [],
      nextCursor: null,
      tailCursor: null,
      hasMore: false,
      truncated: false,
    }));
    const resolveLinkIdentity = vi.fn(async ({
      source,
      remoteSessionId,
    }: Readonly<{ source: ExternalSessionsSource; remoteSessionId: string }>) => ({
      source,
      remoteSessionId,
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
        validateSource: async () => ({ ok: true as const, source: revalidatedSource }),
        listCandidates,
        pageTranscript,
        resolveLinkIdentity,
      }),
    });

    const [listOutcome, readOutcome] = await Promise.allSettled([
      adapter.authorService.list(),
      adapter.authorService.readTranscript(ref),
    ]);
    const followOutcome = await adapter.compositionPort.resolveFollowTarget({
      agentId: 'codex',
      remoteSessionId: 'remote-1',
    });

    expect({
      listOutcome,
      readOutcome,
      followOutcome,
      providerEffectCalls: {
        list: listCandidates.mock.calls.length,
        read: pageTranscript.mock.calls.length,
        follow: resolveLinkIdentity.mock.calls.length,
      },
    }).toEqual({
      listOutcome: {
        status: 'rejected',
        reason: expect.objectContaining({ code: 'plugin_external_source_unavailable' }),
      },
      readOutcome: {
        status: 'rejected',
        reason: expect.objectContaining({ code: 'plugin_external_source_unavailable' }),
      },
      followOutcome: {
        status: 'unavailable',
        code: 'plugin_external_follow_identity_unavailable',
      },
      providerEffectCalls: { list: 0, read: 0, follow: 0 },
    });
  });

  it('permits additive adapter revalidation identity enrichment for list, read, and follow', async () => {
    const canonicalSource = {
      kind: 'codexHome',
      home: 'user',
      canonical: true,
    } as const;
    const listCandidates = vi.fn(async ({ searchTerm }: Readonly<{
      searchTerm?: string;
    }>) => ({
      candidates: searchTerm === 'remote-1'
        ? [{ remoteSessionId: 'remote-1', updatedAtMs: 1 }]
        : [],
      nextCursor: null,
    }));
    const pageTranscript = vi.fn(async () => ({
      items: [],
      nextCursor: null,
      tailCursor: null,
      hasMore: false,
      truncated: false,
    }));
    const resolveLinkIdentity = vi.fn(async ({
      source,
      remoteSessionId,
    }: Readonly<{ source: ExternalSessionsSource; remoteSessionId: string }>) => ({
      source: { ...source, conversationId: remoteSessionId },
      remoteSessionId,
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
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({
          ok: true as const,
          source: Object.hasOwn(source, 'conversationId')
            ? source
            : canonicalSource,
        }),
        listCandidates,
        pageTranscript,
        resolveLinkIdentity,
      }),
    });

    await expect(adapter.authorService.list()).resolves.toMatchObject({ items: [] });
    await expect(adapter.authorService.readTranscript(ref)).resolves.toMatchObject({ items: [] });
    await expect(adapter.compositionPort.resolveFollowTarget({
      agentId: 'codex',
      remoteSessionId: 'remote-1',
    })).resolves.toEqual({
      status: 'resolved',
      ref,
      source: {
        ...canonicalSource,
        conversationId: 'remote-1',
      },
    });
    expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({ source: canonicalSource }));
    expect(pageTranscript).toHaveBeenCalledWith(expect.objectContaining({
      source: { ...canonicalSource, conversationId: 'remote-1' },
    }));
    expect(resolveLinkIdentity).toHaveBeenCalledWith(expect.objectContaining({ source: canonicalSource }));
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
    });

    await expect(adapter.authorService.list()).rejects.toMatchObject({
      name: 'PluginError',
      code: 'plugin_external_list_failed',
    });
    await expect(adapter.authorService.attach(ref)).rejects.toMatchObject({
      name: 'PluginError',
      code: 'plugin_external_attach_failed',
    });
    await expect(adapter.authorService.readTranscript(ref)).rejects.toMatchObject({
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

    await expect(adapter.authorService.attach(ref, { signal: controller.signal })).rejects.toMatchObject({
      code: 'plugin_operation_aborted',
    });
    await expect(adapter.authorService.readTranscript(ref, { signal: controller.signal })).rejects.toMatchObject({
      code: 'plugin_operation_aborted',
    });
    expect(resolveProviderOps).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it('does not relabel a committed attach as aborted and projects only the linked Session id', async () => {
    const controller = new AbortController();
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
      }) as never,
      attach: async () => {
        controller.abort();
        return {
          sessionId: 'linked-after-abort',
          path: '/private/session/path',
          linkMetadata: { private: true },
          machineId: 'machine-1',
          accountId: 'account-1',
          generation: 'generation-1',
          source: { kind: 'codexHome', home: 'user' },
          runtimeDescriptor: { pid: 123 },
          operationRow: { operationId: 'private-operation' },
          progress: { phase: 'private-progress' },
        };
      },
    });

    await expect(adapter.authorService.attach(ref, { signal: controller.signal })).resolves.toEqual({
      sessionId: 'linked-after-abort',
    });
  });

  it('still reports caller cancellation when the canonical link owner does not commit', async () => {
    const controller = new AbortController();
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
      }) as never,
      attach: async () => {
        controller.abort();
        throw new DOMException('The link was not committed', 'AbortError');
      },
    });

    await expect(adapter.authorService.attach(ref, { signal: controller.signal })).rejects.toMatchObject({
      code: 'plugin_operation_aborted',
    });
  });

  it('keeps trusted semantic tool bodies while dropping host-private item carriers', async () => {
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({ ok: true as const, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
        readAfterTranscript: async () => ({
          outcome: 'advanced' as const,
          items: [{
            id: 'message-1',
            createdAtMs: 1,
            raw: {
              role: 'agent',
              content: {
                type: 'acp',
                agentId: 'codex',
                data: {
                  type: 'tool-result',
                  toolCallId: 'tool-call-1',
                  arguments: {
                    path: '/workspace/src/index.ts',
                    query: 'current global external sessions',
                    source: 'semantic-tool-input',
                    machineId: 'semantic-tool-input-machine',
                  },
                  result: {
                    path: '/workspace/src/index.ts',
                    text: 'tool output',
                    generation: 'semantic-tool-output-generation',
                  },
                },
              },
            },
            path: '/private/transcript.jsonl',
            linkMetadata: { private: true },
            machineId: 'machine-1',
            accountId: 'account-1',
            generation: 'generation-1',
            source: { kind: 'codexHome', home: 'user' },
            runtimeDescriptor: { pid: 123 },
            operationRow: { operationId: 'private-operation' },
            progress: { phase: 'private-progress' },
          }],
          nextCursor: 'cursor-2',
          boundary: 'message-1',
          diagnostics: [{
            code: 'skipped_record',
            count: 1,
            positions: [7],
            path: '/private/transcript.jsonl',
            linkMetadata: { private: true },
            machineId: 'machine-1',
            accountId: 'account-1',
            generation: 'generation-1',
            source: { kind: 'codexHome', home: 'user' },
            runtimeDescriptor: { pid: 123 },
            operationRow: { operationId: 'private-operation' },
            progress: { phase: 'private-progress' },
          }],
        }),
      }),
    });

    await expect(adapter.authorService.readTranscript(ref, {
      mode: 'readAfter',
      cursor: 'cursor-1',
    })).resolves.toEqual({
      mode: 'readAfter',
      outcome: 'advanced',
      items: [{
        id: 'message-1',
        timestampMs: 1,
        kind: 'event',
        data: {
          role: 'event',
          content: {
            type: 'tool-result',
            toolCallId: 'tool-call-1',
            arguments: {
              path: '/workspace/src/index.ts',
              query: 'current global external sessions',
              source: 'semantic-tool-input',
              machineId: 'semantic-tool-input-machine',
            },
            result: {
              path: '/workspace/src/index.ts',
              text: 'tool output',
              generation: 'semantic-tool-output-generation',
            },
          },
        },
      }],
      nextCursor: 'cursor-2',
      boundary: 'message-1',
      diagnostics: [{
        code: 'skipped_record',
        count: 1,
        positions: [7],
      }],
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

    await expect(adapter.authorService.list({ signal: controller.signal })).rejects.toMatchObject({
      code: 'plugin_operation_aborted',
    });
  });

  it('fences a public transcript ref when direct identity resolution returns after retirement', async () => {
    let current = true;
    const listCandidates = vi.fn(async () => {
      throw new Error('public read must not re-list candidates');
    });
    const resolveLinkIdentity = vi.fn(async ({ source, remoteSessionId }: Readonly<{
      source: ExternalSessionsSource;
      remoteSessionId: string;
    }>) => {
      current = false;
      return { source, remoteSessionId };
    });
    const pageTranscript = vi.fn();
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => current,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({
          ok: true as const,
          source,
        }),
        listCandidates,
        resolveLinkIdentity,
        pageTranscript,
      }) as never,
    });

    await expect(adapter.authorService.readTranscript(ref)).rejects.toMatchObject({
      code: 'plugin_generation_retired',
    });
    expect(resolveLinkIdentity).toHaveBeenCalledOnce();
    expect(listCandidates).not.toHaveBeenCalled();
    expect(pageTranscript).not.toHaveBeenCalled();
  });

  it('bounds public transcript identity resolution before transcript effects', async () => {
    vi.useFakeTimers();
    const listCandidates = vi.fn(async () => {
      throw new Error('public read must not re-list candidates');
    });
    const resolveLinkIdentity = vi.fn(async ({ signal }: Readonly<{ signal?: AbortSignal }>) => await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        reject(new DOMException('identity resolution timed out', 'AbortError'));
      }, { once: true });
    }));
    const pageTranscript = vi.fn();
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{ agentId: 'codex', sourceId: 'source-1', source: { kind: 'codexHome', home: 'user' } }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({
          ok: true as const,
          source,
        }),
        listCandidates,
        resolveLinkIdentity,
        pageTranscript,
      }) as never,
    });

    try {
      const pending = adapter.authorService.readTranscript(ref);
      const outcome = pending.then(
        () => new Error('Expected public identity resolution to exceed its deadline.'),
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs);
      await expect(outcome).resolves.toMatchObject({
        code: 'plugin_operation_deadline_exceeded',
      });
      expect(resolveLinkIdentity).toHaveBeenCalledOnce();
      expect(listCandidates).not.toHaveBeenCalled();
      expect(pageTranscript).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads an OpenCode public ref through identity resolution without invoking its candidate search', async () => {
    const listCandidates = vi.fn(async () => {
      throw new Error('OpenCode public read must not invoke candidate search');
    });
    const resolveLinkIdentity = vi.fn(async ({ source, remoteSessionId }: Readonly<{
      source: ExternalSessionsSource;
      remoteSessionId: string;
    }>) => ({ source, remoteSessionId }));
    const pageTranscript = vi.fn(async () => ({
      items: [],
      nextCursor: null,
      tailCursor: null,
      hasMore: false,
      truncated: false,
    }));
    const adapter = createPluginExternalSessionsAdapter({
      isCurrent: () => true,
      sources: [{
        agentId: 'opencode',
        sourceId: 'opencodeServer:project',
        source: {
          kind: 'opencodeServer',
          baseUrl: 'http://127.0.0.1:49196',
          directory: '/tmp/project',
        },
      }],
      resolveProviderOps: async () => ({
        validateSource: async ({ source }: Readonly<{ source: ExternalSessionsSource }>) => ({
          ok: true as const,
          source,
        }),
        listCandidates,
        resolveLinkIdentity,
        pageTranscript,
      }),
    });

    await expect(adapter.authorService.readTranscript({
      agentId: 'opencode',
      sourceId: 'opencodeServer:project',
      remoteSessionId: 'opencode-public-ref',
    })).resolves.toMatchObject({ mode: 'page', items: [] });
    expect(resolveLinkIdentity).toHaveBeenCalledOnce();
    expect(listCandidates).not.toHaveBeenCalled();
    expect(pageTranscript).toHaveBeenCalledOnce();
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

    await expect(adapter.authorService.readTranscript(ref)).rejects.toMatchObject({
      code: 'plugin_external_transcript_invalid',
    });
  });
});
