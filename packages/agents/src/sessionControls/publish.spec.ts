import { describe, expect, it } from "vitest";

import { computeMonotonicUpdatedAt } from "./monotonic.js";
import { computeNextMetadataConfigOptionOverrideV1, computeNextMetadataStringOverrideV1, computeNextModelOverrideMetadataV1, computeNextPermissionIntentMetadata } from "./publish.js";

describe("sessionControls monotonic", () => {
    it("applies newer updates with ignore_older", () => {
        const next = computeMonotonicUpdatedAt({
            previousUpdatedAt: 10,
            desiredUpdatedAt: 11,
            previousValue: "old",
            desiredValue: "new",
            policy: "ignore_older",
        });
        expect(next).toBe(11);
    });

    it("drops stale updates with ignore_older", () => {
        const next = computeMonotonicUpdatedAt({
            previousUpdatedAt: 10,
            desiredUpdatedAt: 9,
            previousValue: "old",
            desiredValue: "new",
            policy: "ignore_older",
        });
        expect(next).toBeNull();
    });

    it("bumps timestamp for changed values with force_update", () => {
        const next = computeMonotonicUpdatedAt({
            previousUpdatedAt: 10,
            desiredUpdatedAt: 9,
            previousValue: "old",
            desiredValue: "new",
            policy: "force_update",
        });
        expect(next).toBe(11);
    });

    it("skips force_update when value is unchanged", () => {
        const next = computeMonotonicUpdatedAt({
            previousUpdatedAt: 10,
            desiredUpdatedAt: 9,
            previousValue: "same",
            desiredValue: "same",
            policy: "force_update",
        });
        expect(next).toBeNull();
    });
});

