import { type Fastify } from "../../types";
import { registerSessionCreateOrLoadRoute } from "./registerSessionCreateOrLoadRoute";
import { registerSessionDeleteRoute } from "./registerSessionDeleteRoute";
import { registerSessionArchiveRoutes } from "./registerSessionArchiveRoutes";
import { registerSessionListingRoutes } from "./registerSessionListingRoutes";
import { registerSessionFolderAssignmentRoutes } from "./registerSessionFolderAssignmentRoutes";
import { registerSessionOrganizationRoutes } from "./registerSessionOrganizationRoutes";
import { registerSessionMessageRoutes } from "./registerSessionMessageRoutes";
import { registerSessionAgentTransitionRoute } from "./registerSessionAgentTransitionRoute";
import { registerSessionPatchRoute } from "./registerSessionPatchRoute";
import { registerSessionReadStateRoutes } from "./registerSessionReadStateRoutes";
import { registerSessionTurnRoutes } from "./registerSessionTurnRoutes";
import { registerSessionSystemRecordRoutes } from "./registerSessionSystemRecordRoutes";

export function sessionRoutes(app: Fastify) {
    registerSessionListingRoutes(app);
    registerSessionOrganizationRoutes(app);
    registerSessionFolderAssignmentRoutes(app);
    registerSessionCreateOrLoadRoute(app);
    registerSessionArchiveRoutes(app);
    registerSessionMessageRoutes(app);
    registerSessionSystemRecordRoutes(app);
    registerSessionAgentTransitionRoute(app);
    registerSessionPatchRoute(app);
    registerSessionTurnRoutes(app);
    registerSessionReadStateRoutes(app);
    registerSessionDeleteRoute(app);
}
