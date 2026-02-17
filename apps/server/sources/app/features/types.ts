import type { FeaturesResponse } from "@happier-dev/protocol";

export { OAuthProviderStatusSchema as oauthProviderStatusSchema, FeaturesResponseSchema as featuresSchema } from "@happier-dev/protocol";
export type { FeaturesResponse } from "@happier-dev/protocol";

export type FeaturesPayloadDelta = Readonly<{
    features?: Partial<FeaturesResponse["features"]>;
    capabilities?: Partial<FeaturesResponse["capabilities"]>;
}>;
