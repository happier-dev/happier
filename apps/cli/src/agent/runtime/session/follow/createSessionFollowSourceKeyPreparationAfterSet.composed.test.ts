import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import nacl from 'tweetnacl';
import { z } from 'zod/mini';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import {
  computeRunnerMachineContentKeyFingerprintV1, sealEncryptedDataKeyEnvelopeV1,
  sealRunnerMachineContentKeyVerifierFactV1, signRunnerMachineContentKeyBindingV1,
} from '@happier-dev/protocol';
import {
  SessionFollowSourceKeyPrepareAuthorizationV1Schema, SessionFollowSourceKeyPrepareRequestV1Schema,
} from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { RpcHandler } from '@/api/rpc/types';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { registerRestrictedSessionFollowSourceKeyReceiver } from '@/ephemeralRunner/registerRestrictedSessionFollowSourceKeyReceiver';
import { createSessionFollowSourceMaterialResolver } from './sessionFollowSourceMaterialResolver';
import { createSessionFollowSourceKeyPreparationAfterSet } from './createSessionFollowSourceKeyPreparationAfterSet';
import { createSessionFollowOccurrenceDispatcher } from './sessionFollowOccurrenceDispatcher';
import { createAccountSessionFollowRuleCache } from './accountSessionFollowRuleCache';
import { sealSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createAutomationAccountEncryptionMaterialSnapshotV1 } from '@/plugins/runtime/automations/automationAccountCurrentness';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { SessionFollowSourceOccurrenceWitnessesV1Schema, SessionFollowRelationWitnessesV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { sealSessionStoredContent } from '@/session/transport/encryption/sessionEncryptionContext';

const io = vi.hoisted(() => vi.fn());
// Only authenticated HTTP and Socket.IO transports are substituted. Session
// resolution, envelope opening, Runner trust, RPC crypto and key installation run.
vi.mock('socket.io-client', () => ({ io }));
afterEach(() => vi.restoreAllMocks());

it.each([
  ['direct', 'prepares the direct admitted input through real Session/Runner resolution and installs only the standalone source key'],
  ['source-dispatch', 'prepares the source-dispatch admitted input through real Session/Runner resolution and installs only the standalone source key'],
  ['source-cost', 'measures 20 private rules and 200 encountered Sessions through semantic Pending admission'],
  ['preacceptance-route', 'reobserves a pre-existing private rule before ordinary Pending acceptance and keeps the original id on redispatch'],
  ['preacceptance-private', 'discovers a pre-existing private-only route before its delayed Account notification'],
  ['rule-inception', 'selects only originals at or after the private rule inception, leaving ordinary routes independent'],
] as const)('%s: %s', async mode => {
  const sourceSessionId = 'c111111111111111111111111';
  const destinationSessionId = 'c222222222222222222222222';
  const localInputId = 'accepted-original-not-attempt-alias';
  const costSources = new Set(Array.from({ length: 200 }, (_, index) => `c${String(index + 300).padStart(23, '0')}`));
  const ruleCount = mode === 'source-cost' ? 20 : 1;
  const delayedRuleNotification = mode === 'preacceptance-route' || mode === 'preacceptance-private';
  let ruleAvailable = !delayedRuleNotification;
  let ruleCensusReads = 0;
  let originalCreatedAt: number | undefined = mode === 'rule-inception' ? 99 : undefined;
  const ruleChanges: { invalidate?: () => void } = {};
  const machineId = 'runner-one';
  const machineKey = new Uint8Array(32).fill(11);
  const publicKey = nacl.box.keyPair.fromSecretKey(machineKey).publicKey;
  const credentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature',
    encryption: { type: 'dataKey' as const, publicKey, machineKey } };
  const accountMaterial = createAutomationAccountEncryptionMaterialSnapshotV1(credentials);
  if (!accountMaterial) throw new Error('Missing canonical Account encryption material');
  const sourceKey = new Uint8Array(32).fill(23);
  const destinationKey = new Uint8Array(32).fill(29);
  const runnerKey = new Uint8Array(32).fill(31);
  const randomBytes = (length: number) => new Uint8Array(length).fill(17);
  const projectRef = { id: 'current-checkout', serverId: 'home-one', machineId: 'source-machine',
    rootPath: '/workspace/project', projectKey: 'current-project', createdAtMs: 1 };
  const projectRowKey = { kind: 'workspace-ref' as const, serverId: projectRef.serverId, id: projectRef.id };
  const projectRowCipher = createProjectAccountRowCipherV1({ mode: 'e2ee',
    material: { type: 'dataKey', machineKey }, randomBytes });
  const seal = (key: Uint8Array) => encodeBase64(sealEncryptedDataKeyEnvelopeV1({
    dataKey: key, recipientPublicKey: publicKey, randomBytes,
  }));
  const row = (id: string, key: Uint8Array) => ({ ...createSessionNotificationContextFixture(id),
    active: true, archivedAt: null, ownerAccountId: 'account-1', origin: { kind: 'none' as const },
    seq: id === destinationSessionId ? 0 : 7,
    ...(id === destinationSessionId ? {} : { latestTurnId: 'source-turn', latestTurnStatus: 'failed' as const }),
    encryptionMode: 'e2ee' as const, dataEncryptionKey: seal(key),
    metadata: encodeBase64(encrypt(key, 'dataKey', { machineId: id === destinationSessionId ? machineId : 'source-machine',
      path: '/workspace/project', host: 'host' })),
  });
  const signing = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(37));
  const payload = { v: 1 as const, purpose: 'happier.ephemeral-runner.machine-content-key' as const,
    homeServerIdentityId: 'home-one', creatorAccountId: 'account-1', machineId,
    activationId: '11111111-1111-4111-8111-111111111111', installationId: 'runner-installation',
    machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(runnerKey) };
  const paths: string[] = [];
  const reads = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ mode: 'e2ee', contentKeyFingerprint:
        convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(accountMaterial.contentPublicKeyFingerprint) }) };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'e2ee', updatedAt: 0 } };
    if (path === '/v2/session-organization') {
      const sessionId = new URL(String(url)).searchParams.get('assignmentSessionIds');
      expect(sessionId && costSources.has(sessionId)).toBe(true);
      return { status: 200, data: { snapshot: { schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [],
        tags: [], tagAssignments: [{ sessionId, tagIds: ['current-tag'] }], orderEntries: [], labels: [] } } };
    }
    if (path === '/v2/account/session-follow-preferences') return { status: 200,
      data: { assigned: false, direct: false, team: false, group: false } };
    if (path === '/v2/account/session-follow-rules') {
      if (!options?.params?.destinationSessionId) ruleCensusReads++;
      const receiver = { kind: 'session' as const, sessionId: destinationSessionId };
      return { status: 200, data: { rules: Array.from({ length: ruleAvailable ? ruleCount : 0 }, (_, index) => {
        const ruleId = `private-rule-${index}`;
        return { ruleId, version: 1, receiver, ...(mode === 'rule-inception' ? { inception: { createdAt: 100 } } : {}),
        content: sealSessionFollowRuleContentV1({ ruleId, receiver, mode: 'e2ee', material: credentials.encryption,
          definition: { v: 1, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: ['home-one'], scope: 'all_accessible',
            ...(mode === 'source-cost' ? { projects: { include: [{ serverId: 'home-one', projectKey: projectRef.projectKey }], exclude: [] },
              tagIds: [{ serverId: 'home-one', tagId: 'current-tag' }] } : {}) }),
            policy: { preset: 'important' } } }) };
      }), ...(options?.params?.destinationSessionId ? { sourceRanges: { status: 'available', sources: [{
        sourceSessionId: options.params.sourceSessionId, delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1, throughSeq: 7,
      }] } } : {}) } };
    }
    if (path.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
    if (path.endsWith('/messages')) return { status: 200, data: {
      messages: [{ id: 'source-original-row', localId: 'source-original', seq: 7, createdAt: originalCreatedAt ?? 100,
        content: sealSessionStoredContent({ mode: 'e2ee', ctx: { encryptionKey: sourceKey, encryptionVariant: 'dataKey' },
          payload: buildAcpAgentMessageEnvelope({ provider: 'codex', body: { type: 'turn_failed', id: 'source-turn' } }) }) }],
      hasMore: false, nextAfterSeq: null,
    } };
    if (path === `/v2/sessions/${sourceSessionId}`) return { status: 200, data: { session: row(sourceSessionId, sourceKey) } };
    const costSourceId = path.slice('/v2/sessions/'.length);
    if (path.startsWith('/v2/sessions/') && costSources.has(costSourceId)) return { status: 200,
      data: { session: row(costSourceId, sourceKey) } };
    if (path === `/v2/sessions/${destinationSessionId}`) return { status: 200, data: { session: row(destinationSessionId, destinationKey) } };
    if (path === `/v1/machines/${machineId}`) return { status: 200, data: { machine: {
      id: machineId, kind: 'ephemeral_session_runner', storageMode: 'e2ee', installationId: payload.installationId,
      dataEncryptionKey: seal(runnerKey), runnerContentKeyBinding: {
        ...signRunnerMachineContentKeyBindingV1({ payload, activationSigningSecretKey: signing.secretKey }),
        creatorVerifierFactCiphertext: sealRunnerMachineContentKeyVerifierFactV1({
          payload: { v: 1, activationId: payload.activationId, machineId,
            activationSigningPublicKey: encodeBase64(signing.publicKey, 'base64url') },
          material: credentials.encryption, randomBytes,
        }),
      },
    } } };
    throw new Error(`Unexpected HTTP boundary path: ${path}`);
  });
  const handlers = new Map<string, RpcHandler>();
  const sourceMaterial = createSessionFollowSourceMaterialResolver();
  registerRestrictedSessionFollowSourceKeyReceiver({ destinationSessionId, sourceMaterial,
    rpc: { registerHandler: (method, handler) => handlers.set(method, handler) }, onSourceMaterialInstalled: () => {},
  });
  const content: SocketRpcContent = { mode: 'e2ee', cipher: {
    encryptRaw: async value => encodeBase64(encrypt(runnerKey, 'dataKey', value)),
    decryptRaw: async value => decrypt(runnerKey, 'dataKey', decodeBase64(value)),
  } };
  let authorization: unknown;
  let request: unknown;
  const socket = createApiSessionSocketStub({ emitWithAck: async (event, raw) => {
    expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
    const wire = z.object({ method: z.string(), params: z.unknown(), authorization: z.unknown() }).parse(raw);
    expect(wire.method).toBe(`${machineId}:${RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE}`);
    authorization = SessionFollowSourceKeyPrepareAuthorizationV1Schema.parse(wire.authorization);
    const decoded = await socketRpcCodec.decodeRequestParams(content, wire.params, wire.method);
    request = SessionFollowSourceKeyPrepareRequestV1Schema.parse(decoded.params);
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE)!;
    const result = await handler(decoded.params, { signal: new AbortController().signal,
      authorization: SessionFollowSourceKeyPrepareAuthorizationV1Schema.parse(wire.authorization) });
    return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
  } });
  io.mockReturnValue(socket);
  let attemptedLocalId: string | null = null;
  const produced: Readonly<{ localId: string; delivery: ReturnType<typeof SessionFollowInputV1Schema.parse>;
    sources: ReturnType<typeof SessionFollowSourceOccurrenceWitnessesV1Schema.parse> | undefined;
    relations: ReturnType<typeof SessionFollowRelationWitnessesV1Schema.parse> | undefined }>[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === '/v1/account/project-rows/list') return { status: 200, data: { status: 'listed', coverage: 'complete',
      rows: [{ key: projectRowKey, revision: 1, content: projectRowCipher.seal({ key: projectRowKey, value: projectRef }) }] } };
    if (path.endsWith('/follows/occurrence-routes')) return { status: 200,
      data: { ok: true, v: 1, sourceSessionId: path.split('/')[3], ...(originalCreatedAt === undefined ? {} : { originalCreatedAt }), routes: mode === 'preacceptance-route'
        ? [{ sourceSessionId, destinationSessionId, relation: 'follower', policy: { preset: 'quiet' },
          delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1, observed: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 7 } }] : [] } };
    expect(path).toBe(`/v2/sessions/${destinationSessionId}/pending`);
    const body = z.object({ localId: z.string(), ciphertext: z.string(),
      followSources: z.optional(SessionFollowSourceOccurrenceWitnessesV1Schema),
      followRelations: z.optional(SessionFollowRelationWitnessesV1Schema), followDeliveryV1: SessionFollowInputV1Schema }).parse(raw);
    attemptedLocalId = body.localId;
    if (ruleAvailable) {
      expect(body.followSources).toHaveLength(ruleCount);
      expect(body.followSources?.[0]).toMatchObject({ rule: { ruleId: 'private-rule-0', ruleVersion: 1 } });
    } else expect(body.followSources).toBeUndefined();
    produced.push({ localId: body.localId, delivery: body.followDeliveryV1, sources: body.followSources, relations: body.followRelations });
    const opened = decrypt(destinationKey, 'dataKey', decodeBase64(body.ciphertext));
    expect(JSON.stringify(opened)).not.toContain('private-rule');
    expect(JSON.stringify(opened)).not.toContain('followSources');
    // The already accepted ordinary input is the exact receipt/key custody.
    return mode === 'source-cost' || delayedRuleNotification ? { status: 200, data: { didWrite: true } }
      : { status: 200, data: { didWrite: false, terminal: true, message: { localId: localInputId } } };
  });
  let dispatcher: ReturnType<typeof createSessionFollowOccurrenceDispatcher> | null = null;
  let primedRulesCache: ReturnType<typeof createAccountSessionFollowRuleCache> | null = null;
  try {
    if (mode === 'direct') {
      const prepare = createSessionFollowSourceKeyPreparationAfterSet({ credentials,
        serverHttpBaseUrl: 'https://home.example', serverIdentityId: 'home-one' });
      await expect(prepare({ sourceSessionId, destinationSessionId, localInputId, context: {} })).resolves.toEqual({ kind: 'prepared' });
      expect(reads.mock.calls.filter(([url]) => new URL(String(url)).pathname.startsWith('/v2/sessions/'))
        .map(([, config]) => config?.headers?.['X-Happier-Request-Purpose']))
        .toEqual(['session-detail:follow-source-hydration', 'session-detail:follow-source-hydration']);
    } else {
      if (delayedRuleNotification) {
        primedRulesCache = createAccountSessionFollowRuleCache({ accountId: 'account-1', credentials,
          serverHttpBaseUrl: 'https://home.example', signal: new AbortController().signal, isCurrent: async () => true,
          subscribeInvalidation: listener => { ruleChanges.invalidate = listener; return () => { delete ruleChanges.invalidate; }; } });
        expect(await primedRulesCache.read()).toMatchObject({ status: 'available', rules: [] });
        // The rule exists before the original. Only its already-subscribed
        // Account change notification is delayed until after ordinary admission.
        ruleAvailable = true;
      }
      dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials,
        serverId: 'home-one', serverHttpBaseUrl: 'https://home.example', machineId: 'source-machine', installationId: 'source-installation',
        signal: new AbortController().signal, isCurrent: async () => true,
        ...(primedRulesCache ? { rulesCache: primedRulesCache } : {}),
        subscribeInvalidation: listener => { ruleChanges.invalidate = listener; return () => { delete ruleChanges.invalidate; }; },
        isPersonalCurrent: () => false, dispatchPersonal: async () => {},
        resolveSourceKeyContext: async () => mode === 'source-dispatch'
          ? { serverIdentityId: 'home-one', authority: 'account_automation', surface: 'api' } : null,
      });
      if (mode === 'rule-inception') {
        const occurrence = { sourceSessionId, sourcePublisher: { publisherGeneration: '1', machineId: 'source-machine', committedFenceMs: 1 },
          sourceTurn: { id: 'source-turn', status: 'failed' as const }, evidence: { v: 1 as const, ownerAccountId: 'account-1',
            event: { kind: 'failed_or_stopped' as const }, facts: { serverId: 'home-one', kind: 'session' as const, startedBy: 'you' as const } } };
        await dispatcher.dispatch(occurrence);
        expect(produced).toHaveLength(0);
        originalCreatedAt = undefined;
        await dispatcher.dispatch(occurrence);
        expect(produced).toHaveLength(0);
        // Millisecond ties are included: the incumbent source has no finer
        // ordering witness, so a valid first original must not disappear.
        originalCreatedAt = 100;
        await dispatcher.dispatch(occurrence);
        expect(produced).toHaveLength(1);
        expect(produced[0]?.sources).toMatchObject([{ rule: { ruleId: 'private-rule-0', ruleVersion: 1 } }]);
        return;
      }
      if (delayedRuleNotification) {
        const occurrence = { sourceSessionId, sourcePublisher: { publisherGeneration: '1', machineId: 'source-machine', committedFenceMs: 1 },
          sourceTurn: { id: 'source-turn', status: 'failed' as const }, evidence: { v: 1 as const, ownerAccountId: 'account-1',
            event: { kind: 'failed_or_stopped' as const }, facts: { serverId: 'home-one', kind: 'session' as const, startedBy: 'you' as const } } };
        await dispatcher.dispatch(occurrence);
        if (!ruleChanges.invalidate) throw new Error('Missing captured Account rule-change subscription');
        ruleChanges.invalidate();
        await dispatcher.dispatch(occurrence);
        expect(produced).toHaveLength(2);
        // Source notifications reobserve the ordered range before admission;
        // its fresh rule read must strengthen even the first Pending input.
        const relations = mode === 'preacceptance-route' ? [{ relation: 'follower' }] : undefined;
        expect(produced[0]).toMatchObject({ delivery: { delivery: 'wake' }, relations,
          sources: [{ rule: { ruleId: 'private-rule-0', ruleVersion: 1 } }] });
        expect(produced[1]).toMatchObject({ localId: produced[0]?.localId, delivery: { delivery: 'wake', original: produced[0]?.delivery.original },
          relations: produced[0]?.relations, sources: [{ rule: { ruleId: 'private-rule-0', ruleVersion: 1 } }] });
        expect(ruleCensusReads, 'one priming read plus one fresh census per original admission').toBe(3);
        // Redispatch retains one original identity; the server/DB owner decides
        // immutable Pending custody and effect deduplication.
        return;
      }
      if (mode === 'source-cost') {
        const started = performance.now();
        for (const sessionId of costSources) await dispatcher.dispatch({ sourceSessionId: sessionId,
          sourcePublisher: { publisherGeneration: '1', machineId: 'source-machine', committedFenceMs: 1 },
          sourceTurn: { id: 'source-turn', status: 'failed' }, evidence: { v: 1, ownerAccountId: 'account-1',
            event: { kind: 'failed_or_stopped' }, facts: { serverId: 'home-one', kind: 'session', startedBy: 'you' } } });
        expect(produced).toHaveLength(costSources.size);
        expect(ruleCensusReads, 'one fresh rule census shared by each original and its receiver range').toBe(costSources.size);
        expect(new Set(produced.map(item => 'sourceSessionId' in item.delivery.original
          ? item.delivery.original.sourceSessionId : undefined))).toEqual(costSources);
        // Diagnostic only: no guessed latency ceiling. This source-owner slice
        // does not measure the daemon's fresh requester authority checkpoints.
        console.info('FOLLOW_SOURCE_OWNER_COST', { rules: ruleCount, sessions: costSources.size,
          elapsedMs: Math.round(performance.now() - started),
          ruleReads: paths.filter(path => path === '/v2/account/session-follow-rules').length,
          routeReads: paths.filter(path => path.endsWith('/follows/occurrence-routes')).length, pendingAdmissions: produced.length,
          currentProjectHttpReads: paths.filter(path => path === '/v1/account/project-rows/list').length,
          currentTagHttpReads: paths.filter(path => path === '/v2/session-organization').length,
          accountCurrentnessHttpReads: paths.filter(path => path === '/v1/account/encryption/currentness').length });
        return;
      }
      await dispatcher.dispatch({ sourceSessionId, sourcePublisher: { publisherGeneration: '1', machineId: 'source-machine', committedFenceMs: 1 },
        sourceTurn: { id: 'source-turn', status: 'failed' }, evidence: { v: 1, ownerAccountId: 'account-1',
          event: { kind: 'failed_or_stopped' }, facts: { serverId: 'home-one', kind: 'session', startedBy: 'you' } } });
      expect(attemptedLocalId, JSON.stringify(paths)).toBeTypeOf('string');
      expect(attemptedLocalId).not.toBe(localInputId);
    }
    expect(authorization).toEqual({ kind: 'session.follow.sourceKey.prepare', sourceSessionId, destinationSessionId, localInputId });
    expect(request).toEqual({ v: 1, sourceSessionId, destinationSessionId, localInputId,
      sourceDataEncryptionKeyBase64: encodeBase64(sourceKey) });
    expect(sourceMaterial.resolveForHydration({ sourceSessionId, signal: new AbortController().signal }))
      .toEqual({ mode: 'e2ee', dataKey: sourceKey });
    expect(machineKey).toEqual(new Uint8Array(32).fill(11));
    expect(destinationKey).toEqual(new Uint8Array(32).fill(29));
  } finally { dispatcher?.dispose(); primedRulesCache?.dispose(); sourceMaterial.dispose(); }
});
