import { describe, expect, it, vi } from 'vitest';

import {
  createProviderLocalCatalogFallbackRunner,
  resolveDeclaredProviderInstallation,
  runDeclaredProviderLocalCommand,
} from './localCommand';

describe('runDeclaredProviderLocalCommand', () => {
  it('runs literal argv through the canonical system-tool port without a shell', async () => {
    const runSystemTool = vi.fn(async () => ({ ok: true as const, exitCode: 0, stdout: '', stderr: '' }));
    await expect(runDeclaredProviderLocalCommand({
      toolId: 'ollama',
      lookupNames: ['ollama'],
      fixedArgs: ['list'],
      parser: 'exit-zero-running',
    }, { runSystemTool })).resolves.toEqual({ status: 'present' });
    expect(runSystemTool).toHaveBeenCalledWith(expect.objectContaining({ args: ['list'] }));
  });

  it('maps canonical tool resolution/execution refusal to absent without inspecting diagnostics', async () => {
    await expect(runDeclaredProviderLocalCommand({
      toolId: 'ollama', lookupNames: ['ollama'], fixedArgs: ['list'], parser: 'exit-zero-running',
    }, {
      runSystemTool: async () => ({ ok: false, reasonCode: 'tool_unavailable' }),
    })).resolves.toEqual({ status: 'absent' });
  });

  it('rejects shell operators before invoking the runner', async () => {
    const runSystemTool = vi.fn();
    await expect(runDeclaredProviderLocalCommand({
      toolId: 'ollama', lookupNames: ['ollama'], fixedArgs: ['serve; rm'], parser: 'exit-zero-running',
    }, { runSystemTool })).rejects.toThrow('literal');
    expect(runSystemTool).not.toHaveBeenCalled();
  });
});

describe('resolveDeclaredProviderInstallation', () => {
  it('uses binary-safe system-tool resolution without executing the binary', async () => {
    const resolveSystemTool = vi.fn(async () => ({ ok: true as const, command: '/usr/bin/ollama', args: [], source: 'system' as const }));
    await expect(resolveDeclaredProviderInstallation({
      toolId: 'provider-installation:ollama', lookupNames: ['ollama'],
    }, { resolveSystemTool })).resolves.toEqual({ status: 'present' });
    expect(resolveSystemTool).toHaveBeenCalledWith({
      toolId: 'provider-installation:ollama', lookupNames: ['ollama'], reason: 'provider local installation check',
    });
  });

  it('reports absent for an unavailable bounded descriptor', async () => {
    await expect(resolveDeclaredProviderInstallation({
      toolId: 'provider-installation:ollama', lookupNames: ['ollama'],
    }, {
      resolveSystemTool: vi.fn(async () => ({ ok: false as const, reasonCode: 'tool_unavailable' })),
    })).resolves.toEqual({ status: 'absent' });
  });
});

describe('createProviderLocalCatalogFallbackRunner', () => {
  const descriptor = {
    endpointTemplateId: 'ollama-native',
    lookupNames: ['ollama'],
    fixedArgs: ['list'],
    parser: 'ollama-list-table' as const,
    endpointEnvName: 'OLLAMA_HOST',
  };

  it('parses the official Ollama table and supplies only the declared endpoint environment', async () => {
    const runSystemTool = vi.fn(async () => ({
      ok: true as const,
      exitCode: 0,
      stdout: 'NAME                 ID              SIZE      MODIFIED\nqwen3:8b             abc123          5.2 GB    2 hours ago\ngpt-oss:20b          def456          13 GB     1 day ago\n',
      stderr: '',
    }));
    const fallback = createProviderLocalCatalogFallbackRunner({ runner: { runSystemTool } });

    await expect(fallback.run({
      descriptor,
      endpointUrl: 'http://127.0.0.1:22434/',
    })).resolves.toEqual({
      status: 'success',
      models: [{ id: 'qwen3:8b', name: 'qwen3:8b' }, { id: 'gpt-oss:20b', name: 'gpt-oss:20b' }],
    });
    expect(runSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      lookupNames: ['ollama'],
      args: ['list'],
      env: { OLLAMA_HOST: 'http://127.0.0.1:22434/' },
      timeoutMs: 5_000,
    }));
  });

  it('single-flights and caches command results for at least thirty seconds', async () => {
    let now = 10_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runSystemTool = vi.fn(async () => {
      await gate;
      return { ok: true as const, exitCode: 0, stdout: 'NAME ID SIZE MODIFIED\nmodel-a id 1 GB now\n', stderr: '' };
    });
    const fallback = createProviderLocalCatalogFallbackRunner({ runner: { runSystemTool }, now: () => now });
    const input = { descriptor, endpointUrl: 'http://127.0.0.1:11434/' };
    const first = fallback.run(input);
    const second = fallback.run(input);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'success', models: [{ id: 'model-a', name: 'model-a' }] },
      { status: 'success', models: [{ id: 'model-a', name: 'model-a' }] },
    ]);
    expect(runSystemTool).toHaveBeenCalledTimes(1);
    await fallback.run(input);
    expect(runSystemTool).toHaveBeenCalledTimes(1);
    now += 30_001;
    await fallback.run(input);
    expect(runSystemTool).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed, duplicate, and over-limit output without returning a partial catalog', async () => {
    const outputs = [
      'not the expected header\nmodel-a id 1 GB now\n',
      'NAME ID SIZE MODIFIED\nmodel-a id 1 GB now\nmodel-a id2 2 GB now\n',
    ];
    const runSystemTool = vi.fn(async () => ({
      ok: true as const, exitCode: 0, stdout: outputs.shift()!, stderr: '',
    }));
    const fallback = createProviderLocalCatalogFallbackRunner({ runner: { runSystemTool }, now: (() => {
      let value = 0;
      return () => (value += 31_000);
    })() });
    await expect(fallback.run({ descriptor, endpointUrl: 'http://127.0.0.1:11434/' }))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(fallback.run({ descriptor, endpointUrl: 'http://127.0.0.1:11434/' }))
      .resolves.toEqual({ status: 'unavailable' });
  });

  it('rejects a truncated data row instead of accepting its first token as a model', async () => {
    const fallback = createProviderLocalCatalogFallbackRunner({
      runner: {
        runSystemTool: async () => ({
          ok: true as const,
          exitCode: 0,
          stdout: 'NAME                 ID              SIZE      MODIFIED\ntruncated-model\n',
          stderr: '',
        }),
      },
    });

    await expect(fallback.run({ descriptor, endpointUrl: 'http://127.0.0.1:11434/' }))
      .resolves.toEqual({ status: 'unavailable' });
  });
});
