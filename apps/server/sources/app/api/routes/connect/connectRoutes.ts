import { type Fastify } from "../../types";

import { connectOAuthExternalRoutes } from "./connectRoutes.oauthExternal";
import { connectVendorTokenRoutes } from "./connectRoutes.vendorTokens";

export function connectRoutes(app: Fastify) {
    connectOAuthExternalRoutes(app);
    connectVendorTokenRoutes(app);
}

