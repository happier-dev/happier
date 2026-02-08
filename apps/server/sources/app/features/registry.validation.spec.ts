import { describe, expect, it } from "vitest";

import { featuresSchema } from "./types";
import { resolveFeaturesFromEnv } from "./registry";

describe("features/registry", () => {
    it("returns a schema-valid /v1/features payload", () => {
        const res = resolveFeaturesFromEnv({} as any);
        const parsed = featuresSchema.safeParse(res);
        expect(parsed.success).toBe(true);
    });

    it("throws when a resolver returns an invalid features shape", () => {
        expect(() =>
            resolveFeaturesFromEnv({} as any, [
                () =>
                    ({
                        voice: { enabled: "nope" },
                    }) as any,
            ]),
        ).toThrow(/features/i);
    });
});

