import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactReadHeadersBatchInputV1Schema, ArtifactReadHeadersBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { AgentStartSessionCallerV1Schema } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { ActionsSettingsV1Schema, SessionEffectiveAccessV1Schema, projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { createPlainSessionOwnerMetadataEnvelopeV1, SessionMetadataOwnerPatchV1Schema, SessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { openSessionOwnerMetadataEnvelopeV1, sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { prepareHappierMcpToolInventory, registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { createCliActionDeps } from './createCliActionDeps';

const boundary = vi.hoisted(() => ({
  session: null as RawSessionRecord | null,
  patches: [] as unknown[],
  refuse: false,
  reads: 0,
  rpcCalls: 0,
  race: null as 'unrelated' | 'same-field' | null,
  raceField: 'memory' as 'memory' | 'context' | 'instructions' | 'voice' | 'bot',
  accountMode: 'plain' as 'plain' | 'e2ee',
}));

const botSecret = new Uint8Array(32).fill(17);
const botMaterial = { type: 'legacy' as const, secret: botSecret };
function sealBotOwner(ownerMetadata: Parameters<typeof createPlainSessionOwnerMetadataEnvelopeV1>[0]) {
  return boundary.accountMode === 'plain' ? createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata)
    : sealSessionOwnerMetadataEnvelopeV1({ material: botMaterial, ownerMetadata,
      randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) });
}
function readBotOwner() {
  const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: boundary.accountMode, envelope: boundary.session?.ownerMetadata,
    ...(boundary.accountMode === 'e2ee' ? { material: botMaterial } : {}) });
  if (!opened.ok) throw new Error('Expected readable owner fixture');
  return opened.ownerMetadata;
}

// Only HTTP adapters are replaced: target lookup, Account-mode parsing, the
// registered field engine, envelope projection and metadata CAS remain real.
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById: async () => { boundary.reads += 1; return boundary.session; },
  fetchSessionByIdCompat: async () => { boundary.reads += 1; return boundary.session; },
  lookupSessionsByTags: async () => ({ state: 'available' as const, sessions: [] }),
  fetchSessionListPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
  fetchSessionListQueryPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
  patchSessionMetadataEnvelopeTuple: async (request: Readonly<{ patch: unknown }>) => {
    if (boundary.refuse) throw Object.assign(new Error('forbidden'), { status: 403 });
    boundary.patches.push(request.patch);
    if (boundary.session?.metadataLayoutVersion === 1) {
      const patch = SessionMetadataOwnerPatchV1Schema.parse(request.patch);
      const current = boundary.session;
      if (boundary.race) {
        const currentOwner = readBotOwner();
        const work = currentOwner.work;
        const { bot: _bot, ...workWithoutBot } = work ?? {};
        const racedWork = boundary.race === 'same-field' && boundary.raceField === 'bot' ? workWithoutBot : work;
        boundary.session = { ...current, metadataVersion: current.metadataVersion + 1,
          ownerMetadata: sealBotOwner({ ...currentOwner, work: {
            ...racedWork, sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Concurrent notes' },
            ...(boundary.race === 'same-field' ? boundary.raceField === 'memory' ? { memoryEnabled: true }
              : boundary.raceField === 'voice' ? { voicePreference: { providerContributionId: 'example.voice/speech', settingFieldPath: 'voice', value: 'competing' } }
              : boundary.raceField === 'bot' ? {}
              : { promptStack: [{ id: 'session.instructions', ref: { kind: 'doc', artifactId: 'competing' }, enabled: true, placement: 'system_append' }] } : {}),
          } }) };
        boundary.race = null;
        return { success: false, error: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
          sharedMetadata: { version: boundary.session.metadataVersion }, agentState: { version: current.agentStateVersion } };
      }
      expect(patch.sharedMetadata.expectedVersion).toBe(current.metadataVersion);
      expect(patch.expectedOwnerMetadata).toEqual(current.ownerMetadata);
      boundary.session = { ...current, metadataVersion: current.metadataVersion + 1, metadata: patch.sharedMetadata.ciphertext,
        ownerMetadata: patch.ownerMetadata, agentState: patch.agentState.ciphertext, agentStateVersion: current.agentStateVersion! + 1 };
      return { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: boundary.session.metadataVersion },
        agentState: { version: boundary.session.agentStateVersion } };
    }
    return { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 5 }, agentState: { version: 8 } };
  },
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
  fetchAccountEncryptionCurrentness: async () => { boundary.reads += 1;
    if (boundary.accountMode === 'e2ee') {
      const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: botMaterial });
      return { mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing',
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint),
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } };
    }
    return ({
    mode: 'plain', version: 1, signingKeyFingerprint: null,
    contentKeyFingerprint: null, updatedAt: 1,
    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
  }); },
}));
vi.mock('@/session/transport/rpc/sessionRpc', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/sessionRpc')>(),
  callSessionRpc: async () => { boundary.rpcCalls += 1; throw new Error('Account metadata Actions must not invoke execution-host RPC'); },
}));

