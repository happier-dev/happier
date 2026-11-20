import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { railwayVendor } from '../../testkit/vendor.js';
import { createRailwayNativeClient } from './nativeClient.js';
const launch = { environmentId: 'environment-one' };
async function bound(client: ReturnType<typeof createRailwayNativeClient>) {
  const acquired = await client.acquire(launch, 'managed-one');
  if (acquired.kind !== 'bound') throw new Error('Expected bound sandbox');
  return acquired.resource.value;
}
describe('Railway documented network contracts', () => {
  it('preserves a typed HTTP refusal during a native read', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Interceptor activation failed',
      details: { phase: 'activation' } });
    const request: typeof fetch = async () => { throw refusal; };
    const client = createRailwayNativeClient(request, new AbortController().signal);
    await expect(client.check()).rejects.toBe(refusal);
  });
  it('enrolls the paid native identity through the portable guest carrier', async () => {
    const v = railwayVendor();
    try { const client = createRailwayNativeClient(v.request); const resource = await bound(client);
      expect(await client.bootstrap(resource)).toMatchObject({ kind: 'native', daemonStartup: 'native-process' });
      expect(resource).toMatchObject({ sandboxId: 'sandbox-one', environmentId: 'environment-one', managedId: 'managed-one' });
    } finally { v.cleanup(); }
  });
  it('transfers binary files and file-backed stdin, with separate binary outputs and nonzero exit', async () => {
    const v = railwayVendor();
    try { const client = createRailwayNativeClient(v.request); const resource = await bound(client);
      const file = join(v.home, "private '雪"); const bytes = Buffer.alloc(130000, 255); bytes[0] = 0;
      expect(await client.putFile({ resource, guestPath: file, bytesBase64: bytes.toString('base64'), mode: 0o600 })).toEqual({ kind: 'confirmed' });
      expect(readFileSync(file)).toEqual(bytes); expect(statSync(file).mode & 0o777).toBe(0o600);
      const inputBase64 = Buffer.from('\uFEFF秘密\n').toString('base64');
      expect(await client.exec({ resource, argv: ['sh', '-c', 'cat; printf "\\377\\000" >&2; exit 17'], inputBase64 })).toMatchObject({ termination: { observed: { kind: 'exit', exitCode: 17 } }, stdoutBase64: inputBase64, stderrBase64: '/wA=', stdoutTruncated: false });
      expect(JSON.stringify(v.calls)).not.toContain(inputBase64); expect(JSON.stringify(v.calls)).not.toContain('秘密');
      expect(v.sockets.every(s => s.url === 'wss://ssh.railway.com:2226/ws/files' && s.protocols.join(',') === 'railway-shell,scoped-files-token' && s.closed)).toBe(true);
      v.badFile(true); expect(await client.putFile({ resource, guestPath: file, bytesBase64: 'AA==' })).toMatchObject({ kind: 'unknown' });
    } finally { v.cleanup(); }
  });
  it('retains the filesystem without idle deletion, starts the daemon from a private file and destroys exactly that identity', async () => {
    const v = railwayVendor();
    try { const client = createRailwayNativeClient(v.request); const resource = await bound(client);
      expect(v.calls[0]?.variables.input).toEqual({ environmentId: 'environment-one', idleTimeoutMinutes: 0 });
      expect(await client.inspect(resource)).toMatchObject({ availability: 'present', power: 'running', storage: 'retained' });
      mkdirSync(join(v.home, '.happier')); chmodSync(join(v.home, '.happier'), 0o755);
      const privateWrites = v.writes.length;
      expect(await client.exec({ resource, argv: ['unused'], processConfig: { environment: { HOME: v.home, HAPPIER_HOME_DIR: join(v.home, '.happier') }, detachedDaemonStartArgv: ['sh', '-c', 'printf started > "$HOME/daemon-started"'] } })).toEqual({ kind: 'process-configured' });
      expect(readFileSync(join(v.home, 'daemon-started'), 'utf8')).toBe('started');
      expect(v.writes.slice(privateWrites).every(write => (write.parentMode & 0o077) === 0)).toBe(true);
      v.setFailure(true); expect(await client.inspect(resource)).toMatchObject({ availability: 'unavailable' });
      expect(await client.destroy({ resource })).toMatchObject({ kind: 'unknown' });
      v.setFailure(false); expect(await client.destroy({ resource })).toEqual({ kind: 'confirmed' });
      expect(await client.inspect(resource)).toMatchObject({ availability: 'absent' });
    } finally { v.cleanup(); }
  });
  it('does not replay an ambiguous paid create and reconciles known creating IDs by read only', async () => {
    const v = railwayVendor();
    try { const client = createRailwayNativeClient(v.request); v.loseCreate();
      const acquired = await client.acquire(launch, 'managed-one'); expect(acquired).toMatchObject({ kind: 'unknown', recovery: { reference: 'managed-one', consoleUrl: 'https://railway.com/dashboard' } });
      expect(await client.recover({ kind: 'acquire', environmentId: 'environment-one', managedId: 'managed-one' })).toMatchObject({ kind: 'unknown' });
      expect(v.calls.filter(c => c.query.includes('sandboxCreate('))).toHaveLength(1);
    } finally { v.cleanup(); }
  });
  it('reconciles a returned CREATING identity by reading it, without allocating again', async () => {
    const v = railwayVendor();
    try {
      const client = createRailwayNativeClient(v.request); v.setStatus('CREATING');
      const acquired = await client.acquire(launch, 'managed-one');
      expect(acquired.kind).toBe('pending');
      if (acquired.kind !== 'pending') throw new Error('Expected retained native ID');
      expect(acquired.nativeOperationRef.value).toMatchObject({ sandboxId: 'sandbox-one', environmentId: 'environment-one' });
      expect(await client.recover(acquired.nativeOperationRef.value)).toMatchObject({ kind: 'pending' });
      v.setStatus('RUNNING');
      expect(await client.recover(acquired.nativeOperationRef.value)).toMatchObject({ kind: 'bound', resource: { value: { sandboxId: 'sandbox-one' } } });
      expect(v.calls.filter(call => call.query.includes('sandboxCreate('))).toHaveLength(1);
    } finally { v.cleanup(); }
  });
  it('represents timeout and transport cancellation without claiming the remote command stopped', async () => {
    const v = railwayVendor();
    try { const client = createRailwayNativeClient(v.request); const resource = await bound(client); v.timeout(true);
      expect(await client.exec({ resource, argv: ['true'], timeoutMs: 1000 })).toMatchObject({ termination: { requestedBy: { kind: 'timeout' }, observed: { kind: 'exit', exitCode: -1 } } });
      const c = new AbortController(); c.abort(); const cancelled = createRailwayNativeClient(v.request, c.signal);
      expect(await cancelled.check()).toMatchObject({ available: false });
      expect(await cancelled.putFile({ resource, guestPath: join(v.home, 'cancelled'), bytesBase64: 'AA==' })).toMatchObject({ kind: 'unknown' });
      const during = new AbortController(); v.abortFiles(() => during.abort());
      expect(await createRailwayNativeClient(v.request, during.signal).putFile({ resource, guestPath: join(v.home, 'aborted-write'), bytesBase64: 'AA==' })).toMatchObject({ kind: 'unknown' });
      expect(v.sockets.every(socket => socket.closed)).toBe(true);
    } finally { v.cleanup(); }
  });
});
