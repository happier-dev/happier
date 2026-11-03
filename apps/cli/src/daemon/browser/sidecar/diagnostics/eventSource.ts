import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import type { BrowserAdapterCapabilitiesV1, BrowserDiagnosticFamilyV1, BrowserDiagnosticUnavailableReasonV1 } from '@happier-dev/protocol';

import type { BrowserDiagnosticsDaemonStore, BrowserDiagnosticsPrivateNetworkRequest } from '../../diagnostics/store';
import type { SidecarCdpDiagnosticEventInput } from './mapEvents';
import { createSidecarDiagnosticsPublisher } from './publish';
import { SIDECAR_CDP_DIAGNOSTIC_FAMILIES } from './cdpEventSource';

type SidecarDiagnosticsSourceCdpEvent = Readonly<{
    capturedAtMs?: number;
    rawCdpSessionId?: string;
    debuggerUrl?: string;
    event: SidecarCdpDiagnosticEventInput['event'];
    privateRequest?: BrowserDiagnosticsPrivateNetworkRequest;
}>;

type SidecarDiagnosticsSourceUnavailableEvent = Readonly<{
    capturedAtMs?: number;
    family: BrowserDiagnosticFamilyV1;
    reason?: BrowserDiagnosticUnavailableReasonV1;
}>;

export type SidecarDiagnosticsEventSourceSubscriber = Readonly<{
    onCdpEvent(event: SidecarDiagnosticsSourceCdpEvent): void;
    onUnavailable(event: SidecarDiagnosticsSourceUnavailableEvent): void;
}>;

export type SidecarDiagnosticsEventSourceSubscription = Readonly<{
    stop(): void;
}>;

export type SidecarDiagnosticsEventSource = Readonly<{
    sourceId: string;
    start(subscriber: SidecarDiagnosticsEventSourceSubscriber): SidecarDiagnosticsEventSourceSubscription;
}>;

export type InMemorySidecarDiagnosticsEventSource = SidecarDiagnosticsEventSource & Readonly<{
    emitCdpEvent(event: SidecarDiagnosticsSourceCdpEvent): void;
    emitUnavailable(event: SidecarDiagnosticsSourceUnavailableEvent): void;
    startCount(): number;
    activeSubscriberCount(): number;
}>;

type SidecarDiagnosticsAttachInput = Readonly<{
    requesterAccountId: string;
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    adapterCapabilities: BrowserAdapterCapabilitiesV1;
    source: SidecarDiagnosticsEventSource;
    families: readonly BrowserDiagnosticFamilyV1[];
}>;

type SidecarDiagnosticsCloseViewInput = Readonly<{
    browserSessionId: string;
    viewId: string;
}>;

type SidecarDiagnosticsCloseSessionInput = Readonly<{
    browserSessionId: string;
}>;

export type SidecarDiagnosticsEventSourceAttachResult =
    | Readonly<{ status: 'attached'; sourceId: string }>
    | Readonly<{
        status: 'unsupported';
        reason: BrowserDiagnosticUnavailableReasonV1;
        sourceStarted: false;
    }>
    | Readonly<{
        status: 'denied';
        reason: 'not_owner';
        sourceStarted: false;
    }>;

type ActiveSourceBinding = Readonly<{
    browserSessionId: string;
    viewId: string;
    sourceId: string;
    subscription: SidecarDiagnosticsEventSourceSubscription;
}>;

type OrdinalTarget = Readonly<{
    browserSessionId: string;
    viewId: string;
}>;

function bindingKey(input: Readonly<{ browserSessionId: string; viewId: string; sourceId: string }>): string {
    return browserViewKey(input, input.sourceId);
}

function uniqueFamilies(families: readonly BrowserDiagnosticFamilyV1[]): readonly BrowserDiagnosticFamilyV1[] {
    const seen = new Set<BrowserDiagnosticFamilyV1>();
    const out: BrowserDiagnosticFamilyV1[] = [];
    for (const family of families.length > 0 ? families : SIDECAR_CDP_DIAGNOSTIC_FAMILIES) {
        if (seen.has(family)) continue;
        seen.add(family);
        out.push(family);
    }
    return out;
}

