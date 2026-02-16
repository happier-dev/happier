import { type Fastify } from "../../types";
import { parseIntEnv } from "@/config/env";
import { registerConnectedServiceCredentialRoutesV2 } from "./connectedServicesV2/registerConnectedServiceCredentialRoutesV2";
import { registerConnectedServiceOauthExchangeRoutes } from "./connectedServicesV2/registerConnectedServiceOauthExchangeRoutes";
import { registerConnectedServiceProfilesRoutesV2 } from "./connectedServicesV2/registerConnectedServiceProfilesRoutesV2";
import { registerConnectedServiceRefreshLeaseRoutesV2 } from "./connectedServicesV2/registerConnectedServiceRefreshLeaseRoutesV2";
import { registerConnectedServiceV1ShimRoutes } from "./connectedServicesV2/registerConnectedServiceV1ShimRoutes";

function resolveCredentialMaxLen(env: NodeJS.ProcessEnv): number {
    return parseIntEnv(env.CONNECTED_SERVICE_CREDENTIAL_MAX_LEN, 64_000, { min: 1, max: 2_000_000 });
}

function resolveRefreshLeaseMaxMs(env: NodeJS.ProcessEnv): number {
    return parseIntEnv(env.CONNECTED_SERVICE_REFRESH_LEASE_MAX_MS, 5 * 60_000, { min: 5_000, max: 60 * 60_000 });
}

export function connectConnectedServicesV2Routes(app: Fastify) {
    const refreshLeaseMaxMs = resolveRefreshLeaseMaxMs(process.env);
    const credentialMaxLen = resolveCredentialMaxLen(process.env);

    registerConnectedServiceV1ShimRoutes(app, { credentialMaxLen });
    registerConnectedServiceOauthExchangeRoutes(app);
    registerConnectedServiceCredentialRoutesV2(app, { credentialMaxLen });
    registerConnectedServiceProfilesRoutesV2(app);
    registerConnectedServiceRefreshLeaseRoutesV2(app, { refreshLeaseMaxMs });
}
