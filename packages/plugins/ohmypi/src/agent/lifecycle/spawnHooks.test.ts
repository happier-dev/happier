import { describe, expect, it, vi } from 'vitest';

import { resolveOhMyPiDaemonSpawnPrerequisites } from './spawnHooks.js';

type RunSystemToolResult =
  | Readonly<{
    ok: true;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>
  | Readonly<{
    ok: false;
    errorMessage: string;
  }>;

function createSpawnTools(result: RunSystemToolResult) {
  const runSystemTool = vi.fn(async () => result);
  return {
    tools: { runSystemTool },
    runSystemTool,
  };
}

describe('OhMyPi daemon spawn prerequisites', () => {
  it('denies daemon spawn with the provider-owned no-models diagnostic before shell creation', async () => {
    const fixture = createSpawnTools({
      ok: true,
      exitCode: 0,
      stdout: 'No models available. Set API keys in environment variables.\n',
      stderr: '',
    });

    await expect(resolveOhMyPiDaemonSpawnPrerequisites({
      cwd: '/repo',
      tools: fixture.tools,
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: 'ohmypi_models_unavailable',
      errorMessage: expect.stringContaining('No models available'),
    });

    expect(fixture.runSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'ohmypi-cli',
      args: ['--list-models'],
      cwd: '/repo',
      env: { CI: '1' },
    }));
  });

  it('allows daemon spawn when list-models exposes at least one model', async () => {
    const fixture = createSpawnTools({
      ok: true,
      exitCode: 0,
      stdout: [
        'provider      model                       context  max-out  thinking  images',
        'openai        gpt-5.4                     272K     128K     yes       yes',
      ].join('\n'),
      stderr: '',
    });

    await expect(resolveOhMyPiDaemonSpawnPrerequisites({
      cwd: '/repo',
      tools: fixture.tools,
    })).resolves.toEqual({ ok: true });
  });

  it('passes materialized runtime-selection env to the pre-spawn model probe', async () => {
    const fixture = createSpawnTools({
      ok: true,
      exitCode: 0,
      stdout: [
        'provider      model                       context  max-out  thinking  images',
        'openai        gpt-5.4                     272K     128K     yes       yes',
      ].join('\n'),
      stderr: '',
    });

    await expect(resolveOhMyPiDaemonSpawnPrerequisites({
      cwd: '/repo',
      env: {
        OPENAI_API_KEY: 'sk-materialized',
      },
      tools: fixture.tools,
    })).resolves.toEqual({ ok: true });

    expect(fixture.runSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      env: {
        OPENAI_API_KEY: 'sk-materialized',
        CI: '1',
      },
    }));
  });

  it('denies daemon spawn when list-models only exposes embedding models', async () => {
    const fixture = createSpawnTools({
      ok: true,
      exitCode: 0,
      stdout: [
        'provider  model                    context  max-out  thinking  images',
        'ollama    nomic-embed-text:latest  2.0K     2.0K     -         no',
        'ollama    qwen3-embedding:8b       41K      8.2K     -         no',
      ].join('\n'),
      stderr: '',
    });

    await expect(resolveOhMyPiDaemonSpawnPrerequisites({
      cwd: '/repo',
      tools: fixture.tools,
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: 'ohmypi_models_unavailable',
      errorMessage: expect.stringContaining('chat-capable models'),
    });
  });
});
