import { expect, it } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { prepareWorkspaceCheckoutEffect } from './workspaceEffect';

it('prepares an all-files Sync without optional SCM contributions', async () => {
  const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: [] } });
  try {
    const registry = { ...fixture.registry, scmBackendsById: undefined,
      contributes: { ...fixture.registry.contributes, scmBackends: undefined, scmHostingProviders: undefined, systemTools: undefined } };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIncludePatterns: [], extraIgnorePatterns: [] };
    const input = { workspaceRefId: 'checkout', workspaceRoot: '/private/member', registry,
      request: { serverId: 'home', machineId: 'machine', source: { kind: 'workspace' as const, workspaceId: 'source' },
        materialization: { kind: 'sync' as const, targetPath: '/private/member/checkout',
          workspaceAction: { kind: 'copy_once' as const, contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) } } } } };
    await expect(prepareWorkspaceCheckoutEffect(input)).resolves.toMatchObject({ effect: {
      plugins: [], contributions: { scmBackends: [], scmHostingProviders: [], systemTools: [] },
    } });
    await expect(prepareWorkspaceCheckoutEffect({ ...input, registry: { ...registry, readAdmittedBackgroundServicePlugins: undefined } }))
      .rejects.toMatchObject({ code: 'workspace_private_checkout_required' });
  } finally { await fixture.dispose(); }
});
