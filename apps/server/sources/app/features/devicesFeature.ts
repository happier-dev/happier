import type { FeaturesPayloadDelta } from "./types";
import { readDevicesFeatureEnv } from "./catalog/readFeatureEnv";

export function resolveDevicesFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const config = readDevicesFeatureEnv(env);

    // Device/simulator preview is server-represented + default-allow (§4.1): viewing your own
    // simulator is core dev UX, so it is on by default; the server can disable it for its users.
    // The simulatorPreview dependency closure (devices + machines.liveStream + browser.viewTargets)
    // still gates actual availability at the decision runtime.
    return {
        features: {
            devices: {
                enabled: config.enabled,
                simulatorPreview: { enabled: config.simulatorPreviewEnabled },
            },
        },
    };
}
