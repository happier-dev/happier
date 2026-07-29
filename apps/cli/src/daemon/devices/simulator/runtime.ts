import {
    SimulatorDeviceResourceV1Schema,
    SimulatorPreviewActionResultV1Schema,
    SimulatorPreviewActionV1Schema,
    isBackedSimulatorSidebandKindV1,
    normalizeSimulatorDeviceResourceVisibleCapabilitiesV1,
    validateMachineLiveStreamControlLeaseV1,
    type MachineLiveStreamControlSidebandV1,
    type SimulatorCaptureCapabilitiesV1,
    type SimulatorDeviceResourceV1,
    type SimulatorPreviewActionResultV1,
    type SimulatorPreviewActionTypeV1,
    type SimulatorPreviewActionV1,
    type SimulatorPreviewSnapshotV1,
    type SimulatorStreamControlsV1,
} from '@happier-dev/protocol';

import {
    createSimulatorPreviewDaemonAdapter,
    type SimulatorPreviewDaemonAdapter,
    type SimulatorPreviewDaemonAdapterDispatch,
    type SimulatorPreviewDaemonAdapterDispatchInput,
} from './adapter';
import type { SimulatorCaptureRegistryReconciler } from './captureRegistration';
import { createSimulatorInputLeaseManager, type SimulatorInputLeaseManager } from './lease';
import type { SimulatorPreviewRoutes } from './previewRoutes.types';

export type SimulatorPreviewDaemonRuntimeDispatchInput = SimulatorPreviewDaemonAdapterDispatchInput;

export type SimulatorPreviewDaemonRuntimeDispatch = SimulatorPreviewDaemonAdapterDispatch;

export type SimulatorPreviewDaemonRuntime = Readonly<{
    routes: SimulatorPreviewRoutes;
    snapshot(): Promise<SimulatorPreviewSnapshotV1>;
    stop(): Promise<void>;
}>;

export type SimulatorPreviewDaemonRuntimeOptions = Readonly<{
    machineId: string;
    now?: () => number;
    leaseTtlMs?: number;
    adapter?: SimulatorPreviewDaemonAdapter | null;
    resources?: readonly SimulatorDeviceResourceV1[];
    listResources?: () => Promise<readonly SimulatorDeviceResourceV1[]> | readonly SimulatorDeviceResourceV1[];
    listDiagnostics?: () => Promise<readonly Record<string, unknown>[]> | readonly Record<string, unknown>[];
    dispatchAction?: SimulatorPreviewDaemonRuntimeDispatch | null;
    captureReconciler?: SimulatorCaptureRegistryReconciler | null;
    leaseManager?: SimulatorInputLeaseManager;
    /**
     * Delivers an encoder-reconfiguration sideband control (set_quality / request_keyframe) to the
     * live capture session via the relay terminator's `applySidebandControl` path. Supplied at
     * daemon startup; when absent the encoder-control RPCs report unbacked. This is the bridge from
     * the daemon RPC entry point to the canonical live sideband-control execution channel.
     */
    dispatchStreamControl?: SimulatorStreamControlDispatch | null;
}>;

export type SimulatorStreamControlDispatch = (
    control: MachineLiveStreamControlSidebandV1,
) => Promise<Readonly<{ ok: true } | { ok: false; reasonCode: string }>>
    | Readonly<{ ok: true } | { ok: false; reasonCode: string }>;

type ResourceReadResult = Readonly<{
    resources: readonly SimulatorDeviceResourceV1[];
    diagnostics: readonly Record<string, unknown>[];
}>;

function actionEventType(event: SimulatorPreviewActionV1): SimulatorPreviewActionTypeV1 {
    return event.type;
}

function unavailableResult(
    event: SimulatorPreviewActionV1,
    reasonCode = 'simulator_runtime_action_unavailable',
): SimulatorPreviewActionResultV1 {
    return {
        v: 1,
        eventType: actionEventType(event),
        status: 'unavailable',
        reasonCode,
        diagnostics: [],
    };
}

function rejectedResult(
    event: SimulatorPreviewActionV1,
    reasonCode: string,
): SimulatorPreviewActionResultV1 {
    return {
        v: 1,
        eventType: actionEventType(event),
        status: 'rejected',
        reasonCode,
        diagnostics: [],
    };
}

function acceptedResult(event: SimulatorPreviewActionV1): SimulatorPreviewActionResultV1 {
    return {
        v: 1,
        eventType: actionEventType(event),
        status: 'accepted',
        diagnostics: [],
    };
}

