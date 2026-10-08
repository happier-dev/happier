import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { withAgentPreflightCatalog } from './withAgentPreflightCatalog';

import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';

const runtime = await createAdmittedPluginRuntimeFixture({
  controller: pluginReloadController, runtimeOptions: { pluginIds: ['happier.agent.opencode'] },
});
afterAll(async () => { await runtime.dispose(); });

async function createNativeProbe(tempDir: string, requireSanitizedEnvironment = false) {
  const counterPath = join(tempDir, 'counter.txt');
  const scriptPath = join(tempDir, 'opencode.cjs');
  const fileName = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
  const expectedEnvironment = {
    PATH: requireSanitizedEnvironment ? '/required/cold-probe/path' : process.env.PATH,
    HAPPIER_OPENCODE_PATH: join(tempDir, fileName), HAPPIER_JS_RUNTIME_PATH: process.execPath,
  };
  // The executable is the OS boundary; the real admitted plugin selects the
  // command and owns environment custody, parsing, and model semantics.
  await writeFile(scriptPath, [
    'const fs = require("node:fs"); const args = process.argv.slice(2);',
    'if (args[0] === "--version") { process.stdout.write("2.0.0\\n"); process.exit(0); }',
    'if (args[0] !== "api" || args[1] !== "get" || args[2] !== "/api/model") process.exit(42);',
    `const expectedEnvironment = ${JSON.stringify(expectedEnvironment)};`,
    `const requireSanitizedEnvironment = ${JSON.stringify(requireSanitizedEnvironment)};`,
    'const hasExpectedEnvironment = Object.entries(expectedEnvironment).every(([key, value]) => process.env[key] === value);',
    'const hasNoAmbientCredentials = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_API_KEY", "OPENAI_ACCESS_TOKEN", "HAPPIER_CLIPROXYAPI_REQUEST_AUTH_CAPABILITY_PATH"].every(key => process.env[key] === undefined);',
    'if (requireSanitizedEnvironment && (!hasExpectedEnvironment || !hasNoAmbientCredentials)) process.exit(41);',
    `const counterPath = ${JSON.stringify(counterPath)};`,
    'const current = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) : 0;',
    'fs.writeFileSync(counterPath, String(current + 1));',
    'process.stdout.write(JSON.stringify({ data: [{ providerID: "openai", id: "gpt-4.1", name: "GPT 4.1" }, { providerID: "openai", id: "gpt-4.1-mini", name: "GPT 4.1 mini" }] }));',
  ].join('\n'));
  await writeExecutableShim({ dir: tempDir, fileName, contents: process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n` });
  return { counterPath, env: { ...process.env, ...expectedEnvironment } };
}

async function probe(cwd: string, env: NodeJS.ProcessEnv) {
  return await withAgentPreflightCatalog({ agentId: 'opencode' }, async context =>
    await probeAgentModelsBestEffort({ agentId: 'opencode', cwd, env, timeoutMs: 2_000,
      catalogEntry: context.catalogEntry, runtimeCacheKey: context.runtimeCacheKey }));
}

describe('probeAgentModelsBestEffort (cache)', () => {
  it('caches dynamic CLI results and avoids re-running the CLI probe', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-agent-model-probe-cache-'));
    try {
      const nativeProbe = await createNativeProbe(tempDir);

      resetAgentModelsProbeCacheForTests();

      const first = await probe(tempDir, nativeProbe.env);
      expect(first.source).toBe('dynamic');
      expect(first.availableModels.map((model) => model.id)).toEqual(['default', 'openai/gpt-4.1', 'openai/gpt-4.1-mini']);

      const second = await probe(tempDir, nativeProbe.env);
      expect(second.source).toBe('dynamic');
      expect(second.availableModels.map((model) => model.id)).toEqual(['default', 'openai/gpt-4.1', 'openai/gpt-4.1-mini']);
      await expect(readFile(nativeProbe.counterPath, 'utf8')).resolves.toBe('1');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('passes only approved runtime values to direct CLI probes', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-agent-model-probe-cold-environment-'));

    try {
      const nativeProbe = await createNativeProbe(tempDir, true);
      resetAgentModelsProbeCacheForTests();

      const result = await probe(tempDir, {
          ...nativeProbe.env,
          OPENAI_API_KEY: 'ambient-openai-api-key',
          ANTHROPIC_API_KEY: 'ambient-anthropic-api-key',
          CODEX_API_KEY: 'ambient-codex-api-key',
          OPENAI_ACCESS_TOKEN: 'ambient-openai-access-token',
          HAPPIER_CLIPROXYAPI_REQUEST_AUTH_CAPABILITY_PATH: '/private/cliproxy-capability.json',
      });

      expect(result).toMatchObject({
        agentId: 'opencode',
        source: 'dynamic',
      });
      expect(result.availableModels.map((model) => model.id)).toEqual(['default', 'openai/gpt-4.1', 'openai/gpt-4.1-mini']);
      await expect(readFile(nativeProbe.counterPath, 'utf8')).resolves.toBe('1');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});
