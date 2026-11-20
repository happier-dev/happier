import { getActionSpec } from '../../actions/actionSpecs.js';
import { isSimulatorDeviceOperationRuntimeActionIdV1 } from '../../actions/actionIds.js';
import {
  createUnavailableRuntimeActionExecutor,
  resolveRuntimeActionExecutionFamily,
} from '../../actions/executor/dispatch.js';
import type {
  RuntimeActionExecute,
  RuntimeActionExecuteArgs,
} from '../../actions/executor/types.js';
import { isRpcMethodNotFoundResult } from '../../rpc/errors.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { isBackedSimulatorSidebandKindV1 } from './actionBuilders.js';
import {
  classifySimulatorRuntimeActionBackingV1,
  isSimulatorRuntimeActionIdV1,
  type SimulatorRuntimeActionIdV1,
} from './runtimeActionBacking.js';
import {
  DaemonSimulatorPreviewActionRequestV1Schema,
  DaemonSimulatorPreviewActionResponseV1Schema,
  DaemonSimulatorPreviewSnapshotRequestV1Schema,
  DaemonSimulatorPreviewSnapshotResponseV1Schema,
  type SimulatorPreviewActionResultV1,
  type SimulatorPreviewActionV1,
  type SimulatorPreviewSnapshotV1,
} from './runtimeV1.js';
import type { SimulatorSidebandKindV1 } from './sidebandV1.js';

/**
 * Client side of the simulator runtime Actions: every host that is not the
 * Machine's daemon (app, CLI, MCP, Session tools) reaches the addressed
 * Machine's simulator owner through its Machine RPC transport. Machine
 * admission belongs to that transport's Home route policy, never to this file.
 */
export type SimulatorMachineRpcCallV1 = (
  input: Readonly<{
    machineId: string;
    serverId?: string | null;
    method: string;
    payload: unknown;
    signal?: AbortSignal;
  }>,
) => Promise<unknown>;

export type SimulatorPreviewSnapshotClientInput = Readonly<{
  machineId: string;
  serverId?: string | null;
  signal?: AbortSignal;
}>;

export type SimulatorPreviewSnapshotClientResult =
  | Readonly<{ ok: true; snapshot: SimulatorPreviewSnapshotV1 }>
  | Readonly<{
      ok: false;
      reason: 'unavailable' | 'request_failed' | 'invalid_response';
    }>;

export type SimulatorPreviewActionClientInput = Readonly<{
  machineId: string;
  serverId?: string | null;
  event: SimulatorPreviewActionV1;
  signal?: AbortSignal;
}>;

export type SimulatorPreviewActionClientResult =
  | Readonly<{ ok: true; result: SimulatorPreviewActionResultV1 }>
  | Readonly<{
      ok: false;
      reason: 'unavailable' | 'request_failed' | 'invalid_response';
    }>;

function snapshotMatchesMachine(
  snapshot: SimulatorPreviewSnapshotV1,
  machineId: string,
): boolean {
  return (
    snapshot.machineId === machineId &&
    snapshot.resources.every(
      (resource) => resource.simulatorId.trim().length > 0,
    )
  );
}

/** Transport failures propagate to the caller's transport owner unchanged. */
export async function fetchSimulatorPreviewSnapshotV1(
  call: SimulatorMachineRpcCallV1,
  input: SimulatorPreviewSnapshotClientInput,
): Promise<SimulatorPreviewSnapshotClientResult> {
  const payload = DaemonSimulatorPreviewSnapshotRequestV1Schema.parse({
    machineId: input.machineId,
  });
  const raw = await call({
    machineId: input.machineId,
    serverId: input.serverId,
    method: RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_SNAPSHOT,
    payload,
    signal: input.signal,
  });
  if (isRpcMethodNotFoundResult(raw))
    return { ok: false, reason: 'unavailable' };
  const parsed = DaemonSimulatorPreviewSnapshotResponseV1Schema.safeParse(raw);
  if (
    !parsed.success ||
    !snapshotMatchesMachine(parsed.data.snapshot, input.machineId)
  ) {
    return { ok: false, reason: 'invalid_response' };
  }
  return { ok: true, snapshot: parsed.data.snapshot };
}

/** Transport failures propagate to the caller's transport owner unchanged. */
export async function dispatchSimulatorPreviewActionV1(
  call: SimulatorMachineRpcCallV1,
  input: SimulatorPreviewActionClientInput,
): Promise<SimulatorPreviewActionClientResult> {
  const payload = DaemonSimulatorPreviewActionRequestV1Schema.parse({
    protocolVersion: 1,
    machineId: input.machineId,
    event: input.event,
  });
  const raw = await call({
    machineId: input.machineId,
    serverId: input.serverId,
    method: RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_ACTION,
    payload,
    signal: input.signal,
  });
  if (isRpcMethodNotFoundResult(raw))
    return { ok: false, reason: 'unavailable' };
  const parsed = DaemonSimulatorPreviewActionResponseV1Schema.safeParse(raw);
  return parsed.success
    ? { ok: true, result: parsed.data.result }
    : { ok: false, reason: 'invalid_response' };
}

