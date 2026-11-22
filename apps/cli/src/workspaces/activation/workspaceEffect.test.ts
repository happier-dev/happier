import { expect, it } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { prepareWorkspaceCheckoutEffect } from './workspaceEffect';

it('keeps plain folder attachment independent of unavailable SCM source custody', async () => {
  // This real source-only runtime has declarations but no daemon source custody.
  const registry = await resolveExecutablePluginRuntimeRegistry({
    pluginIds: ['happier.scm.backend.git', 'happier.scm.forge.azure-devops'],
  });
  const input = { workspaceRefId: 'checkout', workspaceRoot: '/private/member', existingRootPath: '/private/member/checkout', registry,
    request: { serverId: 'home', machineId: 'machine', source: { kind: 'workspace' as const, workspaceId: 'checkout' },
      materialization: { kind: 'attach' as const } } };
  try {
    await expect(prepareWorkspaceCheckoutEffect(input)).resolves.toMatchObject({ effect: {
      existingRootPath: input.existingRootPath, plugins: [], contributions: {},
    } });
    await expect(prepareWorkspaceCheckoutEffect({ ...input, request: { ...input.request, cloneSource: true } }))
      .rejects.toThrow();
  } finally { await registry.dispose(); }
});

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
