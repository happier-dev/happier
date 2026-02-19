import { describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { createProbeTempDir, writeExecutableScript } from '@/capabilities/probes/agentModelsProbe.testkit';

describe('detectCliSnapshotOnDaemonPath (cache)', () => {
  it('caches snapshots and avoids re-probing CLI versions within TTL', async () => {
    vi.resetModules();

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        opencode: { id: 'opencode' },
      },
    }));

    const fixture = await createProbeTempDir('happier-cli-snapshot-cache');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const countFile = resolve(join(fixture.dir, 'count.txt'));
    await writeFile(countFile, '', 'utf8');

    const opencodePath = resolve(join(binDir, 'opencode'));
    await writeExecutableScript(
      opencodePath,
      `#!/usr/bin/env node
const fs = require("fs");
const countFile = process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
if (countFile) fs.appendFileSync(countFile, "1");
process.stdout.write("opencode 1.2.3\\n");
process.exit(0);
`,
    );

    const prevPath = process.env.PATH;
    const prevCountFile = process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE = countFile;
    try {
      const { detectCliSnapshotOnDaemonPath } = await import('./cliSnapshot');

      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });
      const afterFirst = (await readFile(countFile, 'utf8')).length;

      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });
      const afterSecond = (await readFile(countFile, 'utf8')).length;

      expect(afterSecond).toBe(afterFirst);

      // Different request params should not share the cached entry.
      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true });
      const afterThird = (await readFile(countFile, 'utf8')).length;
      expect(afterThird).toBeGreaterThan(afterSecond);
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevCountFile === 'string') process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE = prevCountFile;
      else delete process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
      await fixture.cleanup();
    }
  }, 20_000);
});

