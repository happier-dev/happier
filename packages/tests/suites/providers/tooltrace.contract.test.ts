import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

import { createRunDirs } from '../../src/testkit/runDir';
import { writeTestManifest } from '../../src/testkit/manifest';

function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function which(bin: string): string | null {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(cmd, [bin], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  const out = (res.stdout || '').trim().split(/\r?\n/)[0];
  return out && out.length > 0 ? out : null;
}

const run = createRunDirs({ runLabel: 'providers' });

describe('providers: tool-trace contract (scaffold)', () => {
  it('is disabled by default (set HAPPY_E2E_PROVIDERS=1 to enable)', () => {
    if (envFlag('HAPPY_E2E_PROVIDERS')) {
      // When enabled, this test becomes a no-op and the real contract tests below run.
      expect(true).toBe(true);
      return;
    }
    expect(true).toBe(true);
  });

  it('opencode binary is available when explicitly enabled (HAPPY_E2E_PROVIDER_OPENCODE=1)', () => {
    if (!envFlag('HAPPY_E2E_PROVIDERS') || !envFlag('HAPPY_E2E_PROVIDER_OPENCODE')) {
      expect(true).toBe(true);
      return;
    }

    const testDir = run.testDir('opencode-sanity');
    writeTestManifest(testDir, {
      startedAt: new Date().toISOString(),
      runId: run.runId,
      testName: 'opencode-sanity',
      env: {
        HAPPY_E2E_PROVIDERS: process.env.HAPPY_E2E_PROVIDERS,
        HAPPY_E2E_PROVIDER_OPENCODE: process.env.HAPPY_E2E_PROVIDER_OPENCODE,
      },
    });

    const path = which('opencode');
    expect(path).not.toBeNull();
    if (!path) return;

    const res = spawnSync(path, ['--version'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
  });
});

