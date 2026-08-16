import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
