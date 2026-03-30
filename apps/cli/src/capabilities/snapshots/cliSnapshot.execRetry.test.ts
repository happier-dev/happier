import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

import { createProbeTempDir, writeExecutableScript } from '@/capabilities/probes/agentModelsProbe.testkit';
import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('detectCliSnapshotOnDaemonPath (version retry)', () => {
  it('retries version probing when execFile hits transient spawn errors', async () => {
    vi.resetModules();

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        codex: { id: 'codex' },
      },
    }));

    const fixture = await createProbeTempDir('happier-cliSnapshot-retry');
    const envScope = createEnvKeyScope([
      'PATH',
      'HAPPIER_CODEX_PATH',
      'HAPPIER_TEST_CLI_SNAPSHOT_RETRY_STATE_FILE',
    ]);

    try {
      const stateFile = join(fixture.dir, 'state.txt');
      const codexPath = join(fixture.dir, 'codex.cjs');
      await writeExecutableScript(
        codexPath,
        `
const fs = require('node:fs');
const state = process.env.HAPPIER_TEST_CLI_SNAPSHOT_RETRY_STATE_FILE;
const arg = process.argv[2] ?? '';
if (arg === '--version') {
  if (state && !fs.existsSync(state)) {
    fs.writeFileSync(state, '1', 'utf8');
    setTimeout(() => {}, 2000);
    return;
  }
  process.stdout.write('codex 1.2.3\\n');
  process.exit(0);
}
process.stdout.write('ok\\n');
process.exit(0);
`.trimStart(),
      );

      envScope.patch({
        HAPPIER_TEST_CLI_SNAPSHOT_RETRY_STATE_FILE: stateFile,
        HAPPIER_CODEX_PATH: codexPath,
      });

      const { detectCliSnapshotOnDaemonPath } = await import('./cliSnapshot');
      const snapshot = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });

      expect(snapshot.clis.codex.available).toBe(true);
      expect(snapshot.clis.codex.version).toBe('1.2.3');
    } finally {
      envScope.restore();
      await fixture.cleanup();
    }
  });
});
