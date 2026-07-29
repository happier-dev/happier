import { describe, expect, it } from "vitest";

import { buildUsageCostPresentation, buildUsageLeaders, buildUsageModelTimeline } from "./buildUsagePremiumSections";

describe("buildUsagePremiumSections", () => {
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

    it("prefers invoice cost in auto presentation and keeps explicit modes exact", () => {
        const cost = {
            reportedUsd: 0.12,
            estimatedUsd: 0.09,
            invoiceUsd: 0.08,
            currency: "USD",
        } as const;

        expect(buildUsageCostPresentation(cost, undefined)).toMatchObject({
            mode: "auto",
            effectiveUsd: 0.08,
            currency: "USD",
            source: "invoice",
        });

        expect(buildUsageCostPresentation(cost, "reported")).toMatchObject({
            mode: "reported",
            effectiveUsd: 0.12,
            currency: "USD",
            source: "provider_reported",
        });

        expect(buildUsageCostPresentation(cost, "estimated")).toMatchObject({
            mode: "estimated",
            effectiveUsd: 0.09,
            currency: "USD",
            source: "pricing_estimate",
        });
    });
});
