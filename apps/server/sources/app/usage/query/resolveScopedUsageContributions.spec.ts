import { describe, expect, it } from "vitest";

import { createEmptyUsageCost, createEmptyUsageTokens } from "../usageMetrics";
import { resolveScopedUsageContributions, type ScopedUsageEventRow } from "./resolveScopedUsageContributions";
import { resolveEffectiveUsageCostUsd } from "./resolveUsageCostMode";

function row(id: string, time: number, scope: string, total: number): ScopedUsageEventRow {
    return {
        id, sessionId: "session", agentId: "claude", source: "native",
        observedAt: new Date(time), createdAt: new Date(time), scope,
        isCumulative: scope !== "turn_delta", backendMode: null, modelId: null,
        projectKey: null, workspaceId: null, machineId: null, turnId: null,
        contextUsedTokens: null, contextWindowTokens: null,
        tokens: { ...createEmptyUsageTokens(), input: total, total },
        cost: { ...createEmptyUsageCost(), estimatedUsd: total / 100, costSource: "pricing_estimate" },
    };
}

describe("resolveScopedUsageContributions", () => {
    it("uses pre-range snapshots as baselines without making them period events", () => {
        const result = resolveScopedUsageContributions([
            row("baseline", 100, "session_cumulative", 100),
            row("selected", 200, "session_cumulative", 120),
        ], { startMs: 150, endMs: 250 });
        expect(result.totalContributions.map((event) => event.tokens.total)).toEqual([20]);
        expect(result.totalContributions.flatMap((event) => event.contributingEventIds)).toEqual(["selected"]);
        expect(result.bucketAttributions).toEqual(result.totalContributions);
    });

    it("keeps model and inference attribution and assigns only final residual to unknown model", () => {
        const result = resolveScopedUsageContributions([
            { ...row("a", 100, "turn_delta", 30), modelId: "A", turnId: "a" },
            { ...row("b", 200, "turn_delta", 40), modelId: "B", turnId: "b" },
            { ...row("final", 300, "session_final", 80), modelId: "B" },
        ]);
        expect(result.totalContributions.map((event) => [event.modelId, event.tokens.total])).toEqual([
            ["A", 30], ["B", 40], [null, 10],
        ]);
        expect(result.totalContributions.reduce((sum, event) => sum + event.tokens.total, 0)).toBe(80);
    });

    it("reconciles witnessed inference replay once, without deduping different inferences in one turn", () => {
        const subject = { kind: "native", machineId: "machine", agent: { pluginId: "happier.agent.claude", localId: "claude" }, sourceRootKey: "root", nativeSessionKey: "native" };
        const result = resolveScopedUsageContributions([
            { ...row("runtime", 100, "turn_delta", 30), source: "runtime", turnId: "turn", metadata: { accountingSubject: subject, usageAccounting: { inferenceId: "one", path: "runtime" } } },
            { ...row("native", 100, "turn_delta", 30), sessionId: null, source: "native", metadata: { accountingSubject: subject, usageAccounting: { inferenceId: "one", path: "native" } } },
            { ...row("second", 200, "turn_delta", 20), source: "runtime", turnId: "turn", metadata: { accountingSubject: subject, usageAccounting: { inferenceId: "two", path: "runtime" } } },
        ]);
        expect(result.totalContributions.reduce((sum, event) => sum + event.tokens.total, 0)).toBe(50);
        expect(result.totalContributions.map((event) => [event.id, event.sessionId])).toEqual([["runtime", "session"], ["second", "session"]]);
    });

    it("keeps different admitted roots, machines and unwitnessed inferences separate from Session replay", () => {
        const subject = { kind: "native", machineId: "machine", agent: { pluginId: "happier.agent.claude", localId: "claude" }, sourceRootKey: "root", nativeSessionKey: "native" };
        const runtime = { ...row("runtime", 100, "turn_delta", 30), source: "runtime", metadata: { accountingSubject: subject, usageAccounting: { inferenceId: "one", path: "runtime" } } };
        const native = { ...runtime, id: "native", sessionId: null, source: "native" };
        const result = resolveScopedUsageContributions([
            runtime,
            { ...native, metadata: { accountingSubject: subject, usageAccounting: { inferenceId: "one", path: "native" } } },
            { ...native, id: "other-root", metadata: { accountingSubject: { ...subject, sourceRootKey: "other-root" }, usageAccounting: { inferenceId: "one", path: "native" } } },
            { ...native, id: "other-machine", metadata: { accountingSubject: { ...subject, machineId: "other-machine" }, usageAccounting: { inferenceId: "one", path: "native" } } },
            { ...native, id: "other-inference", metadata: { accountingSubject: subject, usageAccounting: { inferenceId: "two", path: "native" } } },
            { ...native, id: "unwitnessed", metadata: { accountingSubject: subject, usageAccounting: { path: "native" } } },
        ]);
        expect(result.totalContributions.reduce((sum, event) => sum + event.tokens.total, 0)).toBe(150);
        expect(result.totalContributions.filter((event) => event.sessionId !== null).map((event) => event.id)).toEqual(["runtime"]);
    });

    it("preserves prior spend and exposes unexplained counter discontinuity", () => {
        const result = resolveScopedUsageContributions([
            row("before", 100, "session_cumulative", 100),
            row("reset", 200, "session_cumulative", 20),
        ]);
        expect(result.totalContributions.reduce((sum, event) => sum + event.tokens.total, 0)).toBe(120);
        expect(result.coverageReasons).toContain("counter_discontinuity");
    });

    it("does not merge unrelated subjects whose Session is absent", () => {
        const result = resolveScopedUsageContributions([
            { ...row("one", 100, "session_cumulative", 100), sessionId: null, metadata: { usageAccounting: { nativeSessionId: "one" } } },
            { ...row("two", 200, "session_cumulative", 20), sessionId: null, metadata: { usageAccounting: { nativeSessionId: "two" } } },
        ]);
        expect(result.totalContributions.reduce((sum, event) => sum + event.tokens.total, 0)).toBe(120);
    });

    it("reconciles the admitted native subject without merging distinct source roots", () => {
        const subject = { kind: "native", machineId: "machine", agent: { pluginId: "happier.agent.codex", localId: "codex" }, sourceRootKey: "root-one", nativeSessionKey: "native-one" };
        const result = resolveScopedUsageContributions([
            { ...row("one", 100, "session_cumulative", 100), sessionId: null, metadata: { accountingSubject: subject } },
            { ...row("one-next", 200, "session_cumulative", 120), sessionId: null, metadata: { accountingSubject: subject } },
            { ...row("different-root", 300, "session_cumulative", 50), sessionId: null, metadata: { accountingSubject: { ...subject, sourceRootKey: "root-two" } } },
        ]);
        expect(result.totalContributions.map((event) => event.tokens.total)).toEqual([100, 20, 50]);
        expect(result.totalContributions.reduce((sum, event) => sum + event.tokens.total, 0)).toBe(170);
    });

    it("counts deltas from a later interrupted turn after the latest final", () => {
        const result = resolveScopedUsageContributions([
            row("covered-delta", 1, "turn_delta", 5),
            row("old-final", 2, "session_final", 10),
            { ...row("covered-later-delta", 3, "turn_delta", 8), metadata: { usageAccounting: { inferenceId: "same" } } },
            row("latest-final", 4, "session_final", 20),
            row("interrupted-delta", 5, "turn_delta", 7),
            // A historical row delivered after the final still belongs before its coverage boundary.
            { ...row("late-replay", 3, "turn_delta", 8), createdAt: new Date(6), metadata: { usageAccounting: { inferenceId: "same" } } },
        ]);

        expect(result.totalContributions.reduce((sum, event) => sum + event.tokens.total, 0)).toBe(27);
        expect(result.bucketAttributions.reduce((sum, event) => sum + event.tokens.total, 0)).toBe(27);
        expect(result.totalContributions.reduce((sum, event) => sum + event.cost.estimatedUsd, 0)).toBeCloseTo(0.27);
        expect(result.bucketAttributions.reduce((sum, event) => sum + resolveEffectiveUsageCostUsd(event.cost, "auto"), 0)).toBeCloseTo(0.27);
        expect(result.totalContributions.map((event) => event.tokens.total)).toEqual([5, 5, 8, 2, 7]);
    });

    it("retains inference attribution and counts only snapshot residual", () => {
        const result = resolveScopedUsageContributions([
            row("delta", 1, "turn_delta", 5),
            row("older", 2, "session_cumulative", 10),
            row("latest", 3, "session_cumulative", 20),
        ]);

        expect(result.totalContributions.map((event) => event.tokens.total)).toEqual([5, 5, 10]);
        expect(result.bucketAttributions).toEqual(result.totalContributions);
    });
});
