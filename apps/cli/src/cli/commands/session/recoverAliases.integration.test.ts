import { createServer, type Server } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { encodeBase64, encryptLegacy, decodeBase64, decryptLegacy } from '@/api/encryption';

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: mockIo }));

// Sanitised assignment evidence supplied by the owner; no registration/key paths are accessed.
const registration = { name: 'happier-6e', sessionId: '8dfb9251-abaf-4592-9e5e-afa54023db0d', nameSince: 1793146034751, startedAt: 1793146034751 };
const observedAt = 1793222820000;
const secret = new Uint8Array(32).fill(7);
const credentials = { token: 'token_test', encryption: { type: 'legacy' as const, secret } };

describe('happier session recover-aliases', () => {
  let server: Server;
  let directory = '';
  let snapshotPath = '';
  const envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_ACTIONS_SETTINGS_V1']);
  let metadataById: Map<string, Record<string, unknown>>;
  let archivedMetadataById: Map<string, Record<string, unknown>>;
  let unreadableRow = false;
  let writes: string[];
  let conflictMetadata: Record<string, unknown> | undefined;
  let requireApproval = false;

  const rawSession = (id: string, metadata: Record<string, unknown>) => ({
    id, seq: 1, createdAt: 1, updatedAt: 2, active: false, activeAt: 0,
    metadata: encodeBase64(encryptLegacy(metadata, secret), 'base64'), metadataVersion: 0,
    agentState: null, agentStateVersion: 0, pendingCount: 0, pendingVersion: 0,
    dataEncryptionKey: null, share: null, archivedAt: null,
  });

  beforeEach(async () => {
    directory = await createTempDir('happier-recover-aliases-');
    snapshotPath = join(directory, 'registrations.json');
    await writeFile(snapshotPath, JSON.stringify({ registrations: [registration] }), 'utf8');
    metadataById = new Map([
      ['target', { flavor: 'claude', claudeSessionId: registration.sessionId, machineId: 'machine1', summary: { text: 'Current title' }, existing: 'preserve' }],
      ['title-guess', { flavor: 'claude', claudeSessionId: 'different', summary: { text: 'happier-6e' } }],
    ]);
    archivedMetadataById = new Map();
    unreadableRow = false;
    writes = [];
    conflictMetadata = undefined;
    requireApproval = false;
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/v2/account/settings') {
        res.end(JSON.stringify({ version: 1, content: { t: 'plain', v: { schemaVersion: 2,
          actionsSettingsV1: { v: 1, actions: requireApproval ? { 'session.aliases.recover': { enabled: true, disabledSurfaces: [], disabledPlacements: [], approvalRequiredSurfaces: ['cli'] } } : {} },
        } } }));
      } else if (req.method === 'POST' && url.pathname === '/v1/artifacts') {
        req.resume();
        res.end(JSON.stringify({ id: 'approval-test' }));
      } else if (url.pathname === '/v2/sessions/archived') {
        res.end(JSON.stringify({ sessions: [...archivedMetadataById].map(([id, metadata]) => ({ ...rawSession(id, metadata), archivedAt: 3 })), hasNext: false, nextCursor: null }));
      } else if (url.pathname === '/v2/sessions') {
        // Matching must finish pagination before deciding uniqueness.
        const sessions = [...metadataById].map(([id, metadata]) => rawSession(id, metadata));
        if (unreadableRow) sessions.push({ ...rawSession('unreadable', {}), metadata: 'invalid-encrypted-metadata' });
        res.end(JSON.stringify(url.searchParams.has('cursor')
          ? { sessions: sessions.slice(1), hasNext: false, nextCursor: null }
          : { sessions: sessions.slice(0, 1), hasNext: true, nextCursor: 'page2' }));
      } else if (url.pathname.startsWith('/v2/sessions/')) {
        const id = url.pathname.slice('/v2/sessions/'.length);
        const metadata = metadataById.get(id);
        if (metadata) res.end(JSON.stringify({ session: rawSession(id, metadata) }));
        else { res.statusCode = 404; res.end('{}'); }
      } else { res.statusCode = 404; res.end('{}'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = process.env.HAPPIER_SERVER_URL;
    process.env.HAPPIER_HOME_DIR = directory;
    delete process.env.HAPPIER_LOCAL_SERVER_URL;
    delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    delete process.env.HAPPIER_ACTIVE_SERVER_ID;
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { configuration } = await import('@/configuration');
    expect(configuration.apiServerUrl).toBe(process.env.HAPPIER_SERVER_URL);
    bindApiSessionSocketMock(mockIo, createApiSessionSocketStub({ emit: async (event, args) => {
      if (event !== 'update-metadata') return;
      const [data, callback] = args as [{ sid: string; metadata: string }, (response: unknown) => void];
      if (conflictMetadata) {
        const changed = conflictMetadata;
        conflictMetadata = undefined;
        metadataById.set(data.sid, changed);
        callback({ result: 'version-mismatch', version: 1, metadata: rawSession(data.sid, changed).metadata });
        return;
      }
      writes.push(data.sid);
      metadataById.set(data.sid, decryptLegacy(decodeBase64(data.metadata, 'base64'), secret));
      callback({ result: 'success', version: 2, metadata: data.metadata });
    } }));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await removeTempDir(directory);
    envScope.restore();
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  async function run(...extra: string[]) {
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['recover-aliases', '--provider', 'claude', '--snapshot', snapshotPath, '--observed-at', String(observedAt), '--json', ...extra], { readCredentialsFn: async () => credentials });
      return output.json();
    } finally { output.restore(); }
  }

  it('recovers existing aliases by exact provider ID into encrypted metadata while preserving other fields', async () => {
    const result = await run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.data.recovered).toEqual([expect.objectContaining({ sessionId: 'target', title: 'Current title', alias: 'happier-6e', providerSessionId: registration.sessionId })]);
    expect(metadataById.get('target')).toEqual(expect.objectContaining({ existing: 'preserve', nativeSessionAliasesV1: { v: 1, assignments: [{ providerId: 'claude', providerSessionId: registration.sessionId, alias: registration.name, assignedAt: registration.nameSince, observedAt }] } }));
    expect(writes).toEqual(['target']);
    await run();
    expect(writes).toEqual(['target']);
  });

  it('leaves cross-machine duplicates ambiguous after the final page and offers a write-free preview', async () => {
    metadataById.set('duplicate', { flavor: 'claude', claudeSessionId: registration.sessionId, machineId: 'machine2' });
    const ambiguous = await run();
    expect(ambiguous.data.unresolved).toEqual([expect.objectContaining({ alias: registration.name, reason: 'ambiguous' })]);
    expect(writes).toEqual([]);
    const preview = await run('--machine-id', 'machine1', '--dry-run');
    expect(preview.data.recovered[0]).toEqual(expect.objectContaining({ sessionId: 'target', title: 'Current title' }));
    expect(writes).toEqual([]);
  });

  it('rechecks target identity during metadata conflict retries', async () => {
    conflictMetadata = { flavor: 'claude', claudeSessionId: 'replacement-session', existing: 'concurrent' };
    const result = await run();
    expect(result.data.unresolved).toEqual([expect.objectContaining({ reason: 'identity_changed' })]);
    expect(writes).toEqual([]);
    expect(metadataById.get('target')).not.toHaveProperty('nativeSessionAliasesV1');
  });

  it('honors configured CLI action approval before looking up or changing targets', async () => {
    requireApproval = true;
    const result = await run();
    expect(result.data).toEqual(expect.objectContaining({ kind: 'approval_request_created', actionId: 'session.aliases.recover' }));
    expect(writes).toEqual([]);
    expect(metadataById.get('target')).not.toHaveProperty('nativeSessionAliasesV1');
  });

  it('preserves unknown history versions rather than overwriting partial evidence', async () => {
    metadataById.set('target', { ...metadataById.get('target'), nativeSessionAliasesV1: { v: 2, assignments: [] } });
    const result = await run();
    expect(result.data.unresolved).toEqual([expect.objectContaining({ reason: 'unsupported_history' })]);
    expect(writes).toEqual([]);
  });

  it('checks archived targets too before declaring a provider identity unique', async () => {
    archivedMetadataById.set('archived-duplicate', { flavor: 'claude', claudeSessionId: registration.sessionId });
    const result = await run();
    expect(result.data.unresolved).toEqual([expect.objectContaining({ reason: 'ambiguous' })]);
    expect(writes).toEqual([]);
  });

  it('aborts without writes when unreadable metadata prevents proving uniqueness', async () => {
    unreadableRow = true;
    const result = await run();
    expect(result.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it('previews the current explicit session name when summary is absent', async () => {
    metadataById.set('target', { flavor: 'claude', claudeSessionId: registration.sessionId, name: 'Named session' });
    const result = await run('--dry-run');
    expect(result.data.recovered[0].title).toBe('Named session');
    expect(writes).toEqual([]);
  });

  it('rejects a blank explicit machine scope instead of importing across machines', async () => {
    const result = await run('--machine-id', ' ');
    expect(result.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it('rejects a snapshot with assignment times after its supplied observation', async () => {
    await writeFile(snapshotPath, JSON.stringify({ registrations: [{ ...registration, nameSince: observedAt + 1 }] }), 'utf8');
    const result = await run();
    expect(result.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it('rejects a future observation rather than inventing an alias validity window', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(observedAt - 1);
    try {
      const result = await run();
      expect(result.ok).toBe(false);
      // MCP/session-agent callers supply evidence directly, without the CLI snapshot parser.
      const { createCliActionExecutorFromCredentials } = await import('@/session/actions/createCliActionExecutorFromCredentials');
      const action = await createCliActionExecutorFromCredentials({ credentials }).execute('session.aliases.recover', {
        assignments: [{ providerId: 'claude', providerSessionId: registration.sessionId, alias: registration.name, assignedAt: registration.nameSince, observedAt }],
      }, { surface: 'cli', defaultSessionId: null });
      expect(action.ok).toBe(false);
      expect(writes).toEqual([]);
    } finally { clock.mockRestore(); }
  });

  it('supports Codex evidence through the same provider-neutral import path', async () => {
    metadataById.set('codex-target', { flavor: 'codex', codexSessionId: registration.sessionId });
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['recover-aliases', '--provider', 'codex', '--snapshot', snapshotPath, '--observed-at', String(observedAt), '--json'], { readCredentialsFn: async () => credentials });
      expect(output.json()).toMatchObject({ ok: true });
      expect(writes).toEqual(['codex-target']);
      expect(metadataById.get('codex-target')?.nativeSessionAliasesV1).toEqual({ v: 1, assignments: [expect.objectContaining({ providerId: 'codex' })] });
    } finally { output.restore(); }
  });
});
