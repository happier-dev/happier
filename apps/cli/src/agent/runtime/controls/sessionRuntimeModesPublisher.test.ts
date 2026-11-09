import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { projectSessionOwnerCompatibilityViewV1, readSessionModesMetadata, SessionMetadataTuplePatchV1Schema, StoredSessionSharedMetadataV1Schema } from '@happier-dev/protocol';
import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { createSessionRuntimeModesPublisher } from './sessionRuntimeModesPublisher';
import { createOpenCodeServerRuntimeAssembly } from '../../../../../../packages/plugins/opencode/src/agent/runtime/server/assembly';
import { createContextFixture } from '../../../../../../packages/plugins/opencode/src/agent/runtime/server/assembly.managedServices.testkit';

function createTupleMetadataSession(sessionId: string, initialMetadata: Metadata) {
  const credentials = { token: 'modes-test-token', encryption: null };
  let metadata = initialMetadata;
  let fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
    storedContentMode: 'plain', metadata, agentState: null });
  let version = 1;
  let wire: unknown;
  // HTTP is the external boundary; the CLI transport and shared tuple owner stay real.
  vi.spyOn(axios, 'patch').mockImplementation(async (_url, body: unknown) => {
    const patch = SessionMetadataTuplePatchV1Schema.parse(body);
    if (patch.mode !== 'owner' || patch.ownerMetadata.t !== 'plain') throw new Error('Expected admitted plain owner tuple mutation');
    wire = projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: StoredSessionSharedMetadataV1Schema.parse(JSON.parse(patch.sharedMetadata.ciphertext)),
      ownerMetadata: patch.ownerMetadata.v,
    });
    fields = { ...fields, sharedMetadata: patch.sharedMetadata, ownerMetadata: patch.ownerMetadata };
    return { status: 200, data: { success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: version + 1 }, agentState: { version: 0 } } };
  });
  return {
    readMetadata: () => metadata,
    readWireMetadata: () => wire,
    session: {
      getMetadataSnapshot: () => metadata,
      updateAgentState: async () => {},
      updateMetadataAsCurrentPublisher: async (handler: (current: Metadata) => Metadata) => {
        const result = await updateSessionMetadataWithRetry({ token: credentials.token, credentials,
          sessionId, rawSession: { metadataLayoutVersion: 1, encryptionMode: 'plain',
            metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
            metadataVersion: version, agentState: null, agentStateVersion: 0 },
          accountEncryptionCurrentness: { mode: 'plain', version: 1, signingKeyFingerprint: null,
            contentKeyFingerprint: null, updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } },
          updater: current => handler(createTestMetadata(current)),
        });
        metadata = createTestMetadata(result.metadata);
        version = result.version;
      },
    },
  };
}

