import { describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// The OS home is isolated; native-home resolution and all plugin code stay real.
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';

import { ApiClient } from '@/api/api';
import { configuration } from '@/configuration';
import { resolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';

import { withForegroundProviderFixture } from './prepareForegroundAdmission.providers.testkit';
import { withRealForegroundAdmissionFixture } from './foregroundAdmission.testkit';
import { ForegroundAgentRuntimeAdmissionResponseV1Schema } from './foregroundAdmissionContract';
import { createForegroundPurposeOwnerFixture } from './prepareForegroundAdmission.connectedServices.testkit';

describe('Claude foreground admission through the applied runtime', () => {
  it.each([true, false])('applies Account retention to a credential-less Provider home (explicit native override: %s)', async explicitOverride => {
    await withForegroundProviderFixture({ agentId: 'claude', runtimeOptions: {
      accountSettingsRecordAdapter: { bindOperation: async () => ({
        readRecord: async () => ({ status: 'present', revision: 1, values: { claudeSessionRetentionV1: { mode: 'days', days: 365 } } }),
        writeRecord: async () => { throw new Error('Foreground materialization must preserve Account intent'); },
      }) },
    } }, async fixture => {
      const actualOs = await vi.importActual<typeof import('node:os')>('node:os');
      const suppliedHome = join(fixture.directory, 'supplied-home');
      const native = join(suppliedHome, '.claude');
      const platformHome = join(fixture.directory, 'platform-home');
      await mkdir(native, { recursive: true });
      await mkdir(platformHome, { recursive: true });
      await writeFile(join(native, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 7, theme: 'dark' }));
      vi.mocked(homedir).mockReturnValue(platformHome);
      const environment = createEnvKeyScope(['CLAUDE_CONFIG_DIR', 'HAPPIER_CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE']);
      environment.patch({ CLAUDE_CONFIG_DIR: explicitOverride ? native : undefined,
        HAPPIER_CLAUDE_CONFIG_DIR: undefined, HOME: suppliedHome, USERPROFILE: suppliedHome });
      try {
        const admission = await fixture.prepare({ profileId: undefined,
          accountSettingsScopeKey: undefined, accountSettingsVersion: undefined });
        expect(admission, admission.ok ? undefined : JSON.stringify(admission.error)).toMatchObject({ ok: true });
        if (!admission.ok) throw new Error(admission.error.code);
        const claimed = await admission.prepared.claim({ canonicalSessionId: 'claude-provider-retention', httpPort: 40123,
          foregroundSatisfiedProfileSecretRequirementNames: [] });
        expect(claimed).toMatchObject({ ok: true });
        if (!claimed.ok) throw new Error(claimed.error.code);
        expect(claimed.environment.HAPPIER_CLAUDE_NATIVE_CONFIG_DIR).toBe(native);
        expect(JSON.parse(await readFile(join(claimed.environment.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8')))
          .toMatchObject({ cleanupPeriodDays: 365, theme: 'dark' });
      } finally { environment.restore(); vi.mocked(homedir).mockImplementation(actualOs.homedir); }
    });
  });


  it.each([true, false])('preserves the native Claude signed-in state (%s) through foreground admission', async loggedIn => {
    await withRealForegroundAdmissionFixture({
      runtimeOptions: { pluginIds: ['happier.agent.claude'] },
    }, async fixture => {
      const catalogEntry = await fixture.runtime.registry.acquireAgentCatalogEntry?.('claude');
      // The executable is the OS boundary; the applied Claude catalog and its
      // declared auth-status parser run unchanged beneath foreground admission.
      const command = await writeExecutableShim({
        dir: fixture.directory,
        fileName: process.platform === 'win32' ? 'claude-auth.cmd' : 'claude-auth',
        contents: process.platform === 'win32'
          ? `@echo off\r\nif "%1"=="--version" (echo 2.1.292 & exit /b 0)\r\necho {"loggedIn":${loggedIn}}\r\nexit /b ${loggedIn ? 0 : 1}\r\n`
          : `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2.1.292; exit 0; fi\nprintf '%s\\n' '{"loggedIn":${loggedIn}}'\nexit ${loggedIn ? 0 : 1}\n`,
      });
      const environment = createEnvKeyScope([resolveAgentCliOverrideEnvKey('claude')]);
      environment.patch({ [resolveAgentCliOverrideEnvKey('claude')]: command });
      try {
        const admission = await fixture.prepare({
          agentId: 'claude',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          connectedServices: { v: 2, bindingsByServiceId: {
            'happier.agent.claude/claude-subscription': { source: 'native' },
            'happier.agent.claude/anthropic': { source: 'native' },
          } },
        }, {
          activateSessionPurposeBindings: createForegroundPurposeOwnerFixture({
            consumer: { pluginId: 'happier.agent.claude', localId: 'claude' },
            service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
            materializeAccount: async () => { throw new Error('Native authentication must not materialize a Connected Account'); },
          }).owner.activateSessionPurposeBindings,
          resolveConnectedServiceAuthForSpawn: async input => {
            const credentials = { token: 'fixture-account', encryption: null } as const;
            return await resolveConnectedServiceAuthForSpawn({ ...input,
              credentials, api: await ApiClient.create(credentials),
              activeServerDir: configuration.activeServerDir, baseDir: fixture.directory,
            });
          },
          resolveDaemonSpawnHooks: async () => await catalogEntry?.getDaemonSpawnHooks?.() ?? null,
        });
        expect(loggedIn ? admission : ForegroundAgentRuntimeAdmissionResponseV1Schema.parse(admission))
          .toMatchObject(loggedIn ? { ok: true } : {
            ok: false, error: { kind: 'launch_error', code: 'agent_signed_out' },
          });
      } finally { environment.restore(); }
    });
  });
});
