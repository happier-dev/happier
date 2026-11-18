import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { buildConnectedServiceCredentialRecord, StrictJsonValueSchema } from '@happier-dev/protocol';
import type { AgentSessionOpenRequest, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

import { createCodexNativeAppServerRuntimeHost } from './native.js';
import type { CodexAppServerEvent } from './core.js';
import { waitForCodexAppServerRuntimeTurnCompletion } from './runtime.js';
import { withCodexNativeAttachFixture } from './runtime.nativeAttach.test-support.js';
import { buildCodexCloudAuthFile } from '../../auth/services/openai/cloud/authFile.js';

// Only the native process/socket and host auth service are substituted. The
// native host refresh adapter, JSON-RPC client, runtime and usage codec are real.
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: process.env.TMPDIR || actual.userInfo().homedir }) };
});

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
const credential = (profileId: string) => StrictJsonValueSchema.parse(buildConnectedServiceCredentialRecord({
  now: 1000, serviceId: service.localId, profileId, kind: 'oauth', expiresAt: 2000,
  oauth: { accessToken: `synthetic-${profileId}`, refreshToken: 'synthetic-refresh', idToken: null,
    scope: null, tokenType: null, providerAccountId: profileId, providerEmail: null },
}));

function nativeRequest(socket: WebSocket, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = 'fixture-refresh';
    const receive = (payload: Buffer) => {
      const message = JSON.parse(payload.toString()) as { id?: unknown; result?: unknown; error?: unknown };
      if (message.id !== id) return;
      socket.off('message', receive);
      if (message.error) reject(new Error('Native request failed'));
      else resolve(message.result);
    };
    socket.on('message', receive);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

describe('prospective native request account scope', () => {
  it.each([
    { planType: 'plus', bound: true, accountScope: 'personal' },
    { planType: 'team', bound: true, accountScope: 'workspace' },
    { planType: 'future-plan', bound: true, accountScope: undefined },
    { planType: 'plus', bound: false, accountScope: undefined },
  ] as const)('captures startup $planType native request proof with bound=$bound without hot-auth application', async ({ planType, bound, accountScope }) => {
    const authBytes = new TextEncoder().encode(JSON.stringify(buildCodexCloudAuthFile({
      accessToken: 'synthetic-startup', idToken: null, accountId: 'provider-account-A', lastRefreshIso: '2026-10-22T00:00:00.000Z',
    })));
    await withCodexNativeAttachFixture(async fixture => {
      const session = await fixture.openConfiguredSession();
      const events: AgentSessionRuntimeEvent[] = [];
      const subscription = session.watch(event => events.push(event));
      try {
        await session.send({ inputIds: ['startup-input'], input: { text: 'Use the materialized startup binding' },
          delivery: { kind: 'newTurn', turnId: 'host-startup' } });
        fixture.emitNotification('rawResponse/completed', { threadId: 'fresh-thread', turnId: 'provider-turn-1',
          responseId: 'startup-response', usage: { totalTokens: 3, inputTokens: 2, outputTokens: 1 } });
        await expect.poll(() => events.filter(event => event.kind === 'usage-observed').length).toBe(1);
        const usage = events.find(event => event.kind === 'usage-observed');
        expect(usage).toMatchObject({ turnId: 'host-startup', tokens: { total: 3 } });
        if (bound) {
          expect(usage).toMatchObject({ attribution: { turnId: 'host-startup', source: {
            kind: 'native', connectedAccount: { service, accountId: 'profile-A' },
            ...(accountScope ? { accountScope } : {}),
          } } });
          if (!accountScope) expect(usage?.kind === 'usage-observed' && usage.attribution?.source).not.toHaveProperty('accountScope');
        } else {
          // docs/providers.md#validation-map; 2a330834023a: an explicit unknown
          // native witness prevents the host from substituting launch proof.
          expect(usage?.kind === 'usage-observed' && usage.attribution).toEqual({
            v: 1, turnId: 'host-startup', source: { kind: 'native', connectedAccount: null },
          });
        }
        expect(fixture.requests.find(request => request.method === 'account/login/start')?.params)
          .toMatchObject({ type: 'chatgptAuthTokens', chatgptAccountId: 'provider-account-A' });
      } finally {
        subscription.dispose();
      }
    }, {
      sessionConnectedAccounts: bound ? [{ purpose: 'primary', account: { service, accountId: 'profile-A' } }] : undefined,
      // Provenance: serializeConnectedServiceChildSelections emits this qualified flat shape.
      processEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
        { kind: 'profile', serviceId: 'happier.agent.codex/openai-codex', profileId: 'profile-A', credentialRevision },
      ]) },
      runtimeAuthHost: { nativeHome: { root: '/fixture-native-home', readFiles: async () => ({ 'auth.json': authBytes }) } },
      accountRead: () => ({ account: { type: 'chatgpt', planType } }),
    });
  });

  it.each([
    ['plus', 'personal'], ['team', 'workspace'], ['future-plan', undefined],
  ] as const)('attributes exact %s response completions while retaining cumulative context', async (planType, accountScope) => {
    await withCodexNativeAttachFixture(async ({ runtime, emitNotification }) => {
      await runtime.updateConfig({ modelId: 'fixture-model' });
      const events: CodexAppServerEvent[] = [];
      runtime.events.subscribe(event => events.push(event));
      expect(await runtime.runtimeAuth.apply({ serviceId: service.localId, authGeneration: {
        credential: credential('account-A'), credentialRevision, forcedWorkspaceId: 'account-A',
        selection: { kind: 'profile', serviceId: service.localId, profileId: 'account-A' },
      } })).toMatchObject({ ok: true });
      await runtime.send({ v: 1, text: 'two Responses completions' }, { turnId: 'host-turn' });
      // rust-v0.162.1 app-server-protocol/v2/thread.rs: exact response usage is
      // separate from the accumulated/estimated/replayed total+last snapshot.
      const usage = { totalTokens: 3, inputTokens: 2, outputTokens: 1 };
      const completeResponse = (responseId: string, turnId = 'provider-turn-1') =>
        emitNotification('rawResponse/completed', { threadId: 'fresh-thread', turnId, responseId, usage, usageMetadata: null });
      completeResponse('response-1');
      completeResponse('response-1'); // transport replay, not another inference
      completeResponse('response-2'); // equal counters, distinct inference
      emitNotification('thread/tokenUsage/updated', { threadId: 'fresh-thread', turnId: 'provider-turn-1', tokenUsage: {
        total: { totalTokens: 1006, inputTokens: 1004, outputTokens: 2 }, last: usage, modelContextWindow: 200_000,
      } });
      await expect.poll(() => events.filter(event => event.kind === 'usage-observed').length).toBe(4);
      const observations = events.filter(event => event.kind === 'usage-observed');
      const exact = observations.filter(event => event.scope === 'turn_delta');
      expect(exact).toHaveLength(3);
      expect(exact[0]?.observationId).toBe(exact[1]?.observationId);
      expect(exact[2]?.observationId).not.toBe(exact[0]?.observationId);
      for (const event of exact) {
        expect(event).toMatchObject({ turnId: 'host-turn', tokens: { total: 3 },
          accounting: { nativeSessionId: 'fresh-thread', inferenceId: expect.stringMatching(/^response-/) },
          attribution: { turnId: 'host-turn', source: { kind: 'native', connectedAccount: { service, accountId: 'account-A' } } } });
        expect(event.attribution?.source).toEqual(expect.objectContaining(accountScope ? { accountScope } : {}));
        if (!accountScope) expect(event.attribution?.source).not.toHaveProperty('accountScope');
        expect(event).not.toHaveProperty('context');
      }
      expect(observations[3]).toMatchObject({ scope: 'session_cumulative', tokens: { total: 1006 },
        context: { usedTokens: 3, totalProcessedTokens: 1006, windowTokens: 200_000 } });
      // Cumulative and last-only snapshots carry the same unknown witness;
      // neither certifies a request Account (docs/providers.md#validation-map).
      expect(observations[3]?.attribution).toEqual({
        v: 1, turnId: 'host-turn', source: { kind: 'native', connectedAccount: null },
      });
      // A legacy last-only snapshot is still readable privately, but the native
      // contract does not establish it as an exact response completion.
      emitNotification('thread/tokenUsage/updated', { threadId: 'fresh-thread', turnId: 'provider-turn-1', tokenUsage: { last: usage } });
      await expect.poll(() => events.filter(event => event.kind === 'usage-observed').length).toBe(5);
      expect(events.filter(event => event.kind === 'usage-observed').at(-1)?.attribution).toEqual({
        v: 1, turnId: 'host-turn', source: { kind: 'native', connectedAccount: null },
      });
      completeResponse('foreign-response', 'foreign-turn');
      const completed = waitForCodexAppServerRuntimeTurnCompletion(runtime);
      emitNotification('turn/completed', { threadId: 'fresh-thread', turn: { id: 'provider-turn-1', status: 'completed' } });
      await completed;
      completeResponse('late-response');
      // Socket ordering makes the following cumulative update a read barrier.
      emitNotification('thread/tokenUsage/updated', { threadId: 'fresh-thread', turnId: 'provider-turn-1', tokenUsage: { total: usage } });
      await expect.poll(() => events.filter(event => event.kind === 'usage-observed' && event.scope === 'session_cumulative').length).toBe(2);
      expect(events.filter(event => event.kind === 'usage-observed' && event.accounting?.inferenceId)).toHaveLength(3);
    }, { connectedAccountService: service,
      runtimeAuthHost: { refreshRuntimeAuth: async () => ({ status: 'failed', reason: 'unused' }) },
      accountRead: () => ({ account: { type: 'chatgpt', planType } }),
    });
  });

  it('does not echo A plan onto B refresh and qualifies only the next fresh B request', async () => {
    const context = {
      signal: new AbortController().signal,
      services: { sessions: { current: null }, logger: { debug() {}, warn() {} } },
      session: { id: 'actual-happier-session', services: { auth: { services: {
        refreshRuntimeAuth: async () => ({ status: 'refreshed', result: {
          credentialRevision, accessToken: 'synthetic-B', providerAccountId: 'account-B',
        } }),
      } } } },
    } as unknown as AgentSessionRuntimeContext;
    const host = createCodexNativeAppServerRuntimeHost({ request: { sessionId: context.session.id } as AgentSessionOpenRequest,
      context, processEnv: {} });
    await expect(host.refreshRuntimeAuth?.({ serviceId: service.localId, reason: 'credential_expired', planType: 'plus' }))
      .resolves.toMatchObject({ status: 'refreshed', result: { chatgptAccountId: 'account-B', chatgptPlanType: null } });
    let planType = 'plus';
    let socket: WebSocket | undefined;
    await withCodexNativeAttachFixture(async ({ runtime, emitNotification, requests }) => {
      await runtime.updateConfig({ modelId: 'fixture-model' });
      const events: CodexAppServerEvent[] = [];
      runtime.events.subscribe(event => events.push(event));
      const apply = (profileId: string) => runtime.runtimeAuth.apply({ serviceId: service.localId,
        authGeneration: { credential: credential(profileId), credentialRevision,
          forcedWorkspaceId: profileId, selection: { kind: 'profile', serviceId: service.localId, profileId } } });
      const usage = async (nativeTurnId: string) => {
        const before = events.filter(event => event.kind === 'usage-observed').length;
        emitNotification('rawResponse/completed', { threadId: 'fresh-thread', turnId: nativeTurnId,
          responseId: `response-${before}`, usage: { totalTokens: 3, inputTokens: 2, outputTokens: 1 } });
        await expect.poll(() => events.filter(event => event.kind === 'usage-observed').length).toBe(before + 1);
        return events.filter(event => event.kind === 'usage-observed').at(-1);
      };
      expect(await apply('account-A')).toMatchObject({ ok: true });
      await runtime.send({ v: 1, text: 'first' }, { turnId: 'host-first' });
      expect(await usage('provider-turn-1')).toMatchObject({ attribution: { source: {
        kind: 'native', accountScope: 'personal', connectedAccount: { service, accountId: 'account-A' },
      } } });
      expect(socket).toBeDefined();
      const refreshed = await nativeRequest(socket!, 'account/chatgptAuthTokens/refresh', { chatgptPlanType: 'plus' });
      expect(refreshed).toMatchObject({ accessToken: 'synthetic-B', chatgptAccountId: 'account-B' });
      expect(refreshed).not.toHaveProperty('chatgptPlanType');
      planType = 'team';
      expect((await usage('provider-turn-1'))?.attribution).toEqual({
        v: 1, turnId: 'host-first', source: { kind: 'native', connectedAccount: null },
      });
      const completed = waitForCodexAppServerRuntimeTurnCompletion(runtime);
      emitNotification('turn/completed', { threadId: 'fresh-thread', turn: { id: 'provider-turn-1', status: 'completed' } });
      await completed;
      expect(await apply('account-B')).toMatchObject({ ok: true });
      await runtime.send({ v: 1, text: 'fresh' }, { turnId: 'host-next' });
      expect(await usage('provider-turn-2')).toMatchObject({ attribution: { source: {
        kind: 'native', accountScope: 'workspace', connectedAccount: { service, accountId: 'account-B' },
      } } });
      expect(requests.filter(request => request.method === 'account/login/start')
        .every(request => !Object.hasOwn(request.params, 'chatgptPlanType'))).toBe(true);
    }, { connectedAccountService: service,
      runtimeAuthHost: { refreshRuntimeAuth: host.refreshRuntimeAuth },
      accountRead: () => ({ account: { type: 'chatgpt', email: null, planType } }),
      onTurnStart: input => { socket = input.socket; },
    });
  });

  it.each(['missing', 'unrecognized', 'failed'] as const)('leaves %s native plan evidence unknown', async kind => {
    await withCodexNativeAttachFixture(async ({ runtime, emitNotification }) => {
      await runtime.updateConfig({ modelId: 'fixture-model' });
      const events: CodexAppServerEvent[] = [];
      runtime.events.subscribe(event => events.push(event));
      expect(await runtime.runtimeAuth.apply({ serviceId: service.localId, authGeneration: {
        credential: credential('account-A'), credentialRevision, forcedWorkspaceId: 'account-A',
        selection: { kind: 'profile', serviceId: service.localId, profileId: 'account-A' },
      } })).toMatchObject({ ok: true });
      await runtime.send({ v: 1, text: 'unknown plan' }, { turnId: 'host-turn' });
      emitNotification('rawResponse/completed', { threadId: 'fresh-thread', turnId: 'provider-turn-1',
        responseId: 'response-1', usage: { totalTokens: 3, inputTokens: 2, outputTokens: 1 } });
      await expect.poll(() => events.filter(event => event.kind === 'usage-observed').length).toBe(1);
      const event = events.find(event => event.kind === 'usage-observed');
      expect(event).toMatchObject({ attribution: { source: { kind: 'native', connectedAccount: { accountId: 'account-A' } } } });
      if (event?.kind !== 'usage-observed') throw new Error('Expected usage');
      expect(event.attribution?.source).not.toHaveProperty('accountScope');
    }, { connectedAccountService: service, runtimeAuthHost: { refreshRuntimeAuth: async () => ({ status: 'failed', reason: 'unused' }) }, accountRead: () => {
      if (kind === 'failed') throw new Error('Synthetic transport failure');
      return { account: { type: 'chatgpt', ...(kind === 'unrecognized' ? { planType: 'future-plan' } : {}) } };
    } });
  });

  it.each(['accepted', 'failed'] as const)('does not restore scope when an auth apply is %s during the plan read', async outcome => {
    let releaseRead!: (value: unknown) => void;
    let notifyRead!: () => void;
    const reading = new Promise<void>(resolve => { notifyRead = resolve; });
    const delayedRead = new Promise<unknown>(resolve => { releaseRead = resolve; });
    let blockRead = false;
    await withCodexNativeAttachFixture(async ({ runtime, emitNotification }) => {
      await runtime.updateConfig({ modelId: 'fixture-model' });
      const events: CodexAppServerEvent[] = [];
      runtime.events.subscribe(event => events.push(event));
      const apply = (profileId: string) => runtime.runtimeAuth.apply({ serviceId: service.localId, authGeneration: {
        credential: credential(profileId), credentialRevision, forcedWorkspaceId: profileId,
        selection: { kind: 'profile', serviceId: service.localId, profileId },
      } });
      expect(await apply('account-A')).toMatchObject({ ok: true });
      blockRead = true;
      const sending = runtime.send({ v: 1, text: 'auth changes during read' }, { turnId: 'host-turn' });
      await reading;
      if (outcome === 'accepted') expect(await apply('account-B')).toMatchObject({ ok: true });
      else expect(await runtime.runtimeAuth.apply({ serviceId: service.localId })).toMatchObject({ ok: false });
      releaseRead({ account: { type: 'chatgpt', planType: 'plus' } });
      await sending;
      emitNotification('rawResponse/completed', { threadId: 'fresh-thread', turnId: 'provider-turn-1',
        responseId: 'response-1', usage: { totalTokens: 3, inputTokens: 2, outputTokens: 1 } });
      await expect.poll(() => events.filter(event => event.kind === 'usage-observed').length).toBe(1);
      expect(events.find(event => event.kind === 'usage-observed')?.attribution).toEqual({
        v: 1, turnId: 'host-turn', source: { kind: 'native', connectedAccount: null },
      });
    }, { connectedAccountService: service,
      runtimeAuthHost: { refreshRuntimeAuth: async () => ({ status: 'failed', reason: 'unused' }) },
      accountRead: async () => {
        if (!blockRead) return { account: { type: 'chatgpt', planType: 'plus' } };
        blockRead = false;
        notifyRead();
        return await delayedRead;
      },
    });
  });
});
