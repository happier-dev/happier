import type { FeaturesPayloadDelta } from "./types";
import {
    resolveConfiguredCanonicalServerUrl,
    resolveEffectiveWebappUrl,
} from "../serverUrls/effectiveServerUrls";

export function resolveServerUrlCapabilitiesFeature(
    env: NodeJS.ProcessEnv,
): FeaturesPayloadDelta {
    const canonicalServerUrl = resolveConfiguredCanonicalServerUrl(env);
    const webappUrl = resolveEffectiveWebappUrl(env);

    if (!canonicalServerUrl && !webappUrl) {
        return {};
    }

    return {
        capabilities: {
            server: {
                ...(canonicalServerUrl ? { canonicalServerUrl } : null),
                ...(webappUrl ? { webappUrl } : null),
            },
        },
    };
}