function familyForCdpEvent(event: SidecarCdpDiagnosticEventInput['event']): BrowserDiagnosticFamilyV1 {
    switch (event.kind) {
        case 'network.requestWillBeSent':
        case 'network.responseReceived':
        case 'network.loadingFailed':
        case 'network.loadingFinished':
        case 'network.requestExtraInfo':
        case 'network.responseExtraInfo':
        case 'network.webSocketSummary':
            return 'network';
        case 'runtime.consoleEntry':
            return 'console';
        case 'runtime.exceptionThrown':
            return 'pageError';
        case 'page.info':
            return 'pageInfo';
        case 'diagnostics.available':
            return event.family;
    }
}

function adapterSupportsCdpFamily(
    adapterCapabilities: BrowserAdapterCapabilitiesV1,
    family: BrowserDiagnosticFamilyV1,
): boolean {
    return adapterCapabilities.adapterKind === 'chromiumSidecar'
        && adapterCapabilities.diagnosticsFidelityByFamily[family] === 'cdp';
}

function resolveAttachBlockedReason(input: SidecarDiagnosticsAttachInput): BrowserDiagnosticUnavailableReasonV1 | null {
    const families = uniqueFamilies(input.families);
    return families.every((family) => adapterSupportsCdpFamily(input.adapterCapabilities, family))
        ? null
        : 'unsupported_fidelity';
}

export function createInMemorySidecarDiagnosticsEventSource(input: Readonly<{
    sourceId: string;
}>): InMemorySidecarDiagnosticsEventSource {
    const subscribers = new Set<SidecarDiagnosticsEventSourceSubscriber>();
    let starts = 0;

    return {
        sourceId: input.sourceId,
        start(subscriber) {
            starts += 1;
            subscribers.add(subscriber);
            let stopped = false;
            return {
                stop() {
                    if (stopped) return;
                    stopped = true;
                    subscribers.delete(subscriber);
                },
            };
        },
        emitCdpEvent(event) {
            for (const subscriber of [...subscribers]) {
                subscriber.onCdpEvent(event);
            }
        },
        emitUnavailable(event) {
            for (const subscriber of [...subscribers]) {
                subscriber.onUnavailable(event);
            }
        },
        startCount() {
            return starts;
        },
        activeSubscriberCount() {
            return subscribers.size;
        },
    };
}

