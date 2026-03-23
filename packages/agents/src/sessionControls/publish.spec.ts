import { describe, expect, it } from "vitest";

import { computeMonotonicUpdatedAt } from "./monotonic.js";
import { computeNextMetadataConfigOptionOverrideV1, computeNextMetadataStringOverrideV1, computeNextPermissionIntentMetadata } from "./publish.js";

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
});
