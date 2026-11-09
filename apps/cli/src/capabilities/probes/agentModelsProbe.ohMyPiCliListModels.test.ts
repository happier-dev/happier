import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createProbeTempDir } from './agentModelsProbe.testkit';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { withAgentPreflightCatalog } from './withAgentPreflightCatalog';

describe('probeAgentModelsBestEffort (Pi and Oh My Pi native candidate provenance)', () => {
  it.each([
    { agentId: 'ohMyPi', pluginId: 'happier.agent.ohmypi', executableName: 'omp', overrideKey: 'HAPPIER_OHMYPI_PATH',
      script: [
        'if (process.argv[2] !== "models" || process.argv[3] !== "--json") process.exit(1);',
        `process.stdout.write(JSON.stringify({ models: [
          { provider: 'openai', id: 'gpt-5.4', kind: 'chat', thinking: ['low', 'high'] },
          { provider: 'anthropic', id: 'claude-3-7-sonnet-latest', kind: 'chat', thinking: [] },
        ] }));`,
      ] },
    { agentId: 'pi', pluginId: 'happier.agent.pi', executableName: 'pi', overrideKey: 'HAPPIER_PI_PATH',
      script: [
        'if (process.argv[2] !== "--mode" || process.argv[3] !== "json" || !process.argv.includes("--no-session")) process.exit(1);',
        `process.stderr.write(JSON.stringify({ type: 'happier-pi-model-catalog', models: [
          { provider: 'openai', id: 'gpt-5.4', name: 'GPT', reasoning: true },
          { provider: 'anthropic', id: 'claude-3-7-sonnet-latest', name: 'Claude', reasoning: false },
        ] }) + '\\n');`,
      ] },
  ])('preserves $agentId candidate diagnostics as static through the actual host preflight ingress', async agent => {
    const fixture = await createProbeTempDir(`happier-${agent.agentId}-cli-list-models`);
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const scriptPath = join(binDir, 'omp.cjs');
    await writeFile(scriptPath, [
      'if (process.argv[2] === "--version") { process.stdout.write("0.82.1\\n"); process.exit(0); }',
      ...agent.script,
    ].join('\n'));
    const ompPath = await writeExecutableShim({ dir: binDir,
      fileName: process.platform === 'win32' ? `${agent.executableName}.cmd` : agent.executableName,
      contents: process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    });

    const prevPath = process.env.PATH;
    const prevOverride = process.env[agent.overrideKey];
    const prevOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    process.env[agent.overrideKey] = ompPath;
    process.env.OPENAI_API_KEY = 'sk-test';
    let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    try {
      runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        runtimeOptions: { pluginIds: [agent.pluginId] },
      });
      const { probeAgentModelsBestEffort } = await import('./agentModelsProbe');

      const result = await withAgentPreflightCatalog({ agentId: agent.agentId }, async context =>
        await probeAgentModelsBestEffort({ agentId: agent.agentId, cwd: fixture.dir, timeoutMs: 2_000,
          catalogEntry: context.catalogEntry, runtimeCacheKey: context.runtimeCacheKey }));
      expect(result.source).toBe('static');
      expect(result.observedAt).toBeUndefined();
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
        process.env[agent.overrideKey] = prevOverride;
      } else {
        delete process.env[agent.overrideKey];
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
