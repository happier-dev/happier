import type {
    BrowserDiagnosticEventV1,
    BrowserDiagnosticFamilyV1,
    BrowserDiagnosticUnavailableReasonV1,
} from '@happier-dev/protocol';

import {
    mapSidecarCdpDiagnosticEvent,
    mapSidecarCdpDiagnosticUnavailable,
    type SidecarCdpDiagnosticEventInput,
} from './mapEvents';
import { createSidecarPrivateReference } from './redaction';
import type { BrowserDiagnosticsPrivateNetworkRequest } from '../../diagnostics/store';

type SidecarDiagnosticsPublisherDeps = Readonly<{
    publish: (event: BrowserDiagnosticEventV1, privateRequest?: BrowserDiagnosticsPrivateNetworkRequest) => void;
    getNetworkRequest?: (input: Readonly<{ browserSessionId: string; viewId: string; navigationGeneration: number; requestId: string }>) => BrowserDiagnosticEventV1 | undefined;
}>;

type SidecarDiagnosticsPublishedResult = Readonly<{
    status: 'published';
    published: true;
    event: BrowserDiagnosticEventV1;
    reason?: BrowserDiagnosticUnavailableReasonV1;
}>;

export type SidecarDiagnosticsPublicationResult = SidecarDiagnosticsPublishedResult;

type SidecarDiagnosticsUnavailableInput = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    capturedAtMs: number;
    eventOrdinal: number;
    family: BrowserDiagnosticFamilyV1;
    reason?: BrowserDiagnosticUnavailableReasonV1;
}>;

type SidecarDiagnosticsCdpPublicationInput = SidecarCdpDiagnosticEventInput & Readonly<{ privateRequest?: BrowserDiagnosticsPrivateNetworkRequest }>;

export function createSidecarDiagnosticsPublisher(deps: SidecarDiagnosticsPublisherDeps): Readonly<{
    publishCdpEvent: (input: SidecarDiagnosticsCdpPublicationInput) => SidecarDiagnosticsPublicationResult;
    publishUnavailable: (input: SidecarDiagnosticsUnavailableInput) => SidecarDiagnosticsPublicationResult;
}> {
    function publishUnavailable(input: SidecarDiagnosticsUnavailableInput): SidecarDiagnosticsPublicationResult {
        const reason = input.reason ?? 'adapter_unavailable';

        const event = mapSidecarCdpDiagnosticUnavailable({
            browserSessionId: input.browserSessionId,
            viewId: input.viewId,
            navigationGeneration: input.navigationGeneration,
            capturedAtMs: input.capturedAtMs,
            eventOrdinal: input.eventOrdinal,
            family: input.family,
            reason,
        });
        deps.publish(event);
        return {
            status: 'published',
            published: true,
            event,
            reason,
        };
    }

    return {
        publishCdpEvent: (input) => {
            const previous = 'requestId' in input.event && input.event.kind !== 'network.webSocketSummary'
                ? deps.getNetworkRequest?.({ browserSessionId: input.browserSessionId, viewId: input.viewId,
                    navigationGeneration: input.navigationGeneration,
                    requestId: createSidecarPrivateReference('request', input.event.requestId) }) : undefined;
            const event = mapSidecarCdpDiagnosticEvent(input, previous);
            deps.publish(event, input.privateRequest);
            return {
                status: 'published',
                published: true,
                event,
            };
        },
        publishUnavailable,
    };
}
