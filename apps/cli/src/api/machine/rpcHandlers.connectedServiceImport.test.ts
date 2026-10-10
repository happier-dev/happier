import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import type { RpcHandler, RpcHandlerContext } from '../rpc/types';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });
describe('machine connected-service import', () => {
  it('stores the machine login through the account credential API and returns no secrets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agy-rpc-'));
    vi.stubEnv('HAPPIER_HOME_DIR', home);
    vi.stubEnv('GEMINI_HOME', join(home, 'gemini'));
    vi.stubEnv('HAPPIER_SERVER_URL', 'http://agy-import.test');
    vi.stubEnv('HAPPIER_LOCAL_SERVER_URL', 'http://agy-import.test');
    vi.stubEnv('HAPPIER_VARIANT', 'stable');
    vi.resetModules();
    const writes: unknown[] = [];
    const app = fastify({ logger: false });
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.get('/v3/connect/antigravity/profiles/work/credential', async (_request, reply) => reply.code(404).send({ error: 'not_found' }));
    app.post('/v3/connect/antigravity/profiles/work/credential', async (request) => {
      expect(request.headers.authorization).toBe('Bearer happy-token');
      writes.push(request.body);
      return { success: true, credentialRevision: 'csr_abcdefghijklmnopqrstuv' };
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://agy-import.test' });
    const controller = new AbortController();
    let cancelDuringVerification = false;
    let missingProject = false;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/token')) return Response.json({ access_token: 'secret-access', scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email', expires_in: 3600 });
      if (String(url).includes('userinfo')) return Response.json({ sub: 'account', email: 'a@example.test' });
      if (cancelDuringVerification) controller.abort(new DOMException('Cancelled', 'AbortError'));
      return Response.json(missingProject ? {} : { currentTier: { id: 'tier' }, cloudaicompanionProject: 'project' });
    }));
    try {
      await mkdir(join(home, 'gemini/antigravity-cli'), { recursive: true });
      await writeFile(join(home, 'gemini/antigravity-cli/antigravity-oauth-token'), JSON.stringify({ token: { refresh_token: 'secret-refresh' } }));
      const { writeCredentialsLegacy } = await import('@/persistence');
      // Disk login may change after this machine connected; its account remains the import owner.
      await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(8), token: 'another-account-token' });
      const { ApiClient } = await import('@/api/api');
      const api = await ApiClient.create({ token: 'happy-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } });
      const client = api.machineSyncClient({
        id: 'machine-import', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy',
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
      });
      client.setRPCHandlers({ spawnSession: async () => ({ type: 'success', sessionId: 'unused' }), stopSession: async () => true, requestShutdown: () => {} });
      // Exercise the real machine registration through its canonical local RPC surface.
      const rpc = (client as unknown as { rpcHandlerManager: RpcHandlerManager }).rpcHandlerManager;
      const handler = (raw: unknown, _compat?: unknown, context?: RpcHandlerContext) => rpc.invokeLocal('daemon.connectedService.import', raw, context);
      expect(await handler({ serviceId: 'antigravity', profileId: 'work', source: 'cli', path: '/arbitrary' })).toMatchObject({ success: false, errorCode: 'invalid_parameters' });
      expect(await handler({ serviceId: 'antigravity', profileId: 'work', source: 'cli', deadlineAtMs: Date.now() - 1 })).toMatchObject({ success: false, errorCode: 'cancelled' });
      expect(writes).toHaveLength(0);
      const result = await handler({ serviceId: 'antigravity', profileId: 'work', source: 'cli' });
      expect(result).toEqual({ success: true, serviceId: 'antigravity', profileId: 'work', requiresBrowserReauthorization: true });
      expect(JSON.stringify(result)).not.toContain('secret-');
      expect(writes).toHaveLength(1);
      cancelDuringVerification = true;
      expect(await handler({ serviceId: 'antigravity', profileId: 'work', source: 'cli' }, undefined, { signal: controller.signal })).toMatchObject({ success: false, errorCode: 'cancelled' });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ content: { t: 'plain', v: { serviceId: 'antigravity', profileId: 'work', oauth: { providerAccountId: 'account', refreshToken: 'secret-refresh' } } } });
      cancelDuringVerification = false;
      missingProject = true;
      expect(await handler({ serviceId: 'antigravity', profileId: 'work', source: 'cli' })).toMatchObject({ success: false, errorCode: 'project_required' });
      expect(writes).toHaveLength(1);
    } finally { restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
  });
  it('requires the authenticated machine account before reading an imported login', async () => {
    const { registerMachineConnectedServiceImportRpcHandlers } = await import('./rpcHandlers.connectedServiceImport');
    const handlers = new Map<string, RpcHandler>();
    registerMachineConnectedServiceImportRpcHandlers({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } } });
    expect(await handlers.get('daemon.connectedService.import')!({ serviceId: 'antigravity', profileId: 'work', source: 'cli' })).toMatchObject({ success: false, errorCode: 'authentication_required' });
  });
});
