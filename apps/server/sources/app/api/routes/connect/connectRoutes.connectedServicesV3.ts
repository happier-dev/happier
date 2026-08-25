import type { Fastify } from "../../types";

import { parseIntEnv } from "@/config/env";
import { registerConnectedServiceRefreshLeaseRoutesV3 } from "./connectedServicesV2/registerConnectedServiceRefreshLeaseRoutesV2";
import { registerConnectedServiceCredentialRoutesV3 } from "./connectedServicesV3/registerConnectedServiceCredentialRoutesV3";

function resolveRefreshLeaseMaxMs(env: NodeJS.ProcessEnv): number {
    return parseIntEnv(env.CONNECTED_SERVICE_REFRESH_LEASE_MAX_MS, 5 * 60_000, { min: 5_000, max: 60 * 60_000 });
}

export function connectConnectedServicesV3Routes(app: Fastify): void {
    const refreshLeaseMaxMs = resolveRefreshLeaseMaxMs(process.env);

    registerConnectedServiceCredentialRoutesV3(app);
    registerConnectedServiceRefreshLeaseRoutesV3(app, { refreshLeaseMaxMs });
}
