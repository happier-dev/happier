import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

import { createRunDirs } from '../../src/testkit/runDir';
import { writeTestManifest } from '../../src/testkit/manifest';
import { which } from '../../src/testkit/process/commands';
import { envFlag } from '../../src/testkit/env';

const run = createRunDirs({ runLabel: 'providers' });

describe('providers: tool-trace contract (scaffold)', () => {
  const providersEnabled = envFlag('HAPPIER_E2E_PROVIDERS', false) || envFlag('HAPPY_E2E_PROVIDERS', false);
  const opencodeEnabled = envFlag('HAPPIER_E2E_PROVIDER_OPENCODE', false) || envFlag('HAPPY_E2E_PROVIDER_OPENCODE', false);

  it.skipIf(providersEnabled)('is disabled by default (set HAPPIER_E2E_PROVIDERS=1 to enable)', () => {
    expect(providersEnabled).toBe(false);
  });

  it.skipIf(!providersEnabled || !opencodeEnabled)(
    'opencode binary is available when explicitly enabled (HAPPIER_E2E_PROVIDER_OPENCODE=1)',
    () => {

      const testDir = run.testDir('opencode-sanity');
      writeTestManifest(testDir, {
        startedAt: new Date().toISOString(),
        runId: run.runId,
        testName: 'opencode-sanity',
        env: {
          HAPPIER_E2E_PROVIDERS: process.env.HAPPIER_E2E_PROVIDERS ?? process.env.HAPPY_E2E_PROVIDERS,
          HAPPIER_E2E_PROVIDER_OPENCODE: process.env.HAPPIER_E2E_PROVIDER_OPENCODE ?? process.env.HAPPY_E2E_PROVIDER_OPENCODE,
        },
      });

      const path = which('opencode');
      expect(path).not.toBeNull();
      if (!path) return;

      const res = spawnSync(path, ['--version'], { encoding: 'utf8' });
      expect(res.status).toBe(0);
    },
  );
});
