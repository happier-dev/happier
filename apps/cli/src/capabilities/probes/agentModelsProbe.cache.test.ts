import { describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { createProbeTempDir, writeExecutableScript } from './agentModelsProbe.testkit';

describe('probeAgentModelsBestEffort (cache)', () => {
  it('caches dynamic CLI results and avoids re-running the CLI probe', async () => {
    vi.resetModules();

    const fixture = await createProbeTempDir('happier-cli-model-probe-cache');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const countFile = resolve(join(fixture.dir, 'count.txt'));
    await writeFile(countFile, '', 'utf8');

    const opencodePath = resolve(join(binDir, 'opencode'));
    await writeExecutableScript(
      opencodePath,
      `#!/usr/bin/env node
const fs = require("fs");
const countFile = process.env.HAPPIER_TEST_PROBE_COUNT_FILE;
if (countFile) fs.appendFileSync(countFile, "1");
const args = process.argv.slice(2);
if (args[0] === "models") {
  process.stdout.write("openai/gpt-4.1\\nopenai/gpt-4.1-mini\\n");
  process.exit(0);
}
process.exit(1);
`,
    );

    const prevPath = process.env.PATH;
    const prevCountFile = process.env.HAPPIER_TEST_PROBE_COUNT_FILE;
    const prevOverride = process.env.HAPPIER_OPENCODE_PATH;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    process.env.HAPPIER_TEST_PROBE_COUNT_FILE = countFile;
    delete process.env.HAPPIER_OPENCODE_PATH;
    try {
      const { probeAgentModelsBestEffort } = await import('./agentModelsProbe');

      const first = await probeAgentModelsBestEffort({ agentId: 'opencode', cwd: fixture.dir, timeoutMs: 2_000 });
      expect(first.source).toBe('dynamic');

      const second = await probeAgentModelsBestEffort({ agentId: 'opencode', cwd: fixture.dir, timeoutMs: 2_000 });
      expect(second.source).toBe('dynamic');

      const count = (await readFile(countFile, 'utf8')).trim();
      expect(count.length).toBe(1);
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevCountFile === 'string') {
        process.env.HAPPIER_TEST_PROBE_COUNT_FILE = prevCountFile;
      } else {
        delete process.env.HAPPIER_TEST_PROBE_COUNT_FILE;
      }
      if (typeof prevOverride === 'string') {
        process.env.HAPPIER_OPENCODE_PATH = prevOverride;
      } else {
        delete process.env.HAPPIER_OPENCODE_PATH;
      }
      await fixture.cleanup();
    }
  }, 20_000);
});

