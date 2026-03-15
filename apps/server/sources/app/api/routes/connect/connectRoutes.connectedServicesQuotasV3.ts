import type { Fastify } from "../../types";

import { registerConnectedServiceQuotaRoutesV3 } from "./connectedServicesV3/registerConnectedServiceQuotaRoutesV3";

export function connectConnectedServicesQuotasV3Routes(app: Fastify): void {
    registerConnectedServiceQuotaRoutesV3(app);
}

