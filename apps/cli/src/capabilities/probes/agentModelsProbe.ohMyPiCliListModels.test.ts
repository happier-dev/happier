import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createProbeTempDir } from './agentModelsProbe.testkit';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { withAgentPreflightCatalog } from './withAgentPreflightCatalog';

describe('probeAgentModelsBestEffort (OhMyPi preflight)', () => {
  it('uses the OhMyPi plugin preflight contribution for source-real dynamic models', async () => {
    const fixture = await createProbeTempDir('happier-ohmypi-cli-list-models');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const scriptPath = join(binDir, 'omp.cjs');
    await writeFile(scriptPath, [
      'if (process.argv[2] === "--version") { process.stdout.write("1.0.0\\n"); process.exit(0); }',
      'if (process.argv[2] !== "--list-models") process.exit(1);',
      'process.stdout.write("provider      model                       context  max-out  thinking  images\\nopenai        gpt-5.4                     272K     128K     yes       yes\\nanthropic     claude-3-7-sonnet-latest    200K     64K      no        yes\\n");',
    ].join('\n'));
    const ompPath = await writeExecutableShim({ dir: binDir,
      fileName: process.platform === 'win32' ? 'omp.cmd' : 'omp',
      contents: process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    });

    const prevPath = process.env.PATH;
    const prevOverride = process.env.HAPPIER_OHMYPI_PATH;
    const prevOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    process.env.HAPPIER_OHMYPI_PATH = ompPath;
    process.env.OPENAI_API_KEY = 'sk-test';
    let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    try {
      runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        runtimeOptions: { pluginIds: ['happier.agent.ohmypi'] },
      });
      const { probeAgentModelsBestEffort } = await import('./agentModelsProbe');

      const result = await withAgentPreflightCatalog({ agentId: 'ohMyPi' }, async context =>
        await probeAgentModelsBestEffort({ agentId: 'ohMyPi', cwd: fixture.dir, timeoutMs: 2_000,
          catalogEntry: context.catalogEntry, runtimeCacheKey: context.runtimeCacheKey }));
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
      await runtime?.dispose();
      process.env.PATH = prevPath;
      if (typeof prevOverride === 'string') {
        process.env.HAPPIER_OHMYPI_PATH = prevOverride;
      } else {
        delete process.env.HAPPIER_OHMYPI_PATH;
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
