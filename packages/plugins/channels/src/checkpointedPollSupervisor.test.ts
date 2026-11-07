import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/plugin-sdk/collections';
import { PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import {
  MAX_CONVERSATION_RECEIVE_WAIT_MS,
  ConversationPollResultV1Schema,
} from '@happier-dev/channels-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { createIngressSupervisor, type IngressSupervisorOptions } from './checkpointedPollSupervisor.js';
import { createConversationPairingManager } from './pairing.js';

import { assertChannelsTestCollectionQueryLimit } from './testkit/collectionQueryBound.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';
import { pollGithubIssueCommentsForChannels } from '../../scm-github/src/observations/githubIssueCommentPollRuntime.js';
function connectionRows(count: number): readonly Readonly<{
  rowId: string;
  revision: number;
  value: Readonly<Record<string, string>>;
}>[] {
  return Array.from({ length: count }, (_unused, index) => {
    const connectionId = `connection-${index + 1}`;
    return {
      rowId: connectionId,
      revision: 1,
      value: {
        id: connectionId,
        'record-kind': 'connection',
        'connection-id': connectionId,
      },
    };
  });
}

function backgroundContext(
  signal: AbortSignal,
  query?: () => Promise<Readonly<{
    rows: readonly Readonly<{ rowId: string; revision: number; value: Readonly<Record<string, string>> }>[];
    changeCursor: number;
  }>>,
  logger?: Pick<PluginServices['logger'], 'warn'>,
): BackgroundServiceContext {
  const collection = {
    watch: () => ({ dispose() {} }),
    async query(request: Readonly<{ limit?: number }>) {
      assertChannelsTestCollectionQueryLimit(request.limit);
      if (query !== undefined) return await query();
      return {
        rows: [{
          rowId: 'connection-1',
          revision: 1,
          value: {
            id: 'connection-1',
            'record-kind': 'connection',
            'connection-id': 'connection-1',
          },
        }],
        changeCursor: 1,
      };
    },
  };
  return {
    plugin: { id: 'happier.channels', version: '0.0.0' },
    contribution: {
      id: 'ingress-supervisor',
      qualifiedId: 'happier.channels/backgroundServices/ingress-supervisor',
    },
    signal,
    services: {
      storage: { account: { collection: () => collection } },
      logger: { info: vi.fn(), ...(logger ?? { warn: vi.fn() }) },
    } as unknown as PluginServices,
  } as BackgroundServiceContext;
}

describe('Checkpointed poll supervisor', () => {
  it.each([false, true])('paces no-hint GitHub polls by their provider budget and still delivers a new comment at the next fire (all headers missing: %s)', async allHeadersMissing => {
    vi.useFakeTimers();
    const startedAt = Date.parse('2026-08-10T12:00:00Z');
    vi.setSystemTime(startedAt);
    const generation = new AbortController();
    const pollTimes: number[] = [];
    const delivered: string[] = [];
    let budgetReads = 0;
    let checkpoint: unknown = null;
    let changed = false;
    const supervisor = createIngressSupervisor({
      runDueWork: async () => 0,
      runRetention: async () => ({}),
      runPoll: async () => {
        pollTimes.push(Date.now() - startedAt);
        const result = ConversationPollResultV1Schema.parse(await pollGithubIssueCommentsForChannels({
          client: {
            requestWithoutFollowingRedirects: async () => { throw new Error('No manual redirects'); },
            request: async ({ url }) => {
              if (new URL(url).pathname === '/rate_limit') {
                budgetReads += 1;
                return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ resources: {
                  core: { remaining: 10, reset: startedAt / 1_000 + 600 },
                } })) };
              }
              const headers: Readonly<Record<string, string>> = allHeadersMissing ? {}
                : { 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': String(startedAt / 1_000 + 600) };
              return {
                status: 200, headers,
                body: new TextEncoder().encode(JSON.stringify(new URL(url).pathname.endsWith('/issues/1')
                  ? { id: 5, number: 1 }
                  : changed ? [{ id: 2, body: 'Fresh comment', created_at: '2026-08-10T12:00:30Z', updated_at: '2026-08-10T12:00:30Z',
                    issue_url: 'https://api.github.com/repos/acme/widgets/issues/1', user: { id: 3, login: 'actor', type: 'User' } }] : [])),
              };
            },
          },
          config: { v: 1, repository: { v: 1, repositoryId: '77', owner: 'acme', name: 'widgets', nameWithOwner: 'acme/widgets' },
            integrationPrincipal: { id: '99', label: 'happier-bot' } },
          connectionId: 'connection-1', providerConnectionKey: 'github:repository:77', checkpoint, limit: 100, nowMs: Date.now(),
        }));
        if (result.kind !== 'batch' && result.kind !== 'checkpointOnly') throw new Error('Expected a successful GitHub poll');
        checkpoint = result.checkpointAfterBatch;
        if (result.kind === 'batch') for (const row of result.observations) {
          if (row.observation.kind === 'fullText') delivered.push(row.observation.observation.message.text ?? '');
        }
        return { kind: 'committed', connectionId: 'connection-1', revision: 1, authorityEpoch: 1,
          ...(result.retryHint === undefined ? {} : { retryAfterMs: result.retryHint.retryAfterMs }) };
      },
    });
    const running = supervisor.run(backgroundContext(generation.signal));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(pollTimes).toEqual([0]);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(pollTimes).toEqual([0]);
      changed = true;
      await vi.advanceTimersByTimeAsync(1);
      expect(pollTimes).toEqual([0, 60_000]);
      expect(delivered).toEqual(['Fresh comment']);
      // The changed poll read both the comment window and its issue identity:
      // two next-cycle reads spread over 540 seconds / 10 remaining requests.
      await vi.advanceTimersByTimeAsync(107_999);
      expect(pollTimes).toEqual([0, 60_000]);
      await vi.advanceTimersByTimeAsync(1);
      expect(pollTimes).toEqual([0, 60_000, 168_000]);
      expect(delivered).toEqual(['Fresh comment']);
      expect(budgetReads).toBe(allHeadersMissing ? 3 : 0);
    } finally {
      generation.abort(); await running; await supervisor.dispose(); vi.useRealTimers();
    }
  });

  it('does not rediscover connections for unrelated writes or ingress maintenance, and discovers a changed connection', async () => {
    vi.useFakeTimers();
    const generation = new AbortController();
    const watchers: Array<{ kind?: string; notify(): void }> = [];
    const rowFor = (index: number) => {
      const connectionId = `connection-${index}`;
      const value = createCurrentConversationConnectionFixture({ connectionId,
        transport: { kind: 'socket' }, replayContinuity: 'sessionBound', authority: {
          providerPluginId: 'example.channel.provider', providerContributionSelection: { contributionId: 'test-provider' },
          providerSetupInput: {}, credentialRef: null,
          transportOrigin: { serverIdentityId: 'srv_account_one', materializationRef: {
            pluginId: 'example.channel.provider', machineId: 'machine-1', materializationId: `provider-${index}`,
          } }, providerConnectionKey: `provider-${index}`, providerConfig: {}, routingIdentityKey: String(index).repeat(43),
          integrationPrincipal: { id: `principal-${index}` }, authorityEpoch: 1,
        } });
      return { rowId: connectionId, revision: 1, value };
    };
    let rows = [rowFor(1)];
    const get = vi.fn(async (rowId: string) => rows.find(row => row.rowId === rowId) ?? null);
    const query = vi.fn(async (request: Readonly<{ prefix?: readonly unknown[] }>) => ({
      rows: request.prefix?.[0] === 'connection' ? rows : [], changeCursor: 1,
    }));
    const context = backgroundContext(generation.signal);
    const supervisor = createIngressSupervisor();
    const running = supervisor.run({ ...context, services: { ...context.services,
      storage: { account: { collection: () => ({ query, get,
        watch: (request: Readonly<{ prefix?: readonly string[] }>, notify: () => void) => {
          watchers.push({ kind: request.prefix?.[0], notify }); return { dispose() {} };
        },
      }) } }, events: { plugin: { emit: async () => ({ subscriberCount: 0 }) } },
    } as unknown as PluginServices });
    const publish = (kind: string) => {
      for (const watch of watchers) if (watch.kind === undefined || watch.kind === kind) watch.notify();
    };
    const connectionReads = () => query.mock.calls.filter(([request]) => request.prefix?.[0] === 'connection').length;
    try {
      await vi.advanceTimersByTimeAsync(0);
      const initial = connectionReads();
      for (let index = 0; index < 10; index += 1) {
        publish('pairing-request');
        publish('ingress-obligation');
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(connectionReads()).toBe(initial);
      rows = [...rows, rowFor(2)];
      publish('connection');
      await vi.advanceTimersByTimeAsync(0);
      expect(connectionReads()).toBe(initial + 1);
      expect(get).toHaveBeenCalledWith('connection-2', { signal: expect.any(AbortSignal) });
    } finally {
      generation.abort(); await running; await supervisor.dispose(); vi.useRealTimers();
    }
  });

  it('pushes shared pairing creation and expiry to provider reconciliation and stays idle between them', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const generation = new AbortController();
    const pairing = createConversationPairingManager({ generationId: 'pairing-wake', now: () => Date.now(),
      randomBytes: () => Uint8Array.from([0, 0, 0, 0, 1]), createId: kind => `${kind}-wake` });
    const emit = vi.fn(async () => ({ status: 'admitted', sequence: 1, subscriberCount: 0 }));
    const context = backgroundContext(generation.signal, async () => ({ rows: [], changeCursor: 1 }));
    const supervisor = createIngressSupervisor({ pairing });
    const running = supervisor.run({ ...context, services: { ...context.services,
      events: { plugin: { emit } },
    } as unknown as PluginServices });
    try {
      await vi.advanceTimersByTimeAsync(0);
      const endpoint = { kind: 'shared', audience: 'shared', id: 'proof-channel' } as const;
      const challenge = pairing.createChallenge({ connectionId: 'connection-1',
        expectedConnectionAuthorityEpoch: 1, pairingRequestId: 'shared-wake', executionOrigin: { serverIdentityId: 'server-1', machineId: 'machine-1', pluginId: 'provider.test' },
        destinationLabel: 'Proof', endpoint, proofEndpoint: endpoint,
        target: { kind: 'session', sessionId: 'session-1', policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only',
          approvals: { kind: 'off' }, newSession: { kind: 'off' } } } });
      await vi.advanceTimersByTimeAsync(0);
      expect(emit).toHaveBeenCalledExactlyOnceWith('connections-invalidated-v1', {}, { signal: expect.any(AbortSignal) });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(emit).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(challenge.expiresAt - Date.now());
      expect(pairing.requiresFullSharedMessageContent('connection-1')).toBe(false);
      expect(emit).toHaveBeenCalledTimes(2);
    } finally {
      generation.abort();
      await running;
      await supervisor.dispose();
      pairing.dispose();
      vi.useRealTimers();
    }
  });

  it.each(['retention', 'due-work', 'connection-discovery', 'poll'] as const)(
    'settles collection_update_required from %s without reads or writes on later wakes', async boundary => {
      vi.useFakeTimers();
      const generation = new AbortController();
      const listeners: Array<() => void> = [];
      const logger = { warn: vi.fn() };
      let outdated = true;
      const refusal = new PluginError({ code: 'collection_update_required', retryable: false,
        message: 'private transport detail must not be exposed' });
      const get = vi.fn(async () => { if (outdated && boundary === 'poll') throw refusal; return null; });
      const query = vi.fn(async (request: Readonly<{ prefix?: readonly unknown[] }>) => {
        const kind = request.prefix?.[0];
        if (outdated && ((boundary === 'retention' && kind === 'ingress-census')
          || (boundary === 'due-work' && kind === 'ingress-obligation')
          || (boundary === 'connection-discovery' && kind === 'connection'))) throw refusal;
        return { rows: kind === 'connection' ? connectionRows(1) : [], changeCursor: 1 };
      });
      const write = vi.fn();
      const context = backgroundContext(generation.signal, undefined, logger);
      const services = { ...context.services, storage: { account: { collection: () => ({
        get, query, put: write, delete: write, batch: write, forget: write,
        watch: (_request: unknown, notify: () => void) => { listeners.push(notify); return { dispose() {} }; },
      }) } }, events: { plugin: { emit: async () => ({ status: 'admitted', sequence: 1, subscriberCount: 0 }) } } } as unknown as PluginServices;
      const supervisor = createIngressSupervisor();
      const running = supervisor.run({ ...context, services });
      try {
        await vi.advanceTimersByTimeAsync(0);
        const reads = get.mock.calls.length + query.mock.calls.length;
        // Neither ordinary row hints nor elapsed retry deadlines make this
        // generation's compiled Collection contract current.
        outdated = false;
        for (let pass = 0; pass < 100; pass += 1) {
          for (const notify of listeners) notify();
          await vi.advanceTimersByTimeAsync(1_000);
        }
        expect(get.mock.calls.length + query.mock.calls.length).toBe(reads);
        expect(write).not.toHaveBeenCalled();
        expect(logger.warn.mock.calls).toEqual([['[Channels] Account Collection requires an update', {
          kind: 'updateRequired', code: 'collection_update_required', collectionId: 'channel-state',
          retryable: false, recovery: 'updateHappierOnThisMachine',
        }]]);
        await running;
        await supervisor.run({ ...context, services });
        expect(get.mock.calls.length + query.mock.calls.length).toBe(reads);
        // An updated activation owns fresh Collection admission.
        const replacement = createIngressSupervisor();
        const replacementRun = replacement.run({ ...context, services });
        await vi.advanceTimersByTimeAsync(0);
        expect(get.mock.calls.length + query.mock.calls.length).toBeGreaterThan(reads);
        generation.abort();
        await replacementRun;
        await replacement.dispose();
      } finally {
        generation.abort(); await running; await supervisor.dispose(); vi.useRealTimers();
      }
    },
  );

  it.each([false, true])('backs off thrown poll failures and recovers without periodic reads (typed retryable: %s)', async typed => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const generation = new AbortController();
    const listeners: Array<() => void> = [];
    const pollTimes: number[] = [];
    let failing = true;
    // Fault the Account transport, keeping the real poll eligibility, due-work,
    // retention, classification and supervisor scheduling owners in the path.
    const get = async () => {
      pollTimes.push(Date.now());
      if (failing) throw typed
        ? new PluginError({ code: 'collection_transport_unavailable', message: 'private boundary detail', retryable: true })
        : new Error('private boundary detail');
      return null;
    };
    const context = backgroundContext(generation.signal);
    const supervisor = createIngressSupervisor();
    const running = supervisor.run({ ...context, services: { ...context.services,
      storage: { account: { collection: () => ({ get,
        query: async (request: Readonly<{ prefix?: readonly unknown[] }>) => ({
          rows: request.prefix?.[0] === 'connection' ? connectionRows(1) : [], changeCursor: 1,
        }),
        watch: (_request: unknown, notify: () => void) => { listeners.push(notify); return { dispose() {} }; },
      }) } },
      events: { plugin: { emit: async () => ({ status: 'admitted', sequence: 1, subscriberCount: 0 }) } },
    } as unknown as PluginServices });
    try {
      await vi.advanceTimersByTimeAsync(7_000);
      expect(pollTimes).toEqual([0, 1_000, 3_000, 7_000]);
      failing = false;
      await vi.advanceTimersByTimeAsync(8_000);
      expect(pollTimes).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(pollTimes).toHaveLength(5);
      // Changed connection input starts a fresh admission/recovery sequence.
      failing = true;
      listeners.at(-1)?.();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(pollTimes.slice(5)).toEqual([75_000, 76_000, 78_000]);
    } finally {
      generation.abort(); await running; await supervisor.dispose(); vi.useRealTimers();
    }
  });

  it('parks a permanent poll failure for a settled minute and recovers on a Collection change with attributable logs', async () => {
    vi.useFakeTimers();
    const generation = new AbortController();
    const listeners: Array<() => void> = [];
    let failing = true;
    const get = vi.fn(async () => {
      if (failing) throw new PluginError({ code: 'plugin_collection_invalid_value',
        message: 'private payload must never be logged', retryable: false });
      return null;
    });
    const logger = { warn: vi.fn() };
    const context = backgroundContext(generation.signal, undefined, logger);
    const collection = {
      get,
      query: async (request: Readonly<{ prefix?: readonly unknown[] }>) => ({
        rows: request.prefix?.[0] === 'connection' ? connectionRows(1) : [], changeCursor: 1,
      }),
      watch: (_request: unknown, notify: () => void) => {
        listeners.push(notify);
        return { dispose() {} };
      },
    };
    const supervisor = createIngressSupervisor();
    const run = supervisor.run({ ...context, services: { ...context.services,
      storage: { account: { collection: () => collection } },
      events: { plugin: { emit: async () => ({ status: 'admitted', sequence: 1, subscriberCount: 0 }) } },
    } as unknown as PluginServices });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(get).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith('[Channels] ingress supervisor work failed', {
        boundary: 'poll', code: 'plugin_collection_invalid_value', retryable: false,
        connectionId: 'connection-1', collectionId: 'channel-state',
      });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private payload');
      // A typed checkpoint repair releases the parked poll without rediscovering connections.
      failing = false;
      listeners[0]?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(get.mock.calls.length).toBeGreaterThan(1);
    } finally {
      generation.abort(); await run; await supervisor.dispose(); vi.useRealTimers();
    }
  });

  it.each([0, 1])('performs no idle periodic reads with %i enabled socket connections and wakes on collection invalidation', async (count) => {
    vi.useFakeTimers();
    const generation = new AbortController();
    const listeners: Array<() => void> = [];
    const value = createCurrentConversationConnectionFixture({
      connectionId: 'connection-1',
      transport: { kind: 'socket' },
      replayContinuity: 'sessionBound',
      authority: {
        providerPluginId: 'example.channel.provider',
        providerContributionSelection: { contributionId: 'test-provider' },
        providerSetupInput: {},
        credentialRef: null,
        transportOrigin: {
          serverIdentityId: 'srv_account_one',
          materializationRef: {
            pluginId: 'example.channel.provider', machineId: 'machine-1', materializationId: 'provider-1',
          },
        },
        providerConnectionKey: 'provider-connection-1',
        providerConfig: {},
        routingIdentityKey: 'a'.repeat(43),
        integrationPrincipal: { id: 'principal-1' },
        authorityEpoch: 1,
      },
    });
    const row = { rowId: value.id, revision: 1, value };
    const query = vi.fn(async (request: Readonly<{ prefix?: readonly unknown[] }>) => ({
      rows: request.prefix?.[0] === 'connection' && count === 1 ? [row] : [], changeCursor: 1,
    }));
    const dispose = vi.fn();
    const emit = vi.fn(async () => ({ status: 'admitted', sequence: 1, subscriberCount: 0 }));
    const context = backgroundContext(generation.signal);
    const collection = {
      query,
      get: vi.fn(async (id: string) => count === 1 && id === row.rowId ? row : null),
      watch: (_request: unknown, listener: () => void) => {
        listeners.push(listener);
        return { dispose };
      },
    };
    const supervisor = createIngressSupervisor();
    const run = supervisor.run({
      ...context,
      services: {
        ...context.services,
        storage: { account: { collection: () => collection } },
        events: { plugin: { emit } },
      } as unknown as PluginServices,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      const initialReads = query.mock.calls.length;
      const initialGets = collection.get.mock.calls.length;
      expect(initialReads).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(60_000);
      console.info('FIX-WAKE ingress measurement', {
        enabledSocketConnections: count,
        startupQueries: initialReads,
        startupGets: initialGets,
        queriesPerMinute: query.mock.calls.length - initialReads,
        getsPerMinute: collection.get.mock.calls.length - initialGets,
      });
      expect(query).toHaveBeenCalledTimes(initialReads);
      expect(collection.get).toHaveBeenCalledTimes(initialGets);
      expect(listeners.length).toBeGreaterThan(0);
      for (const notify of listeners) notify();
      await vi.advanceTimersByTimeAsync(0);
      expect(query.mock.calls.length).toBeGreaterThan(initialReads);
      expect(emit).toHaveBeenCalledWith('connections-invalidated-v1', {}, { signal: expect.any(AbortSignal) });
    } finally {
      generation.abort();
      await run;
      await supervisor.dispose();
      vi.useRealTimers();
    }
    expect(dispose).toHaveBeenCalled();
  });

  it('preserves connection invalidation while an ineligible poll read is still outstanding', async () => {
    vi.useFakeTimers();
    const generation = new AbortController();
    const listeners: Array<() => void> = [];
    const value = createCurrentConversationConnectionFixture({
      connectionId: 'connection-1', transport: { kind: 'socket' }, replayContinuity: 'sessionBound',
      authority: {
        providerPluginId: 'example.channel.provider',
        providerContributionSelection: { contributionId: 'test-provider' },
        providerSetupInput: {}, credentialRef: null,
        transportOrigin: { serverIdentityId: 'srv_account_one', materializationRef: {
          pluginId: 'example.channel.provider', machineId: 'machine-1', materializationId: 'provider-1',
        } },
        providerConnectionKey: 'provider-connection-1', providerConfig: {},
        routingIdentityKey: 'a'.repeat(43), integrationPrincipal: { id: 'principal-1' }, authorityEpoch: 1,
      },
    });
    const row = { rowId: value.id, revision: 1, value };
    let release: (() => void) | undefined;
    const heldRead = new Promise<void>(resolve => { release = resolve; });
    let readReleased = false;
    let releaseDeadlineQuery: (() => void) | undefined;
    const heldDeadlineQuery = new Promise<void>(resolve => { releaseDeadlineQuery = resolve; });
    let deadlineQueries = 0;
    const get = vi.fn(async () => {
      if (get.mock.calls.length === 1) await heldRead;
      return row;
    });
    const collection = {
      get,
      async query(request: Readonly<{ index?: string; prefix?: readonly unknown[]; range?: Readonly<{ upper?: unknown }> }>) {
        if (request.index === 'by-ingress-due' && request.range?.upper === undefined) {
          deadlineQueries += 1;
          if (deadlineQueries === 2) await heldDeadlineQuery;
          if (deadlineQueries > 2 && !readReleased) {
            // End the incorrect busy loop only after observing its forbidden
            // work, so the cost assertion below can deliver a finite RED.
            generation.abort(new Error('Deadline work repeated while the predecessor poll was still held.'));
          }
        }
        return { rows: request.prefix?.[0] === 'connection' ? [row] : [], changeCursor: 1 };
      },
      watch: (_request: unknown, notify: () => void) => { listeners.push(notify); return { dispose() {} }; },
    };
    const context = backgroundContext(generation.signal);
    const supervisor = createIngressSupervisor();
    const running = supervisor.run({ ...context, services: {
      ...context.services, storage: { account: { collection: () => collection } },
      events: { plugin: { emit: async () => ({ status: 'admitted', sequence: 1, subscriberCount: 0 }) } },
    } as unknown as PluginServices });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledTimes(1);
      for (const notify of listeners) notify();
      await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledTimes(1);
      releaseDeadlineQuery?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(deadlineQueries).toBe(2);
      expect(get).toHaveBeenCalledTimes(1);
      readReleased = true;
      release?.();
      await vi.advanceTimersByTimeAsync(0);
      // The invalidation must be consumed after the older in-flight read has
      // settled, not overwritten by that read's ineligible outcome.
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      readReleased = true;
      releaseDeadlineQuery?.(); release?.(); generation.abort(); await running; await supervisor.dispose(); vi.useRealTimers();
    }
  });

  it('recovers an unavailable earliest-due query at the existing recovery deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const generation = new AbortController();
    const deadlineReads: number[] = [];
    const collection = {
      watch: () => ({ dispose() {} }),
      async query(request: Readonly<{ index: string; range?: Readonly<{ upper?: number }> }>) {
        if (request.index === 'by-ingress-due' && request.range?.upper === undefined) {
          deadlineReads.push(Date.now());
          if (deadlineReads.length === 1) throw new Error('Unavailable storage boundary.');
        }
        return { rows: [], changeCursor: 1 };
      },
    };
    const supervisor = createIngressSupervisor();
    const context = backgroundContext(generation.signal);
    const running = supervisor.run({
      ...context,
      services: { ...context.services, storage: { account: { collection: () => collection } } } as unknown as PluginServices,
    });
    const outcome = running.then(() => undefined, error => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(deadlineReads).toEqual([0]);
      await vi.advanceTimersByTimeAsync(999);
      expect(deadlineReads).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(deadlineReads).toEqual([0, 1_000]);
      generation.abort();
      expect(await outcome).toBeUndefined();
    } finally {
      generation.abort(); await outcome; await supervisor.dispose(); vi.useRealTimers();
    }
  });

  it('fires the poll retry at its deadline without an intervening periodic tick', async () => {
    let now = 1_000_000;
    const generation = new AbortController();
    const callTimes: number[] = [];
    const calls: string[] = [];
    const runDueWork = vi.fn(async (input: Readonly<{ now: number; limit: number }>) => {
      calls.push('due');
      expect(input).toEqual({ now, limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 });
      return 0;
    });
    const runPoll = vi.fn(async (input: Readonly<{ connectionId: string; waitMs: number }>) => {
      calls.push('poll');
      callTimes.push(now);
      expect(input).toEqual({ connectionId: 'connection-1', waitMs: MAX_CONVERSATION_RECEIVE_WAIT_MS });
      if (callTimes.length === 1) return { kind: 'retry' as const, retryAfterMs: 2_000 };
      generation.abort(new Error('test complete'));
      return { kind: 'ineligible' as const };
    });
    const supervisor = createIngressSupervisor({
      runDueWork,
      runRetention: async () => ({}),
      reconciliationIntervalMs: 1_000,
      runPoll,
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await supervisor.run(backgroundContext(generation.signal));

    expect(callTimes).toEqual([1_000_000, 1_002_000]);
    expect(calls.filter(call => call === 'poll')).toEqual(['poll', 'poll']);
    await supervisor.dispose();
  });

  it('runs ingress retention through the existing supervisor with a generation-local keyset cursor', async () => {
    let now = 2_000_000;
    const generation = new AbortController();
    const retentionInputs: Array<Readonly<{ now: number; limit: number; cursor?: string }>> = [];
    const runRetention = vi.fn(async (input: Readonly<{ now: number; limit: number; cursor?: string }>) => {
      retentionInputs.push(input);
      if (retentionInputs.length === 2) generation.abort(new Error('retention cursor observed'));
      return retentionInputs.length === 1 ? { nextCursor: 'retention:next' } : {};
    });
    const supervisor = createIngressSupervisor({
      runDueWork: async () => 0,
      runRetention,
      runPoll: async () => ({ kind: 'ineligible' }),
      reconciliationIntervalMs: 1_000,
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await supervisor.run(backgroundContext(generation.signal));

    expect(retentionInputs).toEqual([
      { now: 2_000_000, limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 },
      { now: 2_000_000, limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1, cursor: 'retention:next' },
    ]);
    await supervisor.dispose();
  });

  it('does not rescan handed-off metadata on an age timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    const generation = new AbortController();
    const retentionAt: number[] = [];
    const supervisor = createIngressSupervisor({
      runDueWork: async () => 0,
      runRetention: async (input) => {
        retentionAt.push(input.now);
        return {};
      },
      runPoll: async () => {
        return { kind: 'ineligible' as const };
      },
      reconciliationIntervalMs: 1_000,
    });
    const running = supervisor.run(backgroundContext(generation.signal));
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(retentionAt).toEqual([3_000_000]);
    } finally {
      generation.abort();
      await running;
      await supervisor.dispose();
      vi.useRealTimers();
    }
  });

  it('retries a failed retention page at the existing recovery deadline', async () => {
    let now = 4_000_000;
    const generation = new AbortController();
    const logger = { warn: vi.fn() };
    let retentionCalls = 0;
    const supervisor = createIngressSupervisor({
      runDueWork: async () => 0,
      runRetention: async () => {
        retentionCalls += 1;
        if (retentionCalls === 2) generation.abort(new Error('test complete'));
        throw new Error('secret retention detail');
      },
      runPoll: async () => {
        return { kind: 'ineligible' as const };
      },
      reconciliationIntervalMs: 1_000,
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await supervisor.run(backgroundContext(generation.signal, undefined, logger));

    expect(retentionCalls).toBe(2);
    expect(now).toBe(4_001_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      '[Channels] ingress supervisor work failed',
      { boundary: 'retention' },
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    await supervisor.dispose();
  });

  it('retires one generation before admitting a replacement and refuses duplicate or disposed runs', async () => {
    const first = new AbortController();
    const replacement = new AbortController();
    let calls = 0;
    const runPoll = vi.fn(async (_input: unknown, context: BackgroundServiceContext) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(context.signal.reason);
          context.signal.addEventListener('abort', abort, { once: true });
        });
      }
      replacement.abort(new Error('replacement complete'));
      return { kind: 'ineligible' as const };
    });
    const supervisor = createIngressSupervisor({
      runPoll,
      runDueWork: async () => 0,
      runRetention: async () => ({}),
    });
    const firstContext = backgroundContext(first.signal);
    const firstRun = supervisor.run(firstContext);
    await vi.waitFor(() => expect(runPoll).toHaveBeenCalledTimes(1));

    await expect(supervisor.run(firstContext)).rejects.toThrow('already running');
    first.abort(new Error('first generation retired'));
    await firstRun;
    await supervisor.run(backgroundContext(replacement.signal));
    expect(runPoll).toHaveBeenCalledTimes(2);

    await supervisor.dispose();
    await expect(supervisor.run(backgroundContext(new AbortController().signal)))
      .rejects.toThrow('disposed');
  });

  it('redrives a transient Account discovery failure on the next bounded wake', async () => {
    let now = 2_000_000;
    let queryCalls = 0;
    const generation = new AbortController();
    const context = backgroundContext(generation.signal, async () => {
      queryCalls += 1;
      if (queryCalls === 1) throw new Error('temporary Account storage failure');
      return {
        rows: [{
          rowId: 'connection-1',
          revision: 1,
          value: {
            id: 'connection-1',
            'record-kind': 'connection',
            'connection-id': 'connection-1',
          },
        }],
        changeCursor: 1,
      };
    });
    const runPoll = vi.fn(async () => {
      generation.abort(new Error('test complete'));
      return { kind: 'ineligible' as const };
    });
    const supervisor = createIngressSupervisor({
      runDueWork: async () => 0,
      runRetention: async () => ({}),
      reconciliationIntervalMs: 1_000,
      runPoll,
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await expect(supervisor.run(context)).resolves.toBeUndefined();

    expect(queryCalls).toBe(2);
    expect(runPoll).toHaveBeenCalledTimes(1);
    expect(now).toBe(2_001_000);
    await supervisor.dispose();
  });

  it('logs redacted non-abort worker failures and keeps abort silent', async () => {
    let now = 3_000_000;
    let queryCalls = 0;
    let dueWorkCalls = 0;
    let pollCalls = 0;
    const generation = new AbortController();
    const logger = { warn: vi.fn() };
    const context = backgroundContext(generation.signal, async () => {
      queryCalls += 1;
      if (queryCalls === 1) throw new Error('secret Account discovery detail');
      return {
        rows: [{
          rowId: 'connection-1',
          revision: 1,
          value: {
            id: 'connection-1',
            'record-kind': 'connection',
            'connection-id': 'connection-1',
          },
        }],
        changeCursor: 1,
      };
    }, logger);
    const supervisor = createIngressSupervisor({
      runDueWork: async () => {
        dueWorkCalls += 1;
        if (dueWorkCalls === 1) throw new Error('secret due-work detail');
        return 0;
      },
      runRetention: async () => ({}),
      reconciliationIntervalMs: 1_000,
      runPoll: async () => {
        pollCalls += 1;
        if (pollCalls === 1) throw new Error('secret provider poll detail');
        generation.abort(new Error('test complete'));
        throw new Error('secret abort detail');
      },
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await supervisor.run(context);

    expect(now).toBe(3_002_000);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      '[Channels] ingress supervisor work failed',
      { boundary: 'due-work' },
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      '[Channels] ingress supervisor work failed',
      { boundary: 'connection-discovery' },
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      3,
      '[Channels] ingress supervisor work failed',
      { boundary: 'poll', connectionId: 'connection-1', collectionId: 'channel-state' },
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    await supervisor.dispose();
  });

  it('treats an Account that has not released the Channels collection as inactive without warning', async () => {
    let now = 4_000_000;
    let queryCalls = 0;
    let dueWorkCalls = 0;
    const generation = new AbortController();
    const logger = { warn: vi.fn() };
    const refusal = (): PluginError => new PluginError({
      code: 'collection_unavailable',
      message: 'secret Account Collection rejection detail',
      retryable: false,
    });
    const context = backgroundContext(generation.signal, async () => {
      queryCalls += 1;
      if (queryCalls === 1) throw refusal();
      return {
        rows: [{
          rowId: 'connection-1',
          revision: 1,
          value: {
            id: 'connection-1',
            'record-kind': 'connection',
            'connection-id': 'connection-1',
          },
        }],
        changeCursor: 1,
      };
    }, logger);
    const supervisor = createIngressSupervisor({
      runDueWork: async () => {
        dueWorkCalls += 1;
        if (dueWorkCalls === 1) throw refusal();
        return 0;
      },
      runRetention: async () => ({}),
      reconciliationIntervalMs: 1_000,
      runPoll: async () => {
        generation.abort(new Error('test complete'));
        return { kind: 'ineligible' as const };
      },
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await supervisor.run(context);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(dueWorkCalls).toBe(2);
    expect(queryCalls).toBe(2);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    await supervisor.dispose();
  });

  it('starts every current connection poll on the same wake instead of serializing behind a slow provider', async () => {
    const generation = new AbortController();
    const started: string[] = [];
    let releaseSlowPoll: (() => void) | undefined;
    const slowPoll = new Promise<void>((resolve) => { releaseSlowPoll = resolve; });
    const runPoll = vi.fn(async (input: Readonly<{ connectionId: string; waitMs: number }>) => {
      started.push(input.connectionId);
      if (input.connectionId === 'connection-1') await slowPoll;
      return { kind: 'ineligible' as const };
    });
    const supervisor = createIngressSupervisor({
      runDueWork: async () => 0,
      runRetention: async () => ({}),
      runPoll,
      reconciliationIntervalMs: 1_000,
    });

    const run = supervisor.run(backgroundContext(
      generation.signal,
      async () => ({ rows: connectionRows(3), changeCursor: 1 }),
    ));
    // One long-polling provider must not hold other connections behind it.
    await vi.waitFor(() => expect(started).toEqual([
      'connection-1',
      'connection-2',
      'connection-3',
    ]));

    releaseSlowPoll?.();
    generation.abort(new Error('test complete'));
    await run;
    await supervisor.dispose();
  });

  it('keeps one in-flight poll per connection while due work keeps progressing', async () => {
    const generation = new AbortController();
    const polls: string[] = [];
    let dueWorkCalls = 0;
    let releaseSlowPoll: (() => void) | undefined;
    const slowPoll = new Promise<void>((resolve) => { releaseSlowPoll = resolve; });
    const supervisor = createIngressSupervisor({
      runDueWork: async () => { dueWorkCalls += 1; return 0; },
      runRetention: async () => ({}),
      runPoll: async (input) => {
        polls.push(input.connectionId);
        if (input.connectionId === 'connection-1') await slowPoll;
        return { kind: 'retry' as const, retryAfterMs: 20 };
      },
      reconciliationIntervalMs: 20,
    });

    const run = supervisor.run(backgroundContext(
      generation.signal,
      async () => ({ rows: connectionRows(2), changeCursor: 1 }),
    ));
    await vi.waitFor(() => {
      expect(polls.filter((id) => id === 'connection-2').length).toBeGreaterThanOrEqual(3);
      expect(dueWorkCalls).toBeGreaterThanOrEqual(3);
    });
    // Per-connection order is preserved by admitting at most one outstanding
    // poll for each connection key, not by serializing the whole sweep.
    expect(polls.filter((id) => id === 'connection-1')).toEqual(['connection-1']);

    releaseSlowPoll?.();
    generation.abort(new Error('test complete'));
    await run;
    await supervisor.dispose();
  });

  it('decouples the provider long-poll wait from the one-second reconciliation cadence', async () => {
    const generation = new AbortController();
    let observedWaitMs: number | undefined;
    const supervisor = createIngressSupervisor({
      runDueWork: async () => 0,
      runRetention: async () => ({}),
      runPoll: async (input, context) => {
        observedWaitMs = input.waitMs;
        generation.abort(new Error('wait observed'));
        expect(context.signal.aborted).toBe(true);
        return { kind: 'ineligible' as const };
      },
      reconciliationIntervalMs: 1_000,
    });

    await supervisor.run(backgroundContext(generation.signal));

    expect(observedWaitMs).toBe(MAX_CONVERSATION_RECEIVE_WAIT_MS);
    await supervisor.dispose();
  });

  it('starts connection polls without waiting for a coarse retention page', async () => {
    const generation = new AbortController();
    const polls: string[] = [];
    let retentionCalls = 0;
    let releaseRetention: (() => void) | undefined;
    const slowRetention = new Promise<void>((resolve) => { releaseRetention = resolve; });
    const supervisor = createIngressSupervisor({
      runDueWork: async () => 0,
      runRetention: async () => {
        retentionCalls += 1;
        await slowRetention;
        return {};
      },
      runPoll: async (input) => {
        polls.push(input.connectionId);
        return { kind: 'retry' as const, retryAfterMs: 20 };
      },
      reconciliationIntervalMs: 20,
    });

    const run = supervisor.run(backgroundContext(generation.signal));
    // One retention page can walk a whole census unit per row, so awaiting it
    // inline stopped every connection from being polled for the whole sweep.
    await vi.waitFor(() => expect(polls.length).toBeGreaterThanOrEqual(3));
    // Still exactly one sweep in flight: the wake that finds one outstanding
    // does not start a second pass over the same cursor.
    expect(retentionCalls).toBe(1);

    releaseRetention?.();
    generation.abort(new Error('test complete'));
    await run;
    await supervisor.dispose();
  });

  it('keeps polling a connection whose poll fails before its first suspension point', async () => {
    let now = 5_000_000;
    const generation = new AbortController();
    let pollCalls = 0;
    let wakes = 0;
    const supervisor = createIngressSupervisor({
      runDueWork: async () => {
        wakes += 1;
        if (wakes > 5) generation.abort(new Error('test complete'));
        return 0;
      },
      runRetention: async () => ({}),
      // A provider adapter that throws before returning its promise settles
      // the poll inside the same synchronous turn that started it.
      runPoll: (() => {
        pollCalls += 1;
        if (pollCalls === 1) throw new Error('synchronous provider failure');
        generation.abort(new Error('test complete'));
        return Promise.resolve({ kind: 'ineligible' as const });
      }) as IngressSupervisorOptions['runPoll'],
      reconciliationIntervalMs: 1_000,
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await supervisor.run(backgroundContext(generation.signal));

    expect(pollCalls).toBeGreaterThanOrEqual(2);
    await supervisor.dispose();
  });

  it('keeps sweeping retention after a page that fails before its first suspension point', async () => {
    let now = 6_000_000;
    const generation = new AbortController();
    let retentionCalls = 0;
    let wakes = 0;
    const supervisor = createIngressSupervisor({
      runDueWork: async () => {
        wakes += 1;
        if (wakes > 5) generation.abort(new Error('test complete'));
        return 0;
      },
      runRetention: (() => {
        retentionCalls += 1;
        if (retentionCalls === 1) throw new Error('synchronous retention failure');
        generation.abort(new Error('retention recovered'));
        return Promise.resolve({});
      }) as IngressSupervisorOptions['runRetention'],
      runPoll: async () => ({ kind: 'ineligible' as const }),
      reconciliationIntervalMs: 1_000,
      clock: {
        now: () => now,
        async sleep(delayMs) { now += delayMs; },
      },
    });

    await supervisor.run(backgroundContext(generation.signal));

    expect(retentionCalls).toBeGreaterThanOrEqual(2);
    await supervisor.dispose();
  });

  it('retires a generation only after the polls it started have settled', async () => {
    const generation = new AbortController();
    let settled = false;
    let releaseSlowPoll: (() => void) | undefined;
    const slowPoll = new Promise<void>((resolve) => { releaseSlowPoll = resolve; });
    let pollStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { pollStarted = resolve; });
    const supervisor = createIngressSupervisor({
      runDueWork: async () => 0,
      runRetention: async () => ({}),
      runPoll: async () => {
        pollStarted?.();
        await slowPoll;
        settled = true;
        return { kind: 'ineligible' as const };
      },
      reconciliationIntervalMs: 1_000,
    });

    const run = supervisor.run(backgroundContext(generation.signal));
    await started;
    generation.abort(new Error('test complete'));
    let resolvedEarly = false;
    void run.then(() => { resolvedEarly = !settled; });
    await new Promise<void>((resolve) => { globalThis.setTimeout(resolve, 20); });
    // Provider I/O this generation started is still its own: retiring while a
    // poll is outstanding would let a replacement generation poll the same
    // connection concurrently.
    expect(resolvedEarly).toBe(false);

    releaseSlowPoll?.();
    await run;
    expect(settled).toBe(true);
    await supervisor.dispose();
  });
});
