import { mkdir } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createProbeTempDir, writeExecutableScript } from './agentModelsProbe.testkit';

describe('probeAgentModelsBestEffort (OhMyPi preflight)', () => {
  it('uses the OhMyPi plugin preflight contribution for source-real dynamic models', async () => {
    vi.resetModules();

    const fixture = await createProbeTempDir('happier-ohmypi-cli-list-models');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const ompPath = resolve(join(binDir, 'omp'));
    await writeExecutableScript(
      ompPath,
      `#!/bin/sh
if [ "$1" = "--list-models" ]; then
  printf '%s\\n' 'provider      model                       context  max-out  thinking  images'
  printf '%s\\n' 'openai        gpt-5.4                     272K     128K     yes       yes'
  printf '%s\\n' 'anthropic     claude-3-7-sonnet-latest    200K     64K      no        yes'
  exit 0
fi
exit 1
`,
    );

    const prevPath = process.env.PATH;
    const prevOverride = process.env.HAPPIER_OH_MY_PI_PATH;
    const prevOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    delete process.env.HAPPIER_OH_MY_PI_PATH;
    process.env.OPENAI_API_KEY = 'sk-test';
    try {
      const { probeAgentModelsBestEffort } = await import('./agentModelsProbe');

      const result = await probeAgentModelsBestEffort({ agentId: 'ohMyPi', cwd: fixture.dir, timeoutMs: 2_000 });
      expect(result.source).toBe('dynamic');
      expect(result.availableModels).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'openai/gpt-5.4',
          modelOptions: expect.arrayContaining([
            expect.objectContaining({ id: 'reasoning_effort' }),
          ]),
        }),
        expect.objectContaining({
          id: 'anthropic/claude-3-7-sonnet-latest',
        }),
      ]));
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevOverride === 'string') {
        process.env.HAPPIER_OH_MY_PI_PATH = prevOverride;
      } else {
        delete process.env.HAPPIER_OH_MY_PI_PATH;
      }
      if (typeof prevOpenAiApiKey === 'string') {
        process.env.OPENAI_API_KEY = prevOpenAiApiKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
      await fixture.cleanup();
    }
  }, 60_000);
});
