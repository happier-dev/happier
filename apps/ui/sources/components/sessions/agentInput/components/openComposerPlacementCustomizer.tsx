import * as React from 'react';

import type {
  NavigationPlacementFixedItem,
  NavigationPlacementItem,
  NavigationPlacementPreviewControls,
} from '@/components/ui/navigation/NavigationPlacementCustomizer';
import { Modal } from '@/modal';
import { readCurrentAppShellPluginUiProjection, readCurrentAppShellPluginUiTranslationRuntime } from '@/components/appShell/plugins/committedPluginUiProjection';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { buildPluginComposerPlacementDefinitions } from '@/components/plugins/actions/pluginComposerPlacement';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';
import { getPreferredLanguage, t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isPhoneHardware } from '@/utils/platform/isPhoneHardware';

import type { AgentInputPlacementContext, AgentInputPlacementDescriptor } from '../controls/agentInputControlTypes';
import { buildAgentInputPlacementCatalogGroups } from '../controls/buildAgentInputPlacementDescriptors';
import { listAgentInputActionChipActionIds } from '../sessionActions/listAgentInputActionChipActionIds';
import { buildConfiguredActionShortcutPlacementDefinitions } from '../sessionActions/agentInputActionShortcutPlacements';
import { ComposerPlacementPreview, type ComposerPlacementPreviewValues } from './ComposerPlacementPreview';

/** Says what a row means beyond its segment: where it lives, what keeps it reachable, why it is Shown now. */
function placementNote(
  descriptor: AgentInputPlacementDescriptor,
): string | undefined {
  if (descriptor.pending) return t('navigationPlacement.pendingNote');
  if (descriptor.slot === 'fieldAccessory')
    return t('navigationPlacement.inField');
  if (
    descriptor.allowedPlacements &&
    !descriptor.allowedPlacements.includes('hidden')
  )
    return t('navigationPlacement.alwaysReachable');
  if (
    descriptor.allowedPlacements &&
    !descriptor.allowedPlacements.includes('pinned')
  )
    return t('navigationPlacement.menuOnly');
  return undefined;
}

export function composerPlacementItems(
  descriptors: readonly AgentInputPlacementDescriptor[],
  group?: string,
): readonly NavigationPlacementItem[] {
  return descriptors.map((descriptor) => ({
    id: descriptor.id,
    title: descriptor.title,
    icon: descriptor.icon,
    group,
    defaultPlacement: descriptor.defaultPlacement,
    ...(descriptor.allowedPlacements
      ? { allowedPlacements: descriptor.allowedPlacements }
      : {}),
    pending: descriptor.pending,
    placementNote: placementNote(descriptor),
  }));
}

/**
 * The shared navigation customizer on the `composer` surface: Shown / In + / Hidden, the static row preview, and
 * Stop listed as always there. Context groups share placement ids; the grouped list shows each id once, under
 * the first context that offers it, and opens at the opener's own context. The preview uses only the opener's context, never the union of unrelated composer forms.
 */
