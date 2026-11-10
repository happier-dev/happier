import { z } from '../../zodRuntimePolicy.js';

import { RunnerBrokerReadinessRequestV1Schema } from '../../teams/credentials/readinessV1.js';
import { IrohProviderBrokerHandshakeV1Schema } from '../../providers/brokerRouteGrantV1.js';
import { IrohMachineHandshakeV1Schema } from './machineHandshakeV1.js';

/** The one strict application-admission union carried by happier/machine/1. */
export const IrohMachineAdmissionHandshakeV1Schema = z.union([
  IrohMachineHandshakeV1Schema,
  IrohProviderBrokerHandshakeV1Schema,
  RunnerBrokerReadinessRequestV1Schema,
]);
export type IrohMachineAdmissionHandshakeV1 = z.infer<typeof IrohMachineAdmissionHandshakeV1Schema>;
