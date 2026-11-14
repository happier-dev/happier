import { describe, expect, it, vi } from 'vitest';
import { readFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import { createProbeTempDir, writeExecutableScript } from '@/capabilities/probes/agentModelsProbe.testkit';
import { createEnvKeyScope } from '@/testkit/env/envScope';

// A fake `codex` that appends one line to a counter file for every `--version` call.
const COUNTING_CLI_SCRIPT = `
const fs = require('node:fs');
const counter = process.env.HAPPIER_TEST_CLI_VERSION_COUNTER_FILE;
if ((process.argv[2] ?? '') === '--version') {
  if (counter) fs.appendFileSync(counter, 'x\\n', 'utf8');
  process.stdout.write('codex 1.2.3\\n');
  process.exit(0);
}
process.stdout.write('ok\\n');
process.exit(0);
`.trimStart();

async function countVersionProbes(counterFile: string): Promise<number> {
  try {
    return (await readFile(counterFile, 'utf8')).split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

describe('detectCliSnapshotOnDaemonPath (version cache)', () => {
  it('does not re-spawn `--version` for an unchanged binary, and re-probes when the binary changes', async () => {
    vi.resetModules();
    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        codex: { id: 'codex' },
      },
    }));

    const fixture = await createProbeTempDir('happier-cliSnapshot-versionCache');
    const envScope = createEnvKeyScope(['PATH', 'HAPPIER_CODEX_PATH', 'HAPPIER_TEST_CLI_VERSION_COUNTER_FILE', 'HAPPIER_CLI_VERSION_CACHE']);

    try {
      delete process.env.HAPPIER_CLI_VERSION_CACHE;
      const counterFile = join(fixture.dir, 'version-calls.txt');
      const codexPath = join(fixture.dir, 'codex.cjs');
      await writeExecutableScript(codexPath, COUNTING_CLI_SCRIPT);
      envScope.patch({ HAPPIER_TEST_CLI_VERSION_COUNTER_FILE: counterFile, HAPPIER_CODEX_PATH: codexPath });

      const { detectCliSnapshotOnDaemonPath, invalidateCliSnapshots } = await import('./cliSnapshot');

      // bypassCache skips the 30 s snapshot cache, so only the version cache can prevent a re-spawn.
      const first = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false, bypassCache: true });
      const second = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false, bypassCache: true });
      expect(first.clis.codex.version).toBe('1.2.3');
      expect(second.clis.codex.version).toBe('1.2.3');
      expect(await countVersionProbes(counterFile)).toBe(1);

      // A changed binary (new mtime) is probed again.
      const later = new Date(Date.now() + 60_000);
      await utimes(codexPath, later, later);
      const third = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false, bypassCache: true });
      expect(third.clis.codex.version).toBe('1.2.3');
      expect(await countVersionProbes(counterFile)).toBe(2);

      // Verification after an update always probes.
      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false, bypassCache: true, verifyVersion: true });
      expect(await countVersionProbes(counterFile)).toBe(3);

      // invalidateCliSnapshots() (called after a CLI update) clears cached versions too.
      invalidateCliSnapshots();
      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false, bypassCache: true });
      expect(await countVersionProbes(counterFile)).toBe(4);
    } finally {
      envScope.restore();
      await fixture.cleanup();
    }
  });
});
