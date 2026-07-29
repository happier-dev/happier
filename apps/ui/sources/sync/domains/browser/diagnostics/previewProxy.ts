import type {
    BrowserDiagnosticFamilyV1,
    PeerMediationObservabilityScopeV1,
} from '@happier-dev/protocol';

import {
    selectPeerMediationPreviewProxyDiagnostics,
} from '@/sync/domains/machines/peer/mediation/observability/selectors';
import type {
    PeerMediationObservabilityFlowSummary,
    PeerMediationObservabilityUiStore,
} from '@/sync/domains/machines/peer/mediation/observability/types';

import type {
    BrowserDiagnosticFamilyProjection,
    BrowserPreviewProxyDiagnosticsProjection,
    BrowserPreviewProxyDiagnosticsStatus,
    BrowserPreviewProxyFlowProjection,
} from './types';
import { BROWSER_DIAGNOSTIC_FAMILIES } from './families';

const PREVIEW_PROXY_SUPPORTED_FAMILIES = new Set<BrowserDiagnosticFamilyV1>([
    'network',
    'proxyTunnel',
]);

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
    const value = record?.[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
    const value = record?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function projectFamily(
    family: BrowserDiagnosticFamilyV1,
    status: BrowserPreviewProxyDiagnosticsStatus,
): BrowserDiagnosticFamilyProjection {
    if (!PREVIEW_PROXY_SUPPORTED_FAMILIES.has(family)) {
        return {
            family,
            status: 'unavailable',
            fidelity: 'unavailable',
            trusted: false,
            reasonCode: 'unsupported_fidelity',
        };
    }
    if (status === 'unavailable') {
        return {
            family,
            status: 'unavailable',
            fidelity: 'unavailable',
            trusted: true,
        };
    }
    return {
        family,
        status,
        fidelity: 'previewProxy',
        trusted: true,
    };
}

function projectFlow(flow: PeerMediationObservabilityFlowSummary): BrowserPreviewProxyFlowProjection {
    const method = readString(flow.http, 'method');
    const path = readString(flow.http, 'path');
    const statusCode = readNumber(flow.http, 'statusCode');
    const websocketSubprotocol = readString(flow.websocket, 'subprotocol');
    const hasNetworkMetadata = Boolean(flow.http || flow.websocket);
    return {
        flowId: flow.flowId,
        family: hasNetworkMetadata ? 'network' : 'proxyTunnel',
        fidelity: 'previewProxy',
        trusted: true,
        lifecycleState: flow.lifecycleState,
        ...(method ? { method } : {}),
        ...(path ? { path } : {}),
        ...(typeof statusCode === 'number' ? { statusCode } : {}),
        ...(websocketSubprotocol ? { websocketSubprotocol } : {}),
        bytesIn: flow.bytesIn,
        bytesOut: flow.bytesOut,
        messagesIn: flow.messagesIn,
        messagesOut: flow.messagesOut,
        activeSubstreams: flow.activeSubstreams,
        ...(typeof flow.movingThroughputBps === 'number' ? { movingThroughputBps: flow.movingThroughputBps } : {}),
        ...(flow.closeReasonCode ? { closeReasonCode: flow.closeReasonCode } : {}),
        ...(flow.abortReasonCode ? { abortReasonCode: flow.abortReasonCode } : {}),
        ...(flow.errorReasonCode ? { errorReasonCode: flow.errorReasonCode } : {}),
        lastActivityAtMs: flow.lastActivityAtMs,
    };
}

export function buildBrowserPreviewProxyDiagnosticsProjection(input: Readonly<{
    pmsDiagnostics: ReturnType<typeof selectPeerMediationPreviewProxyDiagnostics>;
}>): BrowserPreviewProxyDiagnosticsProjection {
    const status = input.pmsDiagnostics.status;
    if (status === 'unavailable') {
        return {
            status,
            sourceKind: 'previewProxy',
            fidelity: 'unavailable',
            trusted: true,
            attribution: 'traffic_for_preview_all_views',
            unavailableReasonCode: input.pmsDiagnostics.reasonCode,
            activeFlowCount: 0,
            families: BROWSER_DIAGNOSTIC_FAMILIES.map((family) => projectFamily(family, status)),
            flows: [],
        };
    }

    return {
        status,
        sourceKind: 'previewProxy',
        fidelity: 'previewProxy',
        trusted: true,
        attribution: input.pmsDiagnostics.attribution,
        activeFlowCount: input.pmsDiagnostics.activeFlowCount,
        families: BROWSER_DIAGNOSTIC_FAMILIES.map((family) => projectFamily(family, status)),
        flows: input.pmsDiagnostics.flows.map(projectFlow),
    };
}

export function selectBrowserPreviewProxyDiagnostics(
    state: PeerMediationObservabilityUiStore,
    input: Readonly<{
        scope: PeerMediationObservabilityScopeV1;
        previewId: string;
    }>,
): BrowserPreviewProxyDiagnosticsProjection {
    return buildBrowserPreviewProxyDiagnosticsProjection({
        pmsDiagnostics: selectPeerMediationPreviewProxyDiagnostics(state, input),
    });
}
