import type { SessionHandoffTransportStrategy } from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import {
    resolveMachineDaemonTransferDirectPeerDiagnostics,
} from '@/sync/domains/transfers/runtime/transferRuntime/availability/machineDaemonTransferState';
import { resolveMachineTransferAvailability } from '@/sync/domains/transfers/runtime/resolveTransferAvailability';
import { readCachedMachineRpcDirectRoute } from '@/sync/domains/transfers/runtime/transferRouteCache';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';

import { canHandoffConversation } from './handoffUiSupport';
import { resolveSessionHandoffSourceMachineId } from './resolveSessionHandoffSourceMachineId';
import type { SessionHandoffRuntimeAvailability } from './useSessionHandoffSourceReachability';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

type SessionLike = Readonly<{
    metadata?: Record<string, unknown> | null;
    metadataLayoutVersion?: number;
    ownerMetadataView?: Record<string, unknown> | null;
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

function readSourceMachineDaemonState(input: Readonly<{
    sessionId?: string | null;
    serverId?: string | null;
    reachableMachineId?: string | null;
    session: SessionLike | null | undefined;
}>): unknown | null {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const serverId = normalizeNonEmptyString(input.serverId);
    const reachableMachineId = normalizeNonEmptyString(input.reachableMachineId);
    const sessionMetadata = input.session
        ? readSessionOwnerMetadataView({
            metadataLayoutVersion: input.session.metadataLayoutVersion,
            metadata: input.session.metadata ?? null,
            ownerMetadataView: input.session.ownerMetadataView,
        })
        : null;
    if (!sessionId || !sessionMetadata) {
        return null;
    }

    const sourceMachineId = resolveSessionHandoffSourceMachineId({
        reachableMachineId: reachableMachineId ?? readMachineTargetForSession(sessionId)?.machineId ?? null,
        sessionMetadata,
    });
    if (!sourceMachineId) {
        return null;
    }

    const state = storage.getState() as Readonly<{
        machines?: Record<string, { daemonState?: unknown | null } | undefined>;
        machineListByServerId?: Record<string, readonly Readonly<{ id: string; daemonState?: unknown | null }>[] | null | undefined>;
    }>;
    const scopedMachine = serverId
        ? (state.machineListByServerId?.[serverId]?.find((candidate) => candidate.id === sourceMachineId) ?? null)
        : null;
    if (scopedMachine) {
        return scopedMachine.daemonState ?? null;
    }

    return state.machines?.[sourceMachineId]?.daemonState ?? null;
}

function resolveSessionHandoffDaemonDirectPeerAvailability(input: Readonly<{
    sessionId?: string | null;
    serverId?: string | null;
    reachableMachineId?: string | null;
    session: SessionLike | null | undefined;
    machineDaemonState?: unknown | null;
}>): SessionHandoffRuntimeAvailability {
    const daemonState = input.machineDaemonState ?? readSourceMachineDaemonState(input);
    const diagnostics = resolveMachineDaemonTransferDirectPeerDiagnostics({
        daemonState,
    });

    if (diagnostics.state === 'active') {
        return 'reachable';
    }
    if (diagnostics.state === 'unconfigured') {
        return 'unavailable';
    }
    if (diagnostics.state === 'configured_inactive') {
        // The transfer listener is configured but lazily started. Require a live runtime proof
        // before surfacing handoff, but do not fail closed purely on coarse idle state.
        return 'unknown';
    }
    return 'unknown';
}

export function resolveSessionHandoffRuntimeDirectPeerAvailability(input: Readonly<{
    serverId?: string | null;
    sourceMachineId?: string | null;
    reachableMachineId?: string | null;
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
    serverId?: string | null;
    reachableMachineId?: string | null;
    session: SessionLike | null | undefined;
    sessionHandoffFeatureEnabled: boolean;
    serverSnapshot: unknown;
    runtimeAvailability?: SessionHandoffRuntimeAvailability | null;
    machineDaemonState?: unknown | null;
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

    const daemonRuntimeAvailability = resolveSessionHandoffDaemonDirectPeerAvailability({
        sessionId: input.sessionId,
        serverId: input.serverId,
        reachableMachineId: input.reachableMachineId,
        session: input.session,
        machineDaemonState: input.machineDaemonState,
    });
    const runtimeAvailability = daemonRuntimeAvailability !== 'unknown'
        ? daemonRuntimeAvailability
        : (input.runtimeAvailability ?? 'unknown');

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
