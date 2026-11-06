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
import type { SessionRoute } from '@/providers/session/resolveSessionRoutePresentation';

/** What the "Runs through" popover needs to name an Agent's Gateways and Providers and browse one. */
export type SessionRouteSources = Readonly<{
    machineId: string | null;
    serverId: string | null;
    agentTargetKey: string;
    shownSources: readonly Readonly<{ connectionId: string; rows: readonly unknown[] }>[];
    hiddenSources: readonly Readonly<{ connectionId: string; modelCount: number }>[];
}>;

function RouteSourceIcon(props: Readonly<{ contributionKey: string | null; icon: string | null; dimmed: boolean }>) {
    const { theme } = useUnistyles();
    const color = props.dimmed ? theme.colors.text.tertiary : theme.colors.text.secondary;
    return normalizeNodeForView(<ProviderIcon contributionKey={props.contributionKey} icon={props.icon} size={20} color={color} />);
}

/** Trailing mark of a row that opens a source to browse. */
export function RouteSourceChevron() {
    const { theme } = useUnistyles();
    return normalizeNodeForView(<Icon name="caret-right" size={16} color={theme.colors.text.tertiary} />);
}

function routeSourceSubtitle(row: SessionRouteSourceRow): string {
    if (row.worksWith) return t('connectedServices.authChip.worksWith', { agents: row.worksWith.join(', ') });
    if (row.modelCount === null) return t('agentInput.model.browseSource', { source: row.label });
    const models = t('settingsProviders.detail.modelCount', { count: row.modelCount });
    return row.hiddenFromPicker ? `${models} · ${t('agentInput.model.hiddenFromMainPicker')}` : models;
}

/**
 * The popover's Gateways and Providers groups (RT1). Mounted only inside the open popover, so the
 * connection read is demanded by the person opening it. A row opens the engine pane on that source
 * through the composer's hand-off; picking a model there stays the only commit.
 */
export function useSessionRouteSourceSections(
    sources: SessionRouteSources | undefined,
    appliedRoute?: SessionRoute,
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
    const selectedConnectionId = appliedRoute?.kind === 'provider' ? appliedRoute.connectionId : null;

    return React.useMemo(() => {
        if (!views || !agentTargetKey || !browse) return [];
        const rows = buildSessionRouteSourceRows({
            declarationContext: connections.declarationContext,
            agentTargetKey, views, shownSources: shownSources ?? [], hiddenSources: hiddenSources ?? [],
            isGateway: view => (readProviderGatewayViewDeclarations(view, connections.declarationContext)?.length ?? 0) > 0,
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
                    icon: <RouteSourceIcon contributionKey={row.contributionKey}
                        icon={row.icon} dimmed={row.worksWith !== null} />,
                    selected: row.connectionId === selectedConnectionId,
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
    }, [connections.declarationContext, agentTargetKey, browse, hiddenSources, selectedConnectionId, shownSources, views]);
}
