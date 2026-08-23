import { describe, expect, it } from "vitest";
import { PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1 } from "@happier-dev/protocol";

import { readPluginsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";

import {
    PLUGIN_WEBHOOK_ACCOUNT_PAYLOAD_BYTES_V1,
    PLUGIN_WEBHOOK_ACCOUNT_PAYLOAD_ROWS_V1,
    PLUGIN_WEBHOOK_ACCOUNT_TERMINAL_ROWS_V1,
    PLUGIN_WEBHOOK_ENDPOINT_PAYLOAD_BYTES_V1,
    PLUGIN_WEBHOOK_ENDPOINT_PAYLOAD_ROWS_V1,
    resolvePluginWebhookDeliveryQuotaRejectionV1,
} from "./policy";

describe("plugin webhook V1 queue quota policy", () => {
    const base = {
        endpointPayloadRows: 0,
        accountPayloadRows: 0,
        endpointPayloadBytes: 0n,
        accountPayloadBytes: 0n,
        accountTerminalRows: 0,
        candidatePayloadBytes: 1n,
    };

    it("admits the exact row and byte ceilings", () => {
        expect(resolvePluginWebhookDeliveryQuotaRejectionV1({
            ...base,
            endpointPayloadRows: PLUGIN_WEBHOOK_ENDPOINT_PAYLOAD_ROWS_V1 - 1,
            accountPayloadRows: PLUGIN_WEBHOOK_ACCOUNT_PAYLOAD_ROWS_V1 - 1,
            endpointPayloadBytes: PLUGIN_WEBHOOK_ENDPOINT_PAYLOAD_BYTES_V1 - 1n,
            accountPayloadBytes: PLUGIN_WEBHOOK_ACCOUNT_PAYLOAD_BYTES_V1 - 1n,
            accountTerminalRows: PLUGIN_WEBHOOK_ACCOUNT_TERMINAL_ROWS_V1 - 1,
        })).toBeNull();
    });

    it("rejects exact plus one independently for each bounded resource", () => {
        expect(resolvePluginWebhookDeliveryQuotaRejectionV1({
            ...base,
            endpointPayloadRows: PLUGIN_WEBHOOK_ENDPOINT_PAYLOAD_ROWS_V1,
        })).toBe("endpointPayloadRows");
        expect(resolvePluginWebhookDeliveryQuotaRejectionV1({
            ...base,
            accountPayloadRows: PLUGIN_WEBHOOK_ACCOUNT_PAYLOAD_ROWS_V1,
        })).toBe("accountPayloadRows");
        expect(resolvePluginWebhookDeliveryQuotaRejectionV1({
            ...base,
            endpointPayloadBytes: PLUGIN_WEBHOOK_ENDPOINT_PAYLOAD_BYTES_V1,
        })).toBe("endpointPayloadBytes");
        expect(resolvePluginWebhookDeliveryQuotaRejectionV1({
            ...base,
            accountPayloadBytes: PLUGIN_WEBHOOK_ACCOUNT_PAYLOAD_BYTES_V1,
        })).toBe("accountPayloadBytes");
        expect(resolvePluginWebhookDeliveryQuotaRejectionV1({
            ...base,
            accountTerminalRows: PLUGIN_WEBHOOK_ACCOUNT_TERMINAL_ROWS_V1,
        })).toBe("accountTerminalRows");
    });
});

describe("plugin webhook V1 ingress policy", () => {
    it("keeps one versioned host policy at the feature/config owner and accepts only lower operational limits", () => {
        const lowered = readPluginsFeatureEnv({
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_REQUESTS: "2",
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_RAW_BODY_BYTES: "1024",
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: "5",
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: "2",
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: "3",
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: "1",
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: "20",
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: "4",
        } as NodeJS.ProcessEnv);
        const raised = readPluginsFeatureEnv({
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_REQUESTS: "5",
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_RAW_BODY_BYTES: String(5 * PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1),
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: "601",
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: "17",
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: "301",
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: "9",
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: "3001",
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: "33",
        } as NodeJS.ProcessEnv);

        expect(Reflect.get(lowered as object, "webhookIngressPolicy")).toStrictEqual({
            version: 1,
            process: { maxRequests: 2, maxRawBodyBytes: 1_024 },
            route: { ratePerMinute: 5, concurrency: 2 },
            endpoint: { ratePerMinute: 3, concurrency: 1 },
            account: { ratePerMinute: 20, concurrency: 4 },
        });
        expect(Reflect.get(raised as object, "webhookIngressPolicy")).toStrictEqual({
            version: 1,
            process: { maxRequests: 4, maxRawBodyBytes: 4 * PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1 },
            route: { ratePerMinute: 600, concurrency: 16 },
            endpoint: { ratePerMinute: 300, concurrency: 8 },
            account: { ratePerMinute: 3_000, concurrency: 32 },
        });
    });

    it("derives the raw-body ceiling from the request ceiling so it can never be an unreachable number", () => {
        const withDefaults = readPluginsFeatureEnv({} as NodeJS.ProcessEnv).webhookIngressPolicy;
        expect(withDefaults.process.maxRawBodyBytes).toBe(
            withDefaults.process.maxRequests * PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1,
        );

        const fewerSlots = readPluginsFeatureEnv({
            HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_REQUESTS: "1",
        } as NodeJS.ProcessEnv).webhookIngressPolicy;
        expect(fewerSlots.process).toStrictEqual({
            maxRequests: 1,
            maxRawBodyBytes: PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1,
        });
    });
});
