import { Server } from 'node:http';
import { lstat } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

it('retains target claim cleanup in its canonical registry after unpublished listener failure and filesystem retirement refusal', async () => {
  const fixture = await createAttachedManagedRunFixture();
  try {
    fixture.capabilityCleanupFilesystem.refuse();
    const listen = Server.prototype.listen;
    let listenerRefused = false;
    vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args) {
      if (fixture.sourceDiagnostics.stage === 'source_opened' && !listenerRefused) {
        listenerRefused = true;
        throw Object.assign(new Error('Fixture unpublished listener refused'), { code: 'EADDRINUSE' });
      }
      return listen.apply(this, args);
    });
    const refused = await fixture.dispatch({ kind: 'provider_managed.binding.open', requestId: 'unpublished', ...fixture.proof });
    expect(refused).toMatchObject({ ok: false, error: { code: 'provider_endpoint_unavailable' } });
    expect(fixture.sourceDiagnostics.stage).toBe('source_opened');
    expect(listenerRefused).toBe(true);
    const paths = fixture.capabilityCleanupFilesystem.readBlockedPaths();
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect((await lstat(path)).isDirectory()).toBe(true);

    // The existing registry still owns the exact unsuccessful operation closer;
    // restoring the OS boundary allows its ordinary retained-claim sweep to
    // settle it, without another source acquisition or unpublished PID map.
    fixture.capabilityCleanupFilesystem.restore();
    const custody = createManagedProviderExplicitStartCustody({ machineId: fixture.fixture.machineId,
      happyHomeDir: fixture.fixture.happyHomeDir, controller: pluginReloadController });
    await custody.revalidateRetainedClaims();
    for (const path of paths) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    fixture.capabilityCleanupFilesystem.restore();
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});
