import type { FeaturesPayloadDelta } from "./types";
import { resolveLiveActivityRemoteTransportConfig } from "@/app/activity/liveActivities/resolveLiveActivityRemoteTransport";

export function resolveLiveActivityRemoteUpdatesFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const config = resolveLiveActivityRemoteTransportConfig(env);
    return {
        capabilities: {
            liveActivities: {
                remoteUpdates: config.capabilityDiagnostics,
            },
        },
    };
}
