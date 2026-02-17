import type { FeaturesResponse } from "@happier-dev/protocol";

export { OAuthProviderStatusSchema as oauthProviderStatusSchema, FeaturesResponseSchema as featuresSchema } from "@happier-dev/protocol";
export type { FeaturesResponse } from "@happier-dev/protocol";

type DeepPartial<T> =
    T extends (...args: never[]) => unknown
        ? T
        : T extends ReadonlyArray<infer Item>
            ? ReadonlyArray<DeepPartial<Item>>
            : T extends object
                ? { [K in keyof T]?: DeepPartial<T[K]> }
                : T;

export type FeaturesPayloadDelta = Readonly<{
    features?: DeepPartial<FeaturesResponse["features"]>;
    capabilities?: DeepPartial<FeaturesResponse["capabilities"]>;
}>;
