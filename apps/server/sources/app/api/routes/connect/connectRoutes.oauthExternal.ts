import { type Fastify } from "../../types";
import { registerOAuthCallbackRoute } from "./oauthExternal/registerOAuthCallbackRoute";
import { connectAuthExternalRoutes } from "./connectRoutes.authExternal";
import { connectConnectExternalRoutes } from "./connectRoutes.connectExternal";

export function connectOAuthExternalRoutes(app: Fastify) {
    connectAuthExternalRoutes(app);
    connectConnectExternalRoutes(app);
    registerOAuthCallbackRoute(app);

}
