import { describe, expect, it } from "vitest";

import { buildUsageLeaders, buildUsageModelTimeline } from "./buildUsagePremiumSections";

describe("buildUsagePremiumSections", () => {
    it("retains unknown inference dimensions and does not rank mixed cost kinds as money", () => {
        const base = { sessionId: "session", observedAt: new Date("2026-07-01T10:00:00Z"), agentId: "codex", backendMode: null,
            projectKey: null, workspaceId: null, source: "runtime", contributingEventIds: ["event"],
            tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 } };
        const rows = [
            { ...base, modelId: "mixed", cost: { reportedUsd: 10, estimatedUsd: 0, costSource: "provider_reported" as const, currency: "USD" } },
            { ...base, modelId: "mixed", cost: { reportedUsd: 0, estimatedUsd: 10, costSource: "pricing_estimate" as const, currency: "USD" } },
            { ...base, modelId: "known", tokens: { ...base.tokens, input: 2, total: 2 }, cost: { reportedUsd: 2, estimatedUsd: 0, costSource: "provider_reported" as const, currency: "USD" } },
            { ...base, modelId: null, cost: { reportedUsd: 0, estimatedUsd: 0, costSource: "none" as const, currency: "USD" } },
        ];
        expect(buildUsageLeaders(rows, 10)?.models?.map((row) => row.key)).toEqual(["known", "mixed", "unknown"]);
        expect(buildUsageModelTimeline(rows, "day", 10)?.[0].leaders.map((row) => row.key)).toEqual(["known", "mixed", "unknown"]);
    });
    it("keeps aggregated tokens and cost on leaders and timelines", () => {
        const rows = [
            {
                sessionId: "session-1",
                observedAt: new Date("2024-04-25T13:00:00.000Z"),
                agentId: "claude",
                backendMode: "remote",
                modelId: "claude-sonnet-4-6",
                projectKey: "project-1",
                workspaceId: "workspace-1",
                source: "claude-sdk-result",
                contributingEventIds: ["event-1"],
                tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
                cost: { reportedUsd: 0.12, estimatedUsd: 0.09, invoiceUsd: 0.08, currency: "USD" },
            },
            {
                sessionId: "session-2",
                observedAt: new Date("2024-04-25T13:15:00.000Z"),
                agentId: "claude",
                backendMode: "remote",
                modelId: "claude-sonnet-4-6",
                projectKey: "project-1",
                workspaceId: "workspace-1",
                source: "claude-sdk-result",
                contributingEventIds: ["event-2"],
                tokens: { input: 8, output: 7, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
                cost: { reportedUsd: 0.1, estimatedUsd: 0.08, invoiceUsd: 0.07, currency: "USD" },
            },
        ];

        const leaders = buildUsageLeaders(rows, 10);
        expect(leaders?.agents?.[0]).toMatchObject({
            key: "claude",
            eventCount: 2,
            tokens: {
                input: 18,
                output: 12,
                reasoning: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 30,
            },
            cost: {
                reportedUsd: 0.22,
                estimatedUsd: 0.16999999999999998,
                invoiceUsd: 0.15000000000000002,
                currency: "USD",
            },
        });

        const timeline = buildUsageModelTimeline(rows, "day", 10);
        expect(timeline?.[0]).toMatchObject({
            leaders: [
                {
                    key: "claude-sonnet-4-6",
                    eventCount: 2,
                    tokens: {
                        input: 18,
                        output: 12,
                        reasoning: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 30,
                    },
                    cost: {
                        reportedUsd: 0.22,
                        estimatedUsd: 0.16999999999999998,
                        invoiceUsd: 0.15000000000000002,
                        currency: "USD",
                    },
                },
            ],
        });
    });

});
