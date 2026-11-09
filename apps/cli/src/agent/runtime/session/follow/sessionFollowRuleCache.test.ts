import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import type tweetnacl from 'tweetnacl';
import { createRequire } from 'node:module';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { sealSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import { createSessionFollowRuleCache, type SessionFollowRuleInvalidation } from './sessionFollowRuleCache';
import { createAccountSessionFollowRuleCache } from './accountSessionFollowRuleCache';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import type { SessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { readObservedAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';

let channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>;
beforeEach(async () => { channel = await createRequesterCurrentnessSocketHarness(); });
afterEach(async () => { await channel.close(); vi.restoreAllMocks(); });

const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: ['home'] }),
  policy: { preset: 'important' as const } };
const receiver = { kind: 'account' as const };
const row = { ruleId: 'rule', receiver, version: 1,
  sources: [{ sourceSessionId: 'current-source', delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1 }], content: sealSessionFollowRuleContentV1({
  ruleId: 'rule', receiver, definition, mode: 'plain', material: null }) };

describe('Account Follow rule cache', () => {
  it('publishes observations only after final Account currentness and rule revision admission', async () => {
    let invalidate = () => {};
    const observed = vi.fn();
    const cache = createSessionFollowRuleCache({ signal: new AbortController().signal, isCurrent: () => true,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; },
      onObserved: observed, read: async () => ({ mode: 'plain', material: null, rules: [row] }) });
    try {
      expect(await cache.read(undefined, () => false)).toMatchObject({ status: 'unavailable' });
      expect(observed).not.toHaveBeenCalled();
      expect(await cache.read(undefined, () => { invalidate(); return true; })).toMatchObject({ status: 'unavailable' });
      expect(observed).not.toHaveBeenCalled();
      expect(await cache.read()).toMatchObject({ status: 'available' });
      expect(observed).toHaveBeenCalledTimes(1);
    } finally { cache.dispose(); }
  });
  it('reconciles unchanged receiver discovery only after admitted config and resets it on lost continuity', async () => {
    const sessionRule = (sessionId: string): SessionFollowRuleV1 => ({ ...row, ruleId: `rule-${sessionId}`,
      receiver: { kind: 'session', sessionId }, inception: { createdAt: 100, accountChangeCursor: 5 } });
    let rules = [sessionRule('receiver'), sessionRule('other-receiver')];
    let current = true;
    let invalidate: (change?: SessionFollowRuleInvalidation) => void = () => {};
    let scopedReads = 0;
    let fullReads = 0;
    let discoverySeq = 0;
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200,
        data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (path === '/v2/account/session-follow-preferences') return { status: 200,
        data: { assigned: false, direct: false, team: false, group: false } };
      if (path === '/v2/account/session-follow-rules') {
        if (options?.params) scopedReads++; else fullReads++;
        return { status: 200, data: { rules, ...(options?.params ? { sourceRanges: { status: 'available', sources: [{
          sourceSessionId: 'current-source', delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: discoverySeq }, throughSeq: 8,
        }] } } : {}) } };
      }
      throw new Error(`Unexpected Follow request ${path}`);
    });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://receiver-reconcile.test', signal: new AbortController().signal, isCurrent: () => current,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; } });
    const readReceiver = (destinationSessionId = 'receiver') => cache.readReceiverSourceRanges({ destinationSessionId });
    try {
      expect(await cache.read()).toMatchObject({ status: 'available' });
      expect(await readReceiver()).toMatchObject({ status: 'available' });
      expect(await readReceiver('other-receiver')).toMatchObject({ status: 'available' });
      expect(scopedReads).toBe(2);
      rules = rules.map(rule => ({ ...rule, version: 2, content: { t: 'plain', v: { ...definition, enabled: false } } }));
      invalidate({ full: true });
      // A failed currentness check cannot turn a merely loaded definition into
      // permission to reuse retained discovery.
      current = false;
      expect(await cache.read()).toMatchObject({ status: 'unavailable' });
      expect(await readReceiver()).toMatchObject({ status: 'unavailable' });
      current = true;
      expect(await readReceiver()).toMatchObject({ status: 'unavailable' });
      expect(await cache.read()).toMatchObject({ status: 'available', rules: [{ version: 2, definition: { enabled: false } }, {}] });
      expect(await readReceiver()).toMatchObject({ status: 'available', value: { rules: [{ version: 2 }] } });
      expect(await readReceiver('other-receiver')).toMatchObject({ status: 'available' });
      expect(scopedReads).toBe(2);
      // Only real range-producing changes withdraw this receiver. Content and
      // authoring versions above deliberately did not.
      for (const change of ['inception', 'membership', 'progress'] as const) {
        discoverySeq++;
        if (change === 'inception') rules = rules.map(rule => rule.receiver.kind === 'session' && rule.receiver.sessionId === 'receiver'
          ? { ...rule, inception: { createdAt: 200, accountChangeCursor: 6 } } : rule);
        if (change === 'membership') rules = [...rules, { ...sessionRule('receiver'), ruleId: 'added-session-rule' }];
        if (change === 'progress') rules = rules.map(rule => rule.ruleId === 'added-session-rule' ? { ...rule,
          sources: [{ sourceSessionId: 'current-source', delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 6 } }] } : rule);
        invalidate({ full: true });
        expect(await cache.read()).toMatchObject({ status: 'available' });
        const before = scopedReads;
        expect(await readReceiver('other-receiver')).toMatchObject({ status: 'available' });
        expect(scopedReads).toBe(before);
        expect(await readReceiver()).toMatchObject({ status: 'available', value: { sourceRanges: {
          sources: [{ delivered: { transcriptSeq: discoverySeq } }],
        } } });
        expect(scopedReads).toBe(before + 1);
      }
      invalidate({ full: true, continuityReset: true });
      expect(await readReceiver()).toMatchObject({ status: 'unavailable' });
      expect(await cache.read()).toMatchObject({ status: 'available' });
      const beforeReconnect = scopedReads;
      expect(await readReceiver()).toMatchObject({ status: 'available' });
      expect(await readReceiver('other-receiver')).toMatchObject({ status: 'available' });
      expect(scopedReads).toBe(beforeReconnect + 2);
      expect(fullReads).toBe(6);
    } finally { cache.dispose(); http.mockRestore(); }
  });
  it('reuses admitted encrypted definitions across explicit reloads of unchanged rule revisions', async () => {
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(4) };
    const sessionReceiver = { kind: 'session' as const, sessionId: 'receiver' };
    let rules: SessionFollowRuleV1[] = Array.from({ length: 20 }, (_, index) => {
      const ruleId = `rule-${index}`;
      return { ...row, ruleId, receiver: sessionReceiver, content: sealSessionFollowRuleContentV1({
        ruleId, receiver: sessionReceiver, definition, mode: 'e2ee', material }) };
    });
    let invalidate: (change?: Readonly<{ full: boolean }>) => void = () => {};
    let available = true;
    const lifetime = new AbortController();
    // The source harness loads the workspace Protocol, while the CLI may also
    // have a bundled copy. Observe the source owner's actual native dependency.
    const protocolRequire = createRequire(new URL('../../../../../../../packages/protocol/package.json', import.meta.url));
    const nacl: typeof tweetnacl = protocolRequire('tweetnacl');
    const decrypt = vi.spyOn(nacl.secretbox, 'open');
    const cache = createSessionFollowRuleCache({ signal: lifetime.signal, isCurrent: () => true,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; },
      read: async () => available ? { mode: 'e2ee', material, rules } : null });
    try {
      const initial = await cache.read();
      expect(initial.status).toBe('available');
      expect(decrypt).toHaveBeenCalledTimes(20);
      decrypt.mockClear();
      for (let progress = 1; progress <= 10; progress++) {
        rules = rules.map(rule => ({ ...rule, sources: [{ sourceSessionId: 'current-source',
          delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: progress } }] }));
        invalidate({ full: false });
        expect(await cache.read({ refresh: true })).toMatchObject({
          status: 'available', rules: rules.map(rule => ({ ruleId: rule.ruleId, sources: rule.sources })) });
      }
      expect(decrypt).toHaveBeenCalledTimes(0);
      const editedDefinition = { ...definition, enabled: false };
      rules = rules.map((rule, index) => index !== 0 ? rule : { ...rule, version: rule.version + 1,
        content: sealSessionFollowRuleContentV1({ ruleId: rule.ruleId, receiver: sessionReceiver,
          definition: editedDefinition, mode: 'e2ee', material }) });
      expect(await cache.read({ refresh: true })).toMatchObject({
        status: 'available', rules: [{ definition: editedDefinition }, ...rules.slice(1).map(() => ({ definition }))] });
      expect(decrypt).toHaveBeenCalledTimes(1);
      invalidate({ full: true });
      await cache.read();
      expect(decrypt).toHaveBeenCalledTimes(1);
      invalidate();
      await cache.read();
      expect(decrypt).toHaveBeenCalledTimes(1);
      available = false;
      expect(await cache.read({ refresh: true })).toMatchObject({ status: 'unavailable' });
      available = true;
      expect(await cache.read()).toMatchObject({ status: 'available' });
      expect(decrypt).toHaveBeenCalledTimes(1);
      lifetime.abort();
      expect(await cache.read({ refresh: true })).toMatchObject({
        status: 'unavailable', reason: 'account-retired' });
      expect(decrypt).toHaveBeenCalledTimes(1);
    } finally { cache.dispose(); decrypt.mockRestore(); }
  });
  it('reads fresh receiver progress separately and reloads absent rule configuration only after invalidation', async () => {
    const receiverSessionId = 'receiver';
    const sessionRule = { ...row, receiver: { kind: 'session' as const, sessionId: receiverSessionId },
      content: sealSessionFollowRuleContentV1({ ruleId: row.ruleId,
        receiver: { kind: 'session', sessionId: receiverSessionId }, definition, mode: 'plain', material: null }) };
    let rules: SessionFollowRuleV1[] = [row];
    let available = true;
    let invalidate: (change?: SessionFollowRuleInvalidation) => void = () => {};
    const reads: string[] = [];
    const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path === '/v1/account/encryption/currentness') return { status: 200,
        data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (path === '/v2/account/session-follow-preferences') return { status: 200,
        data: { assigned: false, direct: false, team: false, group: false } };
      if (path === '/v2/account/session-follow-rules') return available ? { status: 200, data: { rules } }
        : { status: 503, data: {} };
      throw new Error(`Unexpected Follow request ${path}`);
    });
    const lifetime = new AbortController();
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://receiver-progress.test', signal: lifetime.signal, isCurrent: async () => true,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; } });
    try {
      expect(await cache.read()).toMatchObject({ status: 'available' });
      reads.length = 0;
      expect(await cache.read()).toMatchObject({ status: 'available' });
      expect(reads).toEqual([]);
      rules = [sessionRule];
      invalidate({ full: true });
      expect(await cache.read()).toMatchObject({ status: 'available',
        rules: [{ receiver: sessionRule.receiver }] });
      expect(reads.filter(path => path.endsWith('/session-follow-rules'))).toHaveLength(1);
      const configurationReads = reads.filter(path => path.endsWith('/session-follow-preferences')).length;
      rules = [{ ...sessionRule, sources: [{ sourceSessionId: 'current-source',
        delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 4 } }] }];
      expect(await cache.readReceiverSourceRanges({ destinationSessionId: receiverSessionId })).toMatchObject({ status: 'available',
        value: { rules: [{ sources: rules[0]!.sources }] } });
      expect(reads.filter(path => path.endsWith('/session-follow-rules'))).toHaveLength(2);
      expect(reads.filter(path => path.endsWith('/session-follow-preferences')),
        'fresh receiver progress must not reload Account configuration').toHaveLength(configurationReads);
      reads.length = 0;
      rules = [{ ...sessionRule, sources: [{ sourceSessionId: 'current-source',
        delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 6 } }] }];
      invalidate({ full: false, receiverSessionIds: ['another-receiver'] });
      expect(await cache.readReceiverSourceRanges({ destinationSessionId: receiverSessionId })).toMatchObject({ status: 'available',
        value: { rules: [{ sources: [{ delivered: { transcriptSeq: 4 } }] }] } });
      expect(reads).toEqual([]);
      invalidate({ full: false, receiverSessionIds: [receiverSessionId] });
      const progress = await Promise.all([cache.readReceiverSourceRanges({ destinationSessionId: receiverSessionId }),
        cache.readReceiverSourceRanges({ destinationSessionId: receiverSessionId })]);
      for (const value of progress) expect(value).toMatchObject({ status: 'available',
        value: { rules: [{ sources: [{ delivered: { transcriptSeq: 6 } }] }] } });
      expect(reads).toEqual(['/v2/account/session-follow-rules']);
      expect(await cache.read()).toMatchObject({ status: 'available' });
      expect(reads).toEqual(['/v2/account/session-follow-rules']);
      available = false;
      invalidate({ full: true });
      expect(await cache.read()).toMatchObject({ status: 'unavailable' });
      available = true;
      expect(await cache.read()).toMatchObject({ status: 'available' });
      lifetime.abort();
      const beforeRetiredRead = reads.length;
      expect(await cache.readReceiverSourceRanges({ destinationSessionId: receiverSessionId })).toMatchObject({ status: 'unavailable' });
      expect(reads).toHaveLength(beforeRetiredRead);
    } finally { cache.dispose(); http.mockRestore(); }
  });
  it('retains rule configuration for source-only notifications and reloads it on a rule change', async () => {
    let invalidate: (change?: Readonly<{ full: boolean }>) => void = () => {};
    let ruleReads = 0;
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(new URL(String(url)).origin).toBe('https://bob-follow.test');
      expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200,
        data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (String(url).endsWith('/v2/account/session-follow-preferences')) return { status: 200,
        data: { assigned: false, direct: false, team: false, group: false } };
      if (String(url).endsWith('/v2/account/session-follow-rules')) {
        ruleReads++;
        return { status: 200, data: { rules: [row] } };
      }
      throw new Error(`Unexpected Follow request ${String(url)}`);
    });
    const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://bob-follow.test', signal: new AbortController().signal, isCurrent: async () => true,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; } });
    try {
      expect(await cache.read()).toMatchObject({ status: 'available', rules: [{ ruleId: row.ruleId }] });
      invalidate({ full: false });
      expect(await cache.read()).toMatchObject({ status: 'available', rules: [{ ruleId: row.ruleId }] });
      expect(ruleReads).toBe(1);
      invalidate({ full: true });
      expect(await cache.read()).toMatchObject({ status: 'available', rules: [{ ruleId: row.ruleId }] });
      expect(ruleReads).toBe(2);
    } finally { cache.dispose(); http.mockRestore(); }
  });
  it.each(['invalid-response', 'retirement', 'dispose', 'progress', 'configuration'] as const)('withdraws a receiver progress read after %s', async failure => {
    const lifetime = new AbortController();
    let current = true;
    let invalidate: (change?: SessionFollowRuleInvalidation) => void = () => {};
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { started = resolve; });
    const sessionRule = { ...row, receiver: { kind: 'session' as const, sessionId: 'receiver' } };
    const http = vi.spyOn(axios, 'get').mockImplementation(async (_url, options) => {
      if (failure === 'configuration' && !options?.params) {
        const path = new URL(String(_url)).pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200,
          data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
        if (path === '/v2/account/session-follow-preferences') return { status: 200,
          data: { assigned: false, direct: false, team: false, group: false } };
        return { status: 200, data: { rules: [sessionRule] } };
      }
      expect(options?.params).toEqual({ destinationSessionId: 'receiver', sourceSessionId: 'current-source' });
      started();
      await gate;
      return { status: 200, data: failure === 'invalid-response' ? { rules: [], sourceRanges: { status: 'unknown' } }
        : { rules: [sessionRule], sourceRanges: { status: 'available', sources: [] } } };
    });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://receiver-progress.test', signal: lifetime.signal, isCurrent: () => current,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; } });
    try {
      if (failure === 'configuration') expect(await cache.read()).toMatchObject({ status: 'available' });
      const pending = cache.readReceiverSourceRanges({ destinationSessionId: 'receiver', sourceSessionId: 'current-source' });
      await reading;
      if (failure === 'retirement') current = false;
      if (failure === 'dispose') cache.dispose();
      if (failure === 'progress') invalidate({ full: false, receiverSessionIds: ['receiver'] });
      if (failure === 'configuration') {
        invalidate({ full: true });
        // Even the same admitted full basis cannot resurrect an older scoped
        // HTTP read that was unfinished at invalidation.
        expect(await cache.read()).toMatchObject({ status: 'available' });
      }
      release();
      expect(await pending).toMatchObject({ status: 'unavailable',
        reason: failure === 'retirement' || failure === 'dispose' ? 'account-retired' : 'source-ranges-unavailable' });
      if (failure === 'retirement' || failure === 'dispose') {
        expect(await cache.readReceiverSourceRanges({ destinationSessionId: 'receiver' })).toMatchObject({ status: 'unavailable' });
        expect(http).toHaveBeenCalledTimes(1);
      }
    } finally { release(); lifetime.abort(); cache.dispose(); http.mockRestore(); }
  });
  it('does not acquire an Account observation when disposed during the initial encryption read', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { started = resolve; });
    const http = vi.spyOn(axios, 'get').mockImplementation(async () => {
      started();
      await gate;
      return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://retired-follow.test', signal: new AbortController().signal,
      isCurrent: async () => true, subscribeInvalidation: () => () => {} });
    try {
      const pending = cache.read();
      await reading;
      cache.dispose();
      release();
      expect(await pending).toMatchObject({ status: 'unavailable' });
      const observed = readObservedAccountEncryptionCurrentness({ token, serverBaseUrl: 'https://retired-follow.test' });
      void observed?.catch(() => {});
      expect(observed).toBeNull();
      expect(channel.clients).toHaveLength(0);
      expect(http).toHaveBeenCalledTimes(1);
    } finally { release(); cache.dispose(); http.mockRestore(); }
  });
  it('withdraws a private Bob read retired during HTTP, without borrowing the installed Account', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    let current = true;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reads: Readonly<{ url: string; authorization: unknown }>[] = [];
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      reads.push({ url: String(url), authorization: config?.headers?.Authorization });
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith('/v2/account/session-follow-preferences')) return { status: 200,
        data: { assigned: true, direct: false, team: false, group: false } };
      if (String(url).endsWith('/v2/account/session-follow-rules')) {
        await gate;
        return { status: 200, data: { rules: [row] } };
      }
      return { status: 404, data: {} };
    });
    const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://bob-follow.test', signal: new AbortController().signal,
      isCurrent: async () => current, subscribeInvalidation: () => () => {} });
    try {
      const pending = cache.read();
      await vi.waitFor(() => expect(reads.some(read => read.url.endsWith('/session-follow-rules'))).toBe(true));
      current = false;
      release();
      expect(await pending).toMatchObject({ status: 'unavailable' });
      expect(await cache.read()).toMatchObject({ status: 'unavailable' });
      expect(reads.every(read => read.url.startsWith('https://bob-follow.test/') && read.authorization === `Bearer ${token}`)).toBe(true);
    } finally { release(); cache.dispose(); http.mockRestore(); }
  });
  it('keeps personal default preferences in the same invalidated Account snapshot', async () => {
    let invalidate = () => {};
    let preferences = { assigned: true, direct: false, team: false, group: false };
    const cache = createSessionFollowRuleCache({ signal: new AbortController().signal, isCurrent: () => true,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; },
      read: async () => ({ mode: 'plain', material: null, rules: [row], defaultPreferences: preferences }) });
    expect(await cache.read()).toMatchObject({ status: 'available', defaultPreferences: preferences });
    preferences = { ...preferences, team: true };
    invalidate();
    expect(await cache.read()).toMatchObject({ status: 'available', defaultPreferences: preferences });
    cache.dispose();
  });
  it('withdraws cached rules invalidated while the Account adapter awaits its final currentness check', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    let invalidate = () => {};
    let checking = false;
    let currentnessChecks = 0;
    let reached!: () => void;
    let release!: () => void;
    const atFinalCheck = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith('/v2/account/session-follow-preferences')) return { status: 200,
        data: { assigned: true, direct: false, team: false, group: false } };
      if (String(url).endsWith('/v2/account/session-follow-rules')) return { status: 200, data: { rules: [row] } };
      return { status: 404, data: {} };
    });
    const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://bob-follow.test', signal: new AbortController().signal,
      isCurrent: async () => {
        // A cached demand checks Account authority before and after reading.
        if (checking && ++currentnessChecks === 2) { reached(); await gate; }
        return true;
      }, subscribeInvalidation: listener => { invalidate = listener; return () => {}; } });
    try {
      expect(await cache.read()).toMatchObject({ status: 'available' });
      checking = true;
      const pending = cache.read();
      await atFinalCheck;
      invalidate();
      release();
      expect(await pending).toMatchObject({ status: 'unavailable', reason: 'rules-changed' });
    } finally { release(); cache.dispose(); http.mockRestore(); }
  });
  it('keeps a completed range refresh usable when another range refreshes during Account validation', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    let currentnessChecks = 0;
    let checking = false;
    let reached!: () => void;
    let release!: () => void;
    const atFinalCheck = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith('/v2/account/session-follow-preferences')) return { status: 200,
        data: { assigned: true, direct: false, team: false, group: false } };
      if (String(url).endsWith('/v2/account/session-follow-rules')) return { status: 200, data: { rules: [row] } };
      return { status: 404, data: {} };
    });
    const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://bob-follow.test', signal: new AbortController().signal,
      isCurrent: async () => {
        // A warm read checks Account custody before and after its snapshot.
        if (checking && ++currentnessChecks === 2) { reached(); await gate; }
        return true;
      }, subscribeInvalidation: () => () => {} });
    try {
      expect(await cache.read()).toMatchObject({ status: 'available' });
      checking = true;
      const wider = cache.read();
      await atFinalCheck;
      expect(await cache.read({ refresh: true })).toMatchObject({ status: 'available' });
      release();
      expect(await wider).toMatchObject({ status: 'available', rules: [{ ruleId: row.ruleId }] });
    } finally { release(); cache.dispose(); http.mockRestore(); }
  });
  it('refreshes progress once at a catchup range boundary without publishing an older pending read', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const fresh = { ...row, sources: [{ sourceSessionId: 'current-source',
      delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 4 } }] };
    const cache = createSessionFollowRuleCache({ signal: new AbortController().signal, isCurrent: () => true,
      subscribeInvalidation: () => () => {}, read: async () => {
        reads++;
        if (reads === 1) { await gate; return { mode: 'plain', material: null, rules: [row] }; }
        return { mode: 'plain', material: null, rules: [fresh] };
      } });
    try {
      const older = cache.read();
      const current = cache.read({ refresh: true });
      release();
      expect(await older).toMatchObject({ status: 'unavailable', reason: 'rules-changed' });
      expect(await current).toMatchObject({ status: 'available', rules: [{ sources: fresh.sources }] });
      expect(await cache.read()).toBe(await current);
      expect(reads).toBe(2);
    } finally { release(); cache.dispose(); }
  });
  it('reads and validates defaults on the captured Account transport beside private rules', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const preferences = { assigned: true, direct: false, team: true, group: false };
    let valid = true;
    let invalidate = () => {};
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(String(url)).toMatch(/^https:\/\/bob-follow\.test\//);
      expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).endsWith('/v2/account/session-follow-rules')) return { status: 200, data: { rules: [row] } };
      if (String(url).endsWith('/v2/account/session-follow-preferences')) return { status: 200, data: valid ? preferences : { assigned: true } };
      return { status: 404, data: {} };
    });
    const cache = createAccountSessionFollowRuleCache({ accountId: 'bob', credentials: { token, encryption: null },
      serverHttpBaseUrl: 'https://bob-follow.test', signal: new AbortController().signal, isCurrent: () => true,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; } });
    try {
      expect(await cache.read()).toMatchObject({ status: 'available', defaultPreferences: preferences });
      valid = false;
      invalidate();
      expect(await cache.read()).toMatchObject({ status: 'unavailable' });
    } finally { cache.dispose(); http.mockRestore(); }
  });
  it('opens once, shares concurrent demand, and reloads only after the existing change feed invalidates', async () => {
    let reads = 0;
    let invalidate = () => {};
    const cache = createSessionFollowRuleCache({ signal: new AbortController().signal, isCurrent: () => true,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; },
      read: async () => { reads++; return { mode: 'plain', material: null, rules: [row] }; } });
    const [first, second] = await Promise.all([cache.read(), cache.read()]);
    expect(first).toMatchObject({ status: 'available', rules: [{ definition, sources: row.sources }] });
    expect(second).toBe(first);
    await cache.read();
    expect(reads).toBe(1);
    invalidate();
    await cache.read();
    expect(reads).toBe(2);
    cache.dispose();
  });

  it('does not reinterpret missing E2EE material or a mismatched mode as an empty rule set', async () => {
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(4) };
    const encrypted = { ...row, content: sealSessionFollowRuleContentV1({ ruleId: row.ruleId, receiver,
      definition, mode: 'e2ee', material }) };
    const cache = createSessionFollowRuleCache({ signal: new AbortController().signal, isCurrent: () => true,
      subscribeInvalidation: () => () => {}, read: async () => ({ mode: 'e2ee', material: null, rules: [encrypted] }) });
    expect(await cache.read()).toMatchObject({ status: 'unavailable', reason: 'encryption-material-unavailable' });
    cache.dispose();
  });

  it.each(['missing-material', 'wrong-mode'] as const)('withdraws admitted definitions when an explicit reload has %s', async cause => {
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(4) };
    const sessionReceiver = { kind: 'session' as const, sessionId: 'receiver' };
    const encrypted = { ...row, receiver: sessionReceiver, content: sealSessionFollowRuleContentV1({
      ruleId: row.ruleId, receiver: sessionReceiver, definition, mode: 'e2ee', material }) };
    let available = true;
    const cache = createSessionFollowRuleCache({ signal: new AbortController().signal, isCurrent: () => true,
      subscribeInvalidation: () => () => {}, read: async () => ({
        mode: !available && cause === 'wrong-mode' ? 'plain' : 'e2ee',
        material: available ? material : null, rules: [encrypted],
      }) });
    try {
      expect(await cache.read()).toMatchObject({ status: 'available' });
      available = false;
      expect(await cache.read({ refresh: true })).toMatchObject({
        status: 'unavailable', reason: cause === 'missing-material' ? 'encryption-material-unavailable' : 'account-mode-mismatch',
      });
    } finally { cache.dispose(); }
  });

  it.each(['retirement', 'invalidation'] as const)('withdraws overlapping refreshes that finish after Account %s', async cause => {
    let finish!: (value: { mode: 'plain'; material: null; rules: typeof row[] }) => void;
    let invalidate = () => {};
    const lifetime = new AbortController();
    const cache = createSessionFollowRuleCache({ signal: lifetime.signal, isCurrent: () => true,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; },
      read: async () => await new Promise(resolve => { finish = resolve; }) });
    const pending = cache.read({ refresh: true });
    const overlapping = cache.read({ refresh: true });
    if (cause === 'retirement') lifetime.abort();
    else invalidate();
    finish({ mode: 'plain', material: null, rules: [row] });
    const unavailable = { status: 'unavailable', reason: cause === 'retirement' ? 'account-retired' : 'rules-changed' };
    expect(await pending).toMatchObject(unavailable);
    expect(await overlapping).toMatchObject(unavailable);
    cache.dispose();
  });

  it.each(['retirement', 'invalidation'] as const)('withdraws a shared refresh invalidated during its promise handoff by %s', async cause => {
    let finish!: (value: { mode: 'plain'; material: null; rules: typeof row[] }) => void;
    let invalidate = () => {};
    let initial = true;
    const lifetime = new AbortController();
    const cache = createSessionFollowRuleCache({ signal: lifetime.signal, isCurrent: () => true,
      subscribeInvalidation: listener => { invalidate = listener; return () => {}; },
      read: async () => {
        if (!initial) return { mode: 'plain', material: null, rules: [{ ...row, version: 2 }] };
        initial = false;
        return await new Promise(resolve => { finish = resolve; });
      } });
    try {
      const refresh = cache.read({ refresh: true });
      const ordinary = cache.read();
      finish({ mode: 'plain', material: null, rules: [row] });
      expect(await ordinary).toMatchObject({ status: 'available' });
      if (cause === 'retirement') lifetime.abort();
      else invalidate();
      const overlapping = cache.read({ refresh: true });
      const unavailable = { status: 'unavailable', reason: cause === 'retirement' ? 'account-retired' : 'rules-changed' };
      expect(await refresh).toMatchObject(unavailable);
      const next = await overlapping;
      if (next.status === 'unavailable') expect(next).toMatchObject(unavailable);
      else expect(next.rules).toMatchObject([{ version: 2 }]);
    } finally { cache.dispose(); }
  });

  it('releases a failed shared refresh so a later demand can recover', async () => {
    let reject!: (reason: Error) => void;
    let failed = false;
    const cache = createSessionFollowRuleCache({ signal: new AbortController().signal, isCurrent: () => true,
      subscribeInvalidation: () => () => {}, read: async () => {
        if (!failed) return await new Promise((_resolve, rejectRead) => { reject = rejectRead; });
        return { mode: 'plain', material: null, rules: [row] };
      } });
    try {
      const refresh = cache.read({ refresh: true });
      const overlapping = cache.read({ refresh: true });
      reject(new Error('Rules transport failed'));
      expect(await refresh).toMatchObject({ status: 'unavailable', reason: 'private-rules-unavailable' });
      expect(await overlapping).toMatchObject({ status: 'unavailable', reason: 'private-rules-unavailable' });
      failed = true;
      expect(await cache.read({ refresh: true })).toMatchObject({ status: 'available', rules: [{ ruleId: row.ruleId }] });
    } finally { cache.dispose(); }
  });
});
