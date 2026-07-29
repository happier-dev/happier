import { describe, expect, it } from "vitest";
import { ConnectedServiceAuthGroupErrorResponseV1Schema } from "@happier-dev/protocol";

import {
    ActiveProfileBodySchema,
    AuthGroupErrorResponseSchema,
    AuthGroupMemberInputSchema,
    DeleteAuthGroupMemberQuerySchema,
    RuntimeStatePatchBodySchema,
    UpdateAuthGroupMemberBodySchema,
    UpdateAuthGroupBodySchema,
} from "./authGroupSchemas";

describe("connected service auth group route schemas", () => {
    it("lets generation-sensitive omissions reach route handlers for typed error responses", () => {
        expect(AuthGroupMemberInputSchema.safeParse({
            profileId: "profile-a",
        }).success).toBe(true);

        expect(UpdateAuthGroupMemberBodySchema.safeParse({
            enabled: true,
        }).success).toBe(true);

        expect(DeleteAuthGroupMemberQuerySchema.safeParse({}).success).toBe(true);

        expect(ActiveProfileBodySchema.safeParse({
            profileId: "profile-a",
        }).success).toBe(true);

        expect(UpdateAuthGroupBodySchema.safeParse({
            activeProfileId: "profile-a",
        }).success).toBe(true);
        expect(UpdateAuthGroupBodySchema.safeParse({
            policy: { autoSwitch: false },
        }).success).toBe(true);
    });

    it("accepts expectedGeneration for generation-sensitive member, active-profile, and policy mutations", () => {
        expect(AuthGroupMemberInputSchema.safeParse({
            profileId: "profile-a",
            expectedGeneration: 1,
        }).success).toBe(true);

        expect(UpdateAuthGroupMemberBodySchema.safeParse({
            enabled: true,
            expectedGeneration: 1,
        }).success).toBe(true);

        expect(DeleteAuthGroupMemberQuerySchema.safeParse({
            expectedGeneration: "1",
        }).success).toBe(true);

        expect(ActiveProfileBodySchema.safeParse({
            profileId: "profile-a",
            expectedGeneration: 1,
            overrideRuntimeCooldown: true,
        }).success).toBe(true);

        expect(UpdateAuthGroupBodySchema.safeParse({
            activeProfileId: "profile-a",
            expectedGeneration: 1,
            overrideRuntimeCooldown: true,
        }).success).toBe(true);

        expect(UpdateAuthGroupBodySchema.safeParse({
            policy: { autoSwitch: false },
            expectedGeneration: 1,
        }).success).toBe(true);

        expect(UpdateAuthGroupBodySchema.safeParse({
            displayName: "Team fallback",
        }).success).toBe(true);
    });

    it("accepts the typed unsupported-runtime fallback error response", () => {
        expect(AuthGroupErrorResponseSchema.safeParse({
            error: "connect_group_runtime_fallback_unsupported",
        }).success).toBe(true);
    });

    it("consumes the protocol-owned error response contract", () => {
        expect(AuthGroupErrorResponseSchema).toBe(ConnectedServiceAuthGroupErrorResponseV1Schema);
        expect(AuthGroupErrorResponseSchema.safeParse({
            error: "made_up_error_code",
        }).success).toBe(false);
    });

    it("lets generationless runtime-state patches reach route handlers for change-aware enforcement", () => {
        expect(RuntimeStatePatchBodySchema.safeParse({
            memberStates: [{ profileId: "profile-a", state: { quotaExhaustedUntilMs: 10 } }],
        }).success).toBe(true);
        expect(RuntimeStatePatchBodySchema.safeParse({
            expectedGeneration: 2,
            expectedRuntimeStateRevision: 3,
            state: { status: "exhausted" },
            memberStates: [],
        }).success).toBe(true);
    });
});
