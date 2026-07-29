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

type SidecarDiagnosticsAccessInput = Readonly<{
    requesterAccountId: string;
}>;

type SidecarDiagnosticsGateInput = Readonly<{
    featureEnabled: boolean;
    policyAllowed: boolean;
    runtimeAvailable: boolean;
}>;

type SidecarDiagnosticsPublisherDeps = Readonly<{
    ownerAccountId: string;
    publish: (event: BrowserDiagnosticEventV1) => void;
}>;

type SidecarDiagnosticsDeniedResult = Readonly<{
    status: 'denied';
    reason: 'not_owner';
    published: false;
}>;

type SidecarDiagnosticsPublishedResult = Readonly<{
    status: 'published';
    published: true;
    event: BrowserDiagnosticEventV1;
    reason?: BrowserDiagnosticUnavailableReasonV1;
}>;

export type SidecarDiagnosticsPublicationResult =
    | SidecarDiagnosticsDeniedResult
    | SidecarDiagnosticsPublishedResult;

type SidecarDiagnosticsUnavailableInput = SidecarDiagnosticsAccessInput
    & SidecarDiagnosticsGateInput
    & Readonly<{
        browserSessionId: string;
        viewId: string;
        navigationGeneration: number;
        capturedAtMs: number;
        eventOrdinal: number;
        family: BrowserDiagnosticFamilyV1;
        reason?: BrowserDiagnosticUnavailableReasonV1;
    }>;

type SidecarDiagnosticsCdpPublicationInput = SidecarDiagnosticsAccessInput
    & SidecarDiagnosticsGateInput
    & SidecarCdpDiagnosticEventInput;

function denied(): SidecarDiagnosticsDeniedResult {
    return {
        status: 'denied',
        reason: 'not_owner',
        published: false,
    };
}

function resolveUnavailableReason(input: SidecarDiagnosticsGateInput): BrowserDiagnosticUnavailableReasonV1 | null {
    if (!input.featureEnabled) return 'feature_disabled';
    if (!input.policyAllowed) return 'policy_denied';
    if (!input.runtimeAvailable) return 'adapter_unavailable';
    return null;
}

function diagnosticFamilyForSidecarEvent(
    event: SidecarCdpDiagnosticEventInput['event'],
): BrowserDiagnosticFamilyV1 {
    switch (event.kind) {
        case 'network.requestWillBeSent':
        case 'network.responseReceived':
        case 'network.loadingFailed':
        case 'network.webSocketSummary':
            return 'network';
        case 'runtime.consoleEntry':
            return 'console';
        case 'runtime.exceptionThrown':
            return 'pageError';
        case 'page.info':
            return 'pageInfo';
    }
}

export function createSidecarDiagnosticsPublisher(deps: SidecarDiagnosticsPublisherDeps): Readonly<{
    publishCdpEvent: (input: SidecarDiagnosticsCdpPublicationInput) => SidecarDiagnosticsPublicationResult;
    publishUnavailable: (input: SidecarDiagnosticsUnavailableInput) => SidecarDiagnosticsPublicationResult;
}> {
    function isOwner(input: SidecarDiagnosticsAccessInput): boolean {
        return input.requesterAccountId === deps.ownerAccountId;
    }

    function publishUnavailable(input: SidecarDiagnosticsUnavailableInput): SidecarDiagnosticsPublicationResult {
        if (!isOwner(input)) return denied();

        const reason = resolveUnavailableReason(input) ?? input.reason ?? 'adapter_unavailable';

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
            if (!isOwner(input)) return denied();

            const reason = resolveUnavailableReason(input);
            if (reason) {
                return publishUnavailable({
                    requesterAccountId: input.requesterAccountId,
                    browserSessionId: input.browserSessionId,
                    viewId: input.viewId,
                    navigationGeneration: input.navigationGeneration,
                    capturedAtMs: input.capturedAtMs,
                    eventOrdinal: input.eventOrdinal,
                    family: diagnosticFamilyForSidecarEvent(input.event),
                    featureEnabled: input.featureEnabled,
                    policyAllowed: input.policyAllowed,
                    runtimeAvailable: input.runtimeAvailable,
                });
            }

            const event = mapSidecarCdpDiagnosticEvent(input);
            deps.publish(event);
            return {
                status: 'published',
                published: true,
                event,
            };
        },
        publishUnavailable,
    };
}
