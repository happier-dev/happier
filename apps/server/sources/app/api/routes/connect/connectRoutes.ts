import { type Fastify } from "../../types";

import { connectAuthExternalRoutes } from "./connectRoutes.authExternal";
import { connectConnectExternalRoutes } from "./connectRoutes.connectExternal";
import { connectVendorTokenRoutes } from "./connectRoutes.vendorTokens";
import { connectConnectedServicesV2Routes } from "./connectRoutes.connectedServicesV2";
import { connectConnectedServicesQuotasV2Routes } from "./connectRoutes.connectedServicesQuotasV2";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import { registerOAuthCallbackRoute } from "./oauthExternal/registerOAuthCallbackRoute";

export function connectRoutes(app: Fastify) {
    connectAuthExternalRoutes(app);

    const connectedServicesApp = createServerFeatureGatedRouteApp(app, "connectedServices", process.env);
    connectConnectExternalRoutes(connectedServicesApp);
    connectVendorTokenRoutes(connectedServicesApp);

    connectConnectedServicesV2Routes(createServerFeatureGatedRouteApp(app, "connectedServices", process.env));
    connectConnectedServicesQuotasV2Routes(createServerFeatureGatedRouteApp(app, "connectedServices.quotas", process.env));

    // OAuth callback must stay mounted for auth flows; connect flows are rejected inside the handler when disabled.
    registerOAuthCallbackRoute(app);
}
