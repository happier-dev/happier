import { normalizePluginUiInlineSurfaceBindingV1, normalizePluginUiDestinationBindingV1, type PluginUiResourceLinkV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';

export function createPluginUiResourceProjection(available = true, targetKind: 'session' | 'app' = 'session', resourceLocation: 'inline' | 'destination' = 'inline',
  resourceLink: PluginUiResourceLinkV1 = { kind: 'pullRequest', urlPattern: '^https://forge.example/[^/]+/[^/]+/pull/[0-9]+$', destination: 'details' }) {
  const binding = normalizePluginUiInlineSurfaceBindingV1({ pluginId: 'acme.forge', surfaceId: 'scm', rendererId: 'native',
    role: 'scmPullRequest', target: { kind: targetKind } });
  if (!binding) throw new Error('SCM binding unavailable');
  const placement = { id: 'surfacePlacement:acme.forge:scm', pluginId: 'acme.forge', occurrenceId: 'forge-occurrence',
    contributionKind: 'surfacePlacement', descriptorId: 'scm', target: binding.target, binding,
    renderer: { kind: 'declarative', contributionId: 'native' }, display: {},
    availability: available
      ? { state: 'available', reason: 'available', diagnostics: [] }
      : { state: 'unavailable', reason: 'disabled', diagnostics: [] },
    resourceLinks: [resourceLink] };
  const destinationBinding = normalizePluginUiDestinationBindingV1({ pluginId: 'acme.forge', destinationId: 'details',
    rendererId: 'native', target: { kind: targetKind }, container: targetKind === 'session' ? 'detailsTab' : 'appPage',
    instancePolicy: targetKind === 'session' ? 'multiple' : 'singleton' });
  if (!destinationBinding) throw new Error('Resource destination binding unavailable');
  const destination = { ...placement, id: 'surfacePlacement:acme.forge:details', descriptorId: 'details',
    target: destinationBinding.target, binding: destinationBinding,
    resourceLinks: resourceLocation === 'destination' ? placement.resourceLinks : undefined };
  return normalizePluginUiProjection({ v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {},
    resourcesById: {}, settingsById: {}, diagnostics: [], familiesById: { pluginUi: { family: 'pluginUi',
      entriesById: { ...(resourceLocation === 'inline' ? { [placement.id]: placement } : {}), [destination.id]: destination } } } } as PluginProjectionV2);
}