export function openComposerPlacementCustomizer(
  options: Readonly<{
    descriptors?: readonly AgentInputPlacementDescriptor[];
    context?: AgentInputPlacementContext;
    /** What each chip shows in the composer that opened this; Settings has no composer behind it. */
    previewValues?: ComposerPlacementPreviewValues;
    placeholder?: string;
    /** The opener's own rail shape; Settings has none, so a session or discussion context draws one rail. */
    singleRow?: boolean;
  }> = {},
) {
  const accountLifetime = captureActiveServerAccountScopeLifetime();
  const scope = accountLifetime?.scope ?? null;
  const projection = scope
    ? readCurrentAppShellPluginUiProjection({ scope, declarationsOnly: true })
    : null;
  const locale = getPreferredLanguage();
  const runtime = readCurrentAppShellPluginUiTranslationRuntime(projection);
  const resolve = createPluginLocalizedTextResolver({ projection, runtime, locale });
  const demandedPlugins = new Set<string>();
  let admittedDefinitions = [
    ...buildPluginComposerPlacementDefinitions(projection, { locale, localize: (pluginId, value) => {
      if (typeof value === 'object' && value !== null && 'key' in value) demandedPlugins.add(pluginId);
      return resolve(pluginId, value);
    } }),
    ...buildConfiguredActionShortcutPlacementDefinitions(scope
      ? listAgentInputActionChipActionIds(getStorage().getState())
      : []),
  ];
  const fixedItems: readonly NavigationPlacementFixedItem[] = [
    {
      id: 'stop',
      title: t('common.stop'),
      icon: 'stop',
      placementNote: t('navigationPlacement.stopNote'),
    },
  ];
  fireAndForget(
    Promise.all([
      import('./ComposerPlacementCustomizer'),
      import('@/agents/registry/agentUiBehavior/nativeComposerPlacement'),
    ]).then(
      async ([{ ComposerPlacementCustomizer }, { readNativeAgentComposerPlacementDefinitions }]) => {
        if (runtime) {
          await Promise.all([...demandedPlugins].map(pluginId => runtime.demand(pluginId, locale)));
          admittedDefinitions = [
            ...buildPluginComposerPlacementDefinitions(projection, { locale, localize: resolve }),
            ...buildConfiguredActionShortcutPlacementDefinitions(scope
              ? listAgentInputActionChipActionIds(getStorage().getState()) : []),
          ];
        }
        if (accountLifetime && !accountLifetime.isCurrent()) return;
        const context = options.context ?? 'session';
        const groups = buildAgentInputPlacementCatalogGroups({
          context,
          phone: isPhoneHardware(),
          admittedDefinitions: [...admittedDefinitions, ...readNativeAgentComposerPlacementDefinitions(scope)],
          runtimeDescriptors: options.descriptors,
        });
        // Settings has no live capability inventory. A + opener does: preview that exact
        // admitted row (including an empty one), not every configurable control in its group.
        const descriptors = options.descriptors ?? groups.find(group => group.id === context)!.descriptors;
        const contextTitles: Record<AgentInputPlacementContext, string> = {
          session: t('navigationPlacement.contextSession'),
          newSession: t('navigationPlacement.contextNewSession'),
          workflow: t('navigationPlacement.contextWorkflow'),
          discussion: t('navigationPlacement.contextDiscussion'),
        };
        // One item per id (one preference and reorder identity), listed under the first context, in the lab's order,
        // that offers it. The active context still owns the live/default/pending facts for shared ids.
        const activeGroup = groups.find(group => group.id === context)!;
        const items = new Map<string, NavigationPlacementItem>();
        for (const group of groups) {
          for (const item of composerPlacementItems(group.descriptors, contextTitles[group.id])) {
            if (!items.has(item.id)) items.set(item.id, item);
          }
        }
        for (const item of composerPlacementItems(activeGroup.descriptors, contextTitles[context])) {
          items.set(item.id, { ...item, group: items.get(item.id)!.group });
        }
        Modal.show({
          component: ComposerPlacementCustomizer,
          props: {
            surfaceId: 'composer',
            items: [...items.values()],
            description: t('navigationPlacement.composerDescription'),
            placementLabels: {
              pinned: t('navigationPlacement.shown'),
              overflow: t('navigationPlacement.inPlus'),
            },
            fixedItems,
            activeGroup: contextTitles[context],
            renderPreview: (preferences: NavigationPlacementPreferences, controls?: NavigationPlacementPreviewControls) => (
              <ComposerPlacementPreview
                descriptors={descriptors}
                preferences={preferences}
                {...(options.previewValues ? { values: options.previewValues } : {})}
                {...(options.placeholder ? { placeholder: options.placeholder } : {})}
                {...(controls ? { reorderFor: controls.reorderFor } : {})}
                singleRow={options.singleRow ?? (context === 'session' || context === 'discussion')}
              />
            ),
            testID: 'composer-placement-customizer',
          },
        });
      },
    ),
    { tag: 'openComposerPlacementCustomizer' },
  );
}
