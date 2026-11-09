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
    reasonCode?: string;
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

    await expect(resolveOhMyPiDaemonSpawnPrerequisites(
      { cwd: '/repo' },
      { tools: fixture.tools },
    )).resolves.toMatchObject({
      decision: 'deny',
      reasonCode: 'ohmypi_models_unavailable',
      errorMessage: expect.stringContaining('No models available'),
    });

    expect(fixture.runSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'ohmypi-cli',
      args: ['models', '--json'],
      cwd: '/repo',
      env: { CI: '1' },
    }));
  });

  it('allows daemon spawn when list-models exposes at least one model', async () => {
    const fixture = createSpawnTools({
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({ models: [{ provider: 'anthropic', id: 'claude-sonnet-4-5', kind: 'chat', thinking: ['medium'] }] }),
      stderr: '',
    });

    await expect(resolveOhMyPiDaemonSpawnPrerequisites(
      { cwd: '/repo' },
      { tools: fixture.tools },
    )).resolves.toEqual({ decision: 'allow' });
  });

  it('passes materialized runtime-selection env to the pre-spawn model probe', async () => {
    const fixture = createSpawnTools({
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({ models: [{ provider: 'openai', id: 'gpt-5.4', kind: 'chat', thinking: ['medium'] }] }),
      stderr: '',
    });

    await expect(resolveOhMyPiDaemonSpawnPrerequisites(
      {
        cwd: '/repo',
        runtimeSelection: { env: { OPENAI_API_KEY: 'sk-materialized' } },
      },
      { tools: fixture.tools },
    )).resolves.toEqual({ decision: 'allow' });

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
      stdout: JSON.stringify({ models: [{ provider: 'ollama', id: 'nomic-embed-text:latest', kind: 'embedding', thinking: null }] }),
      stderr: '',
    });

    await expect(resolveOhMyPiDaemonSpawnPrerequisites(
      { cwd: '/repo' },
      { tools: fixture.tools },
    )).resolves.toMatchObject({
      decision: 'deny',
      reasonCode: 'ohmypi_models_unavailable',
      errorMessage: expect.stringContaining('chat-capable models'),
    });
  });

  it('treats a list-models timeout as inconclusive and lets the runtime own startup', async () => {
    const fixture = createSpawnTools({
      ok: false,
      reasonCode: 'timeout',
      errorMessage: 'model discovery timed out',
    });

    await expect(resolveOhMyPiDaemonSpawnPrerequisites(
      { cwd: '/repo' },
      { tools: fixture.tools },
    )).resolves.toEqual({ decision: 'allow' });
  });
});
