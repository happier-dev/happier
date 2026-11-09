import { describe, expect, it, vi } from 'vitest';
import { parseOllamaListTable } from '../../../../../packages/plugins/ollama/src/provider/contribution';
import { watch } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createDaemonSpawnToolResolutionContext } from '@/daemon/spawnHooks';

import {
  createProviderLocalCatalogFallbackRunner,
  resolveDeclaredProviderInstallation,
  runDeclaredProviderLocalCommand,
} from './localCommand';
import { createProviderProbeScheduler } from './scheduler';
import { createProviderOperationLifetime } from '../operationLifetime';
import type { ProviderLocalCommandRunner } from './localCommand';

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

  it('preserves shell punctuation as literal argv through the system-tool boundary', async () => {
    const runSystemTool = vi.fn(async () => ({ ok: true as const, exitCode: 0, stdout: '', stderr: '' }));
    await expect(runDeclaredProviderLocalCommand({
      toolId: 'ollama', lookupNames: ['ollama'], fixedArgs: ['serve; rm'], parser: 'exit-zero-running',
    }, { runSystemTool })).resolves.toEqual({ status: 'present' });
    expect(runSystemTool).toHaveBeenCalledWith(expect.objectContaining({ args: ['serve; rm'] }));
  });

  it('observes complete presence output beyond former time and capture cutoffs', async () => {
    vi.useFakeTimers();
    const stdout = JSON.stringify({ status: 'running', details: 'x'.repeat(65 * 1024) });
    const pending = runDeclaredProviderLocalCommand({ toolId: 'lms', lookupNames: ['lms'], fixedArgs: ['status'], parser: 'lms-status-json' }, {
      runSystemTool: request => new Promise(resolve => {
        const success = setTimeout(() => resolve({ ok: true, exitCode: 0, stdout, stderr: '' }), 6_000);
        if (request.timeoutMs !== undefined) setTimeout(() => { clearTimeout(success); resolve({ ok: false, reasonCode: 'timeout' }); }, request.timeoutMs);
      }),
    });
    try { await vi.advanceTimersByTimeAsync(6_000); expect(await pending).toEqual({ status: 'present' }); }
    finally { vi.useRealTimers(); }
  });

  it('cancels the running OS presence command through the containing lifetime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-presence-cancel-'));
    const caller = new AbortController();
    const readyPath = join(directory, 'ready');
    const script = join(directory, 'presence.cjs');
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setInterval(() => {}, 1000);`);
    const watcher = watch(directory);
    const ready = new Promise<void>(resolve => watcher.on('change', (_event, name) => { if (String(name) === 'ready') resolve(); }));
    let execution: ReturnType<ProviderLocalCommandRunner['runSystemTool']> | undefined;
    const runner: ProviderLocalCommandRunner = {
      runSystemTool: ({ signal, ...request }) => {
        execution = createDaemonSpawnToolResolutionContext({ processEnv: { PATH: dirname(process.execPath) }, signal }).runSystemTool(request);
        return execution;
      },
    };
    const pending = runDeclaredProviderLocalCommand({ toolId: basename(process.execPath), lookupNames: [basename(process.execPath)],
      fixedArgs: [script], parser: 'exit-zero-running' }, runner, createProviderOperationLifetime({ signal: caller.signal }))
      .then(value => ({ value }), (error: unknown) => ({ error }));
    try {
      await ready;
      caller.abort();
      expect(await pending).toMatchObject({ error: { reason: 'cancelled' } });
      await expect(execution).resolves.toMatchObject({ ok: false, reasonCode: 'aborted' });
    } finally {
      caller.abort();
      watcher.close();
      await pending;
      await execution;
      await rm(directory, { recursive: true, force: true });
    }
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

  it.each([false, true])('uses the catalog lifetime for a slow command and caller cancellation (cancel=%s)', async cancelled => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let complete!: () => void;
    let commandSignal: AbortSignal | undefined;
    const fallback = createProviderLocalCatalogFallbackRunner({ runner: {
      runSystemTool: request => new Promise(resolve => {
        // This is the OS command boundary: it obeys the timeout/signal supplied
        // by the real catalog owner rather than simulating internal policy.
        commandSignal = (request as typeof request & { signal?: AbortSignal }).signal;
        const timer = request.timeoutMs === undefined ? undefined : setTimeout(() => resolve({ ok: false, reasonCode: 'timeout' }), request.timeoutMs);
        complete = () => { clearTimeout(timer); resolve({ ok: true, exitCode: 0,
          stdout: 'NAME ID SIZE MODIFIED\nslow-model id 1 GB now\n', stderr: '' }); };
        commandSignal?.addEventListener('abort', () => { clearTimeout(timer);
          resolve({ ok: false, reasonCode: 'aborted' }); }, { once: true });
      }),
    } satisfies ProviderLocalCommandRunner });
    const request = { contributedCatalogParsers: { 'ollama-list-table': parseOllamaListTable }, descriptor, endpointUrl: 'http://127.0.0.1:11434/',
      lifetime: createProviderOperationLifetime({ wallTimeMs: 30_000, signal: caller.signal }) };
    const pending = fallback.run(request).then(value => ({ value }), error => ({ reason: error.reason }));
    try {
      await vi.advanceTimersByTimeAsync(cancelled ? 1_000 : 6_000);
      if (cancelled) { caller.abort(); complete(); }
      else complete();
      expect(await pending).toEqual(cancelled ? { reason: 'cancelled' }
        : { value: { status: 'success', models: [{ id: 'slow-model', name: 'slow-model' }] } });
      if (cancelled) expect(commandSignal?.aborted).toBe(true);
    } finally { complete?.(); await pending; vi.useRealTimers(); }
  });

  it('uses the catalog lifetime size boundary for valid command output beyond the former local cap', async () => {
    const fallback = createProviderLocalCatalogFallbackRunner({ runner: {
      runSystemTool: async () => ({ ok: true, exitCode: 0,
        stdout: `NAME ID SIZE MODIFIED\n${' '.repeat(1024 * 1024)}valid-model id 1 GB now\n`, stderr: '' }),
    } });
    await expect(fallback.run({ contributedCatalogParsers: { 'ollama-list-table': parseOllamaListTable }, descriptor, endpointUrl: 'http://127.0.0.1:11434/' }))
      .resolves.toMatchObject({ status: 'success', models: [{ id: 'valid-model' }] });
  });

  it('accepts complete command output beyond the former five-MiB capture cap', async () => {
    const fallback = createProviderLocalCatalogFallbackRunner({ runner: {
      runSystemTool: async () => ({ ok: true, exitCode: 0,
        stdout: 'x'.repeat(5 * 1024 * 1024 + 1), stderr: '' }),
    } });
    await expect(fallback.run({
      descriptor: { ...descriptor, parser: 'acme-list-v1' }, endpointUrl: 'http://127.0.0.1:11434/',
      contributedCatalogParsers: { 'acme-list-v1': () => ({ models: [{ id: 'partial-model' }] }) },
    })).resolves.toEqual({ status: 'success', models: [{ id: 'partial-model', name: 'partial-model' }] });
  });

  it('parses the official Ollama table and supplies only the declared endpoint environment', async () => {
    const runSystemTool = vi.fn(async () => ({
      ok: true as const,
      exitCode: 0,
      stdout: 'NAME                 ID              SIZE      MODIFIED\nqwen3:8b             abc123          5.2 GB    2 hours ago\ngpt-oss:20b          def456          13 GB     1 day ago\n',
      stderr: '',
    }));
    const fallback = createProviderLocalCatalogFallbackRunner({ runner: { runSystemTool } });

    await expect(fallback.run({ contributedCatalogParsers: { 'ollama-list-table': parseOllamaListTable },
      descriptor: { ...descriptor, fixedArgs: ['list', 'literal; & | $()'] },
      endpointUrl: 'http://127.0.0.1:22434/',
    })).resolves.toEqual({
      status: 'success',
      models: [{ id: 'qwen3:8b', name: 'qwen3:8b' }, { id: 'gpt-oss:20b', name: 'gpt-oss:20b' }],
    });
    expect(runSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      lookupNames: ['ollama'],
      args: ['list', 'literal; & | $()'],
      env: { OLLAMA_HOST: 'http://127.0.0.1:22434/' },
    }));
  });

  it('observes changed command output between explicit scheduler refreshes', async () => {
    let modelId = 'model-a';
    const runSystemTool = vi.fn(async () => ({
      ok: true as const, exitCode: 0, stdout: `NAME ID SIZE MODIFIED\n${modelId} id 1 GB now\n`, stderr: '',
    }));
    const fallback = createProviderLocalCatalogFallbackRunner({ runner: { runSystemTool } });
    const scheduler = createProviderProbeScheduler();
    const input = { contributedCatalogParsers: { 'ollama-list-table': parseOllamaListTable }, descriptor, endpointUrl: 'http://127.0.0.1:11434/' };
    const refresh = () => scheduler.runCatalog('local-catalog', 'manual_refresh', () => fallback.run(input), {
      unavailable: () => ({ status: 'unavailable' as const }),
    });
    await expect(refresh()).resolves.toEqual({ status: 'success', models: [{ id: 'model-a', name: 'model-a' }] });
    modelId = 'model-b';
    await expect(refresh()).resolves.toEqual({ status: 'success', models: [{ id: 'model-b', name: 'model-b' }] });
    expect(runSystemTool).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed and duplicate output without returning a partial catalog', async () => {
    const outputs = [
      'not the expected header\nmodel-a id 1 GB now\n',
      'NAME ID SIZE MODIFIED\nmodel-a id 1 GB now\nmodel-a id2 2 GB now\n',
    ];
    const runSystemTool = vi.fn(async () => ({
      ok: true as const, exitCode: 0, stdout: outputs.shift()!, stderr: '',
    }));
    const fallback = createProviderLocalCatalogFallbackRunner({ runner: { runSystemTool } });
    await expect(fallback.run({ contributedCatalogParsers: { 'ollama-list-table': parseOllamaListTable }, descriptor, endpointUrl: 'http://127.0.0.1:11434/' }))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(fallback.run({ contributedCatalogParsers: { 'ollama-list-table': parseOllamaListTable }, descriptor, endpointUrl: 'http://127.0.0.1:11434/' }))
      .resolves.toEqual({ status: 'unavailable' });
  });

  it('runs a Provider-contributed command format and never falls back to another format', async () => {
    // A Provider plugin whose CLI prints a format Happier does not bundle
    // declares that format and supplies its implementation, exactly as it does
    // for an HTTP catalog format.
    const contributedDescriptor = {
      endpointTemplateId: 'acme',
      lookupNames: ['acme'],
      fixedArgs: ['models', '--plain'],
      parser: 'acme-list-v1',
    };
    const contributedCatalogParsers = {
      'acme-list-v1': (input: unknown) => ({
        models: String(input).split('\n').filter(Boolean).map((line) => {
          const [id, name] = line.split('|');
          return { id: id!, name: name! };
        }),
      }),
    };
    const runSystemTool = vi.fn(async () => ({
      ok: true as const,
      exitCode: 0,
      stdout: 'acme/one|Acme One\nacme/two|Acme Two\n',
      stderr: '',
    }));
    const fallback = createProviderLocalCatalogFallbackRunner({ runner: { runSystemTool } });

    await expect(fallback.run({
      descriptor: contributedDescriptor,
      endpointUrl: 'http://127.0.0.1:9911/',
      contributedCatalogParsers,
    })).resolves.toEqual({
      status: 'success',
      models: [{ id: 'acme/one', name: 'Acme One' }, { id: 'acme/two', name: 'Acme Two' }],
    });

    // Without the declaring plugin's implementation the output is reported
    // unavailable rather than handed to a bundled format's parser.
    await expect(fallback.run({ contributedCatalogParsers: { 'ollama-list-table': parseOllamaListTable },
      descriptor: { ...contributedDescriptor, endpointTemplateId: 'acme-2' },
      endpointUrl: 'http://127.0.0.1:9911/',
    })).resolves.toEqual({ status: 'unavailable' });
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

    await expect(fallback.run({ contributedCatalogParsers: { 'ollama-list-table': parseOllamaListTable }, descriptor, endpointUrl: 'http://127.0.0.1:11434/' }))
      .resolves.toEqual({ status: 'unavailable' });
  });
});
