import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { claudePreflightModelsProbeAdapter } from '@/backends/claude/preflight/claudePreflightModelsProbeAdapter';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { logger } from '@/ui/logger';
import { withCatalogProbeLifecycle, type NativeCatalogCleanup } from '@/capabilities/probes/catalogProbeLifecycle';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  probeClaudeInstalledRuntimeCapabilities,
  resetClaudeInstalledRuntimeCapabilitiesCacheForTests,
  resolveClaudeInstalledRuntimeSessionMode,
  resolveClaudeInstalledRuntimeSessionOptions,
  resolveInstalledClaudeCliIdentity,
} from './probeClaudeInstalledRuntimeCapabilities';

/** Pin the binary identity so these assertions do not depend on the CLI installed on this machine. */
const INSTALLED_CLI = { resolveInstalledCliIdentity: () => 'claude@fingerprint-1' } as const;

describe('probeClaudeInstalledRuntimeCapabilities', () => {
  beforeEach(() => {
    resetClaudeInstalledRuntimeCapabilitiesCacheForTests();
  });

  it('requires generic effort support before probing ultracode', async () => {
    const probe = vi.fn(async () => 'Claude Code help without the flag');

    await expect(probeClaudeInstalledRuntimeCapabilities({ cwd: '/', timeoutMs: 250 }, probe, INSTALLED_CLI))
      .resolves.toEqual({ supportsEffort: false, supportsUltracode: false });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('recognizes ultracode only when the installed parser rejects a sentinel but accepts ultracode', async () => {
    const probe = vi.fn(async ({ args }: Readonly<{ args: readonly string[] }>) => {
      const effort = args[0] === '--effort' ? args[1] : null;
      if (effort === 'happier-ultracode-probe-invalid') {
        return "Warning: Unknown --effort value 'happier-ultracode-probe-invalid' — ignoring it. Valid values: low, medium, high, xhigh, max.\n--effort <level>";
      }
      return '--effort <level>';
    });

    await expect(probeClaudeInstalledRuntimeCapabilities({ cwd: '/', timeoutMs: 250 }, probe, INSTALLED_CLI))
      .resolves.toEqual({ supportsEffort: true, supportsUltracode: true });
  });

  it('does not infer ultracode from generic effort or a permissive/failed sentinel probe', async () => {
    const probe = vi.fn(async ({ args }: Readonly<{ args: readonly string[] }>) => {
      if (args[0] !== '--effort') return '--effort <level>';
      if (args[1] === 'ultracode') {
        return "Warning: Unknown --effort value 'ultracode' — ignoring it. Valid values: low, medium, high, xhigh, max.";
      }
      return null;
    });

    await expect(probeClaudeInstalledRuntimeCapabilities({ cwd: '/', timeoutMs: 250 }, probe, INSTALLED_CLI))
      .resolves.toEqual({ supportsEffort: true, supportsUltracode: false });
  });

  it('recognizes unknown-value warnings that use double quotes', async () => {
    const probe = vi.fn(async ({ args }: Readonly<{ args: readonly string[] }>) => {
      if (args[0] !== '--effort') return '--effort <level>';
      if (args[1] === 'ultracode') return '--effort <level>';
      return `Warning: Unknown --effort value "${args[1]}" — ignoring it. Valid values: low, medium, high, xhigh, max.`;
    });

    await expect(probeClaudeInstalledRuntimeCapabilities({ cwd: '/', timeoutMs: 250 }, probe, INSTALLED_CLI))
      .resolves.toEqual({ supportsEffort: true, supportsUltracode: true });
  });

  it('fails ultracode closed when an installed-parser probe rejects', async () => {
    const probe = vi.fn(async ({ args }: Readonly<{ args: readonly string[] }>) => {
      if (args[0] !== '--effort') return '--effort <level>';
      throw new Error('probe failed');
    });

    await expect(probeClaudeInstalledRuntimeCapabilities({ cwd: '/', timeoutMs: 250 }, probe, INSTALLED_CLI))
      .resolves.toEqual({ supportsEffort: true, supportsUltracode: false });
  });

  it('spawns one probe set for concurrent and repeated callers of the same installed binary', async () => {
    const probe = vi.fn(async ({ args }: Readonly<{ args: readonly string[] }>) => {
      if (args[0] !== '--effort') return '--effort <level>';
      if (args[1] === 'ultracode') return '--effort <level>';
      return `Warning: Unknown --effort value '${args[1]}' — ignoring it. Valid values: low, medium, high, xhigh, max.`;
    });
    const options = { resolveInstalledCliIdentity: () => 'claude@fingerprint-1' };

    // Session start resolves this from several owners at once, and the chip surfaces re-open it
    // against a different cwd; `--help` is a property of the binary, not of the cwd.
    const concurrent = await Promise.all([
      probeClaudeInstalledRuntimeCapabilities({ cwd: '/worktree-a', timeoutMs: 250 }, probe, options),
      probeClaudeInstalledRuntimeCapabilities({ cwd: '/worktree-b', timeoutMs: 250 }, probe, options),
      probeClaudeInstalledRuntimeCapabilities({ cwd: '/worktree-c', timeoutMs: 250 }, probe, options),
    ]);

    expect(concurrent).toEqual([
      { supportsEffort: true, supportsUltracode: true },
      { supportsEffort: true, supportsUltracode: true },
      { supportsEffort: true, supportsUltracode: true },
    ]);
    expect(probe).toHaveBeenCalledTimes(3);

    await expect(probeClaudeInstalledRuntimeCapabilities({ cwd: '/worktree-d', timeoutMs: 250 }, probe, options))
      .resolves.toEqual({ supportsEffort: true, supportsUltracode: true });
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('re-probes when the installed binary changes underneath the same path', async () => {
    const probe = vi.fn(async () => '--effort <level>');
    let fingerprint = 'claude@fingerprint-1';

    await probeClaudeInstalledRuntimeCapabilities(
      { cwd: '/worktree-a', timeoutMs: 250 },
      probe,
      { resolveInstalledCliIdentity: () => fingerprint },
    );
    expect(probe).toHaveBeenCalledTimes(3);

    fingerprint = 'claude@fingerprint-2';
    await probeClaudeInstalledRuntimeCapabilities(
      { cwd: '/worktree-a', timeoutMs: 250 },
      probe,
      { resolveInstalledCliIdentity: () => fingerprint },
    );
    expect(probe).toHaveBeenCalledTimes(6);
  });

  it('does not cache an answer whose probe could not run the installed CLI', async () => {
    const probe = vi.fn(async () => null);

    await expect(probeClaudeInstalledRuntimeCapabilities({ cwd: '/gone', timeoutMs: 250 }, probe, INSTALLED_CLI))
      .resolves.toEqual({ supportsEffort: false, supportsUltracode: false });
    expect(probe).toHaveBeenCalledTimes(1);

    // A spawn that never produced parser output is not evidence about the binary. Caching it would
    // pin `supportsEffort: false` onto a runtime that does support it for the whole TTL.
    await expect(probeClaudeInstalledRuntimeCapabilities({ cwd: '/present', timeoutMs: 250 }, probe, INSTALLED_CLI))
      .resolves.toEqual({ supportsEffort: false, supportsUltracode: false });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('does not cache a fail-closed ultracode answer produced by a probe that never answered', async () => {
    const probe = vi.fn(async ({ args }: Readonly<{ args: readonly string[] }>) => (
      args[0] === '--effort' ? null : '--effort <level>'
    ));

    await expect(probeClaudeInstalledRuntimeCapabilities({ cwd: '/w', timeoutMs: 250 }, probe, INSTALLED_CLI))
      .resolves.toEqual({ supportsEffort: true, supportsUltracode: false });
    expect(probe).toHaveBeenCalledTimes(3);

    await probeClaudeInstalledRuntimeCapabilities({ cwd: '/w', timeoutMs: 250 }, probe, INSTALLED_CLI);
    expect(probe).toHaveBeenCalledTimes(6);
  });

  it('never caches or serves an answer for a binary that cannot be fingerprinted', async () => {
    const probe = vi.fn(async () => '--effort <level>');
    const unfingerprintable = { resolveInstalledCliIdentity: () => null };

    await probeClaudeInstalledRuntimeCapabilities({ cwd: '/w', timeoutMs: 250 }, probe, unfingerprintable);
    expect(probe).toHaveBeenCalledTimes(3);

    // A missing/unreadable binary is an absence of identity, not an identity of its own. Folding it
    // onto a placeholder key would pin one moment's answer onto every later moment — including the
    // one after the binary becomes readable again — for the whole TTL.
    await probeClaudeInstalledRuntimeCapabilities({ cwd: '/w', timeoutMs: 250 }, probe, unfingerprintable);
    expect(probe).toHaveBeenCalledTimes(6);

    await probeClaudeInstalledRuntimeCapabilities({ cwd: '/w', timeoutMs: 250 }, probe, INSTALLED_CLI);
    expect(probe).toHaveBeenCalledTimes(9);
  });

  it('re-probes once the cached installed-runtime answer expires', async () => {
    const probe = vi.fn(async () => '--effort <level>');
    let clockMs = 1_000;
    const options = { ...INSTALLED_CLI, nowMs: () => clockMs };

    await probeClaudeInstalledRuntimeCapabilities({ cwd: '/w', timeoutMs: 250 }, probe, options);
    expect(probe).toHaveBeenCalledTimes(3);

    clockMs += 12 * 60 * 60 * 1_000 - 1;
    await probeClaudeInstalledRuntimeCapabilities({ cwd: '/w', timeoutMs: 250 }, probe, options);
    expect(probe).toHaveBeenCalledTimes(3);

    clockMs += 2;
    await probeClaudeInstalledRuntimeCapabilities({ cwd: '/w', timeoutMs: 250 }, probe, options);
    expect(probe).toHaveBeenCalledTimes(6);
  });

  it('admits generic effort and ultracode independently for create/resume launch modes', () => {
    const requested = { reasoningEffort: 'xhigh', ultracode: true };

    expect(resolveClaudeInstalledRuntimeSessionOptions(requested, {
      supportsEffort: true,
      supportsUltracode: false,
    })).toEqual({ reasoningEffort: 'xhigh' });
    expect(resolveClaudeInstalledRuntimeSessionOptions(requested, {
      supportsEffort: false,
      supportsUltracode: false,
    })).toEqual({});
    expect(resolveClaudeInstalledRuntimeSessionOptions(requested, {
      supportsEffort: true,
      supportsUltracode: true,
    })).toEqual(requested);
  });

  it('removes unsupported controls after remote metadata is merged into a launch mode', () => {
    expect(resolveClaudeInstalledRuntimeSessionMode({
      permissionMode: 'default',
      reasoningEffort: 'xhigh',
      ultracode: true,
    }, {
      supportsEffort: false,
      supportsUltracode: false,
    })).toEqual({ permissionMode: 'default' });
  });
});

describe('resolveInstalledClaudeCliIdentity', () => {
  let tempDir: string;
  const previousOverride = process.env.HAPPIER_CLAUDE_PATH;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'happier-claude-probe-'));
  });

  afterEach(() => {
    if (typeof previousOverride === 'string') process.env.HAPPIER_CLAUDE_PATH = previousOverride;
    else delete process.env.HAPPIER_CLAUDE_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('changes when the binary at the same path is replaced', () => {
    const cliPath = join(tempDir, 'cli.mjs');
    writeFileSync(cliPath, '// claude 1\n');
    process.env.HAPPIER_CLAUDE_PATH = cliPath;

    const before = resolveInstalledClaudeCliIdentity();
    expect(before).toContain(cliPath);

    // An in-place upgrade keeps the path, so a path-only key would serve the old capabilities.
    writeFileSync(cliPath, '// claude 2 — a longer build with different flags\n');
    expect(resolveInstalledClaudeCliIdentity()).not.toEqual(before);
  });

  it('reports no identity when the configured binary cannot be read', () => {
    process.env.HAPPIER_CLAUDE_PATH = join(tempDir, 'missing', 'cli.mjs');

    expect(resolveInstalledClaudeCliIdentity()).toBeNull();
  });
});

describe('installed runtime real-process lifecycle', () => {
  const fixtures: Array<{ directory: string; pids: () => number[] }> = [];

  function fixture(mode: 'hang-help' | 'hang-effort' | 'delayed-help' | 'inherited-pipes') {
    const directory = mkdtempSync(join(tmpdir(), 'claude-runtime-lifecycle-'));
    const executable = join(directory, 'claude.cjs');
    const marker = join(directory, 'pids');
    writeFileSync(executable, `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const args = process.argv.slice(2);
      const record = () => fs.appendFileSync(process.env.RUNTIME_PID_MARKER, process.pid + String.fromCharCode(10));
      const output = () => {
        if (args[1] === 'happier-ultracode-probe-invalid') {
          console.log('Unknown --effort value happier-ultracode-probe-invalid. Valid values: low, ultracode');
        } else console.log('--effort <level>');
      };
      if (process.env.RUNTIME_FIXTURE_MODE === 'hang-help' ||
          (process.env.RUNTIME_FIXTURE_MODE === 'hang-effort' && args[0] === '--effort')) {
        record();
        process.on('SIGTERM', () => {});
        setInterval(() => {}, 1000);
      } else if (process.env.RUNTIME_FIXTURE_MODE === 'delayed-help') {
        record();
        setTimeout(output, args[0] === '--help' ? Number(process.env.RUNTIME_HELP_DELAY_MS || 600) : 0);
      } else if (process.env.RUNTIME_FIXTURE_MODE === 'inherited-pipes') {
        const child = spawn(process.execPath, ['-e',
          "require('node:fs').appendFileSync(process.env.RUNTIME_PID_MARKER, process.pid + String.fromCharCode(10)); setTimeout(() => {}, 10000)"
        ], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
        child.unref();
        console.log('Claude help without effort');
      } else output();
    `);
    const pids = () => {
      const recorded = existsSync(marker)
        ? readFileSync(marker, 'utf8').trim().split(/\s+/u).filter(Boolean).map(Number)
        : [];
      if (recorded.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
        throw new Error('Invalid owned PID in runtime fixture');
      }
      return recorded;
    };
    fixtures.push({ directory, pids });
    return { directory, pids, processEnv: { ...process.env, HAPPIER_CLAUDE_PATH: executable,
      RUNTIME_PID_MARKER: marker, RUNTIME_FIXTURE_MODE: mode } };
  }

  async function waitForPids(pids: () => number[], count: number) {
    const deadline = Date.now() + 5_000;
    while (pids().length < count && Date.now() < deadline) await delay(10);
    expect(pids()).toHaveLength(count);
  }

  function isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  beforeEach(() => resetClaudeInstalledRuntimeCapabilitiesCacheForTests());
  afterEach(async () => {
    for (const item of fixtures.splice(0)) {
      for (const pid of item.pids()) {
        if (isAlive(pid)) await killProcessTree({ pid });
      }
      rmSync(item.directory, { recursive: true, force: true });
    }
  });

  it('uses the caller runtime override for a JavaScript Claude entrypoint', async () => {
    const runtime = fixture('delayed-help');
    const originalOverride = process.env.HAPPIER_JS_RUNTIME_PATH;
    process.env.HAPPIER_JS_RUNTIME_PATH = join(runtime.directory, 'missing-ambient-runtime');
    try {
      await expect(probeClaudeInstalledRuntimeCapabilities({
        cwd: runtime.directory,
        timeoutMs: 5_000,
        processEnv: { ...runtime.processEnv, HAPPIER_JS_RUNTIME_PATH: process.execPath, RUNTIME_HELP_DELAY_MS: '0' },
      })).resolves.toEqual({ supportsEffort: true, supportsUltracode: true });
      expect(runtime.pids().length).toBeGreaterThan(0);
    } finally {
      if (originalOverride === undefined) delete process.env.HAPPIER_JS_RUNTIME_PATH;
      else process.env.HAPPIER_JS_RUNTIME_PATH = originalOverride;
    }
  });

  it.each([false, true])('settles denied process signals with caller-owned lifecycle=%s', async (callerOwned) => {
    const runtime = fixture('hang-help');
    const realKill = process.kill.bind(process);
    logger.flushSync();
    const before = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8').length : 0;
    // Deny only nonzero signals to PIDs recorded by this real runtime fixture.
    const signals = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal !== 0 && runtime.pids().includes(pid)) {
        throw Object.assign(new Error('fixture signal denied'), { code: 'EPERM' });
      }
      return realKill(pid, signal);
    });
    const controller = new AbortController();
    let result: unknown;
    let settled = false;
    const operation = probeClaudeInstalledRuntimeCapabilities({
      cwd: runtime.directory, timeoutMs: 1_000, processEnv: runtime.processEnv,
      ...(callerOwned ? { signal: controller.signal } : {}),
    }).then(value => { result = { status: 'fulfilled', value }; settled = true; },
      (reason: unknown) => { result = { status: 'rejected', reason }; settled = true; });
    try {
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
      expect(runtime.pids().map(isAlive)).toEqual([true]);
      if (callerOwned) {
        expect(result).toMatchObject({ status: 'rejected', reason: { code: 'process_tree_termination_incomplete' } });
      } else {
        expect(result).toEqual({ status: 'fulfilled', value: { supportsEffort: false, supportsUltracode: false } });
      }
      logger.flushSync();
      const diagnostic = readFileSync(logger.getLogPath(), 'utf8').slice(before);
      expect(diagnostic).toContain('process_tree_termination_incomplete');
      if (!callerOwned) expect(diagnostic).toContain('[claude-runtime]');
      expect(diagnostic).not.toContain(runtime.directory);
    } finally {
      signals.mockRestore();
      controller.abort();
      for (const pid of runtime.pids()) if (isAlive(pid)) await killProcessTree({ pid });
      await operation;
    }
  });

  // Windows process enumeration uses its bundled executable, not PATH-resolved POSIX ps.
  it.skipIf(process.platform === 'win32').each([false, true])('keeps cleanup failure observable with caller-owned lifecycle=%s', async (callerOwned) => {
    const runtime = fixture('hang-help');
    const originalPath = process.env.PATH;
    logger.flushSync();
    const before = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8').length : 0;
    const params = { cwd: runtime.directory, timeoutMs: 1_000, processEnv: runtime.processEnv,
      ...(callerOwned ? { signal: new AbortController().signal } : {}) };
    // The child keeps runtime.processEnv; only this owner's actual ps exec boundary is unavailable.
    process.env.PATH = runtime.directory;
    const settled = probeClaudeInstalledRuntimeCapabilities(params).then(
      (value) => ({ status: 'fulfilled', value } as const),
      (reason: unknown) => ({ status: 'rejected', reason } as const),
    );
    try {
      const result = await settled.finally(() => {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      });
      if (callerOwned) {
        expect(result).toMatchObject({ status: 'rejected', reason: { code: 'process_tree_termination_incomplete' } });
      } else {
        expect(result).toEqual({ status: 'fulfilled', value: { supportsEffort: false, supportsUltracode: false } });
      }
      expect(runtime.pids().map(isAlive)).toEqual([false]);
      logger.flushSync();
      const diagnostic = readFileSync(logger.getLogPath(), 'utf8').slice(before);
      expect(diagnostic).toContain('process_tree_termination_incomplete');
      if (!callerOwned) expect(diagnostic).toContain('[claude-runtime]');
      expect(diagnostic).not.toContain(runtime.directory);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await settled;
    }
  });

  it('does not spawn when the containing deadline was spent in an earlier phase', async () => {
    const runtime = fixture('delayed-help');
    const params = { cwd: runtime.directory, timeoutMs: 2_000, deadlineAt: Date.now() - 1,
      processEnv: runtime.processEnv };
    await expect(probeClaudeInstalledRuntimeCapabilities(params)).rejects.toThrow();
    expect(runtime.pids()).toEqual([]);
  });

  it('cleans both parallel parser processes before the containing cancellation settles', async () => {
    const runtime = fixture('hang-effort');
    const controller = new AbortController();
    let cleanup: NativeCatalogCleanup | undefined;
    let operation: Promise<unknown> | undefined;
    const outer = withCatalogProbeLifecycle({ timeoutMs: 5_000, signal: controller.signal }, async (lifecycle) => {
      const params = { ...lifecycle, cwd: runtime.directory, processEnv: runtime.processEnv,
        onNativeCleanup: (next: NativeCatalogCleanup) => { cleanup = next; } };
      operation = probeClaudeInstalledRuntimeCapabilities(params);
      return await operation;
    }, async () => { await cleanup?.(); });
    // Observe rejection immediately so the assertion remains safe while waiting for real children.
    const settled = outer.then(() => null, (error: unknown) => error);
    try {
      await waitForPids(runtime.pids, 2);
      controller.abort(new Error('cancel runtime fixture'));
      expect(await settled).toBeInstanceOf(Error);
      expect(runtime.pids().map(isAlive)).toEqual([false, false]);
    } finally {
      controller.abort();
      await settled;
      await operation?.catch(() => {});
    }
  });

  it('isolates a short caller deadline from a concurrent longer caller of the same binary', async () => {
    const runtime = fixture('delayed-help');
    const shortParams = { cwd: runtime.directory, timeoutMs: 200, deadlineAt: Date.now() + 200,
      signal: new AbortController().signal, processEnv: runtime.processEnv };
    const short = probeClaudeInstalledRuntimeCapabilities(shortParams);
    const longParams = { cwd: runtime.directory, timeoutMs: 3_000, deadlineAt: Date.now() + 3_000,
      signal: new AbortController().signal, processEnv: runtime.processEnv };
    const long = probeClaudeInstalledRuntimeCapabilities(longParams);
    const [shortResult, longResult] = await Promise.allSettled([short, long]);
    expect(shortResult).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
    expect(longResult).toEqual({ status: 'fulfilled', value: { supportsEffort: true, supportsUltracode: true } });
  });

  it('shares a timeout-only adapter budget across real user helper, HTTP and runtime phases', async () => {
    const runtime = fixture('delayed-help');
    const timeoutMs = 10_000;
    const realNow = Date.now.bind(Date);
    const startedAt = realNow();
    let preparationMs = 0;
    // Control the clock boundary instead of requiring OS helper startup and HTTP to fit 800ms.
    // The response charges preparation time, leaving two seconds for a four-second runtime.
    const helper = join(runtime.directory, 'helper.cjs');
    writeFileSync(helper, "console.log('fixture-helper-token')");
    writeFileSync(join(runtime.directory, 'settings.json'), JSON.stringify({
      apiKeyHelper: `${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`,
    }));
    const server = createServer((_request, response) => {
      preparationMs = timeoutMs - (realNow() - startedAt) - 2_000;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-6', display_name: 'Sonnet 4.6' }], has_more: false }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback server');
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + preparationMs);
    try {
      await expect(claudePreflightModelsProbeAdapter.probeModelsRaw?.({
        cwd: runtime.directory, timeoutMs, backendTarget: undefined, accountSettings: null,
        bypassCache: true,
        processEnv: { ...runtime.processEnv, RUNTIME_HELP_DELAY_MS: '4000', CLAUDE_CONFIG_DIR: runtime.directory,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/prefix`,
          ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined,
          ANTHROPIC_OAUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined },
      })).rejects.toThrow();
      expect(runtime.pids().length).toBeGreaterThan(0);
    } finally {
      clock.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('settles owned stdout and stderr when an exited root leaves inherited pipes open', async () => {
    const runtime = fixture('inherited-pipes');
    const params = { cwd: runtime.directory, timeoutMs: 500, deadlineAt: Date.now() + 500,
      signal: new AbortController().signal, processEnv: runtime.processEnv };
    // A caller timeout may reject, but it must finish cleanup rather than await inherited stdio.
    const result = await Promise.race([
      probeClaudeInstalledRuntimeCapabilities(params).then(() => null, (error: unknown) => error),
      delay(2_000).then(() => { throw new Error('runtime cleanup waited for inherited pipes'); }),
    ]);
    expect(result).toBeInstanceOf(Error);
    await waitForPids(runtime.pids, 1);
  });
});
