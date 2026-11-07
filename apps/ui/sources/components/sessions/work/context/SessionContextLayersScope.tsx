import * as React from 'react';

import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';

import { resolveSessionInstructionsAccess } from '../instructions/SessionInstructionsSection';
import { useSessionContextLayers, type SessionContextLayers } from './useSessionContextLayers';

type LayerParams = Parameters<typeof useSessionContextLayers>[0];
type ObservationProps = Readonly<{ params: LayerParams; children: (layers: SessionContextLayers) => React.ReactNode }>;
const LayerObservation = React.createContext<Readonly<{ params: LayerParams; layers: SessionContextLayers }> | null>(null);

function ObserveSessionContextLayers(props: ObservationProps) {
    return props.children(useSessionContextLayers(props.params));
}

/** Setup's co-mounted Context and Memory consume one observation of this Session's layers. */
export function SessionContextLayersScope(props: Readonly<{ session: Session; serverId: string; children: React.ReactNode }>) {
    const ownerMetadata = React.useMemo(() => readSessionOwnerMetadataView(props.session), [props.session]);
    const params = React.useMemo(() => ({ sessionId: props.session.id, serverId: props.serverId,
        ownerMetadata, metadataVersion: props.session.metadataVersion }),
    [props.session.id, props.serverId, ownerMetadata, props.session.metadataVersion]);
    if (resolveSessionInstructionsAccess(props.session) !== 'readable' || !ownerMetadata) return props.children;
    return <ObserveSessionContextLayers params={params}>{layers =>
        <LayerObservation.Provider value={{ params, layers }}>{props.children}</LayerObservation.Provider>
    }</ObserveSessionContextLayers>;
}

/** Standalone sections still observe through the same hook; a matching Setup already owns it. */
export function SessionContextLayersObservation(props: ObservationProps) {
    const shared = React.useContext(LayerObservation);
    return shared && shared.params.sessionId === props.params.sessionId && shared.params.serverId === props.params.serverId
        && shared.params.metadataVersion === props.params.metadataVersion && shared.params.ownerMetadata === props.params.ownerMetadata
        ? props.children(shared.layers) : <ObserveSessionContextLayers {...props} />;
}
