import type { AuthMethodModule } from "@/app/auth/methods/types";

import { keyChallengeAuthMethodModule } from "@/app/auth/methods/modules/keyChallengeAuthMethodModule";
import { mtlsAuthMethodModule } from "@/app/auth/methods/modules/mtlsAuthMethodModule";

const staticAuthMethodModules: readonly AuthMethodModule[] = Object.freeze([
    keyChallengeAuthMethodModule,
    mtlsAuthMethodModule,
]);

export function resolveAuthMethodRegistry(_env: NodeJS.ProcessEnv): readonly AuthMethodModule[] {
    // For now, methods are a static registry. Enterprise forks can extend this list safely.
    return staticAuthMethodModules;
}

