import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { AgentStartSessionCallerV1Schema } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { SessionEffectiveAccessV1Schema, projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { createCliActionDeps } from './createCliActionDeps';

const boundary = vi.hoisted(() => ({
  session: null as RawSessionRecord | null,
  patches: [] as unknown[],
  refuse: false,
  reads: 0,
}));

// Only HTTP adapters are replaced: target lookup, Account-mode parsing, the
// registered field engine, envelope projection and metadata CAS remain real.
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById: async () => { boundary.reads += 1; return boundary.session; },
  fetchSessionByIdCompat: async () => { boundary.reads += 1; return boundary.session; },
  lookupSessionsByTags: async () => ({ state: 'available' as const, sessions: [] }),
  fetchSessionsPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
  fetchSessionsQueryPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
  patchSessionMetadataEnvelopeTuple: async (request: Readonly<{ patch: unknown }>) => {
    if (boundary.refuse) throw Object.assign(new Error('forbidden'), { status: 403 });
    boundary.patches.push(request.patch);
    return { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 5 }, agentState: { version: 8 } };
  },
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
  fetchAccountEncryptionCurrentness: async () => { boundary.reads += 1; return ({
    mode: 'plain', version: 1, signingKeyFingerprint: null,
    contentKeyFingerprint: null, updatedAt: 1,
    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
  }); },
}));
vi.mock('@/session/transport/rpc/sessionRpc', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/sessionRpc')>(),
  callSessionRpc: async () => { throw new Error('Account metadata Actions must not invoke execution-host RPC'); },
}));

const sessionId = 'c123456789012345678901234';

function executor() {
  return createActionExecutor(createCliActionDeps({
    token: 'token', credentials: { token: 'token', encryption: null,
      requesterSessionCredentialScope: { serverId: 'home', serverHttpBaseUrl: 'https://home.example.test' } },
    sessionId, mode: 'plain', ctx: null, serverId: 'home',
    serverHttpBaseUrl: 'https://home.example.test',
  }));
}

describe('headless registered Session field Actions', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    boundary.patches.length = 0;
    boundary.refuse = false;
    boundary.reads = 0;
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

  it('refuses caller-local next-prompt mode selection before Home reads or writes, while immediate retains its metadata owner', async () => {
    const owner = executor();
    const input = { sessionId, permissionMode: 'read-only' };
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home' };
    expect(await owner.execute('session.permission_mode.set', { ...input, applyTiming: 'next_prompt' }, context))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
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
    expect(boundary.patches[0]).toMatchObject({ mode: 'owner_migration', target: { ownerMetadata: { t: 'plain', v: {
      work: { bot: { kind: 'bot' }, memoryEnabled: false, viewPreferences: { showToolCalls: true } },
    } } } });
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
        const patch = boundary.patches.at(-1);
        expect(patch).toMatchObject({ mode: 'owner_migration', target: { ownerMetadata: { t: 'plain' } } });
        if (showToolCalls === null) {
          expect(JSON.stringify(patch)).not.toContain('"showToolCalls"');
        } else {
          expect(patch).toMatchObject({ target: { ownerMetadata: { v: {
            work: { viewPreferences: { showToolCalls } },
          } } } });
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

  it('admits current Artifact headers and commits Session context and memory only against the reviewed tuple', async () => {
    if (!boundary.session) throw new Error('Missing Home fixture');
    boundary.session = { ...boundary.session, metadata: JSON.stringify({ path: '/repo', host: 'host', work: {
      memoryEnabled: false, sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Keep notes' },
      promptStack: [{ id: 'neighbor', ref: { kind: 'doc', artifactId: 'neighbor-doc' }, enabled: true, placement: 'composer_insert' }],
    } }) };
    const inventory = ['instructions', 'dashboard'].map(id => ({
      id, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent(id === 'instructions'
        ? { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' }
        : { v: 1, kind: 'prompt_bundle.v2', title: 'Dashboard', bundleSchemaId: 'dashboard.v1' }),
      body: encodePlainArtifactStoredContent({ body: '' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    }));
    // The same Account Artifact store used by prompt Actions sees genuine HTTP-shaped data.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const request = new URL(url);
      expect(request.origin).toBe('https://home.example.test');
      if (request.pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (request.pathname === '/v1/artifacts') return { status: 200, data: inventory };
      throw new Error(`Unexpected Artifact HTTP read: ${url}`);
    });
    const owner = executor();
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
    const committed = boundary.patches.length;
    expect(await owner.execute('session.memory.set', { ...target, expectedMetadataRevision: 3, enabled: true }, context))
      .toMatchObject({ ok: false, errorCode: 'conflict' });
    expect(await owner.execute('session.context.update', { ...target, expectedMetadataRevision: 3,
      intent: { kind: 'inherited_enable', entryId: 'inherited', enabled: false } }, context))
      .toMatchObject({ ok: false, errorCode: 'conflict' });
    expect(boundary.patches).toHaveLength(committed);
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
      expect(boundary.patches.at(-1)).toMatchObject({ target: { ownerMetadata: { v: { work: {
        memoryEnabled: expected, promptStack: stack, disabledInheritedEntryIds: ['inherited'],
      } } } } });
    }
  });

  it('does not advertise autonomous write access to the human transcript preference', async () => {
    expect(await executor().execute('settings.list', { pageId: 'transcript' }, { surface: 'agent' }))
      .toMatchObject({ ok: true, result: { items: [expect.objectContaining({ anchor: 'transcript.showToolCalls', writable: false })] } });
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
      for (const actionId of ['settings.set', 'settings.invoke'] as const) {
        const input = { anchor: 'transcript.showToolCalls', ...(actionId === 'settings.set' ? { value: false } : {}) };
        expect(await owner.prepare(actionId, input, context))
          .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'unsupported_action' } });
        expect(await owner.execute(actionId, input, context))
          .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
      }
    }
    expect(boundary.patches).toEqual([]);
    expect(boundary.session?.metadata).toBe(initialMetadata);
  });
});