describe("sessionControls publish metadata", () => {
    it("does not persist invalid permission mode tokens", () => {
        const metadata = { permissionMode: "acceptEdits", permissionModeUpdatedAt: 5 };
        const next = computeNextPermissionIntentMetadata({
            metadata,
            permissionMode: "definitely-invalid-token",
            permissionModeUpdatedAt: 99,
        });

        expect(next).toBe(metadata);
    });

    it("persists a canonical permission mode when token is valid", () => {
        const next = computeNextPermissionIntentMetadata({
            metadata: {},
            permissionMode: "default",
            permissionModeUpdatedAt: 42,
        });

        expect(next).toEqual({
            permissionMode: "default",
            permissionModeUpdatedAt: 42,
        });
    });

    it("writes a clear tombstone for string overrides", () => {
        const next = computeNextMetadataStringOverrideV1({
            metadata: {
                modelOverrideV1: {
                    v: 1,
                    updatedAt: 10,
                    modelId: "gpt-4",
                },
            },
            overrideKey: "modelOverrideV1",
            valueKey: "modelId",
            value: "   ",
            updatedAt: 20,
        });

        expect(next).toEqual({
            modelOverrideV1: {
                v: 1,
                updatedAt: 20,
                modelId: null,
            },
        });
    });

    it("uses monotonic bump when clearing with a stale timestamp", () => {
        const next = computeNextMetadataStringOverrideV1({
            metadata: {
                modelOverrideV1: {
                    v: 1,
                    updatedAt: 20,
                    modelId: "gpt-4",
                },
            },
            overrideKey: "modelOverrideV1",
            valueKey: "modelId",
            value: "",
            updatedAt: 1,
        });

        expect(next).toEqual({
            modelOverrideV1: {
                v: 1,
                updatedAt: 21,
                modelId: null,
            },
        });
    });

    it("dual-writes canonical and legacy session mode override keys", () => {
        const next = computeNextMetadataStringOverrideV1({
            metadata: {},
            overrideKey: "acpSessionModeOverrideV1",
            valueKey: "modeId",
            value: "plan",
            updatedAt: 20,
        });

        expect(next).toMatchObject({
            sessionModeOverrideV1: {
                v: 1,
                updatedAt: 20,
                modeId: "plan",
            },
            acpSessionModeOverrideV1: {
                v: 1,
                updatedAt: 20,
                modeId: "plan",
            },
        });
    });

    it("dual-writes canonical and legacy config option override keys", () => {
        const next = computeNextMetadataConfigOptionOverrideV1({
            metadata: {},
            configId: "telemetry",
            value: "true",
            updatedAt: 30,
        });

        expect(next).toMatchObject({
            sessionConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 30,
                overrides: {
                    telemetry: { updatedAt: 30, value: "true" },
                },
            },
            acpConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 30,
                overrides: {
                    telemetry: { updatedAt: 30, value: "true" },
                },
            },
        });
    });

    it("writes a nullable clear without deleting sibling config overrides", () => {
        const next = computeNextMetadataConfigOptionOverrideV1({
            metadata: {
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 30,
                    overrides: {
                        reasoning_effort: { updatedAt: 30, value: "high" },
                        telemetry: { updatedAt: 29, value: "true" },
                    },
                },
            },
            configId: "reasoning_effort",
            value: null,
            updatedAt: 31,
        });

        expect(next).toMatchObject({
            sessionConfigOptionOverridesV1: {
                updatedAt: 31,
                overrides: {
                    reasoning_effort: { updatedAt: 31, value: null },
                    telemetry: { updatedAt: 29, value: "true" },
                },
            },
        });
    });

    it.each([
        { value: "xhigh", expectedValue: "xhigh" },
        { value: null, expectedValue: null },
    ])("mutates the newest valid config alias and converges both aliases for $value", ({ value, expectedValue }) => {
        const next = computeNextMetadataConfigOptionOverrideV1({
            metadata: {
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 10,
                    overrides: {
                        reasoning_effort: { updatedAt: 10, value: "medium" },
                        canonical_only: { updatedAt: 9, value: "stale" },
                    },
                },
                acpConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 20,
                    overrides: {
                        reasoning_effort: { updatedAt: 20, value: "high" },
                        legacy_sibling: { updatedAt: 19, value: "preserve-me" },
                    },
                },
            },
            configId: "reasoning_effort",
            value,
            updatedAt: 21,
        });

        expect(next.sessionConfigOptionOverridesV1).toEqual(next.acpConfigOptionOverridesV1);
        expect(next.sessionConfigOptionOverridesV1).toMatchObject({
            updatedAt: 21,
            overrides: {
                reasoning_effort: { updatedAt: 21, value: expectedValue },
                legacy_sibling: { updatedAt: 19, value: "preserve-me" },
            },
        });
        expect((next.sessionConfigOptionOverridesV1 as { overrides: Record<string, unknown> }).overrides)
            .not.toHaveProperty("canonical_only");
    });

    it("publishes a model command and clears only prior-model option commands atomically", () => {
        const next = computeNextModelOverrideMetadataV1({
            metadata: {
                sessionModelsV1: {
                    v: 1,
                    provider: "grok",
                    updatedAt: 9,
                    currentModelId: "model-a",
                    availableModels: [
                        { id: "model-a", name: "Model A", modelOptions: [{ id: "reasoning_effort", name: "Thinking", type: "select", currentValue: "high" }] },
                        { id: "model-b", name: "Model B" },
                    ],
                },
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 10,
                    overrides: {
                        reasoning_effort: { updatedAt: 10, value: "high" },
                        telemetry: { updatedAt: 9, value: "true" },
                    },
                },
            },
            modelId: "model-b",
            updatedAt: 10,
            retireModelScopedConfigOverrides: true,
        });

        expect(next.modelOverrideV1).toEqual({ v: 1, updatedAt: 10, modelId: "model-b" });
        expect(next.sessionConfigOptionOverridesV1).toMatchObject({
            overrides: {
                reasoning_effort: { updatedAt: 11, value: null },
                telemetry: { updatedAt: 9, value: "true" },
            },
        });
    });

    it("preserves a strictly newer prior-model option command during a model change", () => {
        const next = computeNextModelOverrideMetadataV1({
            metadata: {
                sessionModelsV1: {
                    v: 1,
                    provider: "grok",
                    updatedAt: 9,
                    currentModelId: "model-a",
                    availableModels: [{ id: "model-a", name: "Model A", modelOptions: [{ id: "reasoning_effort", name: "Thinking", type: "select", currentValue: "high" }] }],
                },
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 12,
                    overrides: { reasoning_effort: { updatedAt: 12, value: "high" } },
                },
            },
            modelId: "model-b",
            updatedAt: 10,
            retireModelScopedConfigOverrides: true,
        });

        expect(next.sessionConfigOptionOverridesV1).toMatchObject({
            overrides: { reasoning_effort: { updatedAt: 12, value: "high" } },
        });
    });

    it("retires prior-model config against the actual emitted monotonic model timestamp", () => {
        const next = computeNextModelOverrideMetadataV1({
            metadata: {
                modelOverrideV1: { v: 1, updatedAt: 20, modelId: "model-a" },
                sessionModelsV1: {
                    v: 1,
                    provider: "grok",
                    updatedAt: 20,
                    currentModelId: "model-a",
                    availableModels: [{ id: "model-a", name: "Model A", modelOptions: [{ id: "reasoning_effort", name: "Thinking", type: "select", currentValue: "high" }] }],
                },
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 20,
                    overrides: { reasoning_effort: { updatedAt: 20, value: "high" } },
                },
            },
            modelId: "model-b",
            updatedAt: 10,
            retireModelScopedConfigOverrides: true,
        });

        expect(next.modelOverrideV1).toEqual({ v: 1, updatedAt: 21, modelId: "model-b" });
        expect(next.sessionConfigOptionOverridesV1).toMatchObject({
            overrides: { reasoning_effort: { updatedAt: 22, value: null } },
        });
    });

    it("fails closed when tombstone retirement support is absent", () => {
        const metadata = {
            sessionModelsV1: {
                v: 1,
                provider: "grok",
                updatedAt: 5,
                currentModelId: "model-a",
                availableModels: [{ id: "model-a", name: "Model A", modelOptions: [{ id: "reasoning_effort", name: "Thinking", type: "select", currentValue: "high" }] }],
            },
            sessionConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 10,
                overrides: { reasoning_effort: { updatedAt: 10, value: "high" } },
            },
        };
        const next = computeNextModelOverrideMetadataV1({
            metadata,
            modelId: "model-b",
            updatedAt: 10,
            retireModelScopedConfigOverrides: false,
        });
        expect(next.sessionConfigOptionOverridesV1).toBe(metadata.sessionConfigOptionOverridesV1);
    });

    it("retires prior-model config from an older valid legacy model alias when canonical is newer but malformed", () => {
        const next = computeNextModelOverrideMetadataV1({
            metadata: {
                sessionModelsV1: {
                    v: 1,
                    provider: "grok",
                    updatedAt: 30,
                    currentModelId: "model-a",
                    availableModels: "malformed",
                },
                acpSessionModelsV1: {
                    v: 1,
                    provider: "grok",
                    updatedAt: 20,
                    currentModelId: "model-a",
                    availableModels: [{
                        id: "model-a",
                        name: "Model A",
                        modelOptions: [{ id: "reasoning_effort", name: "Thinking", type: "select", currentValue: "high" }],
                    }],
                },
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 20,
                    overrides: { reasoning_effort: { updatedAt: 20, value: "high" } },
                },
            },
            modelId: "model-b",
            updatedAt: 20,
            retireModelScopedConfigOverrides: true,
        });

        expect(next.sessionConfigOptionOverridesV1).toMatchObject({
            overrides: { reasoning_effort: { updatedAt: 21, value: null } },
        });
    });

    it("retires prior-model config from an older valid legacy alias when newer canonical modelOptions is malformed", () => {
        const validReasoningOption = {
            id: "reasoning_effort",
            name: "Thinking",
            type: "select",
            currentValue: "high",
            options: [{ value: "high", name: "High" }],
        };
        const next = computeNextModelOverrideMetadataV1({
            metadata: {
                sessionModelsV1: {
                    v: 1,
                    provider: "grok",
                    updatedAt: 30,
                    currentModelId: "model-a",
                    availableModels: [{ id: "model-a", name: "Model A", modelOptions: "malformed" }],
                },
                acpSessionModelsV1: {
                    v: 1,
                    provider: "grok",
                    updatedAt: 20,
                    currentModelId: "model-a",
                    availableModels: [{ id: "model-a", name: "Model A", modelOptions: [validReasoningOption] }],
                },
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 20,
                    overrides: { reasoning_effort: { updatedAt: 20, value: "high" } },
                },
            },
            modelId: "model-b",
            updatedAt: 20,
            retireModelScopedConfigOverrides: true,
        });

        expect(next.sessionConfigOptionOverridesV1).toMatchObject({
            overrides: { reasoning_effort: { updatedAt: 21, value: null } },
        });
    });
});
