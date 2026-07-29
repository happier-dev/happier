import {
    BACKABLE_SIMULATOR_STREAM_CONTROLS_V1,
    classifySimulatorRuntimeActionBackingV1,
    createUnavailableRuntimeActionExecutor,
    getActionSpec,
    isBackedSimulatorSidebandKindV1,
    isSimulatorRuntimeActionIdV1,
    resolveRuntimeActionExecutionFamily,
    type MachineLiveStreamInputControlKindV1,
    type RuntimeActionExecute,
    type RuntimeActionExecuteArgs,
    type SimulatorDeviceResourceV1,
    type SimulatorRuntimeActionIdV1,
    type SimulatorSidebandKindV1,
    type SimulatorStreamControlsV1,
} from '@happier-dev/protocol';

import { randomUUID } from 'node:crypto';

import type { SimulatorDaemonFeatureGate } from '../featureGate';
import type { SimulatorPreviewRoutes } from '../previewRoutes.types';
import {
    isSimulatorQualityScalarRuntimeActionId,
    translateSimulatorQualityScalarRuntimeAction,
    type SimulatorQualityScalarInput,
} from './qualityScalarTranslator';

type CreateSimulatorDaemonRuntimeActionExecutorInput = Readonly<{
    routes: SimulatorPreviewRoutes;
    createEventId?: (kind: string) => string;
    fallback?: RuntimeActionExecute;
    // Single-owner daemon feature-gate (REQUIRED — mirrors the browser/local-services daemon
    // executors). Every simulator runtime action is refused at the execution boundary when
    // `devices.simulatorPreview` is server-disabled. Safety-critical params must not be optional:
    // an omitted gate would silently disable all family gating (the BRW-F3 optional-gate
    // fail-open family), so untyped/stale compiled callers that still omit it fall back to a
    // fail-closed gate at runtime.
    featureGate: SimulatorDaemonFeatureGate;
}>;

// Runtime fallback for untyped/stale compiled callers that omit the required gate: the feature
// reads disabled, so omission can never silently open the family gating.
const failClosedSimulatorDaemonFeatureGate: SimulatorDaemonFeatureGate = {
    isEnabled: () => false,
    refresh: async () => {},
};

const featureDisabledSimulatorActionResult = {
    ok: false,
    errorCode: 'runtime_action_disabled',
    error: 'runtime_action_disabled:devices.simulator:feature_disabled:devices.simulatorPreview',
} as const;

const unbackedSimulatorActionResult = {
    ok: false,
    errorCode: 'runtime_action_disabled',
    error: 'runtime_action_disabled:devices.simulator:simulator_runtime_action_unbacked',
} as const;

const unbackedSimulatorSidebandResult = {
    ok: false,
    errorCode: 'runtime_action_disabled',
    error: 'runtime_action_disabled:devices.simulator:simulator_sideband_unbacked',
} as const;

const invalidParametersResult = {
    ok: false,
    errorCode: 'invalid_parameters',
    error: 'invalid_parameters',
} as const;

const SCRCPY_CONTROL_RUNTIME_ACTION_KINDS: ReadonlySet<MachineLiveStreamInputControlKindV1> = new Set([
    'pinch',
    'rotate',
]);

// Resource-gated encoder/stream-control action ids → the `streamControls` capability bit each one
// requires. Both the prefilter here and the runtime's `dispatchEncoderStreamControl` gate on the
// same bit, governed by the canonical `BACKABLE_SIMULATOR_STREAM_CONTROLS_V1` set, so the public
// action boundary can never diverge from the live-dispatch capability truth. An advertised control
// flows through to the runtime (lease validation + the wired `applySidebandControl` dispatch); an
// unadvertised one is fail-closed here without ever reaching dispatch.
const STREAM_CONTROL_RUNTIME_ACTION_REQUIRED_BIT: Readonly<Partial<Record<
    SimulatorRuntimeActionIdV1,
    keyof SimulatorStreamControlsV1
>>> = {
    'devices.simulator.stream.keyframe': 'requestKeyframe',
    'devices.simulator.stream.snapshot': 'snapshot',
    'devices.simulator.stream.quality.set': 'setQuality',
    'devices.simulator.stream.fps.set': 'setFps',
    'devices.simulator.stream.scale.set': 'setScale',
};

function requiredStreamControlBitForAction(
    actionId: RuntimeActionExecuteArgs['actionId'],
): keyof SimulatorStreamControlsV1 | null {
    const bit = STREAM_CONTROL_RUNTIME_ACTION_REQUIRED_BIT[actionId as SimulatorRuntimeActionIdV1];
    return bit && BACKABLE_SIMULATOR_STREAM_CONTROLS_V1.has(bit) ? bit : null;
}

function classifySimulatorActionBacking(actionId: RuntimeActionExecuteArgs['actionId']) {
    return isSimulatorRuntimeActionIdV1(actionId)
        ? classifySimulatorRuntimeActionBackingV1(actionId as SimulatorRuntimeActionIdV1)
        : null;
}

function isSimulatorRuntimeAction(actionId: RuntimeActionExecuteArgs['actionId']): boolean {
    return resolveRuntimeActionExecutionFamily(actionId) === 'devices.simulator';
}

function parseRuntimeActionInput(args: RuntimeActionExecuteArgs): Readonly<
    | { ok: true; input: unknown }
    | { ok: false; result: typeof invalidParametersResult }
> {
    const spec = getActionSpec(args.actionId);
    const parsed = spec.inputSchema.safeParse(args.input ?? {});
    return parsed.success
        ? { ok: true, input: parsed.data }
        : { ok: false, result: invalidParametersResult };
}