const sessionId = 'c123456789012345678901234';

function executor() {
  return createActionExecutor(createCliActionDeps({
    token: 'token', credentials: { token: 'token', encryption: boundary.accountMode === 'e2ee' ? botMaterial : null,
      requesterSessionCredentialScope: { serverId: 'home', serverHttpBaseUrl: 'https://home.example.test' } },
    sessionId, ...(boundary.accountMode === 'e2ee'
      ? { mode: 'e2ee', ctx: { encryptionKey: botSecret, encryptionVariant: 'legacy' } } : { mode: 'plain', ctx: null }), serverId: 'home',
    serverHttpBaseUrl: 'https://home.example.test',
  }));
}

async function executeFaceThroughMcp(owner: ReturnType<typeof executor>, face: unknown) {
  const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
    'session.bot.face.set': { toolExposureModes: { mcp: 'direct' } },
  } });
  const catalog = createHappierToolInventory({ surface: 'mcp', actionsSettings: settings });
  const inventory = prepareHappierMcpToolInventory({ sessionId, inventory: {
    ...catalog, tools: catalog.tools.filter(tool => tool.name === 'session_bot_face_set'),
  } });
  const bridge = createActionToolExecutorBridge({ surface: 'mcp', actionsSettings: settings,
    executor: { execute: (actionId, input, context) => owner.execute(actionId, input, { ...context, serverId: 'home' }) } });
  const server = new McpServer({ name: 'custom-bot-face', version: '1' });
  registerHappierMcpBuiltInTools(server, { sessionId, surface: 'mcp', actionsSettings: settings, toolInventory: inventory,
    deps: { ...bridge, changeTitle: async () => ({ success: true }),
      resolveActionOptions: args => bridge.resolveActionOptions(args, sessionId) } });
  const client = new Client({ name: 'custom-bot-face-caller', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('session_bot_face_set');
    const result = await client.callTool({ name: 'session_bot_face_set', arguments: { sessionId, face } });
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    const content = result.content;
    if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Expected the face Action result');
    return { ok: true, result: JSON.parse(content[0].text) as unknown };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('headless registered Session field Actions', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    boundary.patches.length = 0;
    boundary.refuse = false;
    boundary.reads = 0;
    boundary.rpcCalls = 0;
    boundary.race = null;
    boundary.accountMode = 'plain';
    boundary.session = V2SessionRecordSchema.parse({
      id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      encryptionMode: 'plain', metadataLayoutVersion: 0, metadataVersion: 4,
      metadata: JSON.stringify({ path: '/repo', host: 'host', summary: { text: 'Keep', updatedAt: 1 },
        work: { viewPreferences: { showToolCalls: true } } }),
      agentState: null, agentStateVersion: 7, dataEncryptionKey: null,
      effectiveAccess: SessionEffectiveAccessV1Schema.parse({ v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) }),
    });
  });

  it.each(['memory', 'context', 'instructions', 'voice'] as const)(
    'reapplies the headless %s Action after an unrelated writer, without overwriting a competing field edit', async field => {
      if (!boundary.session) throw new Error('Missing Home fixture');
      const initialOwner = createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, work: { memoryEnabled: false,
        promptStack: [{ id: 'session.instructions', ref: { kind: 'doc', artifactId: 'original' }, enabled: true, placement: 'system_append' }],
        voicePreference: { providerContributionId: 'example.voice/speech', settingFieldPath: 'voice', value: 'original' },
      } });
      boundary.session = { ...boundary.session, active: true, metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), ownerMetadata: initialOwner };
      boundary.raceField = field;
      const owner = executor();
      const target = { sessionId, serverId: 'home', expectedMetadataRevision: 4 };
      for (const surface of ['cli', 'agent', 'mcp'] as const) {
        boundary.session = { ...boundary.session, metadataVersion: 4, ownerMetadata: initialOwner };
        const context = { surface, authority: 'present_user', serverId: 'home', defaultSessionId: sessionId } as const;
        const execute = (expectedMetadataRevision = target.expectedMetadataRevision) => field === 'memory'
          ? owner.execute('session.memory.set', { ...target, expectedMetadataRevision, enabled: true }, context)
          : field === 'context' ? owner.execute('session.context.update', { ...target, expectedMetadataRevision, intent: { kind: 'detach', entryId: 'session.instructions' } }, context)
          : field === 'instructions' ? owner.execute('session.instructions.set', { ...target, expectedMetadataRevision, ref: null }, context)
          : owner.execute('session.voice.preference.set', { ...target, expectedMetadataRevision, preference: null }, context);
        boundary.race = 'unrelated';
        const commitsBeforeStale = boundary.patches.length;
        expect(await execute(3)).toMatchObject({ ok: false, errorCode: 'conflict' });
        expect(boundary.patches).toHaveLength(commitsBeforeStale);
        const applied = await execute();
        expect(applied, JSON.stringify({ surface, applied })).toMatchObject({ ok: true, result: { version: 6 } });
        expect(boundary.session.ownerMetadata).toMatchObject({ t: 'plain', v: { work: { sessionRolesV1: { notes: 'Concurrent notes' },
          ...(field === 'memory' ? { memoryEnabled: true } : field === 'context' || field === 'instructions' ? { promptStack: [] } : {}),
        } } });
        if (field === 'voice' && boundary.session.ownerMetadata?.t === 'plain') expect(boundary.session.ownerMetadata.v.work).not.toHaveProperty('voicePreference');
        boundary.session = { ...boundary.session, metadataVersion: 4, ownerMetadata: initialOwner };
        boundary.race = 'same-field';
        const commitsBeforeConflict = boundary.patches.length;
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'conflict' });
        expect(boundary.patches).toHaveLength(commitsBeforeConflict + 1);
        expect(boundary.session.ownerMetadata).toMatchObject({ t: 'plain', v: { work: { sessionRolesV1: { notes: 'Concurrent notes' } } } });
      }
    },
  );

  it('refuses the real Action when its registered-field dependency is missing, without any metadata write', async () => {
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId, mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.example.test' });
    const miswired = createActionExecutor({ ...deps, sessionStateFieldSet: undefined });
    expect(await miswired.execute('session.memory.set', { sessionId, serverId: 'home', expectedMetadataRevision: 4, enabled: true },
      { surface: 'cli', authority: 'present_user', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(boundary.patches).toEqual([]);
  });

  it.each(['plain', 'e2ee'] as const)('guards Bot inverses through %s headless Actions on the first read and every metadata retry', async mode => {
    if (!boundary.session) throw new Error('Missing Home fixture');
    boundary.accountMode = mode;
    const initialOwner = sealBotOwner({ v: 1, work: {
      bot: { kind: 'bot' }, memoryEnabled: true, sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Keep' },
    } });
    boundary.session = { ...boundary.session, metadataLayoutVersion: 1, encryptionMode: mode,
      metadata: mode === 'e2ee' ? encodeBase64(encrypt(botSecret, 'legacy', { v: 1 })) : JSON.stringify({ v: 1 }), ownerMetadata: initialOwner };
    const owner = executor();
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home' } as const;
    const inverse = { sessionId, bot: null, expectedBot: { kind: 'bot' } };

    expect(await owner.execute('session.bot.set', { ...inverse, expectedBot: { kind: 'agent' } }, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(boundary.patches).toHaveLength(0);

    // A competing demotion before the initial read is refused without a PATCH.
    boundary.session = { ...boundary.session, ownerMetadata: sealBotOwner({ v: 1, work: { memoryEnabled: true } }) };
    expect(await owner.execute('session.bot.set', inverse, context)).toMatchObject({ ok: false, errorCode: 'conflict' });
    expect(boundary.patches).toHaveLength(0);

    boundary.session = { ...boundary.session, metadataVersion: 4, ownerMetadata: initialOwner };
    boundary.raceField = 'bot';
    boundary.race = 'unrelated';
    expect(await owner.execute('session.bot.set', inverse, context)).toMatchObject({ ok: true, result: { version: 6 } });
    expect(readBotOwner()).toMatchObject({ work: { memoryEnabled: true,
      sessionRolesV1: { notes: 'Concurrent notes' } } });
    expect(readBotOwner()).not.toHaveProperty('work.bot');

    // The first candidate can match while the refreshed CAS candidate does not.
    boundary.session = { ...boundary.session, metadataVersion: 4, ownerMetadata: initialOwner };
    boundary.race = 'same-field';
    const patchesBeforeRace = boundary.patches.length;
    expect(await owner.execute('session.bot.set', inverse, context)).toMatchObject({ ok: false, errorCode: 'conflict' });
    expect(boundary.patches).toHaveLength(patchesBeforeRace + 1);
    expect(readBotOwner()).not.toHaveProperty('work.bot');

    // Explicit null is a condition; omission retains ordinary promotion/demotion.
    expect(await owner.execute('session.bot.set', { sessionId, bot: { kind: 'bot' }, expectedBot: null }, context))
      .toMatchObject({ ok: true });
    const patchesBeforeNull = boundary.patches.length;
    expect(await owner.execute('session.bot.set', { sessionId, bot: null, expectedBot: null }, context))
      .toMatchObject({ ok: false, errorCode: 'conflict' });
    expect(boundary.patches).toHaveLength(patchesBeforeNull);
    expect(await owner.execute('session.bot.set', { sessionId, bot: null }, context)).toMatchObject({ ok: true });
  });

  it.each((['plain', 'e2ee'] as const).flatMap(mode =>
    (['cli', 'agent', 'mcp'] as const).map(surface => ({ mode, surface }))))(
    'retains a custom face through $mode $surface metadata CAS and resets only the face', async ({ mode, surface }) => {
    if (!boundary.session) throw new Error('Missing Home fixture');
    boundary.accountMode = mode;
    const shared = { v: 1, bot: { kind: 'bot' }, botFace: { seed: 'previous' } };
    const readShared = (ciphertext: string) => SessionSharedMetadataV1Schema.parse(mode === 'e2ee'
      ? decrypt(botSecret, 'legacy', decodeBase64(ciphertext)) : JSON.parse(ciphertext));
    const memoryEnabled = mode === 'e2ee';
    boundary.session = { ...boundary.session, metadataLayoutVersion: 1, encryptionMode: mode,
      metadata: mode === 'e2ee' ? encodeBase64(encrypt(botSecret, 'legacy', shared)) : JSON.stringify(shared),
      ownerMetadata: sealBotOwner({ v: 1, work: { bot: { kind: 'bot' }, memoryEnabled,
        sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Keep' } } }) };
    const owner = executor();
    const context = { surface, authority: 'present_user', serverId: 'home', defaultSessionId: sessionId } as const;
    const face = { style: 'planet', body: 'tall', palette: 'ink', seed: 'chosen-reroll', shape: {
      v: 1, fill: ['M 8 82 L 8 18 L 28 30 Q 45 15 62 30 L 82 18 L 82 82 Z'],
      stroke: [['M 20 75 Q 45 88 70 75', 2]], cut: ['M 13 24 L 22 30 L 13 35 Z'],
      mouth: [45, 55, 0.8], origin: 'custom',
    } } as const;
    boundary.race = 'unrelated';
    const rerolled = surface === 'mcp' ? await executeFaceThroughMcp(owner, face)
      : await owner.execute('session.bot.face.set', { sessionId, face }, context);
    expect(rerolled, JSON.stringify(rerolled))
      .toMatchObject({ ok: true, result: { version: 6, face } });
    expect(boundary.patches).toHaveLength(2);
    for (const request of boundary.patches) {
      const patch = SessionMetadataOwnerPatchV1Schema.parse(request);
      expect(readShared(patch.sharedMetadata.ciphertext)).toMatchObject({ bot: { kind: 'bot' }, botFace: face });
    }
    expect(readShared(boundary.session.metadata!)).toMatchObject({ bot: { kind: 'bot' }, botFace: face });
    expect(readBotOwner()).toMatchObject({ work: { bot: { kind: 'bot' }, memoryEnabled, sessionRolesV1: { notes: 'Concurrent notes' } } });

    expect(await owner.execute('session.bot.face.set', { sessionId, face: null }, context))
      .toMatchObject({ ok: true, result: { version: 7, face: null } });
    const reset = readShared(boundary.session.metadata!);
    expect(reset).not.toHaveProperty('botFace');
    expect(reset.bot).toEqual({ kind: 'bot' });
    expect(readBotOwner()).toMatchObject({ work: { bot: { kind: 'bot' }, memoryEnabled, sessionRolesV1: { notes: 'Concurrent notes' } } });
    expect(boundary.rpcCalls).toBe(0);
  });

  it('refuses caller-local next-prompt mode selection before Home reads or writes, while immediate retains its metadata owner', async () => {
    const owner = executor();
    const input = { sessionId, permissionMode: 'read-only' };
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home' };
    expect(await owner.execute('session.permission_mode.set', { ...input, applyTiming: 'next_prompt' }, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters', error: expect.stringContaining('session.message.send') });
    expect(boundary.reads).toBe(0);
    expect(boundary.patches).toEqual([]);
    expect(await owner.execute('session.permission_mode.set', { ...input, applyTiming: 'immediate' }, context))
      .toMatchObject({ ok: true, result: { ok: true, permissionMode: 'read-only' } });
    expect(boundary.reads).toBeGreaterThan(0);
    expect(boundary.patches.length).toBeGreaterThan(0);
  });

  it('writes owner metadata while the execution host is inactive, without any runtime RPC', async () => {
    const owner = executor();
    expect(await owner.execute('session.bot.set', { sessionId, bot: { kind: 'bot' } }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: true, result: { ok: true, version: 5 } });
    const promoted = SessionMetadataOwnerPatchV1Schema.parse(boundary.patches.at(-1));
    expect(promoted.ownerMetadata).toMatchObject({ t: 'plain', v: {
      work: { memoryEnabled: false, viewPreferences: { showToolCalls: true } },
    } });
    expect(JSON.parse(promoted.sharedMetadata.ciphertext)).toMatchObject({ bot: { kind: 'bot' } });
    for (const surface of ['ui', 'voice', 'cli'] as const) {
      for (const showToolCalls of [true, false, null]) {
        if (!boundary.session) throw new Error('Missing Home fixture');
        boundary.session = { ...boundary.session, metadata: JSON.stringify({
          path: '/repo', host: 'host', summary: { text: 'Keep', updatedAt: 1 },
          work: { viewPreferences: { showToolCalls: showToolCalls === true ? false : true } },
        }) };
        expect(await owner.execute('session.view.toolCalls.set', { sessionId, showToolCalls }, {
          surface, authority: 'present_user', serverId: 'home',
        })).toMatchObject({ ok: true, result: { ok: true, version: 5 } });
        const patch = SessionMetadataOwnerPatchV1Schema.parse(boundary.patches.at(-1));
        if (patch.ownerMetadata.t !== 'plain') throw new Error('Expected plain owner metadata');
        if (showToolCalls === null) {
          expect(patch.ownerMetadata.v.work?.viewPreferences).not.toHaveProperty('showToolCalls');
        } else {
          expect(patch).toMatchObject({ ownerMetadata: { v: {
            work: { viewPreferences: { showToolCalls } },
          } } });
        }
      }
    }
  });

  it('refuses denied or unavailable metadata rather than reporting success', async () => {
    boundary.refuse = true;
    expect(await executor().execute('session.bot.set', { sessionId, bot: null }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'forbidden' });
    boundary.refuse = false;
    boundary.session = null;
    expect(await executor().execute('session.bot.set', { sessionId, bot: null }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'session_not_found' });
    expect(boundary.patches).toEqual([]);
  });

  it('admits current Artifact headers and refuses stale reviewed metadata without a write', async () => {
    if (!boundary.session) throw new Error('Missing Home fixture');
    boundary.session = { ...boundary.session, metadata: JSON.stringify({ path: '/repo', host: 'host', work: {
      memoryEnabled: false, sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Keep notes' },
      promptStack: [{ id: 'neighbor', ref: { kind: 'doc', artifactId: 'neighbor-doc' }, enabled: true, placement: 'composer_insert' }],
    } }) };
    const headers = ['instructions', 'dashboard'].map(id => ({
      id, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent(id === 'instructions'
        ? { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' }
        : { v: 1, kind: 'prompt_bundle.v2', title: 'Dashboard', bundleSchemaId: 'dashboard.v1' }),
      publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    }));
    // The same Account Artifact store used by prompt Actions sees genuine HTTP-shaped data.
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
      const request = new URL(String(url));
      expect(request.origin).toBe('https://home.example.test');
      expect(request.pathname).toBe('/v1/artifacts/read');
      expect(options?.headers?.Authorization).toBe('Bearer token');
      const { artifactIds } = ArtifactReadHeadersBatchInputV1Schema.parse(body);
      expect(artifactIds).toHaveLength(1);
      return { status: 200, data: ArtifactReadHeadersBatchResponseV1Schema.parse({
        projection: 'headers', items: artifactIds.map(artifactId => {
          const artifact = headers.find(header => header.id === artifactId);
          if (!artifact) throw new Error(`Unexpected selected Artifact: ${artifactId}`);
          return { artifactId, ok: true, artifact };
        }),
      }) };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const request = new URL(url);
      expect(request.origin).toBe('https://home.example.test');
      if (request.pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      throw new Error(`Unexpected Artifact HTTP read: ${url}`);
    });
    const owner = createActionExecutor(createCliActionDeps({
      token: 'token', credentials: { token: 'token', encryption: null,
        requesterSessionCredentialScope: { serverId: 'home-profile', serverHttpBaseUrl: 'https://home.example.test' } },
      sessionId, mode: 'plain', ctx: null, serverId: 'home-profile', serverIdentityId: 'home',
      serverHttpBaseUrl: 'https://home.example.test',
    }));
    const target = { sessionId, serverId: 'home', expectedMetadataRevision: 4 };
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home' } as const;
    const deniedIntent = { kind: 'attach', entry: { id: 'dashboard', ref: { kind: 'bundle', artifactId: 'dashboard' } } };
    const denied = await owner.execute('session.context.update', { ...target, intent: deniedIntent }, context);
    expect(denied, JSON.stringify(denied))
      .toMatchObject({ ok: false, errorCode: 'attachment_unavailable' });
    expect(boundary.patches).toEqual([]);
    const ref = { kind: 'doc', artifactId: 'instructions', serverId: 'home' };
    expect(await owner.execute('session.instructions.set', { ...target, ref }, context))
      .toMatchObject({ ok: true, result: { version: 5, work: { memoryEnabled: false, sessionRolesV1: { notes: 'Keep notes' }, promptStack: [
        { id: 'neighbor', placement: 'composer_insert' }, { id: 'session.instructions', ref, required: true, placement: 'system_append' },
      ] } } });
    expect(await owner.execute('session.memory.set', { ...target, enabled: true }, context))
      .toMatchObject({ ok: true, result: { enabled: true, version: 5 } });
    const commitsBeforeStale = boundary.patches.length;
    expect(await owner.execute('session.memory.set', { ...target, expectedMetadataRevision: 3, enabled: true }, context))
      .toMatchObject({ ok: false, errorCode: 'conflict' });
    expect(await owner.execute('session.context.update', { ...target, expectedMetadataRevision: 3,
      intent: { kind: 'inherited_enable', entryId: 'inherited', enabled: false } }, context))
      .toMatchObject({ ok: false, errorCode: 'conflict' });
    expect(boundary.patches).toHaveLength(commitsBeforeStale);
  });

  it('selects a Plan through the Context Action against the reviewed revision, preserving current neighboring metadata', async () => {
    if (!boundary.session) throw new Error('Missing Home fixture');
    boundary.session = { ...boundary.session, metadataVersion: 5, metadata: JSON.stringify({ path: '/repo', host: 'host', work: {
      memoryEnabled: false, sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Concurrent notes' }, promptStack: [
        { id: 'a', ref: { kind: 'doc', artifactId: 'doc-a' }, enabled: true, placement: 'system_append', plan: true },
        { id: 'b', ref: { kind: 'doc', artifactId: 'doc-b' }, enabled: false, placement: 'composer_insert', maxChars: 42 },
      ],
    } }) };
    const owner = executor();
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home' } as const;
    const target = { sessionId, serverId: 'home', expectedMetadataRevision: 5, intent: { kind: 'set_plan', entryId: 'b' } };
    expect(await owner.execute('session.context.update', { ...target, expectedMetadataRevision: 4 }, context))
      .toMatchObject({ ok: false, errorCode: 'conflict' });
    expect(boundary.patches).toEqual([]);
    const selected = await owner.execute('session.context.update', target, context);
    expect(selected, JSON.stringify(selected))
      .toMatchObject({ ok: true, result: { work: { memoryEnabled: false, sessionRolesV1: { notes: 'Concurrent notes' }, promptStack: [
        { id: 'a' }, { id: 'b', plan: true, enabled: false, placement: 'composer_insert', maxChars: 42 },
      ] } } });
    const patch = SessionMetadataOwnerPatchV1Schema.parse(boundary.patches.at(-1));
    expect(patch).toMatchObject({ ownerMetadata: { t: 'plain', v: { work: {
      sessionRolesV1: { notes: 'Concurrent notes' }, promptStack: [
        { id: 'a' }, { id: 'b', plan: true, enabled: false, maxChars: 42 },
      ],
    } } } });
    expect(JSON.stringify(patch)).not.toContain('"planEntryId"');
    if (patch.ownerMetadata.t !== 'plain') throw new Error('Expected plain owner metadata');
    expect(patch.ownerMetadata.v.work?.promptStack?.[0]).not.toHaveProperty('plan');
  });

  it('preserves an existing Session memory choice and context when promoting or demoting its Bot marker', async () => {
    const stack = [{ id: 'own', ref: { kind: 'doc', artifactId: 'own-doc' }, enabled: true, placement: 'system_append' }];
    const owner = executor();
    for (const { bot, choice, expected } of [
      { bot: { kind: 'bot' }, choice: false, expected: false },
      { bot: null, choice: false, expected: false },
      { bot: null, choice: undefined, expected: true },
    ]) {
      if (!boundary.session) throw new Error('Missing Home fixture');
      boundary.session = { ...boundary.session, metadata: JSON.stringify({ path: '/repo', host: 'host',
        ...(bot === null ? { bot: { kind: 'bot' } } : {}), work: {
        ...(choice === undefined ? {} : { memoryEnabled: choice }), promptStack: stack, disabledInheritedEntryIds: ['inherited'],
      } }) };
      expect(await owner.execute('session.bot.set', { sessionId, bot }, { surface: 'cli', serverId: 'home' }))
        .toMatchObject({ ok: true, result: { version: 5 } });
      expect(SessionMetadataOwnerPatchV1Schema.parse(boundary.patches.at(-1))).toMatchObject({ ownerMetadata: { v: { work: {
        memoryEnabled: expected, promptStack: stack, disabledInheritedEntryIds: ['inherited'],
      } } } });
    }
  });

  it('advertises the transcript preference as writable to agents; its default Ask governs the write', async () => {
    expect(await executor().execute('settings.list', { pageId: 'transcript' }, { surface: 'agent' }))
      .toMatchObject({ ok: true, result: { items: expect.arrayContaining([expect.objectContaining({ anchor: 'transcript.showToolCalls', writable: true })]) } });
  });

  it('does not let an authenticated Session agent hide tool calls through a human-looking surface', async () => {
    const owner = executor();
    const initialMetadata = boundary.session?.metadata;
    const actionCaller = AgentStartSessionCallerV1Schema.parse({ kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 });
    for (const surface of ['agent', 'mcp', 'ui', 'voice', 'cli'] as const) {
      const context = { surface, serverId: 'home', authority: 'present_user' as const, actionCaller };
      for (const showToolCalls of [false, null]) {
        const input = { sessionId, showToolCalls };
        expect(await owner.prepare('session.view.toolCalls.set', input, context))
          .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'action_disabled' } });
        expect(await owner.execute('session.view.toolCalls.set', input, context))
          .toMatchObject({ ok: false, errorCode: 'action_disabled' });
      }
      // The Account preference has no per-setting surface gate; without a waiver the
      // agent's write reaches only the default Ask, never the preference itself.
      for (const actionId of ['settings.set', 'settings.invoke'] as const) {
        const input = { anchor: 'transcript.showToolCalls', ...(actionId === 'settings.set' ? { value: false } : {}) };
        await owner.execute(actionId, input, context);
      }
    }
    expect(boundary.patches).toEqual([]);
    expect(boundary.session?.metadata).toBe(initialMetadata);
  });
});
