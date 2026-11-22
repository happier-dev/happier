import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProbeTempDir, writeExecutableScript } from '@/capabilities/probes/agentModelsProbe.testkit';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { detectCliSnapshotOnDaemonPath, invalidateCliSnapshots } from './cliSnapshot';

describe('CLI inventory subprocess integration', () => {
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
      const request = { requestedCliNames: ['codex'] as const, bypassCache: true };
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
        detectCliSnapshotOnDaemonPath({requestedCliNames:['codex']}),
        detectCliSnapshotOnDaemonPath({requestedCliNames:['codex','claude']}),
      ]);
      expect(snapshots.map(s => s.clis.codex.version)).toEqual(['1.2.3', '1.2.3']);
      expect(await readFile(counter, 'utf8')).toBe('x');
    } finally { scope.restore(); invalidateCliSnapshots(); await fixture.cleanup(); }
  });
});
