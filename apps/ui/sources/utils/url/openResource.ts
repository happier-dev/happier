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
import { useDestinationInstanceKey } from '@/components/appShell/workspace/destinationInstanceContext';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { resolveExternalUrlTargetFromInput } from '@/sync/domains/browser/shell/address';
import { selectChatLinkEngineOverride } from '@/sync/domains/browser/adapters/selection';
import { BrowserWorkspaceOpenResultV1Schema } from '@happier-dev/protocol/browser/control/v1';

const execute = createFrontDoorActionExecute();
let chatLinkSequence = 0;

export type OpenResourceContext = Readonly<{
  sessionId?: string;
  serverId?: string;
  chatLink?: boolean;
  scopeId?: string;
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
  // Chat URLs honor this device's deliberate destination. Explicit SCM resource intents below
  // retain their contributed destinations and Account preference.
  if (kind === undefined && context?.chatLink) {
    const unavailable = async (): Promise<OpenResourceOutcome> => {
      const [{ Modal }, { t }] = await Promise.all([import('@/modal'), import('@/text')]);
      Modal.alert(t('common.error'), t('browserLaunchpad.status.unavailableGeneric'));
      return { status: 'unavailable' };
    };
    const target = resolveExternalUrlTargetFromInput(url);
    const engineOverride = target && selectChatLinkEngineOverride(target, storage.getState().localSettings.chatLinkOpenLocation);
    if (!target || !engineOverride) return external();
    if (!context.scopeId) return unavailable();
    try {
      const result = await execute('browser.workspace.open', {
        scopeId: context.scopeId, commandId: `chat-link:${Date.now()}:${++chatLinkSequence}`, target, engineOverride,
      }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: context.serverId, defaultSessionId: context.sessionId });
      if (!result.ok) {
        const { presentActionTurnedOffNoticeIfOff } = await import('@/sync/ops/actions/actionTurnedOffNotice');
        return presentActionTurnedOffNoticeIfOff(result, 'browser.workspace.open')
          ? { status: 'unavailable' } : unavailable();
      }
      const opened = BrowserWorkspaceOpenResultV1Schema.safeParse(result.result);
      if (!opened.success || opened.data.status !== 'dispatched') return unavailable();
      return { status: opened.data.outcome === 'workspaceTab' ? 'inApp' : 'external' };
    } catch {
      return unavailable();
    }
  }
  if (storage.getState().settings.scmResourceOpenLocation === 'github' || !context?.navigation) return external();
  const scopedProjection = context.projection === undefined ? context.navigation.projection : context.projection;
  const scoped = scopedProjection === undefined ? readCurrentAppShellPluginUiProjection() : scopedProjection;
  const matchesIn = (catalog: PluginUiProjectionModel, targetKind: 'session' | 'app') => selectRenderablePluginResourceLinkPlacements(catalog)
    .filter(placement => placement.binding.targetKind === targetKind)
    .flatMap(placement => (placement.resourceLinks ?? []).flatMap(link => {
      if (kind !== undefined && link.kind !== kind) return [];
      const match = new RegExp(link.urlPattern).exec(url);
      return match?.[0] === url ? [{ pluginId: placement.pluginId, ...link }] : [];
    }));
  // A Session handler wins. A Session scope's catalog holds only that Session's handlers, so an app handler
  // comes from the app catalog; the Session binding opens it through its enclosing app navigation.
  const sessionScope = context.navigation.targetKind === 'session';
  const sessionMatches = sessionScope && scoped ? matchesIn(scoped, 'session') : [];
  const projection = sessionMatches.length > 0 ? scoped : sessionScope ? readCurrentAppShellPluginUiProjection() : scoped;
  if (!projection) return external();
  const matches = sessionMatches.length > 0 ? sessionMatches : matchesIn(projection, 'app');
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

export function useOpenResource(context?: Readonly<{ sessionId?: string; serverId?: string; chatLink?: boolean }>) {
  const navigation = usePluginSurfaceDestinationNavigationBinding();
  const sessionId = context?.sessionId;
  const serverId = context?.serverId;
  const chatLink = context?.chatLink;
  const instanceKey = useDestinationInstanceKey();
  const scopeId = sessionId ? createSessionPaneScopeId(sessionId, serverId, instanceKey) : undefined;
  const openResource = React.useCallback((resource: PluginUiResourceIntentV1) => (
    requestOpenResource(resource, { navigation, sessionId, serverId })
  ), [navigation, serverId, sessionId]);
  const openResourceUrl = React.useCallback((url: string) => (
    requestOpenResourceUrl(url, { navigation, sessionId, serverId, chatLink, scopeId })
  ), [navigation, serverId, sessionId, chatLink, scopeId]);
  return { openResource, openResourceUrl };
}