export type CreateSimulatorPreviewRuntimeActionExecutorV1Input = Readonly<{
  /** The host's default Machine when the caller names no Machine target. */
  resolveMachineId: (
    args: RuntimeActionExecuteArgs,
  ) => string | null | undefined;
  fetchSnapshot: (
    input: SimulatorPreviewSnapshotClientInput,
  ) => Promise<SimulatorPreviewSnapshotClientResult>;
  dispatchAction: (
    input: SimulatorPreviewActionClientInput,
  ) => Promise<SimulatorPreviewActionClientResult>;
  /** Device operations are whole Actions admitted on the addressed Machine. */
  executeOnMachine?: RuntimeActionExecute;
  fallback?: RuntimeActionExecute;
}>;

type SimulatorPreviewRouteFailureReason =
  | Extract<SimulatorPreviewSnapshotClientResult, { ok: false }>['reason']
  | Extract<SimulatorPreviewActionClientResult, { ok: false }>['reason'];

const unbackedSimulatorActionResult = {
  ok: false,
  errorCode: 'runtime_action_disabled',
  error:
    'runtime_action_disabled:devices.simulator:simulator_runtime_action_unbacked',
} as const;

const unbackedSimulatorSidebandResult = {
  ok: false,
  errorCode: 'runtime_action_disabled',
  error:
    'runtime_action_disabled:devices.simulator:simulator_sideband_unbacked',
} as const;

const machineUnavailableResult = {
  ok: false,
  errorCode: 'runtime_action_disabled',
  error:
    'runtime_action_disabled:devices.simulator:simulator_machine_unavailable',
} as const;

/** A host with no Machine Action route for device operations answers with this typed result. */
export const SIMULATOR_ACTION_ROUTE_UNAVAILABLE_RESULT_V1 = {
  ok: false,
  errorCode: 'runtime_action_disabled',
  error:
    'runtime_action_disabled:devices.simulator:simulator_action_route_unavailable',
} as const;

const invalidParametersResult = {
  ok: false,
  errorCode: 'invalid_parameters',
  error: 'invalid_parameters',
} as const;

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isUnbackedSimulatorRuntimeAction(
  actionId: RuntimeActionExecuteArgs['actionId'],
): boolean {
  // A client has no direct backing path: it forwards statically-backed and resource-gated
  // ids to the daemon (the sole platform-adapter authority, which makes the final resource-gated
  // decision). Only statically-unbacked ids fail closed here. This keeps the client verdict a strict
  // subset of — never a contradiction with — the daemon's classifier verdict.
  return (
    isSimulatorRuntimeActionIdV1(actionId) &&
    classifySimulatorRuntimeActionBackingV1(
      actionId as SimulatorRuntimeActionIdV1,
    ) === 'statically-unbacked'
  );
}

function isUnbackedSimulatorSidebandRuntimeAction(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    'type' in input &&
    input.type === 'simulator.sideband.request' &&
    'kind' in input &&
    !isBackedSimulatorSidebandKindV1(input.kind as SimulatorSidebandKindV1)
  );
}

function routeUnavailableResult(reason: SimulatorPreviewRouteFailureReason) {
  return {
    ok: false as const,
    errorCode: 'runtime_action_disabled',
    error: `runtime_action_disabled:devices.simulator:${reason}`,
  };
}

export function createSimulatorPreviewRuntimeActionExecutorV1(
  input: CreateSimulatorPreviewRuntimeActionExecutorV1Input,
): RuntimeActionExecute {
  const fallback = input.fallback ?? createUnavailableRuntimeActionExecutor();

  return async (args) => {
    if (
      resolveRuntimeActionExecutionFamily(args.actionId) !== 'devices.simulator'
    ) {
      return await fallback(args);
    }

    const parsed = getActionSpec(args.actionId).inputSchema.safeParse(
      args.input ?? {},
    );
    if (!parsed.success) return invalidParametersResult;

    if (isUnbackedSimulatorRuntimeAction(args.actionId)) {
      return unbackedSimulatorActionResult;
    }
    if (
      args.actionId === 'devices.simulator.sideband.request' &&
      isUnbackedSimulatorSidebandRuntimeAction(parsed.data)
    ) {
      return unbackedSimulatorSidebandResult;
    }

    const target = args.context.externalActionTarget;
    const machineId = normalizeId(
      target?.kind === 'machine'
        ? target.machineId
        : input.resolveMachineId(args),
    );
    if (!machineId) {
      return machineUnavailableResult;
    }

    if (isSimulatorDeviceOperationRuntimeActionIdV1(args.actionId)) {
      if (!input.executeOnMachine) return SIMULATOR_ACTION_ROUTE_UNAVAILABLE_RESULT_V1;
      return await input.executeOnMachine({
        ...args,
        input: parsed.data,
        context: {
          ...args.context,
          externalActionTarget:
            target?.kind === 'machine'
              ? { ...target, machineId }
              : { kind: 'machine', machineId },
        },
      });
    }

    const serverId = normalizeId(args.context.serverId);
    const serverScope = {
      ...(serverId ? { serverId } : {}),
      signal: args.context.signal,
    };

    if (args.actionId === 'devices.simulator.list') {
      const result = await input.fetchSnapshot({ machineId, ...serverScope });
      return result.ok
        ? result.snapshot
        : routeUnavailableResult(result.reason);
    }

    const event = parsed.data as SimulatorPreviewActionClientInput['event'];
    const result = await input.dispatchAction({
      machineId,
      ...serverScope,
      event,
    });
    return result.ok ? result.result : routeUnavailableResult(result.reason);
  };
}
