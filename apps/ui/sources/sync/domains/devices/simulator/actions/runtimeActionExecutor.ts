import {
    classifySimulatorRuntimeActionBackingV1,
    createUnavailableRuntimeActionExecutor,
    getActionSpec,
    isBackedSimulatorSidebandKindV1,
    isSimulatorRuntimeActionIdV1,
    resolveRuntimeActionExecutionFamily,
    type RuntimeActionExecute,
    type RuntimeActionExecuteArgs,
    type SimulatorRuntimeActionIdV1,
    type SimulatorSidebandKindV1,
} from '@happier-dev/protocol';

import {
    dispatchSimulatorPreviewActionViaMachineRpc,
    fetchSimulatorPreviewSnapshotViaMachineRpc,
    type SimulatorPreviewActionClientInput,
    type SimulatorPreviewActionClientResult,
    type SimulatorPreviewSnapshotClientInput,
    type SimulatorPreviewSnapshotClientResult,
} from '../machineRpc';

type CreateSimulatorPreviewRuntimeActionExecutorInput = Readonly<{
    resolveMachineId: (args: RuntimeActionExecuteArgs) => string | null | undefined;
    fetchSnapshot?: (input: SimulatorPreviewSnapshotClientInput) => Promise<SimulatorPreviewSnapshotClientResult>;
    dispatchAction?: (input: SimulatorPreviewActionClientInput) => Promise<SimulatorPreviewActionClientResult>;
    createEventId?: (kind: string) => string;
    fallback?: RuntimeActionExecute;
}>;

type SimulatorPreviewRouteFailureReason =
    | Extract<SimulatorPreviewSnapshotClientResult, { ok: false }>['reason']
    | Extract<SimulatorPreviewActionClientResult, { ok: false }>['reason'];

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

const machineUnavailableResult = {
    ok: false,
    errorCode: 'runtime_action_disabled',
    error: 'runtime_action_disabled:devices.simulator:simulator_machine_unavailable',
} as const;

const invalidParametersResult = {
    ok: false,
    errorCode: 'invalid_parameters',
    error: 'invalid_parameters',
} as const;

function normalizeId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
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
    // The UI client has no direct backing path: it forwards statically-backed and resource-gated
    // ids to the daemon (the sole platform-adapter authority, which makes the final resource-gated
    // decision). Only statically-unbacked ids fail closed here. This keeps the UI verdict a strict
    // subset of — never a contradiction with — the daemon's classifier verdict.
    return isSimulatorRuntimeActionIdV1(actionId)
        && classifySimulatorRuntimeActionBackingV1(actionId as SimulatorRuntimeActionIdV1) === 'statically-unbacked';
}

function isUnbackedSimulatorSidebandRuntimeAction(input: unknown): boolean {
    return typeof input === 'object'
        && input !== null
        && 'type' in input
        && input.type === 'simulator.sideband.request'
        && 'kind' in input
        && !isBackedSimulatorSidebandKindV1(input.kind as SimulatorSidebandKindV1);
}

function routeUnavailableResult(reason: SimulatorPreviewRouteFailureReason) {
    return {
        ok: false as const,
        errorCode: 'runtime_action_disabled',
        error: `runtime_action_disabled:devices.simulator:${reason}`,
    };
}

export function createSimulatorPreviewRuntimeActionExecutor(
    input: CreateSimulatorPreviewRuntimeActionExecutorInput,
): RuntimeActionExecute {
    const fallback = input.fallback ?? createUnavailableRuntimeActionExecutor();
    const fetchSnapshot = input.fetchSnapshot ?? fetchSimulatorPreviewSnapshotViaMachineRpc;
    const dispatchAction = input.dispatchAction ?? dispatchSimulatorPreviewActionViaMachineRpc;

    return async (args) => {
        if (!isSimulatorRuntimeAction(args.actionId)) {
            return await fallback(args);
        }

        const parsed = parseRuntimeActionInput(args);
        if (!parsed.ok) return parsed.result;

        if (isUnbackedSimulatorRuntimeAction(args.actionId)) {
            return unbackedSimulatorActionResult;
        }
        if (args.actionId === 'devices.simulator.sideband.request' && isUnbackedSimulatorSidebandRuntimeAction(parsed.input)) {
            return unbackedSimulatorSidebandResult;
        }

        const machineId = normalizeId(input.resolveMachineId(args));
        if (!machineId) {
            return machineUnavailableResult;
        }
        const serverId = normalizeId(args.context.serverId);
        const serverScope = serverId ? { serverId } : {};

        if (args.actionId === 'devices.simulator.list') {
            const result = await fetchSnapshot({ machineId, ...serverScope });
            return result.ok ? result.snapshot : routeUnavailableResult(result.reason);
        }

        const event = parsed.input as SimulatorPreviewActionClientInput['event'];
        const result = await dispatchAction({ machineId, ...serverScope, event });
        return result.ok ? result.result : routeUnavailableResult(result.reason);
    };
}
