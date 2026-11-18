import type { ProviderModelDescriptorV1 } from '@happier-dev/protocol/models/descriptor';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import type { DaemonProviderModelProjectionHiddenSourceV1, DaemonProviderModelProjectionRowV1 } from '@happier-dev/protocol/rpc';

import type { SessionModelPickerOption, SessionModelPickerSection, SessionModelProjectionGroup } from './buildSessionModelPickerSections';
import { isTeamCredentialProviderModelPickerValue, sessionModelSelectionKey } from './sessionModelSelectionKey';

export type SessionModelPickerSourceState = 'ready' | 'signed-out' | 'needs-key' | 'unavailable';
type UpstreamRef = NonNullable<ProviderModelDescriptorV1['upstreamRef']>;
type HiddenSource = Pick<DaemonProviderModelProjectionHiddenSourceV1, 'connectionId' | 'upstreamModels'>;
const upstreamKey = ({ vendor, vendorModelId }: UpstreamRef) => JSON.stringify([vendor, vendorModelId]);
const connectionRouteKey = (connectionId: string | null, agentTargetKey: string | null) => JSON.stringify([connectionId, agentTargetKey]);

export function resolveSessionModelPickerSourceState(
    authorization: SessionModelProjectionGroup['authorization'],
    endpointHealth: DaemonProviderModelProjectionRowV1['endpointHealth'],
): SessionModelPickerSourceState {
    if (authorization.authorized) return endpointHealth === 'unauthorized' ? 'needs-key' : 'ready';
    if (authorization.error.code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired) return 'signed-out';
    if (authorization.error.action === 'add_secret' || authorization.error.action === 'replace_secret') return 'needs-key';
    return 'unavailable';
}

export type SessionModelPickerSourceGroup = Readonly<{
    key: string;
    upstreamRef: ProviderModelDescriptorV1['upstreamRef'];
    sources: readonly Readonly<{
        key: string;
        providerConnectionId: string | null;
        state: SessionModelPickerSourceState;
        hidden: boolean;
        options: readonly SessionModelPickerOption[];
    }>[];
    sourceCount: number;
}>;

/** Group by declared upstream identity. Credential recovery routes stay available to the menu without inflating the count. */
export function selectSessionModelPickerSourceGroups(
    sections: readonly SessionModelPickerSection[],
    projection?: Readonly<{ agentTargetKey: string; hiddenSources: readonly HiddenSource[] }>,
): readonly SessionModelPickerSourceGroup[] {
    type Source = Omit<SessionModelPickerSourceGroup['sources'][number], 'options' | 'state'> & {
        options: SessionModelPickerOption[];
        state: SessionModelPickerSourceState;
    };
    const models = new Map<string, { upstreamRef: SessionModelPickerSourceGroup['upstreamRef']; sources: Map<string, Source> }>();
    const seen = new Set<string>();
    const hiddenConnectionIds = new Set(projection?.hiddenSources.map(source => source.connectionId));
    for (const { options } of sections) {
        for (const option of options) {
            const { value, upstreamRef } = option;
            const selectionKey = sessionModelSelectionKey(value);
            if (seen.has(selectionKey)) continue;
            seen.add(selectionKey);
            const key = upstreamRef ? upstreamKey(upstreamRef) : selectionKey;
            const group = models.get(key) ?? { upstreamRef, sources: new Map<string, Source>() };
            models.set(key, group);
            const team = isTeamCredentialProviderModelPickerValue(value) ? value : null;
            const providerConnectionId = value !== null && 'providerConnectionId' in value
                ? value.providerConnectionId : null;
            const routeKey = team ? JSON.stringify(['team', team.teamId, team.resourceId])
                : connectionRouteKey(providerConnectionId, value?.agentTargetKey ?? null);
            const state = option.sourceState ?? (option.availability === 'unavailable' ? 'unavailable' : 'ready');
            const hidden = providerConnectionId !== null && hiddenConnectionIds.has(providerConnectionId);
            const source = group.sources.get(routeKey) ?? { key: routeKey, providerConnectionId, state, hidden, options: [] };
            if (state === 'ready') source.state = state;
            source.options.push(option);
            group.sources.set(routeKey, source);
        }
    }
    if (projection) {
        for (const { connectionId, upstreamModels } of projection.hiddenSources) {
            const key = connectionRouteKey(connectionId, projection.agentTargetKey);
            for (const { upstreamRef, endpointHealth } of upstreamModels ?? []) {
                const group = models.get(upstreamKey(upstreamRef));
                if (!group) continue;
                // The catalog only projects withheld model identities from authorized sources.
                const state = resolveSessionModelPickerSourceState({ authorized: true }, endpointHealth);
                const source = group.sources.get(key) ?? { key, providerConnectionId: connectionId, state, hidden: true, options: [] };
                if (state === 'ready') source.state = state;
                group.sources.set(key, source);
            }
        }
    }
    return Array.from(models, ([key, { upstreamRef, sources }]) => {
        const routes = [...sources.values()];
        return { key, upstreamRef, sources: routes, sourceCount: routes.filter(route => route.state === 'ready').length };
    });
}
