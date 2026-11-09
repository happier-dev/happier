import { type Fastify } from "../../types";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";

import { registerAutomationEventRoutes } from "./registerAutomationEventRoutes";
import { registerAutomationV3Routes } from "./registerAutomationV3Routes";
import { registerAutomationConversationRoutes } from "./registerAutomationConversationRoutes";
import { registerWorkflowRunStorageRoutes } from "./registerWorkflowRunStorageRoutes";

export function automationRoutes(app: Fastify): void {
    const gated = createServerFeatureGatedRouteApp(app, "workflows", process.env);

    registerAutomationEventRoutes(gated);
    registerAutomationConversationRoutes(gated);
    registerAutomationV3Routes(gated);
    registerWorkflowRunStorageRoutes(gated);
}