// Encoder-reconfiguration RPC actions. scrcpy runs in raw_stream mode, so the H.264 encoder's
// bitrate/fps/resolution/keyframe cadence are fixed at server launch with no in-band control
// channel; the Android scrcpy SERVER-RESTART producer (android/restartProducer.ts) backs these by
// relaunching the server with new args and re-establishing the stream with last-frame continuity.
// Backing is therefore RESOURCE-GATED: an encoder-control RPC is honored only when the live
// resource advertises the corresponding `streamControls` bit (Android scrcpy advertises them; iOS
// does not). The live reconfiguration is delivered to the active capture session via the relay
// `applySidebandControl` path (the `dispatchStreamControl` hook). Pause/resume are NOT encoder
// controls — they gate viewer-facing frame forwarding through the same sideband path.
type EncoderStreamRuntimeAction = Extract<
    SimulatorPreviewActionV1,
    { type: 'simulator.quality.set' | 'simulator.keyframe.request' | 'simulator.snapshot.request' }
>;

function isEncoderStreamRuntimeAction(event: SimulatorPreviewActionV1): event is EncoderStreamRuntimeAction {
    return event.type === 'simulator.quality.set'
        || event.type === 'simulator.keyframe.request'
        || event.type === 'simulator.snapshot.request';
}

function requiredStreamControlForAction(
    event: EncoderStreamRuntimeAction,
): keyof SimulatorStreamControlsV1 {
    if (event.type === 'simulator.quality.set') return 'setQuality';
    if (event.type === 'simulator.keyframe.request') return 'requestKeyframe';
    return 'snapshot';
}

function availableCapture(
    resource: SimulatorDeviceResourceV1 | null,
): SimulatorCaptureCapabilitiesV1 | null {
    if (!resource) return null;
    if (resource.capture.status === 'unavailable') return null;
    return resource.capture;
}

function sortResources(resources: readonly SimulatorDeviceResourceV1[]): readonly SimulatorDeviceResourceV1[] {
    return [...resources].sort((left, right) => (
        left.simulatorId.localeCompare(right.simulatorId)
        || left.deviceId.localeCompare(right.deviceId)
        || left.platform.localeCompare(right.platform)
    ));
}

async function readResources(
    adapter: SimulatorPreviewDaemonAdapter,
    captureReconciler?: SimulatorCaptureRegistryReconciler | null,
): Promise<ResourceReadResult> {
    let rawResources: readonly SimulatorDeviceResourceV1[] = [];
    const resources: SimulatorDeviceResourceV1[] = [];
    const diagnostics: Record<string, unknown>[] = [];

    try {
        rawResources = await adapter.listResources();
    } catch (error) {
        diagnostics.push({
            code: 'simulator_resources_unavailable',
            errorName: error instanceof Error ? error.name : 'UnknownError',
        });
    }

    rawResources.forEach((resource, index) => {
        const parsed = SimulatorDeviceResourceV1Schema.safeParse(resource);
        if (!parsed.success) {
            diagnostics.push({
                code: 'invalid_simulator_resource',
                index,
                issueCount: parsed.error.issues.length,
            });
            return;
        }
        resources.push(normalizeSimulatorDeviceResourceVisibleCapabilitiesV1(parsed.data));
    });

    if (captureReconciler) {
        const reconciliation = captureReconciler.reconcile(resources);
        diagnostics.push(...reconciliation.diagnostics);
    }

    return {
        resources: sortResources(resources),
        diagnostics: [...diagnostics, ...await readPlatformDiagnostics(adapter)],
    };
}

async function readPlatformDiagnostics(
    adapter: SimulatorPreviewDaemonAdapter,
): Promise<readonly Record<string, unknown>[]> {
    try {
        return (await adapter.listDiagnostics()).map((diagnostic, index) => {
            if (
                typeof diagnostic === 'object'
                && diagnostic !== null
                && !Array.isArray(diagnostic)
            ) {
                return diagnostic;
            }
            return {
                code: 'invalid_simulator_diagnostic',
                index,
            };
        });
    } catch (error) {
        return [{
            code: 'simulator_diagnostics_unavailable',
            errorName: error instanceof Error ? error.name : 'UnknownError',
        }];
    }
}

function resolveAdapter(input: SimulatorPreviewDaemonRuntimeOptions): SimulatorPreviewDaemonAdapter {
    return input.adapter ?? createSimulatorPreviewDaemonAdapter({
        resources: input.resources,
        listResources: input.listResources,
        listDiagnostics: input.listDiagnostics,
        dispatchAction: input.dispatchAction,
    });
}

