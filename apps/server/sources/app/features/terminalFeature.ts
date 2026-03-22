import type { FeaturesPayloadDelta } from "./types";
import { readTerminalFeatureEnv } from "./catalog/readFeatureEnv";

export function resolveTerminalFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const config = readTerminalFeatureEnv(env);
    const embeddedPtyEnabled = config.embeddedPtyEnabled;

    return {
        features: {
            terminal: {
                embeddedPty: {
                    enabled: embeddedPtyEnabled,
                },
            },
        },
    };
}

