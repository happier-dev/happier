import type { Fastify } from "../../types";

import { registerConnectedServiceCredentialRoutesV3 } from "./connectedServicesV3/registerConnectedServiceCredentialRoutesV3";

export function connectConnectedServicesV3Routes(app: Fastify): void {
    registerConnectedServiceCredentialRoutesV3(app);
}