function isUnbackedSimulatorRuntimeAction(actionId: RuntimeActionExecuteArgs['actionId']): boolean {
    return classifySimulatorActionBacking(actionId) === 'statically-unbacked';
}

function isUnbackedSimulatorSidebandRuntimeAction(input: unknown): boolean {
    return typeof input === 'object'
        && input !== null
        && 'type' in input
        && input.type === 'simulator.sideband.request'
        && 'kind' in input
        && !isBackedSimulatorSidebandKindV1(input.kind as SimulatorSidebandKindV1);
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readScrcpyControlRuntimeAction(input: unknown): Readonly<{
    sourceId: string;
    kind: MachineLiveStreamInputControlKindV1;
}> | null {
    const event = readObject(input);
    const control = readObject(event?.control);
    const sourceId = control?.sourceId;
    const kind = control?.kind;
    if (typeof sourceId !== 'string' || typeof kind !== 'string') return null;
    if (!SCRCPY_CONTROL_RUNTIME_ACTION_KINDS.has(kind as MachineLiveStreamInputControlKindV1)) return null;
    return {
        sourceId,
        kind: kind as MachineLiveStreamInputControlKindV1,
    };
}

function readStreamControlSourceId(input: unknown): string | null {
    const event = readObject(input);
    const sourceId = event?.sourceId;
    return typeof sourceId === 'string' && sourceId.length > 0 ? sourceId : null;
}

function resourceAdvertisesStreamControl(input: Readonly<{
    resource: SimulatorDeviceResourceV1;
    sourceId: string;
    bit: keyof SimulatorStreamControlsV1;
}>): boolean {
    return input.resource.capture.status !== 'unavailable'
        && input.resource.capture.sourceId === input.sourceId
        && input.resource.capture.streamControls?.[input.bit] === true;
}

function resourceAdvertisesScrcpyControl(input: Readonly<{
    resource: SimulatorDeviceResourceV1;
    sourceId: string;
    kind: MachineLiveStreamInputControlKindV1;
}>): boolean {
    return input.resource.platform === 'android'
        && input.resource.capture.status !== 'unavailable'
        && input.resource.capture.sourceId === input.sourceId
        && input.resource.capture.supportedInputKinds?.includes(input.kind) === true;
}

export function createSimulatorDaemonRuntimeActionExecutor(
    input: CreateSimulatorDaemonRuntimeActionExecutorInput,
): RuntimeActionExecute {
    const fallback = input.fallback ?? createUnavailableRuntimeActionExecutor();
    const createEventId = input.createEventId ?? ((kind: string) => `${kind}_${randomUUID()}`);
    const featureGate = input.featureGate ?? failClosedSimulatorDaemonFeatureGate;

    return async (args) => {
        if (!isSimulatorRuntimeAction(args.actionId)) {
            return await fallback(args);
        }

        // Execution-boundary gate: refuse a server-disabled simulator preview surface before any
        // route dispatch, so the daemon fails closed rather than relying on the UI to hide it.
        if (!featureGate.isEnabled('devices.simulatorPreview')) {
            return featureDisabledSimulatorActionResult;
        }

        const parsed = parseRuntimeActionInput(args);
        if (!parsed.ok) return parsed.result;

        if (isUnbackedSimulatorRuntimeAction(args.actionId)) {
            return unbackedSimulatorActionResult;
        }
        if (classifySimulatorActionBacking(args.actionId) === 'resource-gated') {
            const requiredStreamBit = requiredStreamControlBitForAction(args.actionId);
            if (requiredStreamBit) {
                // Encoder stream control (keyframe / snapshot / quality / fps / scale): backed only
                // when the live resource advertises the corresponding `streamControls` bit. When it
                // does, fall through to the runtime, which validates the lease and dispatches over
                // the wired `applySidebandControl` bridge; when it does not, fail closed here.
                const sourceId = readStreamControlSourceId(parsed.input);
                if (!sourceId) return unbackedSimulatorActionResult;
                const snapshot = await input.routes.getSnapshot();
                const advertised = snapshot.resources.some((resource) => resourceAdvertisesStreamControl({
                    resource,
                    sourceId,
                    bit: requiredStreamBit,
                }));
                if (!advertised) return unbackedSimulatorActionResult;
            } else {
                const control = readScrcpyControlRuntimeAction(parsed.input);
                if (!control) return unbackedSimulatorActionResult;
                const snapshot = await input.routes.getSnapshot();
                const backed = snapshot.resources.some((resource) => resourceAdvertisesScrcpyControl({
                    resource,
                    sourceId: control.sourceId,
                    kind: control.kind,
                }));
                if (!backed) return unbackedSimulatorActionResult;
            }
        }
        if (args.actionId === 'devices.simulator.sideband.request' && isUnbackedSimulatorSidebandRuntimeAction(parsed.input)) {
            return unbackedSimulatorSidebandResult;
        }

        if (args.actionId === 'devices.simulator.list') {
            return await input.routes.getSnapshot();
        }

        // fps.set / scale.set carry a bare positive scalar, not a full simulator.quality.set event.
        // Fold them into the single `set_quality` sideband the producer actually backs (X3) before
        // dispatch, so the resource-gated controls reach the encoder reconfiguration path instead of
        // failing `invalid_simulator_action` at the runtime.
        if (isSimulatorQualityScalarRuntimeActionId(args.actionId)) {
            const event = translateSimulatorQualityScalarRuntimeAction({
                actionId: args.actionId,
                scalar: parsed.input as SimulatorQualityScalarInput,
                createEventId,
            });
            return await input.routes.dispatchAction(event);
        }

        return await input.routes.dispatchAction(parsed.input as Parameters<SimulatorPreviewRoutes['dispatchAction']>[0]);
    };
}
