import { expect, it } from 'vitest';

import { resolveExecutionRunIntentProfileFromCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

import { resolveCliEngineRegistry } from './engineRegistry';

it('discovers admitted descriptor-only review profiles before native activation', async () => {
  const pluginId = 'happier.review.deepsec';
  const profileId = `${pluginId}/repository-security-audit`;
  const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
    contributes: await resolveMergedContributionRegistry({ pluginIds: [pluginId] }),
  } });
  try {
    const custody = fixture.registry.readPluginSourceCustody(pluginId);
    expect(custody).toBeTruthy();
    expect(fixture.registry.activatedPluginIds.has(pluginId)).toBe(false);
    const registry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.registry });
    const catalog = await registry.resolveExecutionRunProfileCatalog();
    expect(catalog.profileDescriptorsById.get(profileId)?.sourceCustody).toEqual(custody);
    expect(resolveExecutionRunIntentProfileFromCatalog(catalog, 'review', profileId, custody).intent).toBe('review');
    // Catalog discovery consumes admitted descriptors without importing native
    // factories. Selection still refuses a different source or an absent profile.
    expect(fixture.registry.activatedPluginIds.has(pluginId)).toBe(false);
    expect(() => resolveExecutionRunIntentProfileFromCatalog(catalog, 'review', profileId,
      { kind: 'development', registeredRootId: '/different-plugin-root' })).toThrowError(
      expect.objectContaining({ code: 'execution_run_profile_stale' }));
    expect(() => resolveExecutionRunIntentProfileFromCatalog(catalog, 'review', `${pluginId}/missing`, custody))
      .toThrowError(expect.objectContaining({ code: 'execution_run_profile_stale' }));
    fixture.registry.retireConsumers();
    const retiredCatalog = await registry.resolveExecutionRunProfileCatalog();
    expect(retiredCatalog.profileDescriptorsById.has(profileId)).toBe(false);
  } finally {
    await fixture.lease.release();
    await fixture.dispose();
  }
});
