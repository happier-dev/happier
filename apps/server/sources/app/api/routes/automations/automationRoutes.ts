import { type Fastify } from "../../types";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";

import { registerAutomationAssignmentRoutes } from "./registerAutomationAssignmentRoutes";
import { registerAutomationCrudRoutes } from "./registerAutomationCrudRoutes";
import { registerAutomationDaemonRoutes } from "./registerAutomationDaemonRoutes";
import { registerAutomationRunRoutes } from "./registerAutomationRunRoutes";

export function automationRoutes(app: Fastify): void {
    const gated = createServerFeatureGatedRouteApp(app, "automations", process.env);

    registerAutomationCrudRoutes(gated);
    registerAutomationAssignmentRoutes(gated);
    registerAutomationDaemonRoutes(gated);
    registerAutomationRunRoutes(gated);
}
