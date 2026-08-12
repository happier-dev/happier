import { describe, expect, it, vi } from 'vitest';

import {
  probeClaudeInstalledRuntimeCapabilities,
  resolveClaudeInstalledRuntimeSessionMode,
  resolveClaudeInstalledRuntimeSessionOptions,
} from './probeClaudeInstalledRuntimeCapabilities';

describe('probeClaudeInstalledRuntimeCapabilities', () => {
  it('requires generic effort support before probing ultracode', async () => {
    const probe = vi.fn(async () => 'Claude Code help without the flag');

    await expect(probeClaudeInstalledRuntimeCapabilities({ cwd: '/', timeoutMs: 250 }, probe))
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

    await expect(probeClaudeInstalledRuntimeCapabilities({ cwd: '/', timeoutMs: 250 }, probe))
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

    await expect(probeClaudeInstalledRuntimeCapabilities({ cwd: '/', timeoutMs: 250 }, probe))
      .resolves.toEqual({ supportsEffort: true, supportsUltracode: false });
  });

  it('recognizes unknown-value warnings that use double quotes', async () => {
    const probe = vi.fn(async ({ args }: Readonly<{ args: readonly string[] }>) => {
      if (args[0] !== '--effort') return '--effort <level>';
      if (args[1] === 'ultracode') return '--effort <level>';
      return `Warning: Unknown --effort value "${args[1]}" — ignoring it. Valid values: low, medium, high, xhigh, max.`;
    });

    await expect(probeClaudeInstalledRuntimeCapabilities({ cwd: '/', timeoutMs: 250 }, probe))
      .resolves.toEqual({ supportsEffort: true, supportsUltracode: true });
  });

  it('fails ultracode closed when an installed-parser probe rejects', async () => {
    const probe = vi.fn(async ({ args }: Readonly<{ args: readonly string[] }>) => {
      if (args[0] !== '--effort') return '--effort <level>';
      throw new Error('probe failed');
    });

    await expect(probeClaudeInstalledRuntimeCapabilities({ cwd: '/', timeoutMs: 250 }, probe))
      .resolves.toEqual({ supportsEffort: true, supportsUltracode: false });
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
