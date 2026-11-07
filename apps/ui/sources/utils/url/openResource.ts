import * as React from 'react';
import type { PluginUiResourceIntentV1 } from '@happier-dev/protocol/plugins/ui';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import {
  usePluginSurfaceDestinationNavigationBinding,
  type PluginSurfaceDestinationNavigationBinding,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { selectPluginSurfacePlacementsByDestination, selectRenderablePluginResourceLinkPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { storage } from '@/sync/domains/state/storageStore';
import { requestOpenExternalUrl } from './requestOpenExternalUrl';

export type OpenResourceContext = Readonly<{
  sessionId?: string;
  serverId?: string;
  navigation?: Pick<PluginSurfaceDestinationNavigationBinding, 'targetKind' | 'projection' | 'openSurface'> | null;
  /** An explicit catalog overrides the navigation scope's resource catalog. */
  projection?: PluginUiProjectionModel | null;
  openExternal?: (url: string) => Promise<boolean>;
}>;

export function hasInAppResourceHandler(projection: PluginUiProjectionModel | null): boolean {
  return projection !== null && selectRenderablePluginResourceLinkPlacements(projection).length > 0;
}

export type OpenResourceOutcome = Readonly<{ status: 'inApp' | 'external' | 'unavailable' }>;

async function openResourceUrl(url: string, kind: PluginUiResourceIntentV1['kind'] | undefined, context?: OpenResourceContext): Promise<OpenResourceOutcome> {
  const external = async (): Promise<OpenResourceOutcome> => {
    const opened = await (context?.openExternal ? context.openExternal(url) : requestOpenExternalUrl(url));
    return { status: opened ? 'external' : 'unavailable' };
  };
  if (storage.getState().settings.scmResourceOpenLocation === 'github' || !context?.navigation) return external();
  const scopedProjection = context.projection === undefined ? context.navigation.projection : context.projection;
  const projection = scopedProjection === undefined ? readCurrentAppShellPluginUiProjection() : scopedProjection;
  if (!projection) return external();
  const resourcePlacements = selectRenderablePluginResourceLinkPlacements(projection);
  const matchesFor = (targetKind: 'session' | 'app') => resourcePlacements
    .filter(placement => placement.binding.targetKind === targetKind)
    .flatMap(placement => (placement.resourceLinks ?? []).flatMap(link => {
      if (kind !== undefined && link.kind !== kind) return [];
      const match = new RegExp(link.urlPattern).exec(url);
      return match?.[0] === url ? [{ pluginId: placement.pluginId, ...link }] : [];
    }));
  // A Session handler wins; otherwise the enclosing navigation owner can
  // open the app destination offered by this same resource catalog.
  const sessionMatches = context.navigation.targetKind === 'session' ? matchesFor('session') : [];
  const matches = sessionMatches.length > 0 ? sessionMatches : matchesFor('app');
  // Contributions offer a handler; declaration order never appoints a winner.
  if (matches.length !== 1) return external();
  const match = matches[0]!;
  const destination = { pluginId: match.pluginId, localId: match.destination };
  const placements = selectPluginSurfacePlacementsByDestination(projection, destination);
  if (placements.length !== 1) return external();
  const resource = { kind: match.kind, url };
  try {
    const result = await context.navigation.openSurface({
      destination,
      ...(placements[0]!.binding.instancePolicy === 'multiple' ? { instanceKey: url } : {}),
      input: { resource },
    });
    if (result.ok) return { status: 'inApp' };
    // A refusal (for example a cancelled handoff) is not an unavailable renderer.
    if (result.code !== 'unavailable') return { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
  return external();
}

export async function requestOpenResourceUrl(url: string, context?: OpenResourceContext): Promise<boolean> {
  return (await openResourceUrl(url, undefined, context)).status !== 'unavailable';
}

export async function requestOpenResource(resource: PluginUiResourceIntentV1, context?: OpenResourceContext): Promise<boolean> {
  return (await requestOpenResourceOutcome(resource, context)).status !== 'unavailable';
}

/** Preserve the actual destination for Actions; an external recovery did not open a workspace tab. */
export function requestOpenResourceOutcome(resource: PluginUiResourceIntentV1, context?: OpenResourceContext): Promise<OpenResourceOutcome> {
  return openResourceUrl(resource.url, resource.kind, context);
}

export function useOpenResource(context?: Readonly<{ sessionId?: string; serverId?: string }>) {
  const navigation = usePluginSurfaceDestinationNavigationBinding();
  const sessionId = context?.sessionId;
  const serverId = context?.serverId;
  const openResource = React.useCallback((resource: PluginUiResourceIntentV1) => (
    requestOpenResource(resource, { navigation, sessionId, serverId })
  ), [navigation, serverId, sessionId]);
  const openResourceUrl = React.useCallback((url: string) => (
    requestOpenResourceUrl(url, { navigation, sessionId, serverId })
  ), [navigation, serverId, sessionId]);
  return { openResource, openResourceUrl };
}
