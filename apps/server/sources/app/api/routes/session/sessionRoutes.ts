import { type Fastify } from "../../types";
import { registerSessionCreateOrLoadRoute } from "./registerSessionCreateOrLoadRoute";
import { registerSessionDeleteRoute } from "./registerSessionDeleteRoute";
import { registerSessionArchiveRoutes } from "./registerSessionArchiveRoutes";
import { registerSessionListingRoutes } from "./registerSessionListingRoutes";
import { registerSessionMessageRoutes } from "./registerSessionMessageRoutes";
import { registerSessionPatchRoute } from "./registerSessionPatchRoute";

export function sessionRoutes(app: Fastify) {
    registerSessionListingRoutes(app);
    registerSessionCreateOrLoadRoute(app);
    registerSessionArchiveRoutes(app);
    registerSessionMessageRoutes(app);
    registerSessionPatchRoute(app);
    registerSessionDeleteRoute(app);
}
