import { type Fastify } from "../../types";
import { registerSessionCreateOrLoadRoute } from "./registerSessionCreateOrLoadRoute";
import { registerSessionDeleteRoute } from "./registerSessionDeleteRoute";
import { registerSessionArchiveRoutes } from "./registerSessionArchiveRoutes";
import { registerSessionListingRoutes } from "./registerSessionListingRoutes";
import { registerSessionLookupByTagsRoute } from "./registerSessionLookupByTagsRoute";
import { registerSessionMessageRoutes } from "./registerSessionMessageRoutes";
import { registerSessionOrganizationRoutes } from "./registerSessionOrganizationRoutes";
import { registerSessionPatchRoute } from "./registerSessionPatchRoute";
import { registerSessionReadStateRoutes } from "./registerSessionReadStateRoutes";
import { registerSessionTurnMutationRoute } from "./registerSessionTurnMutationRoute";
import { registerSessionSystemRecordRoutes } from "./registerSessionSystemRecordRoutes";
import { registerSessionSubagentCustodyRoutes } from "./registerSessionSubagentCustodyRoutes";

export function sessionRoutes(app: Fastify) {
    registerSessionListingRoutes(app);
    registerSessionLookupByTagsRoute(app);
    registerSessionOrganizationRoutes(app);
    registerSessionCreateOrLoadRoute(app);
    registerSessionArchiveRoutes(app);
    registerSessionMessageRoutes(app);
    registerSessionPatchRoute(app);
    registerSessionSystemRecordRoutes(app);
    registerSessionSubagentCustodyRoutes(app);
    registerSessionTurnMutationRoute(app);
    registerSessionReadStateRoutes(app);
    registerSessionDeleteRoute(app);
}
