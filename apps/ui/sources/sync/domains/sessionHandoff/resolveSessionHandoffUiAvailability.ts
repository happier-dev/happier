import { readDeclaredVendorHandoffRefusal, resolveAgentIdFromSessionMetadata, VENDOR_HANDOFF_UNSUPPORTED } from '@happier-dev/agents';
import type { SessionHandoffTransportStrategy } from '@happier-dev/protocol/sessions/control/handoff/handoffTypes';

import { storage } from '@/sync/domains/state/storage';
import {
    resolveMachineDaemonTransferDirectPeerDiagnostics,
} from '@/sync/domains/transfers/runtime/transferRuntime/availability/machineDaemonTransferState';
import { resolveMachineTransferAvailability } from '@/sync/domains/transfers/runtime/resolveTransferAvailability';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';

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
            | typeof VENDOR_HANDOFF_UNSUPPORTED
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

function hasResolvableSessionHandoffSource(input: Readonly<{
    sessionId?: string | null;
    reachableMachineId?: string | null;
    sessionMetadata: Record<string, unknown> | null;
}>): boolean {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const reachableMachineId = normalizeNonEmptyString(input.reachableMachineId)
        ?? (sessionId ? readMachineTargetForSession(sessionId)?.machineId : null)
        ?? null;
    const { sessionMetadata } = input;
    if (!reachableMachineId && !sessionMetadata) {
        return false;
    }

    return resolveSessionHandoffSourceMachineId({
        reachableMachineId,
        ...(sessionMetadata ? { sessionMetadata } : {}),
    }) !== null;
}

function readSourceMachineDaemonState(input: Readonly<{
    sessionId?: string | null;
    serverId?: string | null;
    reachableMachineId?: string | null;
    sessionMetadata: Record<string, unknown> | null;
}>): unknown | null {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const serverId = normalizeNonEmptyString(input.serverId);
    const reachableMachineId = normalizeNonEmptyString(input.reachableMachineId)
        ?? (sessionId ? readMachineTargetForSession(sessionId)?.machineId : null)
        ?? null;
    const { sessionMetadata } = input;
    if (!sessionId || (!reachableMachineId && !sessionMetadata)) {
        return null;
    }

    const sourceMachineId = resolveSessionHandoffSourceMachineId({
        reachableMachineId,
        ...(sessionMetadata ? { sessionMetadata } : {}),
    });
    if (!sourceMachineId) {
        return null;
    }

    const state = storage.getState();
    const scopedMachines = serverId ? state.machineRecordsByServerId[serverId] : undefined;
    const scopedMachine = scopedMachines && Object.hasOwn(scopedMachines, sourceMachineId)
        ? scopedMachines[sourceMachineId] : null;
    if (scopedMachine) {
        return scopedMachine.daemonState ?? null;
    }

    return state.machines?.[sourceMachineId]?.daemonState ?? null;
}

function resolveSessionHandoffDaemonDirectPeerAvailability(input: Readonly<{
    sessionId?: string | null;
    serverId?: string | null;
    reachableMachineId?: string | null;
    sessionMetadata: Record<string, unknown> | null;
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

    const metadata = input.session
        ? readSessionOwnerMetadataView({
            metadataLayoutVersion: input.session.metadataLayoutVersion,
            metadata: input.session.metadata ?? null,
            ownerMetadataView: input.session.ownerMetadataView,
        })
        : null;
    const refusal = readDeclaredVendorHandoffRefusal(resolveAgentIdFromSessionMetadata(metadata));
    if (refusal) return { available: false, reason: refusal.errorCode };

    if (!hasResolvableSessionHandoffSource({
        sessionId: input.sessionId,
        reachableMachineId: input.reachableMachineId,
        sessionMetadata: metadata,
    })) {
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
        sessionMetadata: metadata,
        machineDaemonState: input.machineDaemonState,
    });
    const runtimeAvailability = daemonRuntimeAvailability !== 'unknown'
        ? daemonRuntimeAvailability
        : (input.runtimeAvailability ?? 'unknown');

    if (transport.negotiatedTransportStrategy === 'server_routed_stream') {
        return {
            available: true,
            reason: 'available',
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
