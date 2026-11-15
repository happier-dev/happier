import { describe, expect, it, vi } from 'vitest';
import { readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-claude/manifest';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { invokeAccountMachineSourceAction } from './accountMachineActionTransport';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

// HTTP is the system boundary; exact-Machine admission and RPC disposition remain real.
const httpGet = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { defaults: {}, get: httpGet } }));

describe('Account Machine Action failure cause', () => {
  it.each(['action', 'observation'])('exits the cancelled caller while a noncooperative Machine %s acknowledgement stays pending', async mode => {
    // Real HTTP and Socket.IO boundaries: the remote Action accepts cancellation
    // but deliberately keeps its acknowledgement pending until fixture cleanup.
    const http = createServer((request, response) => {
      if (request.url === '/v1/machines/cancel-machine') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ machine: { id: 'cancel-machine', kind: 'persistent',
          storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } }));
      } else { response.writeHead(404).end(); }
    });
    const home = new Server(http, { path: '/v1/updates' });
    const issued = Promise.withResolvers<void>();
    let acknowledged = false;
    let finish: (() => void) | undefined;
    home.on('connection', socket => {
      socket.on(SOCKET_RPC_EVENTS.CALL, (_request, acknowledge) => {
        if (finish) { acknowledge({ ok: true, result: {} }); return; }
        finish = () => { acknowledged = true; acknowledge({ ok: true, result: { ok: true, result: {} } }); };
        issued.resolve();
      });
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture Home address');
    const child = spawn(process.execPath, ['--import', 'tsx',
      fileURLToPath(new URL('./accountMachineActionTransport.cancel.child.ts', import.meta.url)),
      `http://127.0.0.1:${address.port}`, mode], { cwd: fileURLToPath(new URL('../../../../..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', issued.reject);
    child.once('exit', () => { if (!finish) issued.reject(new Error(`Caller exited before dispatch: ${stderr}\n${stdout}`)); });
    const exited = once(child, 'exit');
    try {
      await issued.promise;
      child.kill('SIGINT');
      await vi.waitFor(() => expect(stdout, stderr).toContain('"cancelled"'));
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, errorCode: 'cancelled', details: { outcome: 'unknown' } });
      await vi.waitFor(() => expect(child.exitCode, stderr).toBe(0));
      expect(acknowledged).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
      finish?.();
      await new Promise<void>(resolve => home.close(() => resolve()));
    }
  });

  it('retains a typed pre-dispatch transport failure as a not-started result', async () => {
    httpGet.mockRejectedValue(Object.assign(new Error('private connection detail'), { code: 'ECONNRESET' }));
    const manifest = normalizePluginManifestV2(PLUGIN_MANIFEST);
    const sourceCustody = { kind: 'managed' as const, immutableGenerationId: 'transport-fixture', installSource: 'archive' as const };
    const result = await invokeAccountMachineSourceAction({
      credentials: { token: 'transport-fixture', encryption: null }, serverUrl: 'https://transport.example.test', machineId: 'machine-fixture',
      callerManifest: manifest, callerSourceCustody: sourceCustody,
      source: { manifest, occurrenceId: 'source-occurrence', sourceCustody },
      request: { action: { pluginId: manifest.id, localId: 'fixture' }, input: {},
        caller: { kind: 'plugin', pluginId: manifest.id, occurrenceId: 'caller-occurrence',
          contribution: { id: 'fixture', qualifiedId: `${manifest.id}/actions/fixture` }, originSurface: 'cli' },
        originSurface: 'cli', signal: new AbortController().signal },
    });
    expect(result).toMatchObject({ status: 'unavailable', actionHandlerInvocation: 'notStarted' });
    expect(readPluginActionFailureAuthorPayload(result.status === 'executed' ? undefined : result.data)).toMatchObject({
      failureCause: { errorCode: 'ECONNRESET', errorClass: 'Error' },
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });
});
