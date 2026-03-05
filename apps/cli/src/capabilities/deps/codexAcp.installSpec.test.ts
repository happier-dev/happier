import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileSpy = vi.fn((...args: any[]) => {
  const callback = typeof args[2] === 'function' ? args[2] : args[3];
  callback?.(null, 'ok', '');
});

vi.mock('child_process', () => ({
  execFile: (...args: any[]) => execFileSpy(...args),
}));

let prevHomeDir: string | undefined;
const tempDirs = new Set<string>();

afterEach(async () => {
  execFileSpy.mockClear();
  vi.resetModules();
  if (prevHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
  else process.env.HAPPIER_HOME_DIR = prevHomeDir;
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('installCodexAcp installSpec overrides', () => {
  it('ignores installSpecOverride containing whitespace and uses the default spec', async () => {
    prevHomeDir = process.env.HAPPIER_HOME_DIR;
    const home = await mkdtemp(join(tmpdir(), 'happier-codex-acp-installSpec-'));
    tempDirs.add(home);
    process.env.HAPPIER_HOME_DIR = home;

    const { DEFAULT_CODEX_ACP_INSTALL_SPEC, installCodexAcp } = await import('./codexAcp');

    await expect(installCodexAcp('not a valid spec')).resolves.toEqual(expect.objectContaining({ ok: true }));

    const installCall = execFileSpy.mock.calls.find((call) => Array.isArray(call[1]) && call[1]?.[0] === 'install');
    expect(installCall).toBeTruthy();
    expect(installCall?.[1]?.at(-1)).toBe(DEFAULT_CODEX_ACP_INSTALL_SPEC);
  });

  it('uses installSpecOverride when it contains no whitespace', async () => {
    prevHomeDir = process.env.HAPPIER_HOME_DIR;
    const home = await mkdtemp(join(tmpdir(), 'happier-codex-acp-installSpec-'));
    tempDirs.add(home);
    process.env.HAPPIER_HOME_DIR = home;

    const { installCodexAcp } = await import('./codexAcp');

    await expect(installCodexAcp('@zed-industries/codex-acp@0.0.0-test')).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );

    const installCall = execFileSpy.mock.calls.find((call) => Array.isArray(call[1]) && call[1]?.[0] === 'install');
    expect(installCall).toBeTruthy();
    expect(installCall?.[1]?.at(-1)).toBe('@zed-industries/codex-acp@0.0.0-test');
  });
});

