import { resolveServerFeaturesForGating } from "@/app/features/catalog/serverFeatureGate";
import { readServerEnabledBit } from "@happier-dev/protocol";

import type { FriendsPolicy } from "./friendsPolicy";

export function resolveFriendsPolicyFromServerFeatures(env: NodeJS.ProcessEnv): FriendsPolicy {
    const payload = resolveServerFeaturesForGating(env);
    const caps = payload.capabilities.social.friends;
    const enabled = readServerEnabledBit(payload, "social.friends") === true;
    return Object.freeze({
        enabled,
        allowUsername: caps.allowUsername,
        requiredIdentityProviderId: caps.requiredIdentityProviderId,
    });
}

