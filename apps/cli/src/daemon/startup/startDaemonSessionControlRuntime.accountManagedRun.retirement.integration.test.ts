import { lstat } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';

it('reports an unsuccessful exact retirement and retries it after filesystem restoration without restoring the public listener', async () => {
  const fixture = await createAttachedManagedRunFixture();
  try {
    const opened = await fixture.dispatch({ kind: 'provider_managed.binding.open', requestId: 'open', ...fixture.proof });
    if (!opened.ok || opened.result.kind !== 'provider_managed.binding') throw new Error(JSON.stringify(opened));
    const binding = opened.result;
    const send = () => fetch(`${binding.endpointUrl}/responses`, { method: 'POST', headers: binding.headers,
      body: JSON.stringify({ model: 'example', input: 'hello' }) });
    expect((await send()).ok).toBe(true);
    fixture.capabilityCleanupFilesystem.refuse();
    const failed = await fixture.dispatch({ kind: 'provider_managed.binding.close', requestId: 'close', bindingId: binding.bindingId });
    expect(failed).toMatchObject({ ok: false, error: { code: 'provider_endpoint_unavailable' } });
    await expect(send()).rejects.toBeDefined();
    const paths = fixture.capabilityCleanupFilesystem.readBlockedPaths();
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect((await lstat(path)).isDirectory()).toBe(true);
    fixture.capabilityCleanupFilesystem.restore();
    await expect(fixture.dispatch({ kind: 'provider_managed.binding.close', requestId: 'retry', bindingId: binding.bindingId }))
      .resolves.toMatchObject({ ok: true, result: { kind: 'provider_managed.binding.closed' } });
    for (const path of paths) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(send()).rejects.toBeDefined();
  } finally {
    fixture.capabilityCleanupFilesystem.restore();
    await fixture.cleanup();
  }
});
