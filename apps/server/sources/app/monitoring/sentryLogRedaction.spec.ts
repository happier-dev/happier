import { describe, expect, it } from "vitest";
import type { Event } from "@sentry/node";

import { redactSentryEvent, redactSentryLog, redactSentryLogAttributes } from "./sentryLogRedaction";

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

    it("templates public-share capabilities in log messages and attribute values", () => {
        const capability = "SENTINEL_PUBLIC_SHARE_CAPABILITY";
        const redacted = redactSentryLog({
            level: "error",
            message: `failed /v1/public-share/${capability}/messages`,
            attributes: {
                "http.url": `https://api.example.test/v1/public-share/${capability}`,
                nested: {
                    detail: `at /v1/public-share/${capability}/messages`,
                },
            },
        });

        expect(JSON.stringify(redacted)).not.toContain(capability);
        expect(redacted.message).toContain("/v1/public-share/:token/messages");
    });

    it("templates public-share capabilities across error and transaction event fields", () => {
        const capability = "SENTINEL_PUBLIC_SHARE_CAPABILITY";
        const redacted = redactSentryEvent({
            transaction: `GET /v1/public-share/${capability}`,
            request: {
                url: `https://api.example.test/v1/public-share/${capability}/messages`,
            },
            breadcrumbs: [{
                message: `fetch /v1/public-share/${capability}`,
            }],
            exception: {
                values: [{
                    value: `failed /v1/public-share/${capability}`,
                    stacktrace: {
                        frames: [{
                            filename: `/v1/public-share/${capability}/messages`,
                        }],
                    },
                }],
            },
        });

        expect(JSON.stringify(redacted)).not.toContain(capability);
        expect(redacted.request.url).toContain("/v1/public-share/:token/messages");
    });

    it("redacts the public-share messages grant header from Sentry request events", () => {
        const grant = "SENTINEL_PUBLIC_SHARE_MESSAGES_GRANT";
        const event = {
            request: {
                headers: {
                    "x-public-share-messages-access-token": grant,
                    "user-agent": "Happier test client",
                },
            },
        } satisfies Event;

        const redacted = redactSentryEvent(event);

        expect(redacted.request?.headers).toEqual({
            "x-public-share-messages-access-token": "[redacted]",
            "user-agent": "Happier test client",
        });
    });
});
