import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('detectCliSnapshotOnDaemonPath (version retry)', () => {
  it('retries version probing when execFile hits transient spawn errors', async () => {
    vi.resetModules();

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        codex: { id: 'codex' },
      },
    }));

    const dir = await mkdtemp(join(tmpdir(), 'happier-cliSnapshot-retry-'));
    const prevPath = process.env.PATH;
    const prevCodexPath = process.env.HAPPIER_CODEX_PATH;
    try {
      const stateFile = join(dir, 'state.txt');
      const codexPath = join(dir, 'codex.cjs');
      await writeFile(
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
        'utf8',
      );
      if (process.platform !== 'win32') {
        await chmod(codexPath, 0o755);
      }

      process.env.HAPPIER_TEST_CLI_SNAPSHOT_RETRY_STATE_FILE = stateFile;
      process.env.HAPPIER_CODEX_PATH = codexPath;

      const { detectCliSnapshotOnDaemonPath } = await import('./cliSnapshot');
      const snapshot = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });

      expect(snapshot.clis.codex.available).toBe(true);
      expect(snapshot.clis.codex.version).toBe('1.2.3');
    } finally {
      delete process.env.HAPPIER_TEST_CLI_SNAPSHOT_RETRY_STATE_FILE;
      if (prevCodexPath === undefined) delete process.env.HAPPIER_CODEX_PATH;
      else process.env.HAPPIER_CODEX_PATH = prevCodexPath;
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
