import { type Fastify } from "../../types";

import { connectOAuthExternalRoutes } from "./connectRoutes.oauthExternal";
import { connectVendorTokenRoutes } from "./connectRoutes.vendorTokens";
import { connectConnectedServicesV2Routes } from "./connectRoutes.connectedServicesV2";
import { connectConnectedServicesQuotasV2Routes } from "./connectRoutes.connectedServicesQuotasV2";
import { readConnectedServicesFeatureEnv } from "@/app/features/catalog/readFeatureEnv";

export function connectRoutes(app: Fastify) {
    connectOAuthExternalRoutes(app);
    connectVendorTokenRoutes(app);
    const connectedServices = readConnectedServicesFeatureEnv(process.env);
    if (!connectedServices.enabled) return;

    connectConnectedServicesV2Routes(app);
    if (connectedServices.quotasEnabled) {
        connectConnectedServicesQuotasV2Routes(app);
    }
}
