import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProbeTempDir, writeExecutableScript } from '@/capabilities/probes/agentModelsProbe.testkit';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { detectCliSnapshotOnDaemonPath, invalidateCliSnapshots } from './cliSnapshot';

describe('CLI inventory subprocess integration', () => {

  it.skipIf(process.platform === 'win32')('reaps a SIGTERM-ignoring version probe and lets an ordinary request retry', async () => {
    const fixture = await createProbeTempDir('pr936-deadline');
    const scope = createEnvKeyScope(['HAPPIER_CODEX_PATH', 'HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS']);
    const launcher = join(fixture.dir, 'codex.cjs');
    const pids = join(fixture.dir, 'pids');
    const release = join(fixture.dir, 'release');
    let pending: ReturnType<typeof detectCliSnapshotOnDaemonPath> | undefined;
    try {
      await writeExecutableScript(launcher, `
        const fs = require('node:fs');
        process.on('SIGTERM', () => {});
        fs.appendFileSync(${JSON.stringify(pids)}, String(process.pid) + '\\n');
        setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 10);
        // A broken owner still leaves only a finite fixture, and its late version
        // would fail the assertion rather than masquerade as a deadline result.
        setTimeout(() => { console.log('codex 9.9.9'); process.exit(0); }, 5000);
      `);
      scope.patch({ HAPPIER_CODEX_PATH: launcher, HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS: '1000' });
      invalidateCliSnapshots();
      const request = { requestedCliNames: ['codex'] as const, requestedTools: [] };
      pending = detectCliSnapshotOnDaemonPath(request);
      expect((await pending).clis.codex.version).toBeUndefined();
      const ownedPids = (await readFile(pids, 'utf8')).trim().split(/\s+/).map(Number);
      expect(ownedPids.length).toBeGreaterThan(0);
      for (const pid of ownedPids) expect(await waitForProcessExit(pid, { timeoutMs: 2_000 })).toBe(true);
      await writeFile(launcher, "console.log('codex 2.0.0');\n");
      // A distinct snapshot key reaches the same ordinary version-probe key,
      // proving the failed shared process did not retain an in-flight promise.
      expect((await detectCliSnapshotOnDaemonPath({ ...request, requestedTools: ['windowsTerminal'] })).clis.codex.version).toBe('2.0.0');
    } finally {
      await writeFile(release, 'exit');
      if (pending) await Promise.allSettled([pending]);
      scope.restore(); invalidateCliSnapshots(); await fixture.cleanup();
    }
  }, 60_000);
  it('observes a changed delegated program after an explicit refresh', async () => {
    const fixture = await createProbeTempDir('pr936-delegated');
    const scope = createEnvKeyScope(['HAPPIER_CODEX_PATH']);
    try {
      const target = join(fixture.dir, 'provider.cjs');
      const launcher = join(fixture.dir, 'codex.cjs');
      await writeExecutableScript(launcher, "require('./provider.cjs');\n");
      await writeFile(target, "console.log('codex 1.2.3');\n");
      scope.patch({ HAPPIER_CODEX_PATH: launcher });
      invalidateCliSnapshots();
      const request = { requestedCliNames: ['codex'] as const, requestedTools: [], bypassCache: true };
      expect((await detectCliSnapshotOnDaemonPath(request)).clis.codex.version).toBe('1.2.3');
      await writeFile(target, "console.log('codex 2.0.0');\n");
      expect((await detectCliSnapshotOnDaemonPath(request)).clis.codex.version).toBe('2.0.0');
    } finally { scope.restore(); invalidateCliSnapshots(); await fixture.cleanup(); }
  });

  it('shares one version launch across concurrent distinct snapshot requests', async () => {
    const fixture = await createProbeTempDir('pr936-concurrent');
    const scope = createEnvKeyScope(['HAPPIER_CODEX_PATH']);
    try {
      const counter = join(fixture.dir, 'calls.txt');
      const launcher = join(fixture.dir, 'codex.cjs');
      await writeExecutableScript(launcher, `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'x'); setTimeout(() => console.log('codex 1.2.3'), 100);\n`);
      scope.patch({ HAPPIER_CODEX_PATH: launcher });
      invalidateCliSnapshots();
      const snapshots = await Promise.all([
        detectCliSnapshotOnDaemonPath({ requestedCliNames: ['codex'], requestedTools: [] }),
        detectCliSnapshotOnDaemonPath({ requestedCliNames: ['codex', 'claude'], requestedTools: [] }),
      ]);
      expect(snapshots.map(s => s.clis.codex.version)).toEqual(['1.2.3', '1.2.3']);
      expect(await readFile(counter, 'utf8')).toBe('x');
    } finally { scope.restore(); invalidateCliSnapshots(); await fixture.cleanup(); }
  });
});
