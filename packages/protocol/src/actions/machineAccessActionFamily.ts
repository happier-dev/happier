import { getActionSpec } from './actionSpecs.js';
import { bindHomeDomainHttpRequestV1 } from './homeDomainHttpBinding.js';
import type { MachineAccessActionId } from './specs/machineAccess.js';

/** Transport comes exclusively from the declared Action row, with Home consumed by the host. */
export function bindMachineAccessActionHttpRequestV1(actionId: Exclude<MachineAccessActionId, 'machines.access.prepareKeys'>, input: unknown) {
  const spec = getActionSpec(actionId);
  if (!spec.serverTransport) throw new TypeError(`Machine access Action declares no transport: ${actionId}`);
  return bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema.transform((value: unknown) => {
    const { serverId: _serverId, ...body } = value as Record<string, unknown>;
    return body;
  }), input });
}
