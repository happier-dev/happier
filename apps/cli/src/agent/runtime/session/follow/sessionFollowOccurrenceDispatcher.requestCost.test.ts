import axios from 'axios';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SessionFollowRuleSourceOccurrenceV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createSessionFollowOccurrenceDispatcher } from './sessionFollowOccurrenceDispatcher.testkit';

// Only the authenticated Home HTTP boundary (and its Socket.IO endpoint) is substituted.
let channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>;
beforeEach(async () => { channel = await createRequesterCurrentnessSocketHarness(); });
afterEach(async () => { await channel.close(); vi.restoreAllMocks(); });

it.each(['no-rules', 'personal-rule'] as const)('reads each committed terminal source once per pass, and only when a receiver can use it (%s)', async (scenario) => {
  const sourceSessionId = 'c444444444444444444444444';
  const credentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null };
  const home = 'http://follow-request-cost.test';
  const rule = { ruleId: 'personal-rule', version: 0, receiver: { kind: 'account' as const },
    content: { t: 'plain' as const, v: { v: 1 as const, enabled: true,
      filter: normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' }), policy: { preset: 'important' as const } } } };
  const source = { ...createSessionNotificationContextFixture(sourceSessionId), encryptionMode: 'plain', dataEncryptionKey: null,
    metadata: JSON.stringify({ path: '/work', host: 'host', machineId: 'source-machine' }), ownerAccountId: 'account-1',
    archivedAt: null, active: true, seq: 9, latestTurnId: 'host-turn', latestTurnStatus: 'completed', origin: { kind: 'none' as const } };
  const requests: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    requests.push(`GET ${path}`);
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: scenario === 'personal-rule' ? [rule] : [] } };
    // The shipped default: assigned Sessions are followed. This Session is not assigned to the requester.
    if (path === '/v2/account/session-follow-preferences') return { status: 200, data: { assigned: true, direct: false, team: false, group: false } };
    if (path === `/v2/sessions/${sourceSessionId}`) return { status: 200, data: { session: source } };
    if (path === '/v2/session-organization') return { status: 200, data: { snapshot: { schemaVersion: 1, version: 1,
      pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [] } } };
    if (path.endsWith('/messages')) {
      const seq = Number(new URL(String(url)).searchParams.get('afterSeq')) + 1;
      return { status: 200, data: { messages: [{ id: `terminal-row-${seq}`, localId: `native-terminal-${seq}`, seq,
        createdAt: 200, updatedAt: 200, messageRole: 'agent', sidechainId: null, content: { t: 'plain', v: {
          role: 'agent', meta: { runtimeTurnId: `host-turn-${seq}` },
          content: { type: 'event', id: `native-ready-${seq}`, data: { type: 'ready', completedTurnId: `host-turn-${seq}` } },
        } } }], hasMore: false } };
    }
    if (path === '/v2/account/session-delivery-mutes') return { status: 200, data: { scopes: [] } };
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    requests.push(`POST ${path}`);
    if (path.endsWith('/follows/occurrence-routes')) return { status: 200, data: { ok: true, v: 1, sourceSessionId,
      originalCreatedAt: 200, routes: [], currentAccountFacts: { defaultRelationships: { assigned: false, direct: false, team: false, group: false },
        personalFollowSuppressed: false, hasPersistentFollow: false } } };
    throw new Error(`Unexpected POST ${path}`);
  });
  const personal: unknown[] = [];
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials, serverId: 'home', serverHttpBaseUrl: home,
    machineId: 'source-machine', installationId: 'installation', signal: new AbortController().signal,
    isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => true, dispatchPersonal: async dispatch => { personal.push(dispatch.sourceSessionId); } });
  const dispatchTerminal = (seq: number) => dispatcher.dispatch(SessionFollowRuleSourceOccurrenceV1Schema.parse({ sourceSessionId,
    sourcePublisher: { machineId: 'source-machine', publisherGeneration: '1', committedFenceMs: 1 },
    sourceMessage: { localId: `native-terminal-${seq}`, seq },
    evidence: { v: 1, ownerAccountId: 'account-1', event: { kind: 'finished' }, facts: { serverId: 'home', kind: 'session' } } }));
  try {
    // The first Turn also opens the retained Account rule configuration; measure the steady per-Turn cost after it.
    await dispatchTerminal(9);
    const before = requests.length;
    personal.length = 0;
    await dispatchTerminal(10);
    const perTurn = requests.slice(before);
    const count = (request: string) => perTurn.filter(item => item === request).length;
    expect(count(`POST /v2/sessions/${sourceSessionId}/follows/occurrence-routes`)).toBe(1);
    // Terminal normalization admits the source transport once; preparation reuses it.
    expect(count('GET /v1/account/encryption/currentness'), JSON.stringify(perTurn)).toBe(1);
    expect(count(`GET /v2/sessions/${sourceSessionId}`), JSON.stringify(perTurn)).toBe(1);
    expect(count(`GET /v1/sessions/${sourceSessionId}/messages`)).toBe(1);
    if (scenario === 'no-rules') {
      // No rule, no applicable default, no ordinary edge: nothing reads the source's list facts.
      expect(perTurn, JSON.stringify(perTurn)).toHaveLength(4);
      expect(personal).toEqual([]);
    } else {
      // A matching personal rule still evaluates against current facts and dispatches.
      expect(personal).toEqual([sourceSessionId]);
    }
  } finally { dispatcher.dispose(); }
});
