import { redactPeerMediationObservabilityMetadata } from '@happier-dev/protocol';

import { peerMediationObservabilityFlowKey, peerMediationObservabilityScopeKey } from './keys';
import type {
    PeerMediationObservabilityFlowEntry,
    PeerMediationObservabilityFlowSummary,
    PeerMediationObservabilityScopeState,
    PeerMediationObservabilityUiStore,
    PeerMediationPreviewProxyDiagnostics,
} from './types';
import type { PeerMediationObservabilityScopeV1 } from '@happier-dev/protocol';

/**
 * Relative-URL parse base for the shared redactor. The daemon binds `loopback.invalid` and the
 * server binds `preview.invalid`; the UI only ever re-reads already-redacted producer metadata, so
 * it binds its own base rather than pretending to be either producer.
 */
const UI_OBSERVABILITY_URL_BASE = 'http://observability.invalid';

export function selectPeerMediationObservabilityScopeState(
    state: PeerMediationObservabilityUiStore,
    scope: PeerMediationObservabilityScopeV1,
): PeerMediationObservabilityScopeState {
    const scopeKey = peerMediationObservabilityScopeKey(scope);
    return state.scopesByKey[scopeKey] ?? {
        scope,
        scopeKey,
        status: 'idle',
        stale: false,
        unavailableReasonCode: null,
        lastAppliedSequenceBySource: {},
        staleSourceBySource: {},
        flowsByKey: {},
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Metadata redaction is owned by protocol (`metadataRedaction.ts`), which already documents this
 * exact consolidation for the daemon/server copies. This selector used to carry a third fork with
 * different rules: it dropped every header object outright instead of applying the shared
 * safe-header allowlist, and it truncated nothing (DEC-8).
 */
function sanitizeMetadata(input: unknown): Record<string, unknown> | undefined {
    if (!isRecord(input)) return undefined;
    return {
        ...redactPeerMediationObservabilityMetadata(input, { urlBase: UI_OBSERVABILITY_URL_BASE }),
    };
}

function pickCounter(
    daemon: number | undefined,
    server: number | undefined,
    fallback = 0,
): number {
    return daemon ?? server ?? fallback;
}

function summarizeFlow(entry: PeerMediationObservabilityFlowEntry): PeerMediationObservabilityFlowSummary {
    const server = entry.sources.server?.snapshot;
    const daemon = entry.sources.daemon?.snapshot;
    const authoritative = server ?? daemon;
    if (!authoritative) {
        throw new Error('peer mediation observability flow entry has no source family');
    }
    const daemonCounters = daemon ?? server;
    const http = sanitizeMetadata(server?.http ?? daemon?.http);
    const websocket = sanitizeMetadata(server?.websocket ?? daemon?.websocket);
    return {
        key: entry.key,
        machineKey: entry.machineKey,
        flowId: entry.flowId,
        flowKind: entry.flowKind,
        flow: authoritative.flow,
        lifecycleState: authoritative.lifecycleState,
        startedAtMs: authoritative.startedAtMs,
        lastActivityAtMs: Math.max(server?.lastActivityAtMs ?? 0, daemon?.lastActivityAtMs ?? 0),
        ...(authoritative.closedAtMs !== undefined ? { closedAtMs: authoritative.closedAtMs } : {}),
        bytesIn: pickCounter(daemonCounters?.bytesIn, server?.bytesIn),
        bytesOut: pickCounter(daemonCounters?.bytesOut, server?.bytesOut),
        framesIn: pickCounter(daemonCounters?.framesIn, server?.framesIn),
        framesOut: pickCounter(daemonCounters?.framesOut, server?.framesOut),
        messagesIn: pickCounter(daemonCounters?.messagesIn, server?.messagesIn),
        messagesOut: pickCounter(daemonCounters?.messagesOut, server?.messagesOut),
        activeSubstreams: pickCounter(daemonCounters?.activeSubstreams, server?.activeSubstreams),
        ...(daemonCounters?.totalSubstreams ?? server?.totalSubstreams) !== undefined
            ? { totalSubstreams: daemonCounters?.totalSubstreams ?? server?.totalSubstreams }
            : {},
        ...(daemonCounters?.movingThroughputBps ?? server?.movingThroughputBps) !== undefined
            ? { movingThroughputBps: daemonCounters?.movingThroughputBps ?? server?.movingThroughputBps }
            : {},
        ...(server?.capProfileId ?? daemon?.capProfileId) !== undefined
            ? { capProfileId: server?.capProfileId ?? daemon?.capProfileId }
            : {},
        ...(server?.capUsagePercent ?? daemon?.capUsagePercent) !== undefined
            ? { capUsagePercent: server?.capUsagePercent ?? daemon?.capUsagePercent }
            : {},
        ...(server?.closeReasonCode ?? daemon?.closeReasonCode) !== undefined
            ? { closeReasonCode: server?.closeReasonCode ?? daemon?.closeReasonCode }
            : {},
        ...(server?.abortReasonCode ?? daemon?.abortReasonCode) !== undefined
            ? { abortReasonCode: server?.abortReasonCode ?? daemon?.abortReasonCode }
            : {},
        ...(server?.errorReasonCode ?? daemon?.errorReasonCode) !== undefined
            ? { errorReasonCode: server?.errorReasonCode ?? daemon?.errorReasonCode }
            : {},
        ...(http ? { http } : {}),
        ...(websocket ? { websocket } : {}),
        sourceFamilies: {
            ...(entry.sources.server ? {
                server: {
                    sequence: entry.sources.server.sequence,
                    lastUpdatedAtMs: entry.sources.server.lastUpdatedAtMs,
                },
            } : {}),
            ...(entry.sources.daemon ? {
                daemon: {
                    sequence: entry.sources.daemon.sequence,
                    lastUpdatedAtMs: entry.sources.daemon.lastUpdatedAtMs,
                },
            } : {}),
        },
    };
}

export function selectPeerMediationObservabilityFlowSummaries(
    state: PeerMediationObservabilityUiStore,
    scope: PeerMediationObservabilityScopeV1,
): readonly PeerMediationObservabilityFlowSummary[] {
    const scopeState = selectPeerMediationObservabilityScopeState(state, scope);
    return Object.values(scopeState.flowsByKey)
        .map(summarizeFlow)
        .sort((left, right) => {
            const byActivity = right.lastActivityAtMs - left.lastActivityAtMs;
            if (byActivity !== 0) return byActivity;
            return left.flowId.localeCompare(right.flowId);
        });
}

export function selectPeerMediationObservabilityActiveFlows(
    state: PeerMediationObservabilityUiStore,
    scope: PeerMediationObservabilityScopeV1,
): readonly PeerMediationObservabilityFlowSummary[] {
    return selectPeerMediationObservabilityFlowSummaries(state, scope).filter((flow) => (
        flow.lifecycleState !== 'closed'
        && flow.lifecycleState !== 'aborted'
        && flow.lifecycleState !== 'errored'
        && flow.lifecycleState !== 'denied'
    ));
}

function selectFlowSummary(
    state: PeerMediationObservabilityUiStore,
    input: Readonly<{
        scope: PeerMediationObservabilityScopeV1;
        flowId: string;
    }>,
): PeerMediationObservabilityFlowSummary | null {
    const scopeState = selectPeerMediationObservabilityScopeState(state, input.scope);
    const firstMatch = Object.values(scopeState.flowsByKey).find((entry) => entry.flowId === input.flowId);
    return firstMatch ? summarizeFlow(firstMatch) : null;
}

export function selectPeerMediationObservabilityHttpMetadata(
    state: PeerMediationObservabilityUiStore,
    input: Readonly<{
        scope: PeerMediationObservabilityScopeV1;
        flowId: string;
    }>,
): Record<string, unknown> | null {
    return selectFlowSummary(state, input)?.http ?? null;
}

export function selectPeerMediationObservabilityWebSocketMetadata(
    state: PeerMediationObservabilityUiStore,
    input: Readonly<{
        scope: PeerMediationObservabilityScopeV1;
        flowId: string;
    }>,
): Record<string, unknown> | null {
    return selectFlowSummary(state, input)?.websocket ?? null;
}

export function selectPeerMediationPreviewProxyDiagnostics(
    state: PeerMediationObservabilityUiStore,
    input: Readonly<{
        scope: PeerMediationObservabilityScopeV1;
        previewId: string;
    }>,
): PeerMediationPreviewProxyDiagnostics {
    const scopeState = selectPeerMediationObservabilityScopeState(state, input.scope);
    if (scopeState.status === 'idle' || scopeState.status === 'unavailable') {
        return {
            status: 'unavailable',
            reasonCode: scopeState.unavailableReasonCode ?? 'observability_unavailable',
        };
    }
    const flows = selectPeerMediationObservabilityFlowSummaries(state, input.scope).filter((flow) => (
        flow.flow.productRef?.kind === 'preview'
        && flow.flow.productRef.id === input.previewId
    ));
    return {
        status: scopeState.stale ? 'stale' : 'available',
        attribution: 'traffic_for_preview_all_views',
        activeFlowCount: flows.filter((flow) => (
            flow.lifecycleState !== 'closed'
            && flow.lifecycleState !== 'aborted'
            && flow.lifecycleState !== 'errored'
            && flow.lifecycleState !== 'denied'
        )).length,
        flows,
    };
}

export function selectPeerMediationObservabilityFlowByRef(
    state: PeerMediationObservabilityUiStore,
    input: Readonly<{
        scope: PeerMediationObservabilityScopeV1;
        flow: PeerMediationObservabilityFlowSummary['flow'];
    }>,
): PeerMediationObservabilityFlowSummary | null {
    const scopeState = selectPeerMediationObservabilityScopeState(state, input.scope);
    const entry = scopeState.flowsByKey[peerMediationObservabilityFlowKey(input.scope, input.flow)];
    return entry ? summarizeFlow(entry) : null;
}
