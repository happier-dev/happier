import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import type { SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import { readProviderGatewayViewDeclarations } from '@/components/settings/providers/collection/providerCollectionModel';
import { SessionModelSourceBrowseHandoffContext } from '@/components/sessions/modelPicker/SessionModelSourceBrowseHandoff';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { useProviderConnections } from '@/providers/hooks/useProviderConnections';
import { buildSessionRouteSourceRows, type SessionRouteSourceRow } from '@/providers/session/buildSessionRouteSourceRows';
import { t } from '@/text';

/** What the "Runs through" popover needs to name an Agent's Gateways and Providers and browse one. */
export type SessionRouteSources = Readonly<{
    machineId: string | null;
    serverId: string | null;
    agentTargetKey: string;
    shownSources: readonly Readonly<{ connectionId: string; rows: readonly unknown[] }>[];
    hiddenSources: readonly Readonly<{ connectionId: string; modelCount: number }>[];
}>;

function RouteSourceIcon(props: Readonly<{ gateway: boolean; icon: string | null; dimmed: boolean }>) {
    const { theme } = useUnistyles();
    const color = props.dimmed ? theme.colors.text.tertiary : theme.colors.text.secondary;
    return normalizeNodeForView(props.gateway
        ? <Icon name="path" size={20} color={color} />
        : <ProviderIcon icon={props.icon} size={20} color={color} />);
}

function RouteSourceChevron() {
    const { theme } = useUnistyles();
    return normalizeNodeForView(<Icon name="caret-right" size={16} color={theme.colors.text.tertiary} />);
}

function routeSourceSubtitle(row: SessionRouteSourceRow): string {
    if (row.worksWith) return t('connectedServices.authChip.worksWith', { agents: row.worksWith.join(', ') });
    const models = t('settingsProviders.detail.modelCount', { count: row.modelCount ?? 0 });
    return row.hiddenFromPicker ? `${models} · ${t('agentInput.model.hiddenFromMainPicker')}` : models;
}

/**
 * The popover's Gateways and Providers groups (RT1). Mounted only inside the open popover, so the
 * connection read is demanded by the person opening it. A row opens the engine pane on that source
 * through the composer's hand-off; picking a model there stays the only commit.
 */
export function useSessionRouteSourceSections(
    sources: SessionRouteSources | undefined,
): readonly SelectionListSectionDescriptor[] {
    const handoff = React.useContext(SessionModelSourceBrowseHandoffContext);
    const browse = handoff?.browse;
    const connections = useProviderConnections({
        enabled: sources !== undefined && browse !== undefined,
        machineId: sources?.machineId ?? null,
        serverId: sources?.serverId ?? null,
    });
    const views = connections.data?.connections;
    const agentTargetKey = sources?.agentTargetKey;
    const shownSources = sources?.shownSources;
    const hiddenSources = sources?.hiddenSources;

    return React.useMemo(() => {
        if (!views || !agentTargetKey || !browse) return [];
        const rows = buildSessionRouteSourceRows({
            agentTargetKey, views, shownSources: shownSources ?? [], hiddenSources: hiddenSources ?? [],
            isGateway: view => (readProviderGatewayViewDeclarations(view)?.length ?? 0) > 0,
        });
        const section = (id: 'gateways' | 'providers', title: string, group: readonly SessionRouteSourceRow[]): SelectionListSectionDescriptor[] => (
            group.length === 0 ? [] : [{
                kind: 'static',
                id: `route-sources:${id}`,
                title,
                options: group.map(row => ({
                    id: `route-source:${row.connectionId}`,
                    label: row.label,
                    subtitle: routeSourceSubtitle(row),
                    icon: <RouteSourceIcon gateway={id === 'gateways'} icon={row.icon} dimmed={row.worksWith !== null} />,
                    ...(row.worksWith ? { disabled: true } : {
                        rightAccessory: <RouteSourceChevron />,
                        accessibilityLabel: t('agentInput.model.browseSource', { source: row.label }),
                        onSelect: () => browse(agentTargetKey, { connectionId: row.connectionId, label: row.label }),
                    }),
                })),
            }]
        );
        return [
            ...section('gateways', t('settingsProvidersCollection.gateway.railGroup'), rows.gateways),
            ...section('providers', t('settingsProviders.title'), rows.providers),
        ];
    }, [agentTargetKey, browse, hiddenSources, shownSources, views]);
}
