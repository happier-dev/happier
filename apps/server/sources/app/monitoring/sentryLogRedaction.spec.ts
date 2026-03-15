import { describe, expect, it } from "vitest";

import { redactSentryLogAttributes } from "./sentryLogRedaction";

describe("app/monitoring/sentryLogRedaction", () => {
    it("redacts common secret keys recursively", () => {
        const input = {
            authorization: "Bearer abc",
            cookie: "a=b",
            nested: {
                token: "t1",
                password: "p1",
                ok: "keep",
            },
            arr: [{ secret: "s1" }, { value: 1 }],
        };

        expect(redactSentryLogAttributes(input)).toEqual({
            authorization: "[redacted]",
            cookie: "[redacted]",
            nested: {
                token: "[redacted]",
                password: "[redacted]",
                ok: "keep",
            },
            arr: [{ secret: "[redacted]" }, { value: 1 }],
        });
    });

    it("leaves non-objects unchanged", () => {
        expect(redactSentryLogAttributes(undefined)).toBeUndefined();
        expect(redactSentryLogAttributes({})).toEqual({});
    });
});
