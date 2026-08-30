import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { openBrowser } from './openBrowser';

const openMock = vi.hoisted(() => vi.fn());

vi.mock('open', () => ({ default: openMock }));

const envScope = createEnvKeyScope([
  'CI',
  'DISPLAY',
  'HAPPIER_NO_BROWSER_OPEN',
  'HEADLESS',
  'PATH',
  'WAYLAND_DISPLAY',
]);

function overrideProcessRuntime({ platform, bunVersion }: { platform: NodeJS.Platform; bunVersion?: string }): () => void {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const versionsDescriptor = Object.getOwnPropertyDescriptor(process, 'versions');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'versions', {
    value: { ...process.versions, ...(bunVersion ? { bun: bunVersion } : {}) },
    configurable: true,
  });
  return () => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    if (versionsDescriptor) Object.defineProperty(process, 'versions', versionsDescriptor);
  };
}

function trySetStdoutIsTty(value: boolean): (() => void) | null {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  try {
    Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
    return () => {
      try {
        if (desc) {
          Object.defineProperty(process.stdout, 'isTTY', desc);
        }
      } catch {
        // ignore restore failures
      }
    };
  } catch {
    return null;
  }
}

describe('openBrowser', () => {
  it('returns false on interactive Linux without a graphical session', async () => {
    const restoreTty = trySetStdoutIsTty(true);
    const restoreRuntime = overrideProcessRuntime({ platform: 'linux', bunVersion: '1.3.5' });
    envScope.patch({
      CI: undefined,
      DISPLAY: undefined,
      HAPPIER_NO_BROWSER_OPEN: undefined,
      HEADLESS: undefined,
      WAYLAND_DISPLAY: undefined,
    });
    openMock.mockResolvedValue(undefined);

    try {
      const ok = await openBrowser('https://example.com');
      expect(ok).toBe(false);
      expect(openMock).not.toHaveBeenCalled();
    } finally {
      openMock.mockReset();
      envScope.restore();
      restoreRuntime();
      restoreTty?.();
    }
  });

  it('returns false when the bundled Linux runtime cannot execute xdg-open', async () => {
    const pathDir = await mkdtemp(join(tmpdir(), 'happier-browser-no-opener-'));
    const restoreTty = trySetStdoutIsTty(true);
    const restoreRuntime = overrideProcessRuntime({ platform: 'linux', bunVersion: '1.3.5' });
    envScope.patch({
      CI: undefined,
      DISPLAY: ':0',
      HAPPIER_NO_BROWSER_OPEN: undefined,
      HEADLESS: undefined,
      PATH: pathDir,
      WAYLAND_DISPLAY: undefined,
    });
    openMock.mockResolvedValue(undefined);

    try {
      const ok = await openBrowser('https://example.com');
      expect(ok).toBe(false);
      expect(openMock).not.toHaveBeenCalled();
    } finally {
      openMock.mockReset();
      envScope.restore();
      restoreRuntime();
      restoreTty?.();
      await rm(pathDir, { recursive: true, force: true });
    }
  });

  it('opens normally when the bundled Linux runtime has a graphical session and xdg-open', async () => {
    const pathDir = await mkdtemp(join(tmpdir(), 'happier-browser-opener-'));
    const openerPath = join(pathDir, 'xdg-open');
    await writeFile(openerPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(openerPath, 0o755);
    const restoreTty = trySetStdoutIsTty(true);
    const restoreRuntime = overrideProcessRuntime({ platform: 'linux', bunVersion: '1.3.5' });
    envScope.patch({
      CI: undefined,
      DISPLAY: ':0',
      HAPPIER_NO_BROWSER_OPEN: undefined,
      HEADLESS: undefined,
      PATH: pathDir,
      WAYLAND_DISPLAY: undefined,
    });
    openMock.mockResolvedValue(undefined);

    try {
      const ok = await openBrowser('https://example.com');
      expect(ok).toBe(true);
      expect(openMock).toHaveBeenCalledWith('https://example.com');
    } finally {
      openMock.mockReset();
      envScope.restore();
      restoreRuntime();
      restoreTty?.();
      await rm(pathDir, { recursive: true, force: true });
    }
  });

  it('returns false when HAPPIER_NO_BROWSER_OPEN is set', async () => {
    const restoreTty = trySetStdoutIsTty(true);
    envScope.patch({ HAPPIER_NO_BROWSER_OPEN: '1' });

    try {
      const ok = await openBrowser('https://example.com');
      expect(ok).toBe(false);
    } finally {
      envScope.restore();
      restoreTty?.();
    }
  });

  it('returns false in CI environments', async () => {
    const restoreTty = trySetStdoutIsTty(true);
    envScope.patch({
      CI: '1',
      HAPPIER_NO_BROWSER_OPEN: undefined,
    });

    try {
      const ok = await openBrowser('https://example.com');
      expect(ok).toBe(false);
    } finally {
      envScope.restore();
      restoreTty?.();
    }
  });

  it('returns false when stdout is not interactive', async () => {
    const restoreTty = trySetStdoutIsTty(false);
    envScope.patch({
      CI: undefined,
      HAPPIER_NO_BROWSER_OPEN: undefined,
    });

    try {
      const ok = await openBrowser('https://example.com');
      expect(ok).toBe(false);
    } finally {
      envScope.restore();
      restoreTty?.();
    }
  });
});
