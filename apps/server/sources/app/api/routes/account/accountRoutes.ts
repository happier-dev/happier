import { type Fastify } from "../../types";
import { registerAccountProfileRoute } from "./registerAccountProfileRoute";
import { registerAccountIdentityVisibilityRoute } from "./registerAccountIdentityVisibilityRoute";
import { registerAccountUsernameRoute } from "./registerAccountUsernameRoute";
import { registerAccountSettingsRoutes } from "./registerAccountSettingsRoutes";
import { registerAccountUsageRoutes } from "./registerAccountUsageRoutes";
import { registerAccountEncryptionRoutes } from "./registerAccountEncryptionRoutes";

export function accountRoutes(app: Fastify): void {
    registerAccountProfileRoute(app);
    registerAccountIdentityVisibilityRoute(app);
    registerAccountUsernameRoute(app);
    registerAccountSettingsRoutes(app);
    registerAccountEncryptionRoutes(app);
    registerAccountUsageRoutes(app);
}
