import axios from 'axios';
import type { AgentState } from '@/api/types';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import { readForegroundAgentRequestFollowEvent } from '@/agent/permissions/activeForegroundRequests';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createSessionFollowOccurrenceDispatcher } from './sessionFollowOccurrenceDispatcher';
import { createAccountSessionFollowRuleCache } from './accountSessionFollowRuleCache';
import { SessionFollowRuleSourceOccurrenceV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import { SessionFollowPersonalProgressRequestV1Schema, type SessionFollowPersonalProgressRequestV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createPersonalFollowOccurrenceDispatcher } from '@/notifications/activity/dispatchPersonalFollowOccurrence';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { notificationCatalogFixture, notificationSettingsFixture } from '@/notifications/activity/activityNotification.testkit';
import { logger } from '@/ui/logger';
import { deriveSessionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { sealSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import { encodeBase64, encryptLegacy } from '@/api/encryption';
import { createAutomationAccountEncryptionMaterialSnapshotV1 } from '@/plugins/runtime/automations/automationAccountCurrentness';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { SessionFollowSessionPendingObservationV1Schema, SessionFollowObserveSourceRoutesRequestV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import type { SessionFollowRuleInvalidation } from './sessionFollowRuleCache';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { buildSessionStopHoldV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';

let channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>;
beforeEach(async () => { channel = await createRequesterCurrentnessSocketHarness(); });
afterEach(async () => { await channel.close(); vi.restoreAllMocks(); });

it('reads filter facts and Project encryption once for 32 originals in one source pass, then refreshes the next pass', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'follow-pass-facts-' }, async () => {
    const sourceSessionId = 'c111111111111111111111111';
    const destinationSessionId = 'c222222222222222222222222';
    const serverId = 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const home = 'https://follow-pass.test';
    await seedTestServerProfile({ id: 'follow-pass', homeId: serverId, serverUrl: home });
    const metadata = JSON.stringify({ path: '/work/project', host: 'host', machineId: 'machine', workspaceId: 'checkout' });
    const stop = buildSessionStopHoldV1({ rawSession: { id: destinationSessionId }, stopIntent: 'explicit_stop',
      executionAuthority: 'present_user', requestId: 'held-receiver', requestedAtMs: 1 });
    if (stop.kind !== 'hold') throw new Error('Expected receiver Stop');
    const source = createSessionRecordFixture({ id: sourceSessionId, ownerAccountId: 'account-1',
      encryptionMode: 'plain', dataEncryptionKey: null, metadata, seq: 32, archivedAt: null, origin: { kind: 'none' },
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
    const destination = { ...createSessionNotificationContextFixture(destinationSessionId),
      ...createSessionRecordFixture({ id: destinationSessionId, ownerAccountId: 'account-1', encryptionMode: 'plain',
        dataEncryptionKey: null, metadata: JSON.stringify({ ...JSON.parse(metadata), sessionExplicitStopV1: stop.stop }),
        archivedAt: null, active: false }) };
    const rows = Array.from({ length: 32 }, (_, index) => ({ id: `original-${index}`, localId: `original-${index}`, seq: index + 1,
      createdAt: index + 200, updatedAt: index + 200, sidechainId: null, messageRole: 'agent',
      content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: `goal-${index}`, data: { type: 'goal-changed' } } } } }));
    let projectKey = 'payments';
    let addTagAtOriginal17 = false;
    let holdAdmission = false;
    let invalidate: ((change?: SessionFollowRuleInvalidation) => void) | undefined;
    const gets: string[] = [], posts: string[] = [];
    const pending: unknown[] = [];
    const rule = { ruleId: 'project-rule', version: 1, receiver: { kind: 'session', sessionId: destinationSessionId },
      content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: [serverId],
        scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'],
        projects: { include: [{ serverId, projectKey: 'payments' }], exclude: [] } }), policy: { preset: 'quiet' } } } };
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      gets.push(path);
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: [rule], sourceRanges: { status: 'available',
        sources: [{ sourceSessionId, delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1, throughSeq: source.seq }] } } };
      if (path === '/v2/account/session-follow-preferences') return { status: 200, data: { assigned: false, direct: false, team: false, group: false } };
      if (path === `/v2/sessions/${sourceSessionId}`) return { status: 200, data: { session: source } };
      if (path === `/v2/sessions/${destinationSessionId}`) return { status: 200, data: { session: destination } };
      if (path.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
      if (path === '/v2/session-organization') return { status: 200, data: { snapshot: { schemaVersion: 1, version: 1,
        pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [{ sessionId: sourceSessionId, tagIds: ['pass-tag'] }],
        orderEntries: [], labels: [] } } };
      if (path.endsWith('/messages')) return { status: 200, data: { messages: rows, hasMore: false } };
      throw new Error(`Unexpected GET ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const path = new URL(String(url)).pathname;
      posts.push(path);
      if (path === '/v1/account/project-rows/list') return projectAccountRowsReadHttpResponse([createPlainProjectAccountRefRow({
        id: 'checkout', serverId, machineId: 'machine', rootPath: '/work/project', projectKey, createdAtMs: 1,
      })], String(url), body);
      if (path.endsWith('/follows/occurrence-routes')) {
        if (addTagAtOriginal17 && SessionFollowObserveSourceRoutesRequestV1Schema.parse(body).sourceMessage?.seq === 49) {
          addTagAtOriginal17 = false;
          rule.version++;
          rule.content.v.filter = normalizeSessionListFilterV1({ ...rule.content.v.filter, tagIds: [{ serverId, tagId: 'pass-tag' }] });
          invalidate?.({ full: true });
        }
        return { status: 200, data: { ok: true, v: 1, sourceSessionId, originalCreatedAt: 200, routes: [] } };
      }
      if (path.endsWith('/pending')) {
        pending.push(body);
        return holdAdmission ? { status: 409, data: { error: 'session_input_held' } }
          : { status: 200, data: { didWrite: true } };
      }
      throw new Error(`Unexpected POST ${path}`);
    });
    const dispatcherInput = { accountId: 'account-1', credentials: {
      token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null }, serverId: 'follow-pass', serverHttpBaseUrl: home,
      machineId: 'machine', installationId: 'installation', signal: new AbortController().signal,
      isCurrent: async () => true, subscribeInvalidation: (listener: (change?: SessionFollowRuleInvalidation) => void) => { invalidate = listener; return () => {}; }, resolveSourceKeyContext: async () => null,
      isPersonalCurrent: () => false, dispatchPersonal: async () => {} };
    const rulesCache = createAccountSessionFollowRuleCache(dispatcherInput);
    let dispatcher = createSessionFollowOccurrenceDispatcher({ ...dispatcherInput, rulesCache });
    const pass = () => dispatcher.dispatchReceiverRange({ destinationSessionId, sourceSessionId, observations: [] });
    try {
      await pass();
      expect(pending, 'all selected originals still reach Pending admission').toHaveLength(32);
      expect(posts.filter(path => path.endsWith('/occurrence-routes'))).toHaveLength(32);
      expect(posts.filter(path => path === '/v1/account/project-rows/list')).toHaveLength(1);
      expect(gets.filter(path => path === '/v1/account/encryption')).toHaveLength(1);
      const settledPosts = posts.length;
      for (let index = 0; index < 10; index++) await pass();
      expect(posts.length - settledPosts, 'idle passes cannot re-probe or re-admit settled originals').toBe(0);
      dispatcher.dispose();
      dispatcher = createSessionFollowOccurrenceDispatcher({ ...dispatcherInput, rulesCache });
      await pass();
      expect(posts).toHaveLength(settledPosts);
      // A new pass must observe real Project changes instead of retaining its
      // predecessor's positive match or borrowing an installed Account's facts.
      projectKey = 'other-project';
      rows.push(...rows.map(row => ({ ...row, id: `${row.id}-next`, localId: `${row.localId}-next`, seq: row.seq + 32 })));
      source.seq = 64;
      invalidate?.({ full: true });
      await pass();
      expect(pending).toHaveLength(32);
      expect(posts.filter(path => path === '/v1/account/project-rows/list')).toHaveLength(2);
      expect(gets.filter(path => path === '/v1/account/encryption')).toHaveLength(2);
      const missedPosts = posts.length;
      for (let index = 0; index < 10; index++) await pass();
      expect(posts.length - missedPosts, 'zero candidates settle this original for this receiver').toBe(0);
      projectKey = 'payments';
      invalidate?.({ full: true });
      addTagAtOriginal17 = true;
      await pass();
      expect(pending, 'a changed rule snapshot must prepare its new tag facts before continuing').toHaveLength(64);
      expect(gets.filter(path => path === '/v2/session-organization')).toHaveLength(1);
      expect(posts.filter(path => path === '/v1/account/project-rows/list')).toHaveLength(4);
      expect(gets.filter(path => path === '/v1/account/encryption')).toHaveLength(4);
      // A distinct committed original is real demand even while older Pending
      // originals remain unconsumed. Admission failure then waits for push.
      const row = { ...rows[0]!, id: 'held-original', localId: 'held-original', seq: 65 };
      rows.push(row);
      source.seq = 65;
      holdAdmission = true;
      await pass();
      const heldPosts = posts.length;
      const heldAdmissions = pending.length;
      expect(heldAdmissions).toBe(65);
      for (let index = 0; index < 10; index++) await pass();
      expect(posts.length - heldPosts, 'held work is not a per-pass retry').toBe(0);
      expect(pending).toHaveLength(heldAdmissions);
      await dispatcher.readReceiverSessionIds(sourceSessionId);
      await pass();
      expect(pending, 'a sibling source change is not receiver availability').toHaveLength(heldAdmissions);
      row.updatedAt++;
      await pass();
      expect(pending, 'a committed revision is a changed original').toHaveLength(heldAdmissions + 1);
      const revisedPosts = posts.length;
      await pass();
      expect(posts.length - revisedPosts).toBe(0);
      holdAdmission = false;
      destination.metadata = metadata;
      destination.active = true;
      for (let index = 0; index < 10; index++) {
        rulesCache.observeSourceChange(destinationSessionId, undefined, false);
        await pass();
      }
      expect(pending, 'unrelated receiver writes are not availability').toHaveLength(heldAdmissions + 1);
      invalidate?.({ full: false, receiverSessionIds: [destinationSessionId] });
      await pass();
      expect(pending, 'consumed progress is not receiver availability').toHaveLength(heldAdmissions + 1);
      rulesCache.observeSourceChange(destinationSessionId, undefined, true);
      await pass();
      expect(pending).toHaveLength(heldAdmissions + 2);
      const resumedPosts = posts.length;
      await pass();
      expect(posts.length - resumedPosts).toBe(0);
    } finally { dispatcher.dispose(); rulesCache.dispose(); }
  });
});

it('prepares only the affected source among 1000 equal or unrelated Follow arrivals', async () => {
  const destinationSessionId = 'c222222222222222222222222';
  const sourceSessionId = 'c111111111111111111111111';
  const equal = Array.from({ length: 1000 }, (_, index) => ({
    sourceSessionId: `c${String(index).padStart(23, '0')}`, destinationSessionId,
    relation: 'follower' as const, policy: { preset: 'everything' as const },
    delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1, observed: SESSION_FOLLOW_ZERO_FRONTIER_V1,
  }));
  const sourceReads: string[] = [];
  const log = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/follows/sessions')) return { status: 200, data: { sources: [] } };
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: [] } };
    if (path === '/v2/account/session-follow-preferences') return { status: 200,
      data: { assigned: false, direct: false, team: false, group: false } };
    if (path.endsWith('/messages')) return { status: 200, data: { messages: [{ id: 'original', seq: 1,
      localId: 'original', createdAt: 1, content: { t: 'plain', v: { role: 'agent',
        content: { type: 'event', id: 'goal', data: { type: 'goal-changed' } } } } }], hasMore: false } };
    if (path.startsWith('/v2/sessions/')) {
      const id = path.slice('/v2/sessions/'.length);
      sourceReads.push(id);
      return { status: 200, data: { session: createSessionRecordFixture({ id, ownerAccountId: 'account-1',
        encryptionMode: 'plain', dataEncryptionKey: null, seq: id === sourceSessionId ? 1 : 0,
        metadata: JSON.stringify({ machineId: 'machine', path: '/work', host: 'host' }) }) } };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async url => {
    expect(new URL(String(url)).pathname).toBe(`/v2/sessions/${sourceSessionId}/follows/occurrence-routes`);
    return { status: 200, data: { ok: true, v: 1, sourceSessionId, routes: [] } };
  });
  const dispatcherInput = { accountId: 'account-1', credentials: {
    token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://follow-facts.test',
    machineId: 'machine', installationId: 'installation', signal: new AbortController().signal,
    isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => false, dispatchPersonal: async () => {} };
  const rulesCache = createAccountSessionFollowRuleCache(dispatcherInput);
  const dispatcher = createSessionFollowOccurrenceDispatcher({ ...dispatcherInput, rulesCache });
  const factsPreparations = () => log.mock.calls.filter(([message, fields]) => message === '[Session Follow] Dispatch checkpoint'
    && fields !== null && typeof fields === 'object' && 'phase' in fields && fields.phase === 'facts'
    && 'status' in fields && fields.status === 'started');
  try {
    await dispatcher.dispatchReceiverRange({ destinationSessionId, observations: equal });
    expect(sourceReads, 'equal source frontiers do not demand source acquisition').toEqual([]);
    expect(factsPreparations()).toHaveLength(0);
    const changed = { ...equal[0]!, sourceSessionId,
      observed: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 1 } };
    await dispatcher.dispatchReceiverRange({ destinationSessionId, sourceSessionId, observations: [
      ...equal.map(observation => ({ ...observation, observed: changed.observed })), changed,
    ] });
    expect(sourceReads, 'one admitted source range has one Session detail loader').toEqual([sourceSessionId]);
    expect(factsPreparations()).toHaveLength(1);
    const readsAfterPreparation = sourceReads.length;
    await dispatcher.dispatchReceiverRange({ destinationSessionId, sourceSessionId,
      observations: [{ ...changed, delivered: changed.observed }] });
    expect(sourceReads).toHaveLength(readsAfterPreparation);
    expect(factsPreparations()).toHaveLength(1);
    const heldOriginal = { sourceSessionId, sourceMessage: { seq: 2, localId: 'held-source-original' } };
    rulesCache.originalWork.start(destinationSessionId, heldOriginal)!('held', 'source');
    await dispatcher.readReceiverSessionIds(sourceSessionId, false, false);
    expect(rulesCache.originalWork.start(destinationSessionId, heldOriginal),
      'a source-negative installed push must not release source-held admission').toBeNull();
    await dispatcher.readReceiverSessionIds(sourceSessionId, false, true);
    const retry = rulesCache.originalWork.start(destinationSessionId, heldOriginal);
    expect(retry, 'a real source change releases its held original once').not.toBeNull();
    retry!('held', 'source');
    expect(rulesCache.originalWork.start(destinationSessionId, heldOriginal)).toBeNull();
    expect(sourceReads).toHaveLength(readsAfterPreparation);
    expect(factsPreparations()).toHaveLength(1);
  } finally { dispatcher.dispose(); rulesCache.dispose(); }
});

it('prepares no private rule or source facts for refused occurrences and reads fresh facts after source recovery', async () => {
  const sourceSessionId = 'c111111111111111111111111';
  const source = createSessionRecordFixture({ id: sourceSessionId, ownerAccountId: 'account-1', encryptionMode: 'plain',
    dataEncryptionKey: null, archivedAt: null, metadata: JSON.stringify({ path: '/work', host: 'host', machineId: 'machine' }) });
  const reads: string[] = [];
  const sessionReads = vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    reads.push(path);
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: [] } };
    if (path === '/v2/account/session-follow-preferences') return { status: 200,
      data: { assigned: false, direct: false, team: false, group: false } };
    if (path === `/v2/sessions/${sourceSessionId}`) return { status: 200, data: { session: source } };
    throw new Error(`Unexpected GET ${path}`);
  });
  let available = false;
  const routes = vi.spyOn(axios, 'post').mockImplementation(async url => {
    expect(new URL(String(url)).pathname).toBe(`/v2/sessions/${sourceSessionId}/follows/occurrence-routes`);
    return available ? { status: 200, data: { ok: true, v: 1, sourceSessionId, routes: [] } }
      : { status: 403, data: { ok: false, v: 1, error: 'forbidden' } };
  });
  const lifetime = new AbortController();
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: {
    token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://follow-refusal.test',
    machineId: 'machine', installationId: 'installation', signal: lifetime.signal,
    isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => false, dispatchPersonal: async () => { throw new Error('No personal route was admitted'); } });
  const occurrence = (seq: number) => SessionFollowRuleSourceOccurrenceV1Schema.parse({ sourceSessionId,
    sourcePublisher: { machineId: 'machine', publisherGeneration: '1', committedFenceMs: 1 },
    sourceMessage: { seq, localId: `original-${seq}` }, evidence: { v: 1, ownerAccountId: 'account-1',
      event: { kind: 'update_posted' }, facts: { serverId: 'home', kind: 'session' } } });
  try {
    for (let seq = 1; seq <= 20; seq++) await dispatcher.dispatch(occurrence(seq));
    expect(routes).toHaveBeenCalledTimes(20);
    expect(reads, 'a refused original must not demand rule configuration, decryption or private filter facts').toEqual([]);
    available = true;
    expect(await dispatcher.dispatch(occurrence(21))).toEqual({});
    expect(reads).toContain('/v2/account/session-follow-rules');
    expect(reads.filter(path => path === `/v2/sessions/${sourceSessionId}`)).toHaveLength(1);
    // A second admitted original still rereads source authority, not a retained fact snapshot.
    expect(await dispatcher.dispatch(occurrence(22))).toEqual({});
    expect(reads.filter(path => path === `/v2/sessions/${sourceSessionId}`)).toHaveLength(2);
    expect(sessionReads.mock.calls.filter(([url]) => new URL(String(url)).pathname === `/v2/sessions/${sourceSessionId}`)
      .map(([, config]) => config?.headers?.['X-Happier-Request-Purpose']))
      .toEqual(['session-detail:follow-occurrence', 'session-detail:follow-occurrence']);
    let state: AgentState = {};
    const store = new AgentStateRequestStore({ logPrefix: '[Refused question]', target: {
      scopeId: sourceSessionId, readState: () => state,
      // In-memory persistence is the boundary; the real request producer stays intact.
      updateState: update => { state = update(state); source.agentState = JSON.stringify(state);
        source.agentStateVersion = (source.agentStateVersion ?? 0) + 1; },
    } });
    try {
      await store.publishRequestAndWait({ requestId: 'question', toolName: 'AskUserQuestion',
        toolInput: { questions: [{ question: 'Which region?' }] }, createdAt: 7, turnId: 'worker-turn' });
      available = false;
      const readsBeforeQuestion = reads.length;
      await dispatcher.dispatch(SessionFollowRuleSourceOccurrenceV1Schema.parse({ sourceSessionId,
        sourcePublisher: { machineId: 'machine', publisherGeneration: '1', committedFenceMs: 1 },
        sourceRequests: { agentStateVersion: source.agentStateVersion,
          requests: [{ requestId: 'question', createdAt: 7, turnId: 'worker-turn' }] },
        requestEvidence: [{ requestId: 'question', evidence: { v: 1, ownerAccountId: 'account-1',
          event: { kind: 'needs_you', type: 'decision' }, facts: { serverId: 'home', kind: 'session' } } }] }));
      expect(reads.slice(readsBeforeQuestion).sort(), 'request freshness needs one exact source, but no refused rule/fact preparation')
        .toEqual(['/v1/account/encryption/currentness', `/v2/sessions/${sourceSessionId}`].sort());
    } finally { store.dispose(); }
    lifetime.abort();
    await dispatcher.dispatch(occurrence(23));
    expect(routes).toHaveBeenCalledTimes(23);
  } finally { dispatcher.dispose(); }
});

it('logs the typed admission rejection and exact question id without private content or extra admission records', async () => {
  const sourceSessionId = 'c111111111111111111111111';
  const destinationSessionId = 'c222222222222222222222222';
  const requestId = 'question-admission';
  const privateContent = 'private-question-and-http-content';
  const token = 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature';
  let agentStateVersion = 0;
  const source = createSessionRecordFixture({ id: sourceSessionId, ownerAccountId: 'account-1',
    encryptionMode: 'plain', dataEncryptionKey: null, archivedAt: null, active: true,
    metadata: JSON.stringify({ path: '/work', host: 'host', machineId: 'machine' }), agentStateVersion: 0 });
  const destination = { ...source, id: destinationSessionId };
  let state: AgentState = {};
  const store = new AgentStateRequestStore({ logPrefix: '[Question admission]', target: {
    scopeId: sourceSessionId, readState: () => state,
    // Persistence and HTTP are the boundaries; request publication and admission remain real.
    updateState: update => { state = update(state); source.agentState = JSON.stringify(state); source.agentStateVersion = ++agentStateVersion; },
  } });
  const log = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  let pendingAttempts = 0;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: [] } };
    if (path === '/v2/account/session-follow-preferences') return { status: 200,
      data: { assigned: false, direct: false, team: false, group: false } };
    if (path === `/v2/sessions/${sourceSessionId}`) return { status: 200, data: { session: source } };
    if (path === `/v2/sessions/${destinationSessionId}`) return { status: 200, data: { session: destination } };
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/follows/occurrence-routes')) return { status: 200,
      data: { ok: true, v: 1, sourceSessionId, routes: [] } };
    if (path.endsWith('/pending')) {
      pendingAttempts++;
      throw new axios.AxiosError(privateContent, undefined, undefined, undefined, {
        status: 403, statusText: 'Forbidden', headers: {}, config: { headers: new axios.AxiosHeaders() },
        data: { error: 'forbidden', code: 'session_input_untrusted_assertion', content: privateContent },
      });
    }
    throw new Error(`Unexpected POST ${path}`);
  });
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: { token, encryption: null },
    serverId: 'home', serverHttpBaseUrl: 'http://question-admission.test', machineId: 'machine', installationId: 'installation',
    signal: new AbortController().signal, isCurrent: async () => true, subscribeInvalidation: () => () => {},
    resolveSourceKeyContext: async () => null, isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
  try {
    await store.publishRequestAndWait({ requestId, toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: privateContent }] }, createdAt: 7, turnId: 'worker-turn',
      questionV1: { mode: 'wait', lasting: false, type: 'decision' },
      currentHandler: { kind: 'session', sessionId: destinationSessionId } });
    const event = readForegroundAgentRequestFollowEvent(state.requests![requestId]!);
    if (!event) throw new Error('The real question producer did not expose its Follow event');
    await dispatcher.dispatch(SessionFollowRuleSourceOccurrenceV1Schema.parse({ sourceSessionId,
      sourcePublisher: { machineId: 'machine', publisherGeneration: '1', committedFenceMs: 1 },
      sourceRequests: { agentStateVersion, requests: [{ requestId, createdAt: 7, turnId: 'worker-turn' }] },
      requestEvidence: [{ requestId, evidence: { v: 1, ownerAccountId: 'account-1',
        event, facts: { serverId: 'home', kind: 'session' } } }] }));
    expect(pendingAttempts, 'a rejected question settles without a retry').toBe(1);
    const admissions = log.mock.calls.filter(([message]) => message === '[Session Follow] Original admission completed');
    expect(admissions).toEqual([['[Session Follow] Original admission completed', {
      sourceSessionId, destinationSessionId, requestId, agentStateVersion,
      ok: false, code: 'admission_rejected', admissionResultCode: 'session_input_untrusted_assertion',
    }]]);
    expect(JSON.stringify(admissions)).not.toContain(privateContent);
    expect(JSON.stringify(admissions)).not.toContain(token);
  } finally { store.dispose(); dispatcher.dispose(); }
});

it('does no rule inventory reads for 50 manager source arrivals without receiver rules in a 1000-Session Account', async () => {
  const destinationSessionId = 'c222222222222222222222222';
  const sessions = new Map(Array.from({ length: 1000 }, (_, index) => {
    const id = `c${String(index).padStart(23, '0')}`;
    return [id, createSessionRecordFixture({ id, ownerAccountId: 'account-1', encryptionMode: 'plain',
      dataEncryptionKey: null, seq: 1, metadata: JSON.stringify({ path: '/work', host: 'host', machineId: 'machine' }) })] as const;
  }));
  const reads: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    reads.push(path);
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: [] } };
    if (path === '/v2/account/session-follow-preferences') return { status: 200,
      data: { assigned: false, direct: false, team: false, group: false } };
    if (path.endsWith('/messages')) return { status: 200, data: { messages: [{ id: 'sidechain-row', seq: 1,
      localId: null, createdAt: 1, sidechainId: 'child-run',
      content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Child output' } } } }], hasMore: false } };
    const session = sessions.get(path.slice('/v2/sessions/'.length));
    if (session) return { status: 200, data: { session } };
    throw new Error(`Unexpected GET ${path}`);
  });
  const writes = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Sidechain rows are not Follow originals'));
  const lifetime = new AbortController();
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: {
    token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://scale-follow.test',
    machineId: 'machine', installationId: 'installation', signal: lifetime.signal,
    isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
  try {
    // Warm the captured Account's canonical configuration once; arrivals do not change it.
    expect(await dispatcher.readReceiverSessionIds()).toEqual([]);
    reads.length = 0;
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
    for (const sourceSessionId of [...sessions.keys()].slice(0, 50)) {
      expect(await dispatcher.dispatchReceiverRange({ destinationSessionId, sourceSessionId, observations: [{
        sourceSessionId, destinationSessionId, relation: 'manager', attachedAt: 1, policy: { preset: 'everything' },
        delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1, observed: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 1 },
      }] })).toEqual({ receiverSessionIds: [] });
    }
    expect({
      rules: reads.filter(path => path === '/v2/account/session-follow-rules').length,
      preferences: reads.filter(path => path === '/v2/account/session-follow-preferences').length,
      currentness: reads.filter(path => path === '/v1/account/encryption/currentness').length,
      sourceDetails: reads.filter(path => path.startsWith('/v2/sessions/') && !path.endsWith('/messages')).length,
      transcriptPages: reads.filter(path => path.endsWith('/messages')).length,
    }).toEqual({ rules: 0, preferences: 0, currentness: 50, sourceDetails: 50, transcriptPages: 50 });
    expect(writes).not.toHaveBeenCalled();
  } finally { lifetime.abort(); dispatcher.dispose(); }
});

it('keeps configuration push-owned while 100 receiver arrivals use fresh progress instead of cached cursors', async () => {
  const destinationSessionId = 'c222222222222222222222222';
  const sourceSessionId = 'c111111111111111111111111';
  const token = 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature';
  const lifetime = new AbortController();
  let invalidate: (change?: Readonly<{ full: boolean }>) => void = () => {};
  let enabled = true;
  let sourceSeq = 6;
  let preferences = { assigned: false, direct: false, team: false, group: false };
  const reads: string[] = [];
  const rule = () => ({ ruleId: 'receiver-rule', version: enabled ? 1 : 2,
    receiver: { kind: 'session' as const, sessionId: destinationSessionId },
    sources: [{ sourceSessionId, delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1 }],
    content: { t: 'plain' as const, v: { v: 1 as const, enabled,
      filter: normalizeSessionListFilterV1({ homeServerIds: ['home'] }), policy: { preset: 'quiet' as const } } } });
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    const receiverRange = options?.params?.destinationSessionId;
    reads.push(receiverRange ? `${path}?receiver` : path);
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v2/account/session-follow-preferences') return { status: 200, data: preferences };
    if (path === '/v2/account/session-follow-rules') {
      const fresh = { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 6, agentStateVersion: 4 };
      return { status: 200, data: { rules: [{ ...rule(), ...(receiverRange ? { sources: [{ sourceSessionId, delivered: fresh }] } : {}) }],
        ...(receiverRange ? { sourceRanges: { status: 'available', sources: [{ sourceSessionId, delivered: fresh, throughSeq: 6 }] } } : {}) } };
    }
    if (path === `/v2/sessions/${sourceSessionId}`) return { status: 200,
      data: { session: createSessionRecordFixture({ id: sourceSessionId, ownerAccountId: 'account-1',
        encryptionMode: 'plain', dataEncryptionKey: null, seq: sourceSeq, agentStateVersion: 4,
        metadata: JSON.stringify({ machineId: 'machine', path: '/work', host: 'host' }) }) } };
    if (path.endsWith('/messages')) return { status: 200, data: { messages: sourceSeq > 6 ? [7, 8].map(seq => ({
      id: `sidechain-${seq}`, seq, localId: null, createdAt: seq, updatedAt: seq, sidechainId: 'child-run',
      content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Child output' } } },
    })) : [], hasMore: false } };
    throw new Error(`Unexpected Follow request ${path}`);
  });
  const writes = vi.spyOn(axios, 'post').mockRejectedValue(new Error('No unconsumed original exists'));
  const scope = { accountId: 'account-1', credentials: { token, encryption: null },
    serverHttpBaseUrl: 'http://follow-progress.test', signal: lifetime.signal, isCurrent: async () => true,
    subscribeInvalidation: (listener: typeof invalidate) => { invalidate = listener; return () => {}; } };
  const cache = createAccountSessionFollowRuleCache(scope);
  const dispatcher = createSessionFollowOccurrenceDispatcher({ ...scope, rulesCache: cache, serverId: 'home',
    machineId: 'machine', installationId: 'installation', resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
  try {
    expect(await dispatcher.readReceiverSessionIds()).toEqual([destinationSessionId]);
    await dispatcher.dispatchReceiverRange({ destinationSessionId, sourceSessionId, observations: [] });
    reads.length = 0;
    for (let arrival = 0; arrival < 100; arrival++) {
      invalidate({ full: false });
      await dispatcher.dispatchReceiverRange({ destinationSessionId, sourceSessionId, observations: [] });
    }
    expect(reads.filter(path => path === '/v2/account/session-follow-rules')).toEqual([]);
    expect(reads.filter(path => path === '/v2/account/session-follow-preferences')).toEqual([]);
    expect(reads.filter(path => path === '/v2/account/session-follow-rules?receiver'),
      'ordinary arrivals must reuse the held receiver projection').toEqual([]);
    expect(reads.filter(path => path.endsWith('/messages')), 'fresh progress must replace the cached zero cursor').toEqual([]);
    sourceSeq = 8;
    await dispatcher.dispatchReceiverRange({ destinationSessionId, sourceSessionId, observations: [] });
    expect(reads.filter(path => path.endsWith('/messages')),
      'a held discovery end must not hide the current source tail').toHaveLength(1);
    expect(reads.filter(path => path.startsWith('/v2/account/session-follow-rules'))).toEqual([]);
    enabled = false;
    preferences = { ...preferences, team: true };
    reads.length = 0;
    invalidate({ full: true });
    expect(await dispatcher.readReceiverSessionIds()).toEqual([]);
    expect(await cache.read()).toMatchObject({ status: 'available', defaultPreferences: preferences,
      rules: [{ version: 2, definition: { enabled: false } }] });
    expect(reads.filter(path => path === '/v2/account/session-follow-rules')).toHaveLength(1);
    expect(reads.filter(path => path === '/v2/account/session-follow-preferences')).toHaveLength(1);
    expect(writes).not.toHaveBeenCalled();
  } finally { lifetime.abort(); dispatcher.dispose(); cache.dispose(); }
});

it.each([
  { show: 'sessions', homeServerId: 'home', exactReads: 0 },
  { show: 'runs', homeServerId: 'home', exactReads: 0 },
  { show: 'sessions', homeServerId: 'unresolved-home', exactReads: 3 },
  { show: 'sessions', homeServerId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN', exactReads: 0 },
] as const)('discovers $show receiver rules with $homeServerId source facts without unnecessary Session reads', async ({ show, homeServerId, exactReads }) => {
  const run = async () => {
    const serverId = homeServerId.startsWith('srv_') ? 'follow-local-profile' : 'home';
    const receiverSessionId = 'c222222222222222222222222';
    const reads = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: [{
        ruleId: 'kind-only', version: 1, receiver: { kind: 'session', sessionId: receiverSessionId }, sources: [],
        content: { t: 'plain', v: { v: 1, enabled: true,
          filter: normalizeSessionListFilterV1({ homeServerIds: [homeServerId], scope: 'all_accessible', show,
            startedBy: ['you', 'agents', 'triggers'] }), policy: { preset: 'quiet' } } },
      }] } };
      if (path === '/v2/account/session-follow-preferences') return { status: 200,
        data: { assigned: false, direct: false, team: false, group: false } };
      if (path.startsWith('/v2/sessions/')) return { status: 404, data: {} };
      throw new Error(`Unexpected GET ${path}`);
    });
    const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: {
      token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null }, serverId, serverHttpBaseUrl: 'http://follow.test',
      machineId: 'machine', installationId: 'installation', signal: new AbortController().signal,
      isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
      isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
    try {
      for (const sourceSessionId of ['source-1', 'source-2', 'source-3']) {
        expect(await dispatcher.readReceiverSessionIds(sourceSessionId)).toEqual(show === 'sessions' ? [receiverSessionId] : []);
      }
      expect(reads.mock.calls.map(([url]) => new URL(String(url)).pathname).filter(path => path.startsWith('/v2/sessions/')),
        'known facts skip exact reads, but an unresolved Home must remain conservative').toEqual(exactReads
        ? ['/v2/sessions/source-1', '/v2/sessions/source-2', '/v2/sessions/source-3'] : []);
    } finally { dispatcher.dispose(); }
  };
  if (homeServerId.startsWith('srv_')) {
    await withConfiguredDaemonTestHome({ prefix: 'follow-known-home-' }, async () => {
      await seedTestServerProfile({ id: 'follow-local-profile', homeId: homeServerId, serverUrl: 'https://follow.test' });
      await run();
    });
  } else await run();
});

it('reads fresh facts for unresolved receiver predicates and retains unknown matches without reviving known misses', async () => {
  const sourceSessionId = 'c111111111111111111111111';
  const matchingReceiver = 'c222222222222222222222222';
  const unrelatedReceiver = 'c333333333333333333333333';
  const rule = (sessionId: string, show: 'sessions' | 'runs') => ({ ruleId: sessionId, version: 1,
    receiver: { kind: 'session', sessionId }, sources: [], content: { t: 'plain', v: { v: 1, enabled: true,
      filter: normalizeSessionListFilterV1({ homeServerIds: ['home'], startedBy: ['you', 'agents', 'triggers'], scope: 'all_accessible', show,
        ...(show === 'sessions' ? { source: 'persisted' } : {}) }),
      policy: { preset: 'quiet' } } } });
  const source = createSessionRecordFixture({ id: sourceSessionId, ownerAccountId: 'account-1', encryptionMode: 'plain',
    dataEncryptionKey: null, metadata: JSON.stringify({ path: '/work', host: 'host', machineId: 'machine' }) });
  let readable = true;
  const reads = vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v2/account/session-follow-rules') return { status: 200,
      data: { rules: [rule(matchingReceiver, 'sessions'), rule(unrelatedReceiver, 'runs')] } };
    if (path === '/v2/account/session-follow-preferences') return { status: 200,
      data: { assigned: false, direct: false, team: false, group: false } };
    if (path === `/v2/sessions/${sourceSessionId}`) return readable ? { status: 200, data: { session: source } } : { status: 404, data: {} };
    throw new Error(`Unexpected GET ${path}`);
  });
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: {
    token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://follow.test',
    machineId: 'machine', installationId: 'installation', signal: new AbortController().signal,
    isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
  try {
    expect(await dispatcher.readReceiverSessionIds(sourceSessionId)).toEqual([matchingReceiver]);
    readable = false;
    expect(await dispatcher.readReceiverSessionIds(sourceSessionId)).toEqual([matchingReceiver]);
    expect(reads.mock.calls.filter(([url]) => new URL(String(url)).pathname === `/v2/sessions/${sourceSessionId}`)).toHaveLength(2);
  }
  finally { dispatcher.dispose(); }
});

it('does not rediscover configured Run sources on an exact Session source wake', async () => {
  const reads = vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: [] } };
    if (path === '/v2/account/session-follow-preferences') return { status: 200,
      data: { assigned: false, direct: false, team: false, group: false } };
    if (path.endsWith('/follows/sessions')) return { status: 200, data: { sources: [] } };
    throw new Error(`Unexpected GET ${path}`);
  });
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: {
    token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://follow.test',
    machineId: 'machine', installationId: 'installation', signal: new AbortController().signal,
    isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
  try {
    expect(await dispatcher.dispatchReceiverRange({ destinationSessionId: 'c222222222222222222222222',
      sourceSessionId: 'c111111111111111111111111', observations: [] })).toEqual({ receiverSessionIds: [] });
    expect(reads.mock.calls.filter(([url]) => String(url).endsWith('/follows/sessions'))).toEqual([]);
  } finally { dispatcher.dispose(); }
});

// Terminal Turns use protected Pending intake, covered with real custody in
// sessionFollowStalled.sqlite.composed.integration.spec.ts. Waiting and stalls
// remain no-original context-only wakes under the selected route policy.
it.each([
  { status: 'waiting', sidechainSuffix: false, relation: 'manager', preset: 'everything' },
  { status: 'stalled', sidechainSuffix: false, relation: 'manager', preset: 'everything' },
  { status: 'stalled', sidechainSuffix: false, relation: 'follower', preset: 'important' },
  { status: 'stalled', sidechainSuffix: false, relation: 'follower', preset: 'quiet' },
  { status: 'stalled', sidechainSuffix: false, relation: 'rule', preset: 'important' },
  { status: 'stalled', sidechainSuffix: false, relation: 'rule', preset: 'quiet' },
] as const)('dispatches a no-original $relation $status Turn under $preset through receiver recovery', async ({ status, sidechainSuffix, relation, preset }) => {
  const sourceSessionId = 'c111111111111111111111111';
  const destinationSessionId = 'c222222222222222222222222';
  const metadata = { machineId: 'machine', path: '/receiver', host: 'host', flavor: 'codex', codexSessionId: 'native-session',
    runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} } };
  let running = false;
  let held = false;
  let delivered = SESSION_FOLLOW_ZERO_FRONTIER_V1;
  const observation = () => SessionFollowSessionPendingObservationV1Schema.parse({ sourceSessionId, destinationSessionId, relation, ...(relation === 'manager' ? { attachedAt: 1 } : {}),
    ...(relation === 'rule' ? { effectiveDelivery: preset === 'quiet' ? 'next_turn' : 'wake', presence: { turnId: 'source-turn', publisherFence: 0 } }
      : { policy: { preset } }), delivered,
    observed: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: sidechainSuffix ? 1 : 0, turn: { id: 'source-turn', status } } });
  const source = createSessionRecordFixture({ id: sourceSessionId, encryptionMode: 'plain', dataEncryptionKey: null,
    metadata: JSON.stringify(metadata), ownerAccountId: 'account-1', origin: { kind: 'none' }, seq: sidechainSuffix ? 1 : 0,
    latestTurnId: 'source-turn', latestTurnStatus: status === 'stalled' ? 'in_progress' : status,
    active: status !== 'stalled', activeAt: 0, pendingReviewRuns: 0 });
  const destination = () => createSessionRecordFixture({ id: destinationSessionId, encryptionMode: 'plain', dataEncryptionKey: null,
    metadata: JSON.stringify({ ...metadata, ...(held ? { sessionExplicitStopV1: {
      v: 1, cause: 'explicit_stop', requestId: 'person-stop', requestedAtMs: 1 } } : {}) }), active: false });
  const reads = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/follows/sessions')) return { status: 200, data: { sources: [] } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: relation === 'rule' ? [{
      ruleId: 'private-rule', version: 1, receiver: { kind: 'session', sessionId: destinationSessionId },
      sources: [{ sourceSessionId, delivered, stalled: { ruleVersion: 1,
        presence: { turnId: 'source-turn', publisherFence: 0 }, effectiveDelivery: preset === 'quiet' ? 'next_turn' : 'wake' } }],
      content: { t: 'plain', v: { v: 1, enabled: true, policy: { preset },
        filter: normalizeSessionListFilterV1({ homeServerIds: ['home'] }) } },
    }] : [], ...(relation === 'rule' && options?.params?.destinationSessionId
      ? { sourceRanges: { status: 'available', sources: [{ sourceSessionId, delivered, throughSeq: 0 }] } } : {}) } };
    if (path === '/v2/account/session-follow-preferences') return { status: 200, data: { assigned: false, direct: false, team: false, group: false } };
    if (path === `/v2/sessions/${sourceSessionId}`) return { status: 200, data: { session: source } };
    if (path === `/v2/sessions/${destinationSessionId}`) return { status: 200, data: { session: destination() } };
    if (path.endsWith('/messages')) return { status: 200, data: { messages: sidechainSuffix
      && (options?.params?.scope ?? new URL(String(url)).searchParams.get('scope')) === 'all'
      ? [{ id: 'sidechain-row', seq: 1, localId: null, createdAt: 1, sidechainId: 'child-run',
        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Child run output' } } } }] : [], hasMore: false } };
    if (path.endsWith('/execution-runs')) return { status: 200, data: { runs: [] } };
    return { status: 404, data: {} };
  });
  const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
    if (new URL(String(url)).pathname === '/v3/automations/runs/workflow-storage') {
      expect(body).toMatchObject({ operation: 'list' });
      return { status: 200, data: { runs: [], nextCursor: null } };
    }
    if (new URL(String(url)).pathname.endsWith('/personal-progress')) {
      expect(SessionFollowPersonalProgressRequestV1Schema.parse(body)).toMatchObject({ kind: 'session_stalled',
        sourceSessionId, destinationSessionId, rules: [{ ruleId: 'private-rule', ruleVersion: 1, selectedDelivery: preset === 'quiet' ? 'next_turn' : 'wake' }] });
      return { status: 200, data: { accepted: true, alreadyRepresented: delivered.turn?.status === 'stalled' } };
    }
    expect(new URL(String(url)).pathname).toBe(`/v2/sessions/${destinationSessionId}/follows/inactive-observations`);
    expect(options?.headers?.['X-Happier-Request-Purpose']).toBe('session-follow:manager-turn-admission');
    return { status: 200, data: { ok: true, v: 1, sessionId: destinationSessionId,
      target: { homeId: 'home', accountId: 'account-1', sessionId: destinationSessionId, machineId: 'machine', installationId: 'installation' },
      currentSourceSessionIds: [sourceSessionId], observations: [observation()] } };
  });
  const spawn = vi.fn(async () => ({ type: 'success' as const, sessionId: destinationSessionId }));
  let invalidate: (() => void) | undefined;
  const cache = createAccountSessionFollowRuleCache({ accountId: 'account-1', credentials: {
    token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null }, serverHttpBaseUrl: 'http://turn-follow.test',
    signal: new AbortController().signal, isCurrent: async () => true,
    subscribeInvalidation: listener => { invalidate = () => listener({ full: false, receiverSessionIds: [destinationSessionId] }); return () => {}; } });
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: {
    token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://turn-follow.test',
    machineId: 'machine', installationId: 'installation', signal: new AbortController().signal,
    isCurrent: async () => true, subscribeInvalidation: () => () => {}, rulesCache: cache,
    isSessionAlreadyRunning: async () => running, spawnSession: spawn,
    resolveSourceKeyContext: async () => ({ serverIdentityId: 'home', authority: 'account_automation', surface: 'api' }),
    isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
  const recover = () => dispatcher.dispatchReceiverRange({ destinationSessionId,
    observations: relation === 'rule' ? [] : [observation()] });
  try {
    held = true;
    await recover();
    expect(spawn).not.toHaveBeenCalled();
    held = false;
    running = true;
    await recover();
    expect(spawn).not.toHaveBeenCalled();
    running = false;
    const beforeConsumption = reads.mock.calls.length;
    await recover();
    if (preset === 'quiet') {
      expect(spawn).not.toHaveBeenCalled();
      const consumed = reads.mock.calls.slice(beforeConsumption);
      expect(consumed.filter(([url]) => new URL(String(url)).pathname === `/v2/sessions/${destinationSessionId}`),
        'next-turn policy does not demand a receiver resume read').toHaveLength(0);
      expect(consumed.filter(([url]) => new URL(String(url)).pathname === `/v2/sessions/${sourceSessionId}`),
        'only existing original-range traversal reads the source; no wake hydration').toHaveLength(1);
    }
    else expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ existingSessionId: destinationSessionId }));
    expect(writes.mock.calls.filter(([url]) => String(url).endsWith('/pending'))).toEqual([]);
    if (relation === 'rule') {
      // Provider acceptance changes only private Turn progress. The real Home
      // omits represented rule observations; it does not fabricate a settled row.
      delivered = { ...delivered, turn: observation().observed.turn };
      invalidate?.();
      spawn.mockClear();
      await dispatcher.dispatchReceiverRange({ destinationSessionId, sourceSessionId, observations: [] });
      expect(spawn).not.toHaveBeenCalled();
      return;
    }
    delivered = observation().observed;
    spawn.mockClear();
    const consumedReads = reads.mock.calls.length;
    for (let arrival = 0; arrival < 100; arrival++) await dispatcher.dispatchReceiverRange({
      destinationSessionId, sourceSessionId, observations: [observation()],
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(reads.mock.calls.length, 'settled presence arrivals add no source, configuration or discovery GET').toBe(consumedReads);
  } finally { dispatcher.dispose(); cache.dispose(); }
});

it.each(['rules', 'source_ranges'] as const)('identifies a pending and refused range rule read without exposing private source or Account content (%s)', async phase => {
  const log = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  const sourceSessionId = 'c111111111111111111111111';
  const destinationSessionId = 'c222222222222222222222222';
  const token = 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let readingRules = false;
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/follows/sessions')) return { status: 200, data: { sources: [] } };
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v2/account/session-follow-preferences') return { status: 200,
      data: { assigned: false, direct: false, team: false, group: false } };
    if (path === '/v2/account/session-follow-rules') {
      if (phase === 'source_ranges' && !options?.params?.destinationSessionId) return { status: 200, data: { rules: [{
        ruleId: 'private-rule', version: 0, receiver: { kind: 'session', sessionId: destinationSessionId },
        content: { t: 'plain', v: { v: 1, enabled: true,
          filter: normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' }), policy: { preset: 'quiet' } } },
      }] } };
      readingRules = true;
      await gate;
      return { status: 503, data: { privateDiagnostic: 'private-rule-response' } };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  const writes = vi.spyOn(axios, 'post').mockRejectedValue(new Error('No admission is authorized'));
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: { token, encryption: null },
    serverId: 'home', serverHttpBaseUrl: 'http://follow-diagnostic.test', machineId: 'receiver-machine', installationId: 'installation',
    signal: new AbortController().signal, isCurrent: async () => true, subscribeInvalidation: () => () => {},
    resolveSourceKeyContext: async () => null, isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
  const pending = dispatcher.dispatchReceiverRange({ destinationSessionId, sourceSessionId, observations: phase === 'source_ranges' ? [] : [{
      sourceSessionId, destinationSessionId, relation: 'follower', policy: { preset: 'quiet' },
      delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 6 },
      observed: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 11 },
    }] });
  try {
    await vi.waitFor(() => expect(readingRules).toBe(true));
    const checkpoints = () => log.mock.calls.filter(([message]) => message === '[Session Follow] Dispatch checkpoint')
      .map(([, fields]) => fields);
    expect(checkpoints().at(-1)).toMatchObject({ sourceSessionId, destinationSessionId,
      entry: 'receiver_range', phase, status: 'started' });
    release();
    expect(await pending).toEqual({ receiverSessionIds: [] });
    expect(checkpoints()).toContainEqual(expect.objectContaining({ sourceSessionId, destinationSessionId,
      entry: 'receiver_range', phase, status: 'held',
      reason: phase === 'rules' ? 'private-rules-unavailable' : 'source_ranges_unavailable' }));
    expect(writes).not.toHaveBeenCalled();
    expect(JSON.stringify(checkpoints())).not.toContain(token);
    expect(JSON.stringify(checkpoints())).not.toContain('private-rule-response');
  } finally { release(); await pending; dispatcher.dispose(); }
});

it.each([
  { entry: 'receiver', restriction: 'none' }, { entry: 'source', restriction: 'none' },
  { entry: 'receiver-equal-ordinary', restriction: 'none' },
  { entry: 'overlapping-receiver', restriction: 'none' },
  { entry: 'source', restriction: 'section' }, { entry: 'source', restriction: 'other-home-section' },
  { entry: 'source', restriction: 'section-moved' },
  { entry: 'source', restriction: 'missing-section' }, { entry: 'source', restriction: 'future-core' },
  { entry: 'source', restriction: 'future-extension' },
] as const)('admits only freshly matching rule originals while retaining discovery candidates ($entry, $restriction)', async ({ entry, restriction }) => {
  const log = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  const authoredLocalId = 'private-authored-follow-source-id';
  const sourceSessionId = 'c111111111111111111111111';
  const destinationSessionId = 'c222222222222222222222222';
  const token = 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature';
  const rule = { ruleId: 'new-rule', version: 0, receiver: { kind: 'session' as const, sessionId: destinationSessionId },
    inception: { accountChangeCursor: 5, createdAt: 100 },
    content: { t: 'plain' as const, v: { v: 1 as const, enabled: true, filter: {
      ...normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' }),
      ...(restriction.includes('section') ? { sections: { include: [{ serverId: restriction === 'other-home-section' ? 'other-home' : 'home', sectionId: 'section-a' }], exclude: [] } } : {}),
      ...(restriction === 'future-core' ? { futureCore: { value: 'narrow' } } : {}),
      ...(restriction === 'future-extension' ? { extensions: { 'acme.future': { kind: 'future', value: true } } } : {}),
    },
      policy: { preset: 'important' as const } } } };
  const source = { ...createSessionNotificationContextFixture(sourceSessionId), encryptionMode: 'plain', dataEncryptionKey: null,
    metadata: JSON.stringify({ path: '/work', host: 'host', machineId: 'source-machine' }), ownerAccountId: 'account-1',
    archivedAt: null, active: true, seq: 2, origin: { kind: 'none' as const } };
  const destination = { ...source, id: destinationSessionId, seq: 0 };
  let readable = false;
  let releaseSource!: () => void;
  const sourceGate = new Promise<void>(resolve => { releaseSource = resolve; });
  let readingSource = false;
  let sourceLists = 0;
  const afterSequences: number[] = [];
  const pending: unknown[] = [];
  let placementReads = 0;
  let configurationReads = 0;
  let preferenceReads = 0;
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    if (path.endsWith('/follows/sessions')) { sourceLists++; return { status: 200, data: { sources: [] } }; }
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    if (path === '/v2/session-organization') {
      placementReads++;
      if (restriction === 'missing-section') return { status: 503, data: { error: 'unavailable' } };
      return { status: 200, data: { snapshot: { schemaVersion: 1, version: 1, pins: [], folders: [],
        folderAssignments: [{ sessionId: sourceSessionId,
          folderId: restriction === 'section-moved' && placementReads > 1 ? 'section-b' : 'section-a' }],
        tags: [], tagAssignments: [], orderEntries: [], labels: [] } } };
    }
    if (path === '/v2/sessions' || path === '/v2/sessions/archived') return { status: 200,
      data: { sessions: [], hasNext: false, nextCursor: null } };
    if (path === '/v2/account/session-follow-rules') {
      if (!options?.params?.destinationSessionId) configurationReads++;
      if (entry === 'overlapping-receiver') return { status: 200, data: { rules: [] } };
      const demanded = options?.params?.destinationSessionId;
      return { status: 200, data: { rules: [rule], ...(demanded ? { sourceRanges: { status: 'available', sources: [{
        sourceSessionId, delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 1 }, throughSeq: 2,
      }] } } : {}) } };
    }
    if (path === '/v2/account/session-follow-preferences') {
      preferenceReads++;
      return { status: 200, data: { assigned: false, direct: false, team: false, group: false } };
    }
    if (path === `/v2/sessions/${sourceSessionId}`) {
      // Overlap at required source admission, independent of private-rule demand.
      if (entry === 'overlapping-receiver' && readable) { readingSource = true; await sourceGate; }
      return readable ? { status: 200, data: { session: source } } : { status: 404, data: {} };
    }
    if (path === `/v2/sessions/${destinationSessionId}`) return { status: 200, data: { session: destination } };
    if (path.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
    if (path.includes('/messages')) {
      afterSequences.push(Number(options?.params?.afterSeq ?? parsed.searchParams.get('afterSeq')));
      const original = { id: 'original-2', seq: 2, localId: authoredLocalId, createdAt: 200,
        content: { t: 'plain' as const, v: { role: 'agent', content: { type: 'event', id: 'goal', data: { type: 'goal-changed' } } } } };
      return { status: 200, data: { messages: [original],
        hasMore: false, nextAfterSeq: null } };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v2/sessions/lookup-by-tags') return { status: 200, data: { sessions: [] } };
    if (path.endsWith('/follows/occurrence-routes')) return { status: 200,
      data: { ok: true, v: 1, sourceSessionId, originalCreatedAt: 200, routes: entry === 'overlapping-receiver' ? [{
        sourceSessionId, destinationSessionId, relation: 'follower', policy: { preset: 'important' },
        delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 1 }, observed: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 2 },
      }] : [] } };
    if (path.endsWith('/pending')) { pending.push(body); return { status: 200,
      data: { didWrite: true, message: { localId: 'accepted-original', seq: 1 } } }; }
    throw new Error(`Unexpected POST ${path}`);
  });
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: { token, encryption: null },
    serverId: 'home', serverHttpBaseUrl: 'http://home.test', machineId: entry === 'source' ? 'source-machine' : 'receiver-machine', installationId: 'installation',
    signal: new AbortController().signal, isCurrent: async () => true, subscribeInvalidation: () => () => {},
    resolveSourceKeyContext: async () => null, isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
  try {
    if (entry === 'source') {
      expect(await dispatcher.readReceiverSessionIds()).toEqual([destinationSessionId]);
      configurationReads = 0;
      preferenceReads = 0;
    }
    const dispatch = () => entry !== 'source' ? dispatcher.dispatchReceiverRange({ destinationSessionId,
      observations: entry === 'receiver-equal-ordinary' ? [{ sourceSessionId, destinationSessionId, relation: 'follower',
        policy: { preset: 'important' }, delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 2 },
        observed: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 2 } }] : [] })
      : dispatcher.dispatch(SessionFollowRuleSourceOccurrenceV1Schema.parse({ sourceSessionId,
          sourcePublisher: { machineId: 'source-machine', publisherGeneration: '1', committedFenceMs: 1 },
          sourceMessage: { localId: authoredLocalId, seq: 2 }, evidence: { v: 1, ownerAccountId: 'account-1',
            event: { kind: 'goal_changed' }, facts: { serverId: 'home', kind: 'session', source: 'persisted' } } }));
    await dispatch();
    expect(pending).toEqual([]);
    readable = true;
    if (restriction !== 'none') {
      const discovered = await dispatcher.readReceiverSessionIds(sourceSessionId);
      expect(discovered).toEqual(restriction === 'other-home-section' ? [] : [destinationSessionId]);
      placementReads = 0;
    }
    await (async () => {
      if (entry !== 'overlapping-receiver') return dispatch();
      const observation = { sourceSessionId, destinationSessionId, relation: 'follower' as const, policy: { preset: 'important' as const },
        delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 1 }, observed: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 2 } };
      const listsBefore = sourceLists;
      const latest = dispatcher.dispatchReceiverRange({ destinationSessionId, observations: [observation] });
      await vi.waitFor(() => expect(readingSource).toBe(true));
      const older = dispatcher.dispatchReceiverRange({ destinationSessionId, observations: [{ ...observation,
        observed: { ...observation.observed, transcriptSeq: 1 } }] });
      try { await vi.waitFor(() => expect(sourceLists).toBe(listsBefore + 2)); }
      finally { releaseSource(); }
      return (await Promise.all([latest, older]))[0];
    })();
    if (entry === 'source') expect({ configurationReads, preferenceReads },
      'proved source originals reuse push-owned configuration').toEqual({ configurationReads: 0, preferenceReads: 0 });
    const refuses = ['other-home-section', 'missing-section', 'section-moved', 'future-core', 'future-extension'].includes(restriction);
    if (refuses) {
      expect(pending).toEqual([]);
      expect(placementReads).toBe(restriction === 'section-moved' ? 2 : restriction === 'missing-section' ? 1 : 0);
      return;
    }
    // Source discovery and ordered receiver recovery each prove the current placement.
    expect(placementReads).toBe(restriction === 'section' ? 2 : 0);
    expect(afterSequences).toEqual([1]);
    expect(pending).toHaveLength(1);
    const localInputId = deriveSessionFollowInputLocalIdV1({ destinationSessionId,
      original: { sourceSessionId, sourceMessage: { localId: authoredLocalId, seq: 2 } } });
    expect(pending[0]).toMatchObject({ localId: localInputId, ...(entry === 'overlapping-receiver'
      ? { followRelations: [{ relation: 'follower' }] }
      : { followSources: [{ sourceMessage: { localId: authoredLocalId, seq: 2 }, ...(entry === 'source'
        ? { expectedSourcePublisherGeneration: '1', machineId: 'source-machine', installationId: 'installation' }
        : { evaluation: 'receiver' }) }] }) });
    const admissionLogs = log.mock.calls.filter(([message]) => message === '[Session Follow] Original admission completed');
    expect(admissionLogs).toHaveLength(1);
    expect(JSON.stringify(admissionLogs)).not.toContain(authoredLocalId);
    expect(admissionLogs).toEqual([[expect.any(String), expect.objectContaining({
      sourceSessionId, destinationSessionId, sourceMessageSeq: 2, ok: true, localInputId,
    })]]);
  } finally { releaseSource(); dispatcher.dispose(); }
});

it.each([
  ['completed', true, 'plain'], ['failed', true, 'plain'], ['completed', false, 'plain'], ['failed', false, 'plain'],
  ['completed', true, 'e2ee'], ['failed', true, 'e2ee'],
] as const)('shares the %s Turn receipt with personal progress, or defers without it (%s, %s)', async (status, hasReceipt, mode) => {
  await withConfiguredDaemonTestHome({ prefix: 'happier-au1-personal-terminal-' }, async () => {
  const sourceSessionId = 'c333333333333333333333333';
  const material = mode === 'e2ee' ? { type: 'legacy' as const, secret: new Uint8Array(32).fill(19) } : null;
  const credentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: material };
  const home = 'https://personal-terminal.test';
  const homeId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
  await seedTestServerProfile({ id: 'home', homeId, serverUrl: home });
  const keySnapshot = createAutomationAccountEncryptionMaterialSnapshotV1(credentials);
  const receiver = { kind: 'account' as const };
  const definition = { v: 1 as const, enabled: true,
    filter: normalizeSessionListFilterV1({ homeServerIds: [homeId], scope: 'all_accessible',
      tagIds: [{ serverId: homeId, tagId: 'source-tag' }] }), policy: { preset: 'everything' as const } };
  const rule = { ruleId: 'personal-rule', version: 0, receiver: { kind: 'account' as const },
    inception: { createdAt: 100 }, content: sealSessionFollowRuleContentV1({ ruleId: 'personal-rule', receiver, definition, mode, material }) };
  const stored = (value: unknown) => material ? encodeBase64(encryptLegacy(value, material.secret)) : JSON.stringify(value);
  const source = { ...createSessionNotificationContextFixture(sourceSessionId), encryptionMode: mode, dataEncryptionKey: null,
    metadata: stored({ path: '/work', host: 'host', machineId: 'source-machine' }), ownerAccountId: 'account-1',
    archivedAt: null, active: true, seq: 0, latestTurnId: 'host-turn', latestTurnStatus: status, origin: { kind: 'none' as const } };
  const settings = notificationSettingsFixture({});
  const snapshot = { source: 'network' as const, settings, rawSettings: {}, ...notificationCatalogFixture(settings),
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
    scopeKey: runWithServerHttpBaseUrl(home, () => resolveAccountSettingsScopeKey(credentials)) };
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot, serverHttpBaseUrl: home, isCurrent: async () => true });
  let represented = false;
  const sent: unknown[] = [];
  const settlements: SessionFollowPersonalProgressRequestV1[] = [];
  const terminalSourceMessage = { localId: 'native-terminal', seq: 9 };
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode,
      contentKeyFingerprint: keySnapshot ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        keySnapshot.contentPublicKeyFingerprint) : null }) };
    if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: [rule] } };
    if (path === '/v2/account/session-follow-preferences') return { status: 200, data: { assigned: false, direct: false, team: false, group: false } };
    if (path === `/v2/sessions/${sourceSessionId}`) return { status: 200, data: { session: source } };
    if (path === '/v2/session-organization') return { status: 200, data: { snapshot: { schemaVersion: 1, version: 1,
      pins: [], folders: [], folderAssignments: [], tags: [],
      tagAssignments: [{ sessionId: sourceSessionId, tagIds: ['source-tag'] }], orderEntries: [], labels: [] } } };
    if (path.endsWith('/messages')) return { status: 200, data: { messages: [{ id: 'terminal-row', ...terminalSourceMessage,
      createdAt: 200, updatedAt: 200, messageRole: 'agent', sidechainId: null, content: material ? { t: 'encrypted', c: stored({
        role: 'agent', meta: { runtimeTurnId: 'host-turn' }, content: status === 'completed'
          ? { type: 'event', id: 'native-ready', data: { type: 'ready', completedTurnId: 'host-turn' } }
          : { type: 'codex', data: { type: 'turn_failed', id: 'provider-turn' } },
      }) } : { t: 'plain', v: {
        role: 'agent', meta: { runtimeTurnId: 'host-turn' }, content: status === 'completed'
          ? { type: 'event', id: 'native-ready', data: { type: 'ready', completedTurnId: 'host-turn' } }
          : { type: 'codex', data: { type: 'turn_failed', id: 'provider-turn' } },
      } } }], hasMore: false } };
    if (path === '/v2/account/session-delivery-mutes') return { status: 200, data: { scopes: [] } };
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/follows/occurrence-routes')) return { status: 200, data: { ok: true, v: 1, sourceSessionId,
      originalCreatedAt: 200, routes: [], currentAccountFacts: { defaultRelationships: { assigned: false, direct: false, team: false, group: false },
        personalFollowSuppressed: false, hasPersistentFollow: false } } };
    if (path.endsWith('/personal-progress')) {
      settlements.push(SessionFollowPersonalProgressRequestV1Schema.parse(body));
      const alreadyRepresented = represented; represented = true;
      return { status: 200, data: { accepted: true, alreadyRepresented } };
    }
    throw new Error(`Unexpected POST ${path}`);
  });
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials, serverId: 'home', serverHttpBaseUrl: home,
    machineId: 'source-machine', installationId: 'installation', signal: new AbortController().signal,
    isCurrent: async () => true, subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null,
    isPersonalCurrent: () => operationContext.isCurrent(), dispatchPersonal: (dispatch, isCurrent) => createPersonalFollowOccurrenceDispatcher({
      operationContext, isCurrent, pluginNotifications: null, fetchSessionNotificationContext: async () => source,
      readAccountSessionDeliveryMutedScopes: async () => [], expoPushSender: { sendToAllDevicesAsync: async (...args) => {
        expect(represented).toBe(true); sent.push(args); return true;
      } },
    })(dispatch) });
  const occurrence = SessionFollowRuleSourceOccurrenceV1Schema.parse({ sourceSessionId,
    sourcePublisher: { machineId: 'source-machine', publisherGeneration: '1', committedFenceMs: 1 },
    ...(hasReceipt ? { sourceMessage: terminalSourceMessage } : { sourceTurn: { id: 'host-turn', status } }),
    evidence: { v: 1, ownerAccountId: 'account-1', event: { kind: status === 'completed' ? 'finished' : 'failed_or_stopped' },
      facts: { serverId: 'home', kind: 'session' } } });
  try {
    await dispatcher.dispatch(occurrence);
    await dispatcher.dispatch(occurrence);
    expect(sent).toHaveLength(hasReceipt ? 1 : 0);
    expect(settlements).toHaveLength(hasReceipt ? 2 : 0);
    if (hasReceipt) expect(settlements[0]).toMatchObject({ sourceTurn: { id: 'host-turn', status }, terminalSourceMessage,
      rules: [{ ruleId: 'personal-rule', ruleVersion: 0 }] });
  } finally { dispatcher.dispose(); }
  });
});

it.each(['complete', 'unavailable-route', 'unavailable-mute', 'optout-before-dispatch', 'unavailable-personal-scope'] as const)(
  'settles one complete current personal request map and keeps native policy return independent (%s)', async availability => {
    const sourceSessionId = 'c333333333333333333333333';
    const token = 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature';
    const credentials = { token, encryption: null };
    const serverHttpBaseUrl = 'http://personal-request-group.test';
    const rule = { ruleId: 'personal-rule', version: 0, receiver: { kind: 'account' as const },
      inception: { accountChangeCursor: 5, createdAt: 100 }, content: { t: 'plain' as const,
        v: { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' }),
          policy: { preset: 'important' as const } } } };
    const source = { ...createSessionNotificationContextFixture(sourceSessionId), encryptionMode: 'plain', dataEncryptionKey: null,
      metadata: JSON.stringify({ path: '/work', host: 'host', machineId: 'source-machine' }), ownerAccountId: 'account-1',
      archivedAt: null, active: true, seq: 0, agentStateVersion: 1, origin: { kind: 'none' as const } };
    const requests = [{ requestId: 'A', createdAt: availability === 'complete' || availability === 'optout-before-dispatch' ? 90 : 200 },
      { requestId: 'B', createdAt: 300 }];
    const evidence = { v: 1, ownerAccountId: 'account-1', event: { kind: 'needs_you', type: 'decision' },
      facts: { serverId: 'home', kind: 'session', startedBy: 'you' } };
    const occurrence = SessionFollowRuleSourceOccurrenceV1Schema.parse({ sourceSessionId,
      sourcePublisher: { machineId: 'source-machine', publisherGeneration: '1', committedFenceMs: 1 },
      sourceRequests: { agentStateVersion: 1, requests }, requestEvidence: requests.map(request => ({ requestId: request.requestId, evidence })) });
    const settings = accountSettingsParse({});
    const snapshot = { source: 'network' as const, settings, rawSettings: {}, ...notificationCatalogFixture(settings),
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(credentials)) };
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot, serverHttpBaseUrl,
      isCurrent: async () => true });
    const settlements: SessionFollowPersonalProgressRequestV1[] = [];
    let observedRequestId: string | undefined;
    let secondRequestRouteReads = 0;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: [rule] } };
      if (path === '/v2/account/session-follow-preferences') return { status: 200,
        data: { assigned: false, direct: false, team: false, group: false } };
      if (path === `/v2/sessions/${sourceSessionId}`) return { status: 200, data: { session: source } };
      if (path === '/v2/account/session-delivery-mutes') return availability === 'unavailable-mute' && observedRequestId === 'B'
        ? { status: 409, data: { error: 'mute_state_unavailable' } } : { status: 200, data: { scopes: [] } };
      throw new Error(`Unexpected GET ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/follows/occurrence-routes')) {
        const original = SessionFollowRuleSourceOccurrenceV1Schema.parse({ ...occurrence,
          ...(typeof body === 'object' && body !== null && 'sourceRequests' in body ? { sourceRequests: body.sourceRequests } : {}) });
        observedRequestId = 'sourceRequests' in original ? original.sourceRequests.requests[0]?.requestId : undefined;
        const request = requests.find(item => item.requestId === observedRequestId)!;
        if (request.requestId === 'B') secondRequestRouteReads++;
        return availability === 'unavailable-route' && request.requestId === 'B' ? { status: 503, data: {} }
          : { status: 200, data: { ok: true, v: 1, sourceSessionId, originalCreatedAt: request.createdAt, routes: [],
              currentAccountFacts: { defaultRelationships: { assigned: false, direct: false, team: false, group: false }, hasPersistentFollow: false,
                personalFollowSuppressed: availability === 'optout-before-dispatch' && request.requestId === 'B' && secondRequestRouteReads > 1 } } };
      }
      if (path.endsWith('/personal-progress')) {
        settlements.push(SessionFollowPersonalProgressRequestV1Schema.parse(body));
        return { status: 200, data: { accepted: true, alreadyRepresented: false } };
      }
      throw new Error(`Unexpected POST ${path}`);
    });
    const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials,
      serverId: 'home', serverHttpBaseUrl, machineId: 'source-machine', installationId: 'installation',
      signal: new AbortController().signal, isCurrent: async () => true, subscribeInvalidation: () => () => {},
      resolveSourceKeyContext: async () => null, isPersonalCurrent: () => availability !== 'unavailable-personal-scope' && operationContext.isCurrent(),
      dispatchPersonal: (dispatch, isCurrent) => createPersonalFollowOccurrenceDispatcher({
        operationContext, isCurrent: () => isCurrent(),
      })(dispatch) });
    try {
      if (availability === 'optout-before-dispatch') {
        await expect(dispatcher.dispatch(occurrence)).rejects.toThrow('personal_follow_scope_retired');
        expect(settlements).toEqual([]);
        return;
      }
      const result = await dispatcher.dispatch(occurrence);
      if (availability === 'unavailable-personal-scope') {
        expect(result).toEqual({});
        expect(settlements).toEqual([]);
        return;
      }
      const eligibleRequestId = availability === 'complete' ? 'B' : 'A';
      expect(result).toMatchObject({ personalFollow: { sourceSessionId, requests: [{ requestId: eligibleRequestId,
        policies: [{ preset: 'important' }] }] } });
      if (availability === 'complete') {
        expect(result).toMatchObject({ personalFollow: { accepted: true } });
        expect(settlements).toEqual([{ sourceSessionId, expectedSourcePublisherGeneration: '1', machineId: 'source-machine',
          installationId: 'installation', sourceRequests: { agentStateVersion: 1, requests },
          rules: [{ ruleId: rule.ruleId, ruleVersion: rule.version, requestIds: ['B'] }] }]);
      } else {
        expect(result && result.personalFollow).not.toHaveProperty('accepted');
        expect(settlements).toEqual([]);
      }
    } finally { dispatcher.dispose(); }
  },
);