export function createBrowserSidecarDiagnosticsEventSourceBridge(input: Readonly<{
    ownerAccountId: string;
    store: Pick<BrowserDiagnosticsDaemonStore, 'publishEvent' | 'clearView' | 'clearSession' | 'getNetworkRequest'>;
    nowMs: () => number;
}>): Readonly<{
    attachView(attachInput: SidecarDiagnosticsAttachInput): SidecarDiagnosticsEventSourceAttachResult;
    closeView(closeInput: SidecarDiagnosticsCloseViewInput): void;
    closeSession(closeInput: SidecarDiagnosticsCloseSessionInput): void;
    dispose(): void;
}> {
    const activeBindings = new Map<string, ActiveSourceBinding>();
    const ordinalsByView = new Map<string, number>();
    // The view each ordinal key belongs to. `browserViewKey` is an opaque injective encoding, so
    // session-scoped cleanup matches on the recorded view ref rather than on the key's shape.
    const viewRefsByOrdinalKey = new Map<string, { browserSessionId: string; viewId: string }>();
    const publisher = createSidecarDiagnosticsPublisher({
        getNetworkRequest: input.store.getNetworkRequest,
        publish: (event, privateRequest) => {
            input.store.publishEvent(event, privateRequest);
        },
    });

    function nextOrdinal(target: OrdinalTarget): number {
        const key = browserViewKey(target);
        const next = (ordinalsByView.get(key) ?? 0) + 1;
        ordinalsByView.set(key, next);
        viewRefsByOrdinalKey.set(key, {
            browserSessionId: target.browserSessionId,
            viewId: target.viewId,
        });
        return next;
    }

    function publishUnavailable(
        attachInput: Pick<
            SidecarDiagnosticsAttachInput,
            'browserSessionId' | 'viewId' | 'navigationGeneration'
        >,
        family: BrowserDiagnosticFamilyV1,
        reason: BrowserDiagnosticUnavailableReasonV1,
        capturedAtMs = input.nowMs(),
    ): void {
        publisher.publishUnavailable({
            browserSessionId: attachInput.browserSessionId,
            viewId: attachInput.viewId,
            navigationGeneration: attachInput.navigationGeneration,
            capturedAtMs,
            eventOrdinal: nextOrdinal(attachInput),
            family,
            reason,
        });
    }

    function stopBinding(binding: ActiveSourceBinding): void {
        binding.subscription.stop();
        activeBindings.delete(bindingKey(binding));
    }

    function stopViewBindings(closeInput: SidecarDiagnosticsCloseViewInput): void {
        for (const binding of [...activeBindings.values()]) {
            if (binding.browserSessionId === closeInput.browserSessionId && binding.viewId === closeInput.viewId) {
                stopBinding(binding);
            }
        }
        const closedKey = browserViewKey(closeInput);
        ordinalsByView.delete(closedKey);
        viewRefsByOrdinalKey.delete(closedKey);
    }

    return {
        attachView(attachInput) {
            if (attachInput.requesterAccountId !== input.ownerAccountId) {
                return {
                    status: 'denied',
                    reason: 'not_owner',
                    sourceStarted: false,
                };
            }

            const families = uniqueFamilies(attachInput.families);
            const blockedReason = resolveAttachBlockedReason(attachInput);
            if (blockedReason) {
                for (const family of families) {
                    publishUnavailable(attachInput, family, blockedReason);
                }
                return {
                    status: 'unsupported',
                    reason: blockedReason,
                    sourceStarted: false,
                };
            }

            try {
                const subscription = attachInput.source.start({
                    onCdpEvent: (event) => {
                        if (!families.includes(familyForCdpEvent(event.event))) return;
                        publisher.publishCdpEvent({
                            browserSessionId: attachInput.browserSessionId,
                            viewId: attachInput.viewId,
                            navigationGeneration: attachInput.navigationGeneration,
                            capturedAtMs: event.capturedAtMs ?? input.nowMs(),
                            eventOrdinal: nextOrdinal(attachInput),
                            rawCdpSessionId: event.rawCdpSessionId,
                            debuggerUrl: event.debuggerUrl,
                            event: event.event,
                            privateRequest: event.privateRequest,
                        });
                    },
                    onUnavailable: (event) => {
                        publishUnavailable(
                            attachInput,
                            event.family,
                            event.reason ?? 'adapter_unavailable',
                            event.capturedAtMs,
                        );
                    },
                });
                const binding: ActiveSourceBinding = {
                    browserSessionId: attachInput.browserSessionId,
                    viewId: attachInput.viewId,
                    sourceId: attachInput.source.sourceId,
                    subscription,
                };
                activeBindings.set(bindingKey(binding), binding);
                return {
                    status: 'attached',
                    sourceId: attachInput.source.sourceId,
                };
            } catch {
                for (const family of families) {
                    publishUnavailable(attachInput, family, 'adapter_unavailable');
                }
                return {
                    status: 'unsupported',
                    reason: 'adapter_unavailable',
                    sourceStarted: false,
                };
            }
        },
        closeView(closeInput) {
            stopViewBindings(closeInput);
            input.store.clearView(closeInput);
        },
        closeSession(closeInput) {
            for (const binding of [...activeBindings.values()]) {
                if (binding.browserSessionId === closeInput.browserSessionId) {
                    stopBinding(binding);
                }
            }
            for (const [key, viewRef] of [...viewRefsByOrdinalKey.entries()]) {
                if (viewRef.browserSessionId === closeInput.browserSessionId) {
                    ordinalsByView.delete(key);
                    viewRefsByOrdinalKey.delete(key);
                }
            }
            input.store.clearSession(closeInput);
        },
        dispose() {
            for (const binding of [...activeBindings.values()]) {
                stopBinding(binding);
            }
            ordinalsByView.clear();
            viewRefsByOrdinalKey.clear();
        },
    };
}