function findActionResource(
    resources: readonly SimulatorDeviceResourceV1[],
    event: SimulatorPreviewActionV1,
): SimulatorDeviceResourceV1 | null {
    if (!('simulatorId' in event)) {
        return null;
    }
    return resources.find((resource) => resource.simulatorId === event.simulatorId) ?? null;
}

function findResourceBySourceId(
    resources: readonly SimulatorDeviceResourceV1[],
    sourceId: string,
): SimulatorDeviceResourceV1 | null {
    return resources.find((resource) => resource.capture.sourceId === sourceId) ?? null;
}

function ensureActionSource(
    resource: SimulatorDeviceResourceV1 | null,
    event: Extract<SimulatorPreviewActionV1, { sourceId: string }>,
): Readonly<{ ok: true } | { ok: false; reasonCode: string }> {
    if (!resource) {
        return { ok: false, reasonCode: 'unknown_simulator' };
    }
    if (resource.capture.status === 'unavailable') {
        return { ok: false, reasonCode: resource.capture.reasonCode };
    }
    if (resource.capture.sourceId !== event.sourceId) {
        return { ok: false, reasonCode: 'unknown_simulator_source' };
    }
    if (resource.capture.inputMode === 'none') {
        return { ok: false, reasonCode: 'input_not_supported' };
    }
    return { ok: true };
}

