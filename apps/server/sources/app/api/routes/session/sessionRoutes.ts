import { type Fastify } from "../../types";
import { registerSessionCreateOrLoadRoute } from "./registerSessionCreateOrLoadRoute";
import { registerSessionDeleteRoute } from "./registerSessionDeleteRoute";
import { registerSessionArchiveRoutes } from "./registerSessionArchiveRoutes";
import { registerSessionListingRoutes } from "./registerSessionListingRoutes";
import { registerSessionMessageRoutes } from "./registerSessionMessageRoutes";
import { registerSessionPatchRoute } from "./registerSessionPatchRoute";
import { registerSessionReadStateRoutes } from "./registerSessionReadStateRoutes";
import { registerSessionFolderAssignmentRoutes } from "./registerSessionFolderAssignmentRoutes";

export function sessionRoutes(app: Fastify) {
    registerSessionListingRoutes(app);
    registerSessionFolderAssignmentRoutes(app);
    registerSessionCreateOrLoadRoute(app);
    registerSessionArchiveRoutes(app);
    registerSessionMessageRoutes(app);
    registerSessionPatchRoute(app);
    registerSessionReadStateRoutes(app);
    registerSessionDeleteRoute(app);
}
