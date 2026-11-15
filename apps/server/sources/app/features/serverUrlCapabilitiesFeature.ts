import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';

import type { FeaturesPayloadDelta } from "./types";
import {
    resolveConfiguredCanonicalServerUrl,
    resolveEffectiveWebappUrl,
} from "../serverUrls/effectiveServerUrls";
import { readServerGuestCliIdentity, readServerReleaseVersion } from "../runtime/serverRelease";

/**
 * `capabilities.server`: the addresses clients use; `capabilities.serverRelease`: diagnostic facts about
 * the running server binary — its release version and flavour (plan `2026-09-26-home-owner-console` §3.7).
 */
export function resolveServerUrlCapabilitiesFeature(
    env: NodeJS.ProcessEnv,
): FeaturesPayloadDelta {
    const canonicalServerUrl = resolveConfiguredCanonicalServerUrl(env);
    const webappUrl = resolveEffectiveWebappUrl(env);
    const version = readServerReleaseVersion();
    const flavor = readServerConfig(env, SERVER_CONFIG.HAPPIER_SERVER_FLAVOR);

    const releaseFlavor = flavor === "light" ? "light" as const : flavor === "full" ? "full" as const : null;
    const server = {
        ...(canonicalServerUrl ? { canonicalServerUrl } : null),
        ...(webappUrl ? { webappUrl } : null),
    };
    const serverRelease = {
        ...(version ? { version } : null),
        ...(releaseFlavor ? { flavor: releaseFlavor } : null),
    };
    return {
        capabilities: {
            guestCli: readServerGuestCliIdentity(),
            ...(Object.keys(server).length > 0 ? { server } : null),
            // Its own family: released readers parse `capabilities.server` strictly (see
            // `serverReleaseCapabilities.ts` in protocol).
            ...(Object.keys(serverRelease).length > 0 ? { serverRelease } : null),
        },
    };
}
