import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AgentRuntimeDaemonServiceRequestV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';

it('accepts a canonical Account scope key under a deeply configured Home without a subordinate field limit', async () => {
  const fixture = await createAttachedManagedRunFixture();
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  try {
    env.patch({ HAPPIER_HOME_DIR: join(fixture.directory, ...Array.from({ length: 7 }, (_, index) => `home-${index}-${'x'.repeat(80)}`)) });
    reloadConfiguration();
    const expectedAccountSettingsScopeKey = resolveAccountSettingsScopeKey(fixture.credentials);
    expect(expectedAccountSettingsScopeKey.length).toBeGreaterThan(512);
    expect(AgentRuntimeDaemonServiceRequestV1Schema.safeParse({ v: 1,
      context: { token: 'a'.repeat(43), sessionId: 'parent-session' },
      operation: { kind: 'provider_managed.binding.open', requestId: 'deep-home', ...fixture.proof, expectedAccountSettingsScopeKey },
    }).success).toBe(true);
  } finally { env.restore(); reloadConfiguration(); await fixture.cleanup(); }
});
