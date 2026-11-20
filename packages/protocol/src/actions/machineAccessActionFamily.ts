import { getActionSpec } from './actionSpecs.js';
import { bindHomeDomainHttpRequestV1 } from './homeDomainHttpBinding.js';
import type { MachineAccessHttpActionId } from './specs/machine/access.js';
import { MACHINE_ACCESS_GRANT_SET_ACTION_ID_V1, MACHINE_ACCESS_GRANTS_LIST_ACTION_ID_V1 } from './specs/machine/accessActionIdsV1.js';
import { z } from '../zodRuntimePolicy.js';

/** Transport comes exclusively from the declared Action row, with Home consumed by the host. */
export function bindMachineAccessActionHttpRequestV1(actionId: Exclude<MachineAccessHttpActionId, 'machines.access.prepareKeys'>, input: unknown) {
  const spec = getActionSpec(actionId);
  if (!spec.serverTransport) throw new TypeError(`Machine access Action declares no transport: ${actionId}`);
  return bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: z.pipe(spec.inputSchema, z.transform((value: z.output<typeof spec.inputSchema>) => {
    const { serverId: _serverId, ...body } = value as Record<string, unknown>;
    return body;
  })), input });
}

/** Grant Set may read the same Machine for its review or to settle key readiness. */
export function isMachineGrantSetAccessReadV1(input: Readonly<{
  rootActionId: string;
  effectActionId: string;
  serverId: string;
  machineId: string;
  request: Readonly<{ method: string; path: string; body?: unknown }>;
}>): boolean {
  if (input.rootActionId !== MACHINE_ACCESS_GRANT_SET_ACTION_ID_V1
    || input.effectActionId !== MACHINE_ACCESS_GRANTS_LIST_ACTION_ID_V1 && input.effectActionId !== input.rootActionId
    || input.request.method.toUpperCase() !== 'GET' || input.request.body !== undefined) return false;
  const read = bindMachineAccessActionHttpRequestV1(MACHINE_ACCESS_GRANTS_LIST_ACTION_ID_V1, {
    serverId: input.serverId, machineId: input.machineId,
  });
  return input.request.path === read.path;
}
