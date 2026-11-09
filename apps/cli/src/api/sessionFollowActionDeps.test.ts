import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import {
  API_TOKEN_FULL_GRANT_V1,
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  verifyExternalActionMachineRequestV1,
  type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionFollowActionDeps, createSessionTrackedTargetCompatibilityDep } from './sessionFollowActionDeps';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { openSessionFollowRuleContentV1, sealSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import { SetSessionFollowRuleRequestV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { SESSION_FOLLOW_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/api';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { FollowListActionOutputV1Schema } from '@happier-dev/protocol/sessions/follow/actions';
import { evaluateSessionFollowRuleOccurrenceV1, type SessionFollowRuleSourceOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { NotificationChannelRecordV1Schema, sealNotificationChannelCatalogContentV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createPersonalFollowOccurrenceDispatcher } from '@/notifications/activity/dispatchPersonalFollowOccurrence';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';

describe('released tracked-target compatibility', () => {
  it('qualifies bare ids to the fixed Home and preserves notification preferences', async () => {
    const replaceSessionVoiceInclusions = vi.fn(async () => ({ ok: true as const, sessionIds: ['session-1'] }));
    const dep = createSessionTrackedTargetCompatibilityDep({ serverId: 'home-a', replaceSessionVoiceInclusions });

    await expect(dep.sessionTargetTrackedSet!({
      sessionIds: ['session-1'],
      context: {},
    })).resolves.toMatchObject({
      ok: true,
      sessionAddresses: [{ serverId: 'home-a', sessionId: 'session-1' }],
    });
    expect(replaceSessionVoiceInclusions).toHaveBeenCalledWith(expect.objectContaining({ sessionIds: ['session-1'] }));
  });

  it('fails an exact-address request for another Home before a Follow read', async () => {
    const replaceSessionVoiceInclusions = vi.fn();
    const dep = createSessionTrackedTargetCompatibilityDep({ serverId: 'home-a', replaceSessionVoiceInclusions });
    await expect(dep.sessionTargetTrackedSet!({
      sessionAddresses: [{ serverId: 'home-b', sessionId: 'session-1' }],
      context: {},
    })).resolves.toMatchObject({ ok: false, status: 'unavailable' });
    expect(replaceSessionVoiceInclusions).not.toHaveBeenCalled();
  });

  it('replaces with an empty set after the compatibility adapter is recreated', async () => {
    type ReplaceSessionVoiceInclusionsRequest = Parameters<
      Parameters<typeof createSessionTrackedTargetCompatibilityDep>[0]['replaceSessionVoiceInclusions']
    >[0];
    const requests: ReplaceSessionVoiceInclusionsRequest[] = [];
    const replaceSessionVoiceInclusions = async (request: ReplaceSessionVoiceInclusionsRequest) => {
      requests.push(request);
      return { ok: true as const, sessionIds: [...request.sessionIds] };
    };
    const first = createSessionTrackedTargetCompatibilityDep({ serverId: 'home-a', replaceSessionVoiceInclusions });
    await first.sessionTargetTrackedSet!({ sessionIds: ['session-1'], context: {} });
    const recreated = createSessionTrackedTargetCompatibilityDep({ serverId: 'home-a', replaceSessionVoiceInclusions });
    await recreated.sessionTargetTrackedSet!({ sessionIds: [], context: {} });
    expect(requests.map((request) => request.sessionIds)).toEqual([
      ['session-1'],
      [],
    ]);
  });
});

describe('Follow HTTP family adapter', () => {
  let app = fastify();
  let restore = () => {};
  beforeEach(() => { app = fastify(); restore = installAxiosFastifyAdapter({ app, origin: 'http://follow.test' }); });
  afterEach(async () => { restore(); await app.close(); });
  it('reads only the selected Follow kind without acquiring unrelated private rules', async () => {
    const requests: string[] = [];
    app.addHook('onRequest', async request => { requests.push(request.url); });
    app.get('/v2/account/session-follows', async request => {
      expect(request.query).toEqual({ sourceKinds: '["execution_run","workflow_run"]' });
      return { follows: [] };
    });
    const deps = createSessionFollowActionDeps({ token: 'account-token', serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.sessionFollowAction!({ context: {}, actionId: 'follow.list', input: {
      direction: 'following', receiver: { kind: 'account' }, sourceKinds: ['execution_run', 'workflow_run'],
    } })).resolves.toEqual({ follows: [], sources: [], rules: [], coverage: 'complete' });
    expect(requests).toEqual(['/v2/account/session-follows?sourceKinds=%5B%22execution_run%22%2C%22workflow_run%22%5D']);
  });
  const createRuleAuthorityFixture = async () => {
    // This composed slice uses real HTTP and the existing real Socket.IO harness.
    restore();
    const channel = await createRequesterCurrentnessSocketHarness();
    const accountId = 'follow-authority-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const encryption = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
    const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
      createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: encryption }).contentPublicKeyFingerprint);
    const receiver = { kind: 'account' as const };
    const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: ['private-home'] }),
      policy: { preset: 'quiet' as const } };
    const rule = { ruleId: 'admitted-rule', receiver, version: 1, inception: { createdAt: 7, accountChangeCursor: 4 }, sources: [],
      content: sealSessionFollowRuleContentV1({ ruleId: 'admitted-rule', receiver, definition, mode: 'e2ee', material: encryption }) };
    let mode: 'plain' | 'e2ee' = 'e2ee';
    let revoked = false;
    let reads = 0;
    let holdRules = false;
    let ruleRequested!: () => void;
    let releaseRules!: () => void;
    const requested = new Promise<void>(resolve => { ruleRequested = resolve; });
    const released = new Promise<void>(resolve => { releaseRules = resolve; });
    app.get('/v1/account/encryption/currentness', async (_request, reply) => {
      reads++;
      return revoked ? reply.code(401).send({ error: 'unauthorized' }) : createAccountEncryptionCurrentnessFixture({
        mode, contentKeyFingerprint: mode === 'e2ee' ? fingerprint : null,
      });
    });
    app.get('/v2/account/session-follow-rules', async () => {
      if (holdRules) { ruleRequested(); await released; }
      return { rules: [rule] };
    });
    app.put('/v2/account/session-follow-rules/:ruleId', async request => {
      const body = SetSessionFollowRuleRequestV1Schema.parse(request.body);
      expect(body.content.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
      return { rule: { ruleId: 'authored-rule', receiver: body.receiver, content: body.content, version: body.expectedVersion + 1 } };
    });
    const serverHttpBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const holder = acquireRequesterAccountEncryptionCurrentness({ accountId, token, serverBaseUrl: serverHttpBaseUrl });
    const deps = createSessionFollowActionDeps({ token, credentials: { token, encryption }, serverId: 'home', serverHttpBaseUrl });
    return {
      channel, requested, releaseRules, receiver, definition, deps,
      warm: () => holder.read(),
      read: () => deps.readSessionFollowRules!({ context: {}, serverId: 'home' }),
      reads: () => reads,
      hold: () => { holdRules = true; },
      change(change: 'mode' | 'epoch') { if (change === 'epoch') revoked = true; else mode = 'plain'; },
      async close() { releaseRules(); await holder.dispose(); await channel.close(); },
    };
  };
  it('borrows warm Follow rule identity while freshly admitting each opened census', async () => {
    const f = await createRuleAuthorityFixture();
    try {
      await f.warm();
      for (let read = 0; read < 2; read++) await expect(f.read()).resolves.toMatchObject({ kind: 'complete',
        rules: [{ ruleId: 'admitted-rule', definition: f.definition }] });
      expect(f.reads()).toBe(3);
    } finally { await f.close(); }
  });
  it.each([
    ['mode', false], ['epoch', false], ['mode', true], ['epoch', true],
  ] as const)('withholds Follow rules after committed %s before socket delivery (gap=%s)', async (change, gap) => {
    const f = await createRuleAuthorityFixture();
    try {
      await f.warm();
      f.hold();
      const read = f.read();
      await f.requested;
      f.change(change);
      if (gap) await f.channel.disconnect();
      else expect(f.channel.clients.every(client => client.connected)).toBe(true);
      f.releaseRules();
      await expect(read).resolves.toEqual({ kind: 'unavailable' });
    } finally { await f.close(); }
  });
  it('freshly admits Follow rule sealing after a mode change before socket delivery', async () => {
    const f = await createRuleAuthorityFixture();
    try {
      await f.warm();
      f.change('mode');
      await expect(f.deps.sessionFollowAction!({ context: {}, actionId: 'follow.set', serverId: 'home', input: {
        receiver: f.receiver, source: { kind: 'rule', ruleId: 'authored-rule' }, expectedVersion: -1,
        ruleDefinition: { v: 1, enabled: true, filter: f.definition.filter }, policy: f.definition.policy,
      } })).resolves.toMatchObject({ rule: { ruleId: 'authored-rule', definition: f.definition } });
      expect(f.reads()).toBe(2);
    } finally { await f.close(); }
  });
  it('qualifies portable tracked-target reads through the saved profile Home', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'tracked-portable-home-' }, async () => {
      const profileId = 'stack_agent-qa-coord-n1__id_default';
      const homeId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
      const serverUrl = 'https://follow.test';
      restore();
      restore = installAxiosFastifyAdapter({ app, origin: serverUrl });
      await seedTestServerProfile({ id: profileId, homeId, serverUrl });
      app.put(SESSION_FOLLOW_HTTP_PATHS_V1.voiceInclusions, async () => ({ changed: true, sessionIds: ['source'] }));
      const follow = createSessionFollowActionDeps({ token: 'account-token', serverId: profileId, serverHttpBaseUrl: serverUrl });
      const tracked = createSessionTrackedTargetCompatibilityDep({ serverId: profileId,
        replaceSessionVoiceInclusions: follow.replaceSessionVoiceInclusions });
      await expect(tracked.sessionTargetTrackedSet!({ context: {}, sessionAddresses: [{ serverId: homeId, sessionId: 'source' }] }))
        .resolves.toMatchObject({ ok: true, sessionAddresses: [{ serverId: homeId, sessionId: 'source' }] });
    });
  });
  it.each([
    { operation: 'read', root: 'session.status.get' },
    { operation: 'read', root: 'session.targets.resolve' },
    { operation: 'write', root: 'session.status.get' },
  ] as const)('keeps nested Follow $operation authorization bound to its declared effect ($root)', async ({ operation, root }) => {
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'session' as const, sessionId: 'source' };
    const authorization: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'execution-proof', binding: {
      serverIdentityId: 'home', accountId: 'account-1', custodianAccountId: 'account-1', installationId: 'installation-1',
      principalId: 'principal-1', credentialId: 'credential-1', grant: API_TOKEN_FULL_GRANT_V1,
      machineId: 'machine-1', actionId: root, requestId: 'request-1', requestEnvelopeDigest: 'd'.repeat(43), target,
    } };
    let effect: unknown;
    app.get('/v2/sessions/:sourceSessionId/follows/followers', async request => {
      effect = request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER];
      expect(request.headers.authorization).toBeUndefined();
      return { follows: [], sources: [], rules: [], coverage: 'complete', peopleCount: 0 };
    });
    app.put('/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId', async request => {
      effect = request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER];
      return { changed: true, source: { sourceSessionId: 'source', destinationSessionId: 'receiver',
        policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false } };
    });
    const deps = createSessionFollowActionDeps({ token: 'daemon-token', serverId: 'home', serverIdentityId: 'home',
      serverHttpBaseUrl: 'http://follow.test', externalActionMachineRequestPrivateKey: keyPair.secretKey,
      externalActionMachineInstallationId: 'installation-1' });
    const context = { externalActionExecutionAuthorization: authorization, externalActionTarget: target };
    if (operation === 'read') await deps.sessionFollowAction!({ context, actionId: 'follow.list', serverId: 'home',
      input: { direction: 'followers', source: { kind: 'session', sessionId: 'source' } } });
    else await deps.sessionFollowAction!({ context, actionId: 'follow.set', serverId: 'home', input: {
      source: { kind: 'session', sessionId: 'source' }, receiver: { kind: 'session', sessionId: 'receiver' }, policy: { preset: 'quiet' },
    } });
    expect(effect).toBe(operation === 'read' ? root : 'follow.set');
  });
  it('preserves source continuation and emits private rules once across following pages', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'page-account' })).toString('base64url')}.signature`;
    const receiver = { kind: 'account' as const };
    const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'quiet' as const } };
    const rule = { ruleId: 'rule', receiver, version: 0, content: { t: 'plain' as const, v: definition } };
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain', contentKeyFingerprint: null }));
    app.get('/v2/account/session-follow-rules', async () => ({ rules: [rule] }));
    app.get('/v2/account/session-follows', async request => {
      const query = request.query as { cursor?: string; limit?: string };
      expect(query.limit).toBe('1');
      return query.cursor ? { follows: [] } : { follows: [], continuation: 'next-source-page' };
    });
    const deps = createSessionFollowActionDeps({ token, credentials: { token, encryption: null },
      serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    const first = await deps.sessionFollowAction!({ context: {}, actionId: 'follow.list',
      input: { direction: 'following', receiver, limit: 1 } });
    expect(first).toMatchObject({ rules: [{ ruleId: 'rule', definition }], coverage: 'partial', continuation: 'next-source-page' });
    const second = await deps.sessionFollowAction!({ context: {}, actionId: 'follow.list',
      input: { direction: 'following', receiver, limit: 1, cursor: 'next-source-page' } });
    expect(second).toEqual({ follows: [], sources: [], rules: [], coverage: 'complete' });
  });
  it.each(['plain', 'e2ee'] as const)('reads the complete own-Account %s rule census without dropping route facts', async mode => {
    const encryption = mode === 'e2ee' ? { type: 'legacy' as const, secret: new Uint8Array(32).fill(29) } : null;
    const snapshot = encryption && createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: encryption });
    const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'quiet' as const } };
    const rules = [{ ruleId: 'personal', receiver: { kind: 'account' as const }, version: 0 },
      { ruleId: 'session-a', receiver: { kind: 'session' as const, sessionId: 'receiver-a' }, version: 1 },
      { ruleId: 'session-b', receiver: { kind: 'session' as const, sessionId: 'receiver-b' }, version: 2 }]
      .map(rule => ({ ...rule, inception: { createdAt: 7, accountChangeCursor: 4 }, sources: [] }));
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode,
      contentKeyFingerprint: snapshot ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint) : null }));
    app.get('/v2/account/session-follow-rules', async () => ({ rules: rules.map(rule => ({ ...rule,
      content: sealSessionFollowRuleContentV1({ ...rule, definition, mode, material: encryption }) })) }));
    const deps = createSessionFollowActionDeps({ token: 'token', credentials: { token: 'token', encryption },
      serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.readSessionFollowRules!({ context: {}, serverId: 'home' }))
      .resolves.toEqual({ kind: 'complete', rules: rules.map(rule => ({ ...rule, definition })) });
  });
  it.each(['mode', 'census'] as const)('withholds the entire rule census when the captured Account retires during %s', async stage => {
    let current = true;
    let censusReads = 0;
    app.get('/v1/account/encryption/currentness', async () => {
      if (stage === 'mode') current = false;
      return createAccountEncryptionCurrentnessFixture();
    });
    app.get('/v2/account/session-follow-rules', async () => {
      censusReads++;
      if (stage === 'census') current = false;
      return { rules: [] };
    });
    const deps = createSessionFollowActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      isCredentialCurrent: () => current, serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.readSessionFollowRules!({ context: {}, serverId: 'home' })).resolves.toEqual({ kind: 'unavailable' });
    expect(censusReads).toBe(stage === 'mode' ? 0 : 1);
  });
  it.each(['home', 'credentials', 'requester', 'account'] as const)('refuses the private rule census before HTTP for a mismatched %s', async mismatch => {
    let reads = 0;
    app.setNotFoundHandler(async (_request, reply) => { reads++; return reply.code(404).send({}); });
    const deps = createSessionFollowActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    const missingCredentials = createSessionFollowActionDeps({ token: 'token', serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect((mismatch === 'credentials' ? missingCredentials : deps).readSessionFollowRules!({
      context: mismatch === 'requester' ? { externalActionCredential: { accountId: 'requester', principalId: 'principal',
        credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 } } : mismatch === 'account' ? { runtimeAccountId: 'other' } : {},
      serverId: mismatch === 'home' ? 'other' : 'home',
    })).resolves.toEqual({ kind: 'unavailable' });
    expect(reads).toBe(0);
  });
  it.each(['mode', 'refusal'] as const)('does not turn an unreadable private rule census into a partial set (%s)', async failure => {
    const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'quiet' as const } };
    const rule = { ruleId: 'bad', receiver: { kind: 'account' as const }, version: 1 };
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture());
    app.get('/v2/account/session-follow-rules', async (_request, reply) => failure === 'refusal'
      ? reply.code(403).send({ error: 'credential_scope_denied' }) : { rules: [
        { ...rule, ruleId: 'good', content: { t: 'plain', v: definition } },
        { ...rule, content: sealSessionFollowRuleContentV1({ ...rule, definition, mode: 'e2ee',
          material: { type: 'legacy', secret: new Uint8Array(32).fill(23) } }) },
      ] });
    const deps = createSessionFollowActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.readSessionFollowRules!({ context: {}, serverId: 'home' })).resolves.toEqual({ kind: 'unavailable' });
  });
  it('reports the Home effective Voice set instead of claiming every requested inclusion', async () => {
    app.put(SESSION_FOLLOW_HTTP_PATHS_V1.voiceInclusions, async () => ({ changed: true, sessionIds: [] }));
    const deps = createSessionFollowActionDeps({ token: 'account-token', serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    const tracked = createSessionTrackedTargetCompatibilityDep({ serverId: 'home', replaceSessionVoiceInclusions: deps.replaceSessionVoiceInclusions });
    expect(await tracked.sessionTargetTrackedSet!({ sessionIds: ['policy-off-source'], context: {} }))
      .toMatchObject({ ok: true, sessionIds: [], sessionAddresses: [] });
  });
  it('reads the strict source-bound reverse census through the public HTTP adapter', async () => {
    const payload = { follows: [], sources: [{ sourceSessionId: 'source', destinationSessionId: 'receiver', relation: 'follower',
      policy: { preset: 'important' }, deliveryState: 'eligible', hasPendingUpdates: false }], rules: [], coverage: 'complete', peopleCount: 2 };
    let denied = false;
    app.get('/v2/sessions/:sourceSessionId/follows/followers', async (_request, reply) =>
      denied ? reply.code(404).send({ error: 'session_not_found' }) : payload);
    const deps = createSessionFollowActionDeps({ token: 'account-token', serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    const request = { context: {}, actionId: 'follow.list' as const,
      input: { direction: 'followers' as const, source: { kind: 'session' as const, sessionId: 'source' } } };
    expect(await deps.sessionFollowAction!(request)).toEqual(payload);
    denied = true;
    expect(await deps.sessionFollowAction!(request)).toEqual({ ok: false, errorCode: 'session_not_found', error: 'session_not_found' });
  });
  it.each(['plain', 'e2ee'] as const)('opens private %s settings and rules into actual personal notification acceptance without a UI', async mode => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'personal-account' })).toString('base64url')}.signature`;
    const encryption = mode === 'e2ee' ? { type: 'legacy' as const, secret: new Uint8Array(32).fill(19) } : null;
    const credentials = { token, encryption };
    const material = encryption && createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: encryption });
    const policy = { preset: 'custom' as const, events: { goal_changed: { delivery: 'interrupt' as const } } };
    const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: ['home'],
      projects: { include: [{ serverId: 'home', projectKey: 'payments' }], exclude: [] } }), policy };
    const rule = { ruleId: 'personal-rule', receiver: { kind: 'account' as const }, version: 1,
      content: sealSessionFollowRuleContentV1({ ruleId: 'personal-rule', receiver: { kind: 'account' },
        definition, mode, material: encryption }) };
    const oppositeContent = sealSessionFollowRuleContentV1({ ruleId: rule.ruleId, receiver: rule.receiver, definition,
      mode: mode === 'plain' ? 'e2ee' : 'plain', material: mode === 'e2ee' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(20) } });
    let current = true;
    let wrongMode = false;
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode,
      contentKeyFingerprint: material ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) : null }));
    app.get('/v2/account/settings', async () => ({ version: 3, content: encryption
      ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material: encryption, payload: {}, randomBytes }) }
      : { t: 'plain', v: {} } }));
    app.get('/v2/account/session-follows', async () => ({ follows: [] }));
    app.get('/v2/account/session-delivery-mutes', async () => ({ scopes: [] }));
    app.get('/v2/account/settings/history', async () => ({ snapshots: [] }));
    app.get('/v1/account/saved-secrets/resources/materials', async () => ({ resources: [] }));
    app.setNotFoundHandler((request, reply) => {
      const empty = emptyAccountSettingsHistoryCaptureResponse(new URL(request.url, 'http://follow.test').pathname);
      return empty ? reply.code(empty.status).send(empty.data) : reply.code(404).send({ error: 'unexpected_test_boundary' });
    });
    app.get('/v2/account/session-follow-rules', async () => ({ rules: [wrongMode
      ? { ...rule, content: oppositeContent } : rule] }));
    const channelContent = sealNotificationChannelCatalogContentV1({ mode, material: encryption,
      record: { v: 1, channels: [NotificationChannelRecordV1Schema.parse({ v: 1, id: 'personal-push', kind: 'expo_push', topics: {} })] } });
    app.get('/v1/account/entity-rows/notification-channels', async () => ({ status: 'present', revision: 1, content: channelContent }));
    const source = createSessionNotificationContextFixture('personal-source');
    app.get('/v2/sessions/:id', async () => ({ session: source }));
    const snapshot = await runWithServerHttpBaseUrl('http://follow.test', () => bootstrapAccountSettingsContext({ credentials,
      expectedAccountEncryptionMode: mode, publication: 'invocation', mode: 'blocking', refresh: 'force', honorAccountSettingsModeEnv: false,
      deps: { readCache: async () => null, writeCache: async () => {}, applySideEffects: () => {} },
    }));
    const operationContext = runWithServerHttpBaseUrl('http://follow.test', () => createInvocationSavedSecretOperationContextV1({
      credentials, snapshot, serverHttpBaseUrl: 'http://follow.test', isCurrent: async () => current,
    }));
    const deps = createSessionFollowActionDeps({ token, credentials, serverId: 'home', serverHttpBaseUrl: 'http://follow.test',
      isCredentialCurrent: () => current });
    const readRules = async () => FollowListActionOutputV1Schema.parse(await deps.sessionFollowAction!({ context: {},
      actionId: 'follow.list', input: { direction: 'following', receiver: { kind: 'account' } } })).rules;
    const rules = await readRules();
    const evidence = { v: 1 as const, ownerAccountId: 'personal-account', event: { kind: 'goal_changed' as const },
      facts: { serverId: 'home', kind: 'session' as const } };
    const evaluation = evaluateSessionFollowRuleOccurrenceV1({ accountId: 'personal-account', evaluator: 'source', production: 'source',
      sourceSessionId: source.id, evidence, currentFacts: { serverId: 'home', kind: 'session', startedBy: 'you',
        scopeMatches: { my_work: true }, projectKey: 'payments' }, rules: rules ?? [] });
    if (evaluation.status !== 'evaluated') throw new Error('Source must own its own-Account evaluation');
    const route = evaluation.routes.find(item => item.receiver.kind === 'account');
    expect(route).toBeDefined();
    const occurrence: SessionFollowRuleSourceOccurrenceV1 = { sourceSessionId: source.id,
      sourcePublisher: { machineId: 'source-machine', committedFenceMs: 1, publisherGeneration: '1' },
      sourceMessage: { localId: 'goal-original', seq: 8 }, evidence };
    const sends: unknown[][] = [];
    let acceptPush = true;
    const dispatch = createPersonalFollowOccurrenceDispatcher({ operationContext, isCurrent: async () => current, pluginNotifications: null,
      expoPushSender: { sendToAllDevicesAsync: async (...args: unknown[]) => { sends.push(args); return acceptPush; } } });
    const input = { sourceSessionId: source.id, occurrence, policies: route!.policies, signal: new AbortController().signal };
    await expect(dispatch(input)).resolves.toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
    expect(sends[0]?.[2]).toMatchObject({ sessionId: source.id, activityEventLocalId: 'goal-original' });
    acceptPush = false;
    await expect(dispatch(input)).resolves.toEqual({ attemptedChannels: 1, deliveredChannels: 0 });
    wrongMode = true;
    await expect(readRules()).rejects.toThrow('account-mode-mismatch');
    current = false;
    await expect(dispatch(input)).rejects.toThrow('personal_follow_scope_retired');
    expect(sends).toHaveLength(2);
  });
  it.each(['plain', 'e2ee'] as const)('seals authored rule Actions at the captured %s Account boundary and opens the correlated result', async mode => {
    const encryption = mode === 'e2ee' ? { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } : null;
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`;
    const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: ['home'] }) };
    const policy = { preset: 'important' as const };
    const receiver = { kind: 'session' as const, sessionId: 'receiver' };
    const snapshot = encryption && createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: encryption });
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode,
      contentKeyFingerprint: snapshot ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint) : null }));
    app.put('/v2/account/session-follow-rules/:ruleId', async request => {
      const body = SetSessionFollowRuleRequestV1Schema.parse(request.body);
      expect(body.receiver).toEqual(receiver);
      expect(body.content.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
      expect(openSessionFollowRuleContentV1({ ruleId: 'rule/one', receiver, content: body.content, mode, material: encryption }))
        .toEqual({ status: 'opened', definition: { ...definition, policy } });
      if (mode === 'e2ee') expect(JSON.stringify(body)).not.toContain('homeServerIds');
      return { rule: { ruleId: 'rule/one', receiver, content: body.content, version: 0 } };
    });
    const deps = createSessionFollowActionDeps({ token, credentials: { token, encryption }, serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.sessionFollowAction!({ context: {}, actionId: 'follow.set', serverId: 'home',
      input: { receiver, source: { kind: 'rule', ruleId: 'rule/one' }, ruleDefinition: definition, policy, expectedVersion: -1 } }))
      .resolves.toEqual({ rule: { ruleId: 'rule/one', receiver, version: 0, definition: { ...definition, policy } } });
  });
  it('refuses missing encrypted Account material before writing an authored rule', async () => {
    let writes = 0;
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' }));
    app.put('/v2/account/session-follow-rules/:ruleId', async () => { writes++; return {}; });
    const deps = createSessionFollowActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.sessionFollowAction!({ context: {}, actionId: 'follow.set', serverId: 'home', input: {
      receiver: { kind: 'account' }, source: { kind: 'rule', ruleId: 'rule-1' }, expectedVersion: -1,
      ruleDefinition: { v: 1, enabled: true, filter: normalizeSessionListFilterV1() }, policy: { preset: 'quiet' },
    } })).rejects.toMatchObject({ code: 'account_storage_currentness_unavailable' });
    expect(writes).toBe(0);
  });
  it('does not borrow custodian material for an external rule read without admitted requester custody', async () => {
    let reads = 0;
    app.get('/v1/account/encryption/currentness', async () => { reads++; return createAccountEncryptionCurrentnessFixture(); });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`;
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const authorization: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'execution-proof', binding: {
      serverIdentityId: 'home', accountId: 'account-1', custodianAccountId: 'account-1', installationId: 'installation-1',
      principalId: 'principal-1', credentialId: 'credential-1', grant: API_TOKEN_FULL_GRANT_V1,
      machineId: 'machine-1', actionId: 'follow.get', requestId: 'request-1', requestEnvelopeDigest: 'd'.repeat(43), target,
    } };
    const deps = createSessionFollowActionDeps({ token, credentials: { token, encryption: null }, serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.sessionFollowAction!({ context: { externalActionExecutionAuthorization: authorization, externalActionTarget: target },
      actionId: 'follow.get', serverId: 'home', input: { receiver: { kind: 'account' }, source: { kind: 'rule', ruleId: 'private' } },
    })).rejects.toMatchObject({ code: 'follow_rule_account_scope_unavailable' });
    expect(reads).toBe(0);
  });
  it.each(['identity', 'receiver', 'cipher-binding'] as const)('rejects a rule response swapped by %s before returning private content', async mismatch => {
    const receiver = { kind: 'session' as const, sessionId: 'receiver' };
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(8) };
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material });
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'e2ee',
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint) }));
    app.get('/v2/account/session-follow-rules/:ruleId', async () => ({ rule: {
      ruleId: mismatch === 'identity' ? 'other-rule' : 'rule-1', receiver: mismatch === 'receiver' ? { kind: 'account' } : receiver, version: 1,
      content: sealSessionFollowRuleContentV1({ ruleId: mismatch === 'cipher-binding' ? 'other-rule' : 'rule-1', receiver,
        definition: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'quiet' } }, mode: 'e2ee', material }),
    } }));
    const deps = createSessionFollowActionDeps({ token: 'token', credentials: { token: 'token', encryption: material }, serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.sessionFollowAction!({ context: {}, actionId: 'follow.get', serverId: 'home', input: {
      receiver, source: { kind: 'rule', ruleId: 'rule-1' },
    } })).rejects.toThrow(mismatch === 'cipher-binding' ? 'invalid-stored-content' : 'session_follow_response_target_mismatch');
  });
  it('rejects a retired captured Account after the mode read and before the rule write', async () => {
    let current = true;
    let writes = 0;
    app.get('/v1/account/encryption/currentness', async () => { current = false; return createAccountEncryptionCurrentnessFixture(); });
    app.put('/v2/account/session-follow-rules/:ruleId', async () => { writes++; return {}; });
    const deps = createSessionFollowActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      isCredentialCurrent: () => current, serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.sessionFollowAction!({ context: {}, actionId: 'follow.set', serverId: 'home', input: {
      receiver: { kind: 'account' }, source: { kind: 'rule', ruleId: 'rule-1' }, expectedVersion: -1,
      ruleDefinition: { v: 1, enabled: true, filter: normalizeSessionListFilterV1() }, policy: { preset: 'quiet' },
    } })).rejects.toThrow('action_account_scope_changed');
    expect(writes).toBe(0);
  });
  it.each([{ kind: 'account' as const }, { kind: 'session' as const, sessionId: 'receiver' }])('composes following rows with only the exact $kind receiver rules', async receiver => {
    const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'quiet' as const } };
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture());
    app.get('/v2/account/session-follows', async () => ({ follows: [] }));
    app.get('/v2/sessions/:destinationSessionId/follows/sessions', async () => ({ sources: [] }));
    app.get('/v2/account/session-follow-rules', async () => ({ rules: [
      { ruleId: 'personal', receiver: { kind: 'account' }, version: 0, content: { t: 'plain', v: definition } },
      { ruleId: 'session', receiver: { kind: 'session', sessionId: 'receiver' }, version: 0, content: { t: 'plain', v: definition } },
      { ruleId: 'other-session', receiver: { kind: 'session', sessionId: 'other' }, version: 0, content: { t: 'plain', v: definition } },
    ] }));
    const deps = createSessionFollowActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.sessionFollowAction!({ context: {}, actionId: 'follow.list', serverId: 'home', input: { direction: 'following', receiver } }))
      .resolves.toEqual({ follows: [], sources: [], coverage: 'complete', rules: [{
        ruleId: receiver.kind === 'account' ? 'personal' : 'session', receiver, version: 0, definition,
      }] });
  });
  it.each([
    { actionId: 'follow.get', method: 'GET', path: '/v2/sessions/:sessionId/follow', input: { receiver: { kind: 'account' }, source: { kind: 'session', sessionId: 'session-1' } } },
    { actionId: 'follow.list', method: 'GET', path: '/v2/sessions/:sessionId/follows/sessions', input: { direction: 'following', receiver: { kind: 'session', sessionId: 'session-1' } } },
  ] as const)('preserves strict credential scope refusals for $actionId', async ({ actionId, method, path, input: actionInput }) => {
    app.route({ method, url: path, handler: async (_request, reply) => reply.code(403).send({ error: 'credential_scope_denied' }) });
    const deps = createSessionFollowActionDeps({ token: 'token', serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.sessionFollowAction!({ context: {}, actionId, input: actionInput, serverId: 'home' }))
      .resolves.toEqual({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' });
  });
  it.each([
    { error: 'credential_scope_denied', details: { sessionId: 'private' } },
    { error: 'unknown_denial' },
  ])('keeps malformed or unknown 403s closed', async (payload) => {
    app.get('/v2/sessions/:sessionId/follows/sessions', async (_request, reply) => reply.code(403).send(payload));
    const deps = createSessionFollowActionDeps({ token: 'token', serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.sessionFollowAction!({ context: {}, actionId: 'follow.list', input: { direction: 'following', receiver: { kind: 'session', sessionId: 'session-1' } }, serverId: 'home' }))
      .rejects.toMatchObject({ response: { status: 403 } });
  });
  it('rejects a fixed Home endpoint without its matching Home identity', () => {
    const partialFixedHome = { token: 'token', serverHttpBaseUrl: 'http://follow.test' };
    // @ts-expect-error -- Untyped JavaScript callers can still provide a partial fixed-Home binding.
    expect(() => createSessionFollowActionDeps(partialFixedHome)).toThrow('fixed_action_server_target_incomplete');
  });
  it('uses the declared verb, encodes path IDs and sends only the strict replacement body', async () => {
    const prepareSourceKeyAfterSet = vi.fn().mockResolvedValue({ kind: 'prepared' });
    app.put('/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId', async (request) => {
      expect(request.params).toEqual({ destinationSessionId: 'dest/one', sourceSessionId: 'src/two' });
      expect(request.body).toEqual({ policy: { preset: 'important' } });
      expect(request.headers.authorization).toBe('Bearer token');
      return { changed: true, source: { sourceSessionId: 'src/two', destinationSessionId: 'dest/one', policy: { preset: 'important' }, deliveryState: 'eligible', hasPendingUpdates: false } };
    });
    const deps = createSessionFollowActionDeps({
      token: 'token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://follow.test',
      prepareSourceKeyAfterSet,
    });
    await expect(deps.sessionFollowAction!({ context: {}, actionId: 'follow.set', serverId: 'home', input: { receiver: { kind: 'session', sessionId: 'dest/one' }, source: { kind: 'session', sessionId: 'src/two' }, policy: { preset: 'important' } } })).resolves.toMatchObject({ changed: true });
    expect(prepareSourceKeyAfterSet).toHaveBeenCalledWith({
      sourceSessionId: 'src/two',
      destinationSessionId: 'dest/one',
      context: {},
    });
  });
  it('uses the one-shot external execution authorization without disclosing the daemon bearer', async () => {
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const authorization: ExternalActionExecutionAuthorizationV1 = {
      v: 1,
      token: 'execution-proof',
      binding: {
        serverIdentityId: 'home', accountId: 'account-1', custodianAccountId: 'account-1', installationId: 'installation-1', principalId: 'principal-1', credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        machineId: 'machine-1', actionId: 'follow.preferences.get', requestId: 'request-1',
        requestEnvelopeDigest: 'd'.repeat(43), target,
      },
    };
    app.get('/v2/account/session-follow-preferences', async (request) => {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('execution-proof');
      expect(request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe('follow.preferences.get');
      expect(verifyExternalActionMachineRequestV1({
        authorizationToken: authorization.token,
        effectActionId: 'follow.preferences.get',
        target,
        installationId: 'installation-1',
        requestId: authorization.binding.requestId,
        method: 'GET',
        path: '/v2/account/session-follow-preferences',
        publicKey: keyPair.publicKey,
        signature: String(request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]),
      })).toBe(true);
      return { assigned: true, direct: false, team: false, group: false };
    });
    const deps = createSessionFollowActionDeps({
      token: 'daemon-token',
      serverId: 'home',
      serverIdentityId: 'home',
      serverHttpBaseUrl: 'http://follow.test',
      externalActionMachineRequestPrivateKey: keyPair.secretKey,
      externalActionMachineInstallationId: 'installation-1',
    });
    await deps.sessionFollowAction!({
      context: {
        externalActionCredential: { accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1', grant: API_TOKEN_FULL_GRANT_V1 },
        externalActionExecutionAuthorization: authorization,
        externalActionTarget: target,
      },
      actionId: 'follow.preferences.get',
      serverId: 'home',
      input: {},
    });
  });
  it('binds an external Follow authorization to the observed Home identity, not its local profile id', async () => {
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const authorization: ExternalActionExecutionAuthorizationV1 = {
      v: 1,
      token: 'execution-proof',
      binding: {
        serverIdentityId: 'srv-cryptographic-home', accountId: 'account-1', custodianAccountId: 'account-1', installationId: 'installation-1', principalId: 'principal-1', credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        machineId: 'machine-1', actionId: 'follow.preferences.get', requestId: 'request-1',
        requestEnvelopeDigest: 'd'.repeat(43), target,
      },
    };
    let reached = 0;
    app.get('/v2/account/session-follow-preferences', async () => {
      reached += 1;
      return { assigned: true, direct: false, team: false, group: false };
    });
    const deps = createSessionFollowActionDeps({
      token: 'daemon-token',
      serverId: 'local-profile-id',
      serverIdentityId: 'srv-cryptographic-home',
      serverHttpBaseUrl: 'http://follow.test',
      externalActionMachineRequestPrivateKey: keyPair.secretKey,
      externalActionMachineInstallationId: 'installation-1',
    });
    await expect(deps.sessionFollowAction!({
      context: { externalActionExecutionAuthorization: authorization, externalActionTarget: target },
      actionId: 'follow.preferences.get',
      serverId: 'local-profile-id',
      input: {},
    })).resolves.toMatchObject({ assigned: true });
    expect(reached).toBe(1);
  });
  it('retains external invocation authority while preparing a committed Follow source key', async () => {
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'session' as const, sessionId: 'destination' };
    const authorization: ExternalActionExecutionAuthorizationV1 = {
      v: 1,
      token: 'execution-proof',
      binding: {
        serverIdentityId: 'home', accountId: 'account-1', custodianAccountId: 'account-1', installationId: 'installation-1', principalId: 'principal-1', credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        machineId: 'machine-1', actionId: 'follow.set', requestId: 'request-1',
        requestEnvelopeDigest: 'd'.repeat(43), target,
      },
    };
    app.put('/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId', async (request) => {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(verifyExternalActionMachineRequestV1({
        authorizationToken: authorization.token,
        effectActionId: 'follow.set',
        target,
        installationId: 'installation-1',
        requestId: authorization.binding.requestId,
        method: 'PUT',
        path: '/v2/sessions/destination/follows/sessions/source',
        body: { policy: { preset: 'important' } },
        publicKey: keyPair.publicKey,
        signature: String(request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]),
      })).toBe(true);
      return {
        changed: true,
        source: { sourceSessionId: 'source', destinationSessionId: 'destination', policy: { preset: 'important' }, deliveryState: 'eligible', hasPendingUpdates: true },
      };
    });
    const prepareSourceKeyAfterSet = vi.fn().mockResolvedValue({ kind: 'prepared' });
    const deps = createSessionFollowActionDeps({
      token: 'daemon-token',
      serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'http://follow.test',
      externalActionMachineRequestPrivateKey: keyPair.secretKey,
      externalActionMachineInstallationId: 'installation-1',
      prepareSourceKeyAfterSet,
    });
    const context = {
        externalActionCredential: { accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1', grant: API_TOKEN_FULL_GRANT_V1 },
        externalActionExecutionAuthorization: authorization,
        externalActionTarget: target,
      };
    await expect(deps.sessionFollowAction!({
      context,
      actionId: 'follow.set', serverId: 'home',
      input: { receiver: { kind: 'session', sessionId: 'destination' }, source: { kind: 'session', sessionId: 'source' }, policy: { preset: 'important' } },
    })).resolves.toMatchObject({ changed: true });
    expect(prepareSourceKeyAfterSet).toHaveBeenCalledWith({
      sourceSessionId: 'source', destinationSessionId: 'destination',
      context,
    });
  });
  it('keeps the committed edge successful when optional key preparation is unavailable', async () => {
    app.put('/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId', async () => ({
      changed: true,
      source: { sourceSessionId: 'source', destinationSessionId: 'destination', policy: { preset: 'important' }, deliveryState: 'eligible', hasPendingUpdates: true },
    }));
    const deps = createSessionFollowActionDeps({
      token: 'token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://follow.test',
      prepareSourceKeyAfterSet: vi.fn().mockResolvedValue({ kind: 'waiting', reason: 'runner_unreachable' }),
    });

    await expect(deps.sessionFollowAction!({
      context: {},
      actionId: 'follow.set',
      serverId: 'home',
      input: { receiver: { kind: 'session', sessionId: 'destination' }, source: { kind: 'session', sessionId: 'source' }, policy: { preset: 'important' } },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_follow_source_key_preparation_waiting',
      error: 'session_follow_source_key_preparation_waiting',
      details: {
        status: 'waiting',
        reason: 'runner_unreachable',
        edgeCommitted: true,
        source: {
          sourceSessionId: 'source',
          destinationSessionId: 'destination',
          deliveryState: 'eligible',
          hasPendingUpdates: true,
          policy: { preset: 'important' },
        },
      },
    });
  });
  it('does not swallow an unexpected preparation exception after the edge commits', async () => {
    app.put('/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId', async () => ({
      changed: true,
      source: { sourceSessionId: 'source', destinationSessionId: 'destination', policy: { preset: 'important' }, deliveryState: 'eligible', hasPendingUpdates: false },
    }));
    const deps = createSessionFollowActionDeps({
      token: 'token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://follow.test',
      prepareSourceKeyAfterSet: vi.fn().mockRejectedValue(new Error('unexpected preparation failure')),
    });

    await expect(deps.sessionFollowAction!({
      context: {},
      actionId: 'follow.set',
      serverId: 'home',
      input: { receiver: { kind: 'session', sessionId: 'destination' }, source: { kind: 'session', sessionId: 'source' }, policy: { preset: 'important' } },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'session_follow_source_key_preparation_waiting',
      details: { status: 'waiting', edgeCommitted: true },
    });
  });
  it('does not activate source-key delivery without a Lane 09 preparation request backed by Lane 13 verified Machine material', async () => {
    let unexpectedFollowupReads = 0;
    app.put('/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId', async () => ({
      changed: true,
      source: { sourceSessionId: 'source', destinationSessionId: 'destination', policy: { preset: 'important' }, deliveryState: 'eligible', hasPendingUpdates: true },
    }));
    app.setNotFoundHandler(async (_request, reply) => {
      unexpectedFollowupReads += 1;
      return await reply.code(404).send({ error: 'not_found' });
    });
    const legacyImplicitCredentials = {
      token: 'token',
      credentials: { token: 'token', encryption: { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7),
        publicKey: tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(7)).publicKey } },
      serverId: 'home',
      serverHttpBaseUrl: 'http://follow.test',
    };
    const deps = createSessionFollowActionDeps(legacyImplicitCredentials);

    await expect(deps.sessionFollowAction!({
      context: {},
      actionId: 'follow.set',
      serverId: 'home',
      input: { receiver: { kind: 'session', sessionId: 'destination' }, source: { kind: 'session', sessionId: 'source' }, policy: { preset: 'important' } },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'session_follow_source_key_preparation_waiting',
      details: {
        status: 'waiting',
        reason: 'source_key_unavailable',
        edgeCommitted: true,
      },
    });
    expect(unexpectedFollowupReads).toBe(0);
  });
  it('rejects wrong Home before disclosure and preserves domain failures', async () => {
    app.get('/v2/account/session-follow-preferences', async (_request, reply) => reply.code(403).send({ error: 'account_inactive' }));
    const deps = createSessionFollowActionDeps({ token: 'token', serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.sessionFollowAction!({ context: {}, actionId: 'follow.preferences.get', serverId: 'other', input: {} })).resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    await expect(deps.sessionFollowAction!({ context: {}, actionId: 'follow.preferences.get', serverId: 'home', input: {} })).resolves.toEqual({ ok: false, errorCode: 'account_inactive', error: 'account_inactive' });
  });
  it('rejects a valid projection for a different Session', async () => {
    app.get('/v2/sessions/:sessionId/follow', async () => ({
      follow: {
        sessionId: 'other',
        following: true,
        notificationLevel: 'none',
        includeInVoice: true,
      },
      isSessionOwner: false,
      capabilities: { manageFollow: true },
      voiceInitialSnapshotPending: false,
    }));
    const deps = createSessionFollowActionDeps({ token: 'token', serverId: 'home', serverHttpBaseUrl: 'http://follow.test' });
    await expect(deps.sessionFollowAction!({ context: {}, actionId: 'follow.get', serverId: 'home', input: { receiver: { kind: 'account' }, source: { kind: 'session', sessionId: 'target' } } })).rejects.toThrow('session_follow_response_target_mismatch');
  });
});
