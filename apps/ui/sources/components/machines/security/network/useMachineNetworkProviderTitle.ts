import * as React from 'react';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { usePreferredLanguage } from '@/text';
import {
  resolveMachineNetworkProviderTitle,
  type MachineNetworkFacts,
  type MachineNetworkProviderTitle,
} from './networkSurface';

const TITLE_SECTIONS = ['familiesById.accessProviders', 'familiesById.pluginUi'] as const;

/** The open Network surface shares the Machine catalog's acquisition and translation owners. */
export function useMachineNetworkProviderTitle(input: Readonly<{
  serverId: string; machineId: string; enabled: boolean; facts: MachineNetworkFacts;
}>): MachineNetworkProviderTitle {
  const { posture, observation, selections } = input.facts;
  const saved = posture?.defaultServiceIngress;
  const needsPluginTitles = (saved?.kind === 'provider' && !('kind' in saved.selection.provider))
    || selections?.some(selection => !('kind' in selection.provider))
    || observation?.management.providers.some(entry => !('kind' in entry.provider))
    || observation?.ingress.some(entry => !('kind' in entry.provider))
    || observation?.privateNetworks.some(entry => !('kind' in entry.provider));
  const { inputs } = useDaemonMergedProjectionInputs({ serverId: input.serverId, machineId: input.machineId,
    enabled: input.enabled && Boolean(needsPluginTitles), sections: TITLE_SECTIONS });
  const locale = usePreferredLanguage();
  const pluginUiProjection = inputs?.pluginUiProjection;
  const localize = React.useMemo(() => createPluginLocalizedTextResolver({ projection: pluginUiProjection, locale }), [pluginUiProjection, locale]);
  const projection = inputs?.pluginProjectionV2;
  return React.useCallback(provider => resolveMachineNetworkProviderTitle(provider, projection, localize), [projection, localize]);
}
