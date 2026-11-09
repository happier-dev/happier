import * as React from 'react';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveSessionHandoffSourceMachineId } from './resolveSessionHandoffSourceMachineId';
import { resolveSessionHandoffUiAvailability } from './resolveSessionHandoffUiAvailability';
import { useSessionHandoffSourceReachability } from './useSessionHandoffSourceReachability';
import { runSessionHandoffPickerFlow } from './runSessionHandoffPickerFlow';
import { probeSessionHandoffSourceReachability } from './probeSessionHandoffSourceReachability';

/** Shared Session header, Info and Inbox entry; probe only at the person's Handoff intent. */
export function useSessionHandoffAction(input: Readonly<{
    sessionId: string;
    session: Session | null;
    serverId: string | null;
    reachableMachineId: string | null;
    sessionHandoffFeatureEnabled: boolean;
    execute: Parameters<typeof runSessionHandoffPickerFlow>[0]['execute'];
    placement: Parameters<typeof runSessionHandoffPickerFlow>[0]['placement'];
}>) {
    const ownerMetadata = input.session ? readSessionOwnerMetadataView(input.session) : null;
    const sourceMachineId = React.useMemo(() => resolveSessionHandoffSourceMachineId({
        reachableMachineId: input.reachableMachineId, sessionMetadata: ownerMetadata,
    }), [input.reachableMachineId, ownerMetadata]);
    const serverSnapshot = useServerFeaturesSnapshotForServerId(input.serverId, { enabled: Boolean(input.serverId) });
    const runtimeAvailability = useSessionHandoffSourceReachability({ serverId: input.serverId, sourceMachineId });
    const availability = resolveSessionHandoffUiAvailability({ sessionId: input.sessionId, serverId: input.serverId,
        reachableMachineId: input.reachableMachineId, session: input.session,
        sessionHandoffFeatureEnabled: input.sessionHandoffFeatureEnabled, serverSnapshot, runtimeAvailability });
    const run = React.useCallback(async () => {
        if (!availability.available) return null;
        const reachability = await probeSessionHandoffSourceReachability({ serverId: input.serverId, sourceMachineId });
        if (reachability === 'unavailable') {
            Modal.alert(t('sessionHandoff.failure.title'), t('errors.daemonUnavailableBody'));
            return null;
        }
        return runSessionHandoffPickerFlow({ execute: input.execute, sessionId: input.sessionId,
            sourceMachineId, serverId: input.serverId, placement: input.placement,
        });
    }, [input.execute, input.placement, input.serverId, input.sessionId, sourceMachineId, availability.available]);
    return { availability, run, sourceMachineId };
}
