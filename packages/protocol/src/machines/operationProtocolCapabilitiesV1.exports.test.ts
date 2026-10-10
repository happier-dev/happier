import { describe, expect, it } from 'vitest';

import * as protocolRoot from '../index.js';
import * as machines from './index.js';
import * as protocol from './operationProtocolCapabilitiesV1.js';

describe('MachineOperationProtocolCapabilitiesV1 exports', () => {
  it('publishes the canonical helpers and stored projection through both barrels', () => {
    expect(machines.supportsMachineSessionFollowContextV1)
      .toBe(protocol.supportsMachineSessionFollowContextV1);
    expect(protocolRoot.supportsMachineSessionFollowContextV1)
      .toBe(protocol.supportsMachineSessionFollowContextV1);
    expect(machines.supportsMachineSessionFollowWakeOnHumanChangeV1)
      .toBe(protocol.supportsMachineSessionFollowWakeOnHumanChangeV1);
    expect(protocolRoot.supportsMachineSessionFollowWakeOnHumanChangeV1)
      .toBe(protocol.supportsMachineSessionFollowWakeOnHumanChangeV1);
    expect(machines.MachineOperationProtocolCapabilitiesV1StoredReadSchema)
      .toBe(protocol.MachineOperationProtocolCapabilitiesV1StoredReadSchema);
    expect(protocolRoot.MachineOperationProtocolCapabilitiesV1StoredReadSchema)
      .toBe(protocol.MachineOperationProtocolCapabilitiesV1StoredReadSchema);
  });
});
