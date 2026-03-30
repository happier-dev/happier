import { describe, expect, it, vi } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { createProbeTempDir, writeExecutableScript } from './agentModelsProbe.testkit';

describe('probeAgentModelsBestEffort (pi preflight)', () => {
  it('parses models from `pi --list-models` even when Pi prints the table to stderr', async () => {
    vi.resetModules();

    const fixture = await createProbeTempDir('happier-pi-cli-list-models');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const piPath = resolve(join(binDir, 'pi'));
    await writeExecutableScript(
      piPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--list-models') {
  process.stderr.write('provider      model                       context  max-out  thinking  images\\n');
  process.stderr.write('openai-codex  gpt-5.4                     272K     128K     yes       yes\\n');
  process.stderr.write('anthropic     claude-3-7-sonnet-latest    200K     64K      yes       yes\\n');
  process.exit(0);
}
process.exit(1);
`,
    );

    const prevPath = process.env.PATH;
    const prevOverride = process.env.HAPPIER_PI_PATH;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    delete process.env.HAPPIER_PI_PATH;
    try {
      const { probeAgentModelsBestEffort } = await import('./agentModelsProbe');

      const result = await probeAgentModelsBestEffort({ agentId: 'pi', cwd: fixture.dir, timeoutMs: 2_000 });
      expect(result.source).toBe('dynamic');
      const ids = result.availableModels.map((m) => m.id);
      expect(ids).toContain('openai-codex/gpt-5.4');
      expect(ids).toContain('anthropic/claude-3-7-sonnet-latest');
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevOverride === 'string') {
        process.env.HAPPIER_PI_PATH = prevOverride;
      } else {
        delete process.env.HAPPIER_PI_PATH;
      }
      await fixture.cleanup();
    }
  }, 20_000);
});
