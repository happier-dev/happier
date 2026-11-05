import { describe, expect, it } from "vitest";

import { buildUsageEngineTimeline, buildUsageInsights, buildUsageModelTimeline } from "./buildUsagePremiumSections";
import { resolveScopedUsageContributions } from "./resolveScopedUsageContributions";

describe("buildUsagePremiumSections", () => {
    it("defers timeline money reads until pricing, except to preserve a truncated token tie", () => {
        for (const count of [2, 128]) {
            let moneyReads = 0;
            const rows = Array.from({ length: count }, (_, index) => ({ sessionId: "session",
                observedAt: new Date(100), agentId: "codex", backendMode: null, modelId: `model-${index % 2}`,
                projectKey: null, workspaceId: null, source: "runtime", contributingEventIds: [String(index)],
                tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
                cost: { get reportedUsd() { moneyReads++; return index % 2 ? 2 : 1; }, estimatedUsd: 0, currency: "USD" },
            }));
            const prepared = buildUsageModelTimeline(rows, "day", 2, 0, "auto", true);
            expect(moneyReads, "timeline preparation must not price money that the canonical pricing pass rebuilds").toBe(0);
            expect(prepared?.[0]?.leaders.map(leader => leader.key).sort()).toEqual(["model-0", "model-1"]);
            const truncated = buildUsageModelTimeline(rows, "day", 1, 0, "auto", true);
            expect(moneyReads).toBeGreaterThan(0);
            expect(truncated?.[0]?.leaders.map(leader => leader.key)).toEqual(["model-1"]);
        }
    });
    it("does not count the real QA snapshot alias as a different model or model switch", () => {
        const rows = ["claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-haiku-5-5"].map((modelId, index) => ({
            sessionId: "session", observedAt: new Date(1791720000000 + index), agentId: "claude", backendMode: null,
            modelId, projectKey: null, workspaceId: null, source: "runtime", contributingEventIds: [`event-${index}`],
            tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: "USD" },
        }));
        expect(buildUsageInsights(rows, { messageCount: 0 })).toMatchObject({
            modelsTried: 2, favoriteModel: { key: "claude-haiku-4-5" }, favoriteModelChangeCount: 1,
        });
    });
    it("partitions reconciled timeline sources without classifying linked native replay as outside", () => {
        const subject = { kind: "native", machineId: "machine", agent: { pluginId: "happier.agent.codex", localId: "codex" }, sourceRootKey: "root", nativeSessionKey: "native" };
        const base = { id: "runtime", sessionId: "session", observedAt: new Date(100), createdAt: new Date(100), agentId: "codex", backendMode: null,
            modelId: "model", projectKey: null, workspaceId: null, source: "runtime", scope: "turn_delta", isCumulative: false, turnId: "turn",
            contextUsedTokens: null, contextWindowTokens: null, tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 },
            cost: { reportedUsd: 1, estimatedUsd: 0, costSource: "provider_reported" as const, currency: "USD" },
            metadata: { accountingSubject: subject, usageAccounting: { path: "runtime", inferenceId: "one" } } };
        const resolved = resolveScopedUsageContributions([
            base,
            { ...base, id: "replay", source: "native", metadata: { accountingSubject: { ...subject, linkedSessionId: "session" }, usageAccounting: { path: "native", inferenceId: "one" } } },
            { ...base, id: "linked-native", source: "native", metadata: { accountingSubject: { ...subject, linkedSessionId: "session" }, usageAccounting: { path: "native", inferenceId: "two" } } },
            { ...base, id: "outside", sessionId: null, source: "native", metadata: { accountingSubject: { ...subject, nativeSessionKey: "outside" }, usageAccounting: { path: "native", inferenceId: "three" } } },
            { ...base, id: "unknown", sessionId: null, source: "old-source", metadata: {} },
        ]);
        const timeline = buildUsageEngineTimeline(resolved.totalContributions, "day", 10, 0, "reported");
        expect(timeline?.[0]?.leaders[0]).toMatchObject({ key: "codex", tokens: { total: 40 }, sources: [
            { source: "native", path: "native", execution: "happier", tokens: { total: 10 } },
            { source: "native", path: "native", execution: "outside", tokens: { total: 10 } },
            { source: "old-source", path: "unknown", execution: "unknown", tokens: { total: 10 } },
            { source: "runtime", path: "runtime", execution: "happier", tokens: { total: 10 } },
        ] });
    });
    it("retains unknown dimensions and ranks mixed best-available money without calling it reported", () => {
        const base = { sessionId: "session", observedAt: new Date("2026-07-01T10:00:00Z"), agentId: "codex", backendMode: null,
            projectKey: null, workspaceId: null, source: "runtime", contributingEventIds: ["event"],
            tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 } };
        const rows = [
            { ...base, modelId: "mixed", cost: { reportedUsd: 10, estimatedUsd: 0, costSource: "provider_reported" as const, currency: "USD" } },
            { ...base, modelId: "mixed", cost: { reportedUsd: 0, estimatedUsd: 10, costSource: "pricing_estimate" as const, currency: "USD" } },
            { ...base, modelId: "known", tokens: { ...base.tokens, input: 2, total: 2 }, cost: { reportedUsd: 2, estimatedUsd: 0, costSource: "provider_reported" as const, currency: "USD" } },
            { ...base, modelId: null, cost: { reportedUsd: 0, estimatedUsd: 0, costSource: "none" as const, currency: "USD" } },
        ];
        const automatic = buildUsageModelTimeline(rows, "day", 10)?.[0].leaders;
        expect(automatic?.map((row) => row.key)).toEqual(["mixed", "known", "unknown"]);
        expect(automatic?.[0]?.cost).toMatchObject({ reportedUsd: 10, estimatedUsd: 10, effectiveUsd: 20, costSource: "none" });
        const reported = buildUsageModelTimeline(rows, "day", 10, 0, "reported")?.[0].leaders;
        expect(reported?.map((row) => row.key)).toEqual(["known", "mixed", "unknown"]);
        expect(reported?.find((row) => row.key === "mixed")?.cost?.effectiveUsd).toBeUndefined();
    });
    it("keeps aggregated tokens and cost on timeline leaders", () => {
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
                        estimatedUsd: 0.17,
                        invoiceUsd: 0.15,
                        currency: "USD",
                    },
                },
            ],
        });
    });

});
