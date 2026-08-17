import { type Fastify } from "../../types";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";

import { registerAutomationAssignmentRoutes } from "./registerAutomationAssignmentRoutes";
import { registerAutomationCrudRoutes } from "./registerAutomationCrudRoutes";
import { registerAutomationDaemonRoutes } from "./registerAutomationDaemonRoutes";
import { registerAutomationRunRoutes } from "./registerAutomationRunRoutes";
import { registerAutomationEventRoutes } from "./registerAutomationEventRoutes";
import { registerAutomationV3Routes } from "./registerAutomationV3Routes";
import { registerAutomationConversationRoutes } from "./registerAutomationConversationRoutes";

export function automationRoutes(app: Fastify): void {
    const gated = createServerFeatureGatedRouteApp(app, "automations", process.env);

    registerAutomationCrudRoutes(gated);
    registerAutomationAssignmentRoutes(gated);
    registerAutomationDaemonRoutes(gated);
    registerAutomationRunRoutes(gated);
    registerAutomationEventRoutes(gated);
    registerAutomationConversationRoutes(gated);
    registerAutomationV3Routes(gated);
}
