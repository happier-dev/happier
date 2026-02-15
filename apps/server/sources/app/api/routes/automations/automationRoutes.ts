import { type Fastify } from "../../types";
import { resolveServerFeaturePayload } from "@/app/features/catalog/resolveServerFeaturePayload";

import { registerAutomationAssignmentRoutes } from "./registerAutomationAssignmentRoutes";
import { registerAutomationCrudRoutes } from "./registerAutomationCrudRoutes";
import { registerAutomationDaemonRoutes } from "./registerAutomationDaemonRoutes";
import { registerAutomationRunRoutes } from "./registerAutomationRunRoutes";

export function automationRoutes(app: Fastify): void {
    if (!resolveServerFeaturePayload(process.env).features.automations.enabled) {
        return;
    }

    registerAutomationCrudRoutes(app);
    registerAutomationAssignmentRoutes(app);
    registerAutomationDaemonRoutes(app);
    registerAutomationRunRoutes(app);
}
