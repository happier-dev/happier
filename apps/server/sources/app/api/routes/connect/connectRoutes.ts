import { type Fastify } from "../../types";

import { connectAuthExternalRoutes } from "./connectRoutes.authExternal";
import { connectConnectExternalRoutes } from "./connectRoutes.connectExternal";
import { connectVendorTokenRoutes } from "./connectRoutes.vendorTokens";
import { connectConnectedServicesV2Routes } from "./connectRoutes.connectedServicesV2";
import { connectConnectedServicesQuotasV2Routes } from "./connectRoutes.connectedServicesQuotasV2";
import { connectConnectedServicesQuotasV3Routes } from "./connectRoutes.connectedServicesQuotasV3";
import { connectConnectedServicesV3Routes } from "./connectRoutes.connectedServicesV3";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import { registerOAuthCallbackRoute } from "./oauthExternal/registerOAuthCallbackRoute";
import {
    registerQualifiedConnectedAccountCredentialRoutesV4,
} from "./qualifiedConnectedAccounts/registerQualifiedConnectedAccountCredentialRoutesV4";
import {
    registerConnectedAccountAttemptTransactionRoutes,
} from "./connectedAccountAttemptTransactions/registerConnectedAccountAttemptTransactionRoutes";

export function connectRoutes(app: Fastify) {
    connectAuthExternalRoutes(app);

    connectConnectExternalRoutes(app);
    connectVendorTokenRoutes(app);

    connectConnectedServicesV2Routes(app);
    connectConnectedServicesV3Routes(app);
    registerConnectedAccountAttemptTransactionRoutes(app);
    registerQualifiedConnectedAccountCredentialRoutesV4(app);
    connectConnectedServicesQuotasV2Routes(createServerFeatureGatedRouteApp(app, "connectedServices.quotas", process.env));
    connectConnectedServicesQuotasV3Routes(createServerFeatureGatedRouteApp(app, "connectedServices.quotas", process.env));

    // The shared OAuth callback stays mounted for both auth and core Connected Accounts flows.
    registerOAuthCallbackRoute(app);
}