describe('native session modes publication', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(['create', 'resume', 'resume-legacy', 'resume-unknown'] as const)('preserves V1 zero-turn modes using only a fresh native default, not staged intent (%s)', async (kind) => {
    const fixture = createTupleMetadataSession('happi-v1-modes', createTestMetadata({ flavor: 'opencode', path: '/repo', host: 'localhost', homeDir: '/home/test', happyHomeDir: '/tmp/happier', happyLibDir: '/tmp/lib', happyToolsDir: '/tmp/tools',
      ...(kind === 'resume' ? { sessionModesV1: { v: 1 as const, agentId: 'opencode', updatedAt: 1, currentModeId: 'previous-accepted', availableModes: [] } } : {}),
      ...(kind === 'resume-legacy' ? { acpSessionModesV1: { v: 1 as const, agentId: 'opencode', updatedAt: 1, currentModeId: 'previous-accepted', availableModes: [] } } : {}) }));
    const { session } = fixture;
    const publications = createNativeAgentSessionPublications({ agentId: 'opencode', session, signal: new AbortController().signal, isCurrent: () => true, supportsInFlightSteer: false });
    const projector = createSessionRuntimeModesPublisher({ agentId: 'opencode', session, source: publications.modesSource });
    const rows = [{ name: 'hidden', mode: 'primary', hidden: true }, { name: 'worker', mode: 'subagent' }, { name: 'custom-default', mode: 'primary' }, { name: 'build', mode: 'primary' }];
    let dispatchedAgent: string | null = null;
    const ctx = createContextFixture({ managedServerBaseUrl: 'http://127.0.0.1:49222', managedServerRequest: async (input) => {
      const path = input.pathAndQuery.split('?')[0];
      if (path === '/mcp' && input.method === 'POST' && input.body) {
        const registration = JSON.parse(new TextDecoder().decode(input.body));
        return { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify({ [registration.name]: { status: 'connected' } })).body };
      }
      if (input.method === 'POST' && path === '/session/native-v1-modes/message' && input.body) dispatchedAgent = JSON.parse(new TextDecoder().decode(input.body)).agent;
      const data = path === '/session' ? { id: 'native-v1-modes' } : path === '/agent' ? rows : path === '/provider' ? { all: [] } : path === '/session/native-v1-modes/message' ? (input.method === 'POST' ? { id: 'native-user-v1' } : []) : { id: 'native-v1-modes' };
      return { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify(data)).body };
    } });
    const assembly = await createOpenCodeServerRuntimeAssembly({ ctx, directory: '/repo', happierSessionId: 'happi-v1-modes', endpoint: { mode: 'managed-spawn' }, modes: publications.services.modes,
      mcpServers: { happier: { command: '/fixture/happier' } },
      request: kind === 'create' ? { kind, sessionId: 'happi-v1-modes', cwd: '/repo' } : { kind: 'resume', sessionId: 'happi-v1-modes', cwd: '/repo', providerSessionId: 'native-v1-modes' } });
    try {
      await projector.flush();
      expect(readSessionModesMetadata(fixture.readMetadata())?.availableModes.map((mode) => mode.id)).toEqual(rows.map((row) => row.name));
      const current = kind === 'create' ? 'custom-default' : kind === 'resume-unknown' ? null : 'previous-accepted';
      expect(readSessionModesMetadata(fixture.readMetadata())?.currentModeId).toBe(current);
      if (kind === 'resume-unknown') expect(fixture.readMetadata().sessionModesV1).toBeUndefined();
      if (!assembly.runtime.updateConfiguration) throw new Error('Configuration control unavailable');
      await expect(assembly.runtime.updateConfiguration({ mode: { value: 'build', updatedAtMs: 2 }, model: { value: null, updatedAtMs: 0 }, permissionIntent: { value: null, updatedAtMs: 0 }, options: {} })).resolves.toMatchObject({ status: 'deferred' });
      await projector.flush();
      expect(readSessionModesMetadata(fixture.readMetadata())?.currentModeId).toBe(current);
      await expect(assembly.runtime.send({ inputIds: ['native-control-proof'], input: { text: 'boundary-only fixture' }, delivery: { kind: 'newTurn', turnId: 'native-control-turn' } })).resolves.toEqual({ status: 'admitted' });
      await projector.flush();
      expect(dispatchedAgent).toBe('build');
      expect(fixture.readMetadata().sessionModesV1?.currentModeId).toBe('build');
    } finally { await assembly.runtime.dispose(); await projector.stopAndDrain(); publications.dispose(); }
  });
  it('projects native HTTP/SSE modes through the admitted host writer into canonical published mode options', async () => {
    // This proof begins after publisher admission. It exercises the real metadata tuple writer,
    // not the separate constructor/admission RPC. UI owner tests prove packet consumption.
    const fixture = createTupleMetadataSession('happi-modes', createTestMetadata({ flavor: 'opencode', path: '/repo', host: 'localhost', homeDir: '/home/test', happyHomeDir: '/tmp/happier', happyLibDir: '/tmp/lib', happyToolsDir: '/tmp/tools' }));
    const { session } = fixture;
    const scope = new AbortController();
    const publications = createNativeAgentSessionPublications({ agentId: 'opencode', session, signal: scope.signal, isCurrent: () => true, supportsInFlightSteer: false });
    const projector = createSessionRuntimeModesPublisher({ agentId: 'opencode', session, source: publications.modesSource });
    const ids = ['build', 'plan', 'general', 'explore', 'compaction', 'title', 'summary'];
    let agents = ids.map((id) => ({ id, name: id }));
    let nativeMode = 'build';
    let rejectMode = false;
    const stream: { current: ReadableStreamDefaultController<Uint8Array> | null } = { current: null };
    const ctx = createContextFixture({ managedServerBaseUrl: 'http://127.0.0.1:49221', managedServerRequest: async (input) => {
      const path = input.pathAndQuery.split('?')[0];
      if (path === '/api/event') {
        return { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'text/event-stream' }, body: new ReadableStream<Uint8Array>({ start(controller) { stream.current = controller; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","location":{"directory":"/repo"},"data":{}}\n\n')); input.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }) };
      }
      let ok = true;
      if (path === '/api/session/native-modes/agent') {
        ok = !rejectMode;
        if (ok && input.body) nativeMode = JSON.parse(new TextDecoder().decode(input.body)).agent;
      }
      const data = path === '/api/session' ? { id: 'native-modes' }
        : path === '/api/session/native-modes' ? { id: 'native-modes', agent: nativeMode }
          : path === '/api/agent' ? agents : [];
      return { ok, status: ok ? 200 : 503, statusText: ok ? 'OK' : 'Service Unavailable', headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify({ data })).body };
    } });
    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx, directory: '/repo', happierSessionId: 'happi-modes', endpoint: { mode: 'managed-spawn' }, modes: publications.services.modes,
      request: { kind: 'create', sessionId: 'happi-modes', cwd: '/repo', configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 }, permissionIntent: { value: null, updatedAtMs: 0 }, options: { opencodeCliGeneration: { value: 'v2', updatedAtMs: 1 } } } },
    });
    const options = () => readSessionModesMetadata(fixture.readMetadata())?.availableModes.map((mode) => mode.id) ?? [];
    try {
      await projector.flush();
      expect(options()).toEqual(ids);
      expect(fixture.readWireMetadata()).toMatchObject({ sessionModesV1: { agentId: 'opencode', currentModeId: 'build', availableModes: agents } });
      if (!assembly.runtime.updateConfiguration) throw new Error('Configuration control unavailable');
      const control = { mode: { value: 'plan', updatedAtMs: 2 }, model: { value: null, updatedAtMs: 0 }, permissionIntent: { value: null, updatedAtMs: 0 }, options: {} };
      rejectMode = true;
      await expect(assembly.runtime.updateConfiguration(control)).resolves.toMatchObject({ status: 'rejected' });
      await projector.flush();
      expect(fixture.readMetadata().sessionModesV1?.currentModeId).toBe('build');
      rejectMode = false;
      await expect(assembly.runtime.updateConfiguration(control)).resolves.toMatchObject({ status: 'applied' });
      await projector.flush();
      expect(fixture.readMetadata().sessionModesV1?.currentModeId).toBe('plan');
      expect(options()).toEqual(ids);
      agents = [];
      if (!stream.current) throw new Error('Provider stream unavailable');
      stream.current.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'agent.updated', location: { directory: '/repo' }, data: {} })}\n\n`));
      await vi.waitFor(() => expect(options()).toEqual([]));
      expect(fixture.readMetadata().sessionModesV1?.currentModeId).toBe('plan');
      await assembly.runtime.dispose();
      await projector.flush();
      expect(options()).toEqual([]);
      expect(publications.modesSource.read()).toEqual({ modes: null });
    } finally {
      await assembly.runtime.dispose();
      await projector.stopAndDrain();
      publications.dispose();
    }
  });
});
