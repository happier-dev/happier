import { BROWSER_AUTOMATION_MAX_ACTION_TIMEOUT_MS } from '@happier-dev/protocol/browser/automation/v1';
import { BrowserEventBatchV1Schema } from '@happier-dev/protocol/browser/events/v1';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import type { BrowserEventV1, MachineLiveStreamControlSidebandV1 } from '@happier-dev/protocol';
import type { BrowserAutomationDaemonService } from '../automation/service';
import type { BrowserSidecarContextCaptureSurface } from '../sidecar/controlAdapter';
import type { MachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';
import type { MachineLiveStreamCaptureAdapter } from '../../peer/mediation/stream/captureAdapter';
import type { SurfaceInputControl } from '../../surfaces/inputControl';
import { createSimulatorFrameProducerCaptureAdapter } from '../../devices/simulator/capture/adapter';
import type { BrowserCaptureView, BrowserCdpScreencastFrame, BrowserCdpScreencastProducer } from './cdpScreencast';

export function registerBrowserLiveCapture(input: Readonly<{
    registry: MachineLiveStreamCaptureRegistry;
    contextCapture: BrowserSidecarContextCaptureSurface;
    producer: BrowserCdpScreencastProducer;
    automation: () => BrowserAutomationDaemonService | null;
    resolveInputControl?: (view: BrowserCaptureView) => SurfaceInputControl | undefined;
}>): Readonly<{ dispose(): void }> {
    const registered = new Set<string>();
    function register(identity: BrowserCaptureView): void {
        const view = { browserSessionId: identity.browserSessionId, viewId: identity.viewId };
        if (!input.contextCapture.resolvePageHandle(view)?.sessionId || !input.contextCapture.subscribeCdpEvents) return;
        const sourceId = browserViewKey(view);
        const adapter: MachineLiveStreamCaptureAdapter = {
            async start(startInput) {
                const humanViewer = startInput.callerAuthority === 'present_user';
                const canObserve = () => humanViewer || !(input.resolveInputControl?.(view)
                    ?? input.automation()?.getInputControl(view))?.isObservationHeld();
                let latest: BrowserCdpScreencastFrame | null = null;
                let paused = false;
                let stopped = false;
                let failInput: (reasonCode: string) => void = () => undefined;
                let inputPending = Promise.resolve();
                // Reuse the existing codec normalization/credit admission/terminal receipt owner.
                const capture = createSimulatorFrameProducerCaptureAdapter({ sourceId, sourceCodecs: ['image.mjpeg'], producer: {
                    async start({ emitFrame, fail, reportInputFailure }) {
                        failInput = reportInputFailure;
                        const emitLatest = () => {
                            if (latest && !paused && !stopped && canObserve()) emitFrame({ codecId: 'image.mjpeg', payload: latest.dataBase64,
                                timestampMs: latest.timestampMs, keyframe: true });
                        };
                        const subscription = await input.producer.start({ view, purpose: humanViewer ? 'humanViewer' : undefined,
                            onFrame: frame => { latest = frame; emitLatest(); },
                            onError: () => fail('capture_source_unavailable'),
                        });
                        if (!subscription) throw { reasonCode: 'capture_source_unavailable' };
                        // Metadata uses the same encrypted frame transport, scope and lifetime as
                        // the watched view. The controller and engine remain the event producers.
                        const emitEvent = (event?: BrowserEventV1) => {
                            if (stopped || !canObserve() || event && (event.browserSessionId !== view.browserSessionId
                                || !('viewId' in event) || event.viewId !== view.viewId)) return;
                            const occurredAt = Date.now();
                            const controller = input.automation()?.getStatus(view);
                            const navigation = input.contextCapture.getNavigationState?.(view);
                            const events: BrowserEventV1[] = [];
                            if (navigation) events.push({ kind: 'navigationStateChanged', ...view, ...navigation,
                                eventId: `navigation-snapshot:${startInput.streamId}:${occurredAt}`, occurredAt });
                            if (controller) events.push({ kind: 'controllerChanged', ...view, state: controller,
                                eventId: `controller-snapshot:${startInput.streamId}:${occurredAt}`, occurredAt,
                                navigationGeneration: navigation?.navigationGeneration ?? 0 });
                            if (event) events.push(event);
                            emitFrame({ codecId: 'image.mjpeg', payloadKind: 'metadata', timestampMs: occurredAt,
                                payload: Buffer.from(JSON.stringify(BrowserEventBatchV1Schema.parse({ v: 1, events })), 'utf8').toString('base64') });
                        };
                        const unsubscribeEngine = input.contextCapture.subscribeBrowserEvents?.(emitEvent);
                        const unsubscribeController = input.automation()?.subscribeBrowserEvents(emitEvent);
                        emitEvent();
                        return {
                            stop: async () => { stopped = true; unsubscribeEngine?.(); unsubscribeController?.(); await subscription.stop(); },
                            pause: () => { paused = true; return { ok: true }; },
                            resume: () => { paused = false; emitEvent(); emitLatest(); return { ok: true }; },
                            requestKeyframe: () => { emitEvent(); emitLatest(); return { ok: true }; },
                        };
                    },
                } });
                const result = await capture.start(startInput);
                if (!result.ok) return result;
                return { ok: true, session: { ...result.session,
                    applySidebandControl(control) {
                        if (control.sourceId !== sourceId || control.streamId !== startInput.streamId) return { ok: false, reasonCode: 'invalid_control' };
                        if (stopped) return { ok: false, reasonCode: 'capture_stopped' };
                        const action = inputAction(control, latest);
                        if (!action) return result.session.applySidebandControl?.(control) ?? { ok: false, reasonCode: 'input_not_supported' };
                        if (!humanViewer) return { ok: false, reasonCode: 'input_not_supported' };
                        const automation = input.automation();
                        if (!automation) return { ok: false, reasonCode: 'input_not_supported' };
                        if (!input.contextCapture.resolvePageHandle(view)) return { ok: false, reasonCode: 'capture_source_unavailable' };
                        // Input acceptance is not a claim of execution. Failures become the existing
                        // typed nonterminal receipt; the automation owner remains the custody authority.
                        const takeover = automation.getStatus(view).controller === 'human'
                            ? Promise.resolve({ ok: false, errorCode: 'no_active_action' } as const)
                            : automation.recordHumanInput({ ...view, authority: 'present_user' });
                        inputPending = inputPending.then(async () => {
                            const interrupted = await takeover;
                            if (stopped) return;
                            if (interrupted.ok && interrupted.completion === 'uncertain') {
                                failInput('human_input_interruption_uncertain');
                                return;
                            }
                            const outcome = await automation.execute({ v: 1, ...view, automationRequestId: control.eventId,
                                requestedBy: 'user', requesterRef: { kind: 'streamViewer', id: startInput.streamId },
                                navigationGeneration: input.contextCapture.getNavigationState?.(view)?.navigationGeneration ?? 0,
                                ...action, timeoutMs: BROWSER_AUTOMATION_MAX_ACTION_TIMEOUT_MS });
                            if (outcome.status !== 'succeeded') failInput(outcome.errorCode ?? 'human_input_failed');
                        }).catch(() => failInput('human_input_failed'));
                        return { ok: true };
                    },
                } };
            },
        };
        input.registry.register({ sourceId, streamFamily: 'browser.streamed', adapter,
            capabilities: { v: 1, sourceId, sourceKind: 'browser', supportedCodecs: ['image.mjpeg'],
                inputMode: 'shared', sidebands: [], health: { status: 'available' } } });
        registered.add(sourceId);
    }
    const unsubscribe = input.contextCapture.subscribeViewLifecycle?.(event => {
        const sourceId = browserViewKey(event);
        if (event.type === 'bound') register(event);
        else { input.registry.unregister(sourceId); registered.delete(sourceId); }
    });
    return { dispose() {
        unsubscribe?.();
        for (const sourceId of registered) input.registry.unregister(sourceId);
        registered.clear();
    } };
}

function inputAction(control: MachineLiveStreamControlSidebandV1, frame: BrowserCdpScreencastFrame | null) {
    if (control.kind === 'keyboard_text') return { actionKind: 'type' as const, payload: { text: control.text } };
    if (control.kind === 'keyboard_key') return { actionKind: 'press' as const, payload: { key: control.key } };
    if (!frame?.width || !frame.height) return null;
    if (control.kind === 'tap') return { actionKind: 'tap' as const, payload: { x: control.x * frame.width, y: control.y * frame.height } };
    if (control.kind === 'swipe') return { actionKind: 'scroll' as const, payload: {
        x: control.fromX * frame.width, y: control.fromY * frame.height,
        deltaX: (control.fromX - control.toX) * frame.width, deltaY: (control.fromY - control.toY) * frame.height,
    } };
    return null;
}
