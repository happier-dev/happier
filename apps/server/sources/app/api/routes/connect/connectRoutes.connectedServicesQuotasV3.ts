import type { Fastify } from "../../types";

import { registerConnectedServiceQuotaRoutesV3 } from "./connectedServicesV3/registerConnectedServiceQuotaRoutesV3";
import { registerProviderAccountUsageRoutesV3 } from "./providerAccountUsageRoutesV3";

export function connectConnectedServicesQuotasV3Routes(app: Fastify): void {
    registerProviderAccountUsageRoutesV3(app);
    registerConnectedServiceQuotaRoutesV3(app);
}