export function createSimulatorPreviewDaemonRuntime(
    input: SimulatorPreviewDaemonRuntimeOptions,
): SimulatorPreviewDaemonRuntime {
    const now = input.now ?? (() => Date.now());
    const adapter = resolveAdapter(input);
    let stopPromise: Promise<void> | null = null;
    const leaseManager = input.leaseManager ?? createSimulatorInputLeaseManager({
        ttlMs: input.leaseTtlMs ?? 30_000,
    });

    const snapshot = async (): Promise<SimulatorPreviewSnapshotV1> => {
        const read = await readResources(adapter, input.captureReconciler);
        return {
            v: 1,
            machineId: input.machineId,
            generatedAt: now(),
            refreshState: 'idle',
            resources: [...read.resources],
            diagnostics: [...read.diagnostics],
        };
    };

    const dispatchEncoderStreamControl = async (
        event: EncoderStreamRuntimeAction,
        resource: SimulatorDeviceResourceV1 | null,
    ): Promise<SimulatorPreviewActionResultV1> => {
        const capture = availableCapture(resource);
        if (!capture) {
            return rejectedResult(event, resource?.capture.status === 'unavailable'
                ? resource.capture.reasonCode
                : 'unknown_simulator');
        }
        if (capture.sourceId !== event.sourceId) {
            return rejectedResult(event, 'unknown_simulator_source');
        }
        // Capability-truth: the control is honored only when the live resource advertises it.
        const requiredControl = requiredStreamControlForAction(event);
        if (capture.streamControls?.[requiredControl] !== true) {
            return unavailableResult(event, 'simulator_stream_control_unbacked');
        }
        if (!input.dispatchStreamControl) {
            return unavailableResult(event, 'simulator_stream_control_dispatch_unavailable');
        }

        // snapshot.request has no sideband control payload; it reads the held decoded keyframe. The
        // quality/keyframe RPCs carry a typed control we forward verbatim to the live session.
        const control: MachineLiveStreamControlSidebandV1 = event.type === 'simulator.snapshot.request'
            ? {
                v: 1,
                streamId: event.streamId,
                sourceId: event.sourceId,
                eventId: event.eventId,
                kind: 'request_keyframe',
            }
            : event.control;

        // Validate the lease against the live capture source before mutating the encoder.
        const activeLease = leaseManager.read({
            streamId: event.streamId,
            sourceId: event.sourceId,
            nowMs: now(),
        });
        const controlValidation = validateMachineLiveStreamControlLeaseV1({
            source: { sourceId: capture.sourceId, inputMode: capture.inputMode },
            control,
            activeLease,
            nowMs: now(),
        });
        if (!controlValidation.ok) {
            return rejectedResult(event, controlValidation.reasonCode);
        }

        const dispatched = await input.dispatchStreamControl(control);
        if (!dispatched.ok) {
            return unavailableResult(event, dispatched.reasonCode);
        }
        return acceptedResult(event);
    };

    const dispatchAction = async (rawEvent: SimulatorPreviewActionV1): Promise<SimulatorPreviewActionResultV1> => {
        const parsed = SimulatorPreviewActionV1Schema.safeParse(rawEvent);
        if (!parsed.success) {
            return {
                v: 1,
                eventType: 'simulator.devices.list',
                status: 'rejected',
                reasonCode: 'invalid_simulator_action',
                diagnostics: [{ code: 'invalid_simulator_action', issueCount: parsed.error.issues.length }],
            };
        }
        const event = parsed.data;
        const read = await readResources(adapter, input.captureReconciler);
        const resource = findActionResource(read.resources, event);

        switch (event.type) {
            case 'simulator.devices.list':
                return acceptedResult(event);
            // The daemon-local stream open/close RPC was the retired `loopback_direct`
            // second transport. Live capture is owned end-to-end by the `server_relay`
            // terminator (peer/mediation/stream/relay.ts), driven by the start envelope
            // from the UI relay client. This RPC path is intentionally retired so capture
            // is never double-started behind the relay terminator.
            case 'simulator.stream.open':
            case 'simulator.stream.close':
                return unavailableResult(event, 'simulator_stream_server_relay_only');
            case 'simulator.lease.acquire': {
                const source = ensureActionSource(resource, event);
                if (!source.ok) return rejectedResult(event, source.reasonCode);
                const acquired = leaseManager.acquire({
                    streamId: event.streamId,
                    sourceId: event.sourceId,
                    holderId: event.viewerId,
                    nowMs: now(),
                });
                if (!acquired.ok) return rejectedResult(event, acquired.reasonCode);
                return {
                    v: 1,
                    eventType: event.type,
                    status: 'accepted',
                    lease: acquired.lease,
                    diagnostics: [],
                };
            }
            case 'simulator.lease.release':
                const released = leaseManager.release({
                    streamId: event.streamId,
                    sourceId: event.sourceId,
                    leaseId: event.leaseId,
                });
                if (!released.ok) return rejectedResult(event, released.reasonCode);
                return acceptedResult(event);
            case 'simulator.lease.renew': {
                const source = ensureActionSource(resource, event);
                if (!source.ok) return rejectedResult(event, source.reasonCode);
                const activeLease = leaseManager.read({
                    streamId: event.streamId,
                    sourceId: event.sourceId,
                    nowMs: now(),
                });
                if (!activeLease || activeLease.leaseId !== event.leaseId || activeLease.holderId !== event.viewerId) {
                    return rejectedResult(event, 'input_lease_mismatch');
                }
                const renewed = leaseManager.acquire({
                    streamId: event.streamId,
                    sourceId: event.sourceId,
                    holderId: event.viewerId,
                    nowMs: now(),
                });
                if (!renewed.ok) return rejectedResult(event, renewed.reasonCode);
                return {
                    v: 1,
                    eventType: event.type,
                    status: 'accepted',
                    lease: renewed.lease,
                    diagnostics: [],
                };
            }
            case 'simulator.control.send': {
                const controlResource = findResourceBySourceId(read.resources, event.control.sourceId);
                if (!controlResource) {
                    return rejectedResult(event, 'unknown_simulator_source');
                }
                if (controlResource.capture.status === 'unavailable') {
                    return rejectedResult(event, controlResource.capture.reasonCode);
                }
                const activeLease = leaseManager.read({
                    streamId: event.control.streamId,
                    sourceId: event.control.sourceId,
                    nowMs: now(),
                });
                const controlValidation = validateMachineLiveStreamControlLeaseV1({
                    source: controlResource.capture,
                    control: event.control,
                    activeLease,
                    nowMs: now(),
                });
                if (!controlValidation.ok) {
                    return rejectedResult(event, controlValidation.reasonCode);
                }
                break;
            }
            case 'simulator.sideband.request':
                if (!isBackedSimulatorSidebandKindV1(event.kind)) {
                    return unavailableResult(event, 'simulator_sideband_unbacked');
                }
                break;
        }

        if (isEncoderStreamRuntimeAction(event)) {
            return await dispatchEncoderStreamControl(event, resource);
        }

        const delegated = await adapter.dispatchAction({
            event,
            resources: read.resources,
        });
        const result = SimulatorPreviewActionResultV1Schema.safeParse(
            delegated ?? unavailableResult(event),
        );
        return result.success
            ? result.data
            : unavailableResult(event, 'invalid_simulator_action_result');
    };

    const routes: SimulatorPreviewRoutes = {
        getSnapshot: snapshot,
        dispatchAction,
    };

    const stop = async (): Promise<void> => {
        stopPromise ??= Promise.resolve()
            .then(() => {
                input.captureReconciler?.stop();
            })
            .then(() => adapter.stop());
        await stopPromise;
    };

    return { routes, snapshot, stop };
}
