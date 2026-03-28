import type { SessionHandoffTransportStrategy } from '@happier-dev/protocol';

import { resolveMachineTransferAvailability } from '@/sync/domains/transfers/runtime/resolveTransferAvailability';
import { readCachedMachineRpcDirectRoute } from '@/sync/domains/transfers/runtime/transferRouteCache';

import { canHandoffConversation } from './handoffUiSupport';
import type { SessionHandoffRuntimeAvailability } from './useSessionHandoffSourceReachability';

type SessionLike = Readonly<{
    metadata?: Record<string, unknown> | null;
}>;

export type SessionHandoffUiAvailability =
    | Readonly<{
        available: true;
        reason: 'available';
    }>
    | Readonly<{
        available: false;
        reason:
            | 'handoff_feature_disabled'
            | 'session_ineligible'
            | 'transport_unavailable'
            | 'runtime_direct_peer_unavailable';
    }>;

const SESSION_HANDOFF_UI_PREFERRED_TRANSPORT_STRATEGIES: readonly SessionHandoffTransportStrategy[] = [
    'direct_peer',
    'server_routed_stream',
];

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveSessionHandoffRuntimeDirectPeerAvailability(input: Readonly<{
    serverId?: string | null;
    sourceMachineId?: string | null;
}>): SessionHandoffRuntimeAvailability {
    const serverId = normalizeNonEmptyString(input.serverId);
    const sourceMachineId = normalizeNonEmptyString(input.sourceMachineId);
    if (!serverId || !sourceMachineId) {
        return 'unknown';
    }

    const cached = readCachedMachineRpcDirectRoute({
        serverId,
        remoteMachineId: sourceMachineId,
    });

    if (cached.status === 'viable') return 'reachable';
    if (cached.status === 'unavailable') return 'unavailable';
    return 'unknown';
}

export function resolveSessionHandoffUiAvailability(input: Readonly<{
    sessionId?: string | null;
    session: SessionLike | null | undefined;
    sessionHandoffFeatureEnabled: boolean;
    serverSnapshot: unknown;
    runtimeAvailability?: SessionHandoffRuntimeAvailability | null;
}>): SessionHandoffUiAvailability {
    if (input.sessionHandoffFeatureEnabled !== true) {
        return {
            available: false,
            reason: 'handoff_feature_disabled',
        };
    }

    if (canHandoffConversation({ sessionId: input.sessionId, session: input.session }) !== true) {
        return {
            available: false,
            reason: 'session_ineligible',
        };
    }

    const transport = resolveMachineTransferAvailability({
        serverFeatures: input.serverSnapshot,
        preferredTransportStrategies: SESSION_HANDOFF_UI_PREFERRED_TRANSPORT_STRATEGIES,
    });
    if (!transport.ok) {
        return {
            available: false,
            reason: 'transport_unavailable',
        };
    }

    const runtimeAvailability = input.runtimeAvailability ?? 'unknown';

    if (transport.negotiatedTransportStrategy === 'server_routed_stream') {
        return {
            available: false,
            reason: 'runtime_direct_peer_unavailable',
        };
    }

    if (
        transport.negotiatedTransportStrategy === 'direct_peer'
        && runtimeAvailability === 'unavailable'
    ) {
        return {
            available: false,
            reason: 'runtime_direct_peer_unavailable',
        };
    }

    // The header/info surfaces do not have authoritative endpoint-candidate truth before starting a
    // handoff. Fail closed unless a caller can positively prove direct-peer viability.
    if (
        transport.negotiatedTransportStrategy === 'direct_peer'
        && runtimeAvailability !== 'reachable'
    ) {
        return {
            available: false,
            reason: 'runtime_direct_peer_unavailable',
        };
    }

    return {
        available: true,
        reason: 'available',
    };
}
