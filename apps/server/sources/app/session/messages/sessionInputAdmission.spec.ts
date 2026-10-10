import { describe, expect, it } from "vitest";
import type { EffectiveSessionAccess } from "@/app/session/access/sessionAccess";
import { projectSessionAccessCapabilitiesV1, SessionMessagesPageV1Schema, SessionExternalShareableMessagesPageV1Schema } from "@happier-dev/protocol";
import { UpdateBodySchema } from "@happier-dev/protocol/updates";
import { buildSessionInputAdmissionReceipt, readStoredSessionInputAdmissionReceipt, isSameSessionInputAdmissionIssuer } from "./sessionInputAdmission";
import { buildNewMessageUpdate, buildMessageUpdatedUpdate } from "@/app/events/eventPayloadBuilders";

const access: EffectiveSessionAccess = {
    accountId: "owner", sessionId: "session", level: "owner", sources: [{ kind: "owner" }],
    audienceContext: null, relationshipKinds: [], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }),
};

describe("Session input admission constraints", () => {
    it("drops future stored receipt fields but never accepts invalid or retargeted known placement", () => {
        const target = { homeId: 'home', accountId: 'owner', sessionId: 'session', machineId: 'machine', installationId: 'installation' };
        const receipt = { v: 1 as const, issuer: 'authenticatedAccount' as const, actorAccountId: 'owner',
            sessionRelationship: 'owner' as const, admittedTarget: target };
        expect(readStoredSessionInputAdmissionReceipt({ ...receipt, futureIssuerField: true,
            admittedTarget: { ...target, futureTargetField: true } })).toEqual(receipt);
        expect(readStoredSessionInputAdmissionReceipt({ ...receipt, admittedTarget: { ...target, installationId: 42 } })).toBeUndefined();
        expect(isSameSessionInputAdmissionIssuer(receipt, { ...receipt, admittedTarget: { ...target, machineId: 'other' } })).toBe(false);
        expect(isSameSessionInputAdmissionIssuer(receipt, { ...receipt, admittedTarget: undefined })).toBe(false);
    });
    it("validates the receipt on authenticated message wire shapes and omits it from public pages", () => {
        const inputAdmissionReceipt = { v: 1 as const, issuer: "authenticatedAccount" as const,
            actorAccountId: "owner", sessionRelationship: "owner" as const };
        const message = { id: "message", seq: 1, localId: "local", messageRole: "user" as const,
            content: { t: "encrypted" as const, c: "opaque" }, createdAt: 1, updatedAt: 1, inputAdmissionReceipt };
        expect(SessionMessagesPageV1Schema.parse({ messages: [message] }).messages[0])
            .toHaveProperty("inputAdmissionReceipt", inputAdmissionReceipt);
        expect(SessionExternalShareableMessagesPageV1Schema.parse({ messages: [message] }).messages[0])
            .not.toHaveProperty("inputAdmissionReceipt");
        for (const t of ["new-message", "message-updated"] as const) {
            expect(UpdateBodySchema.safeParse({ t, sid: "session", message: {
                ...message, inputAdmissionReceipt: { ...inputAdmissionReceipt, permissionOverride: "bypassPermissions" },
            } }).success).toBe(false);
        }
    });
    it("carries the trusted receipt through direct and updated message fanout", () => {
        const inputAdmissionReceipt = { v: 1 as const, issuer: "authenticatedAccount" as const,
            actorAccountId: "owner", sessionRelationship: "owner" as const };
        const message = {
            id: "message", seq: 1, localId: "local", messageRole: "user" as const,
            content: { t: "encrypted", c: "opaque" }, createdAt: new Date(1), updatedAt: new Date(1),
            inputAdmissionReceipt,
        };
        for (const build of [buildNewMessageUpdate, buildMessageUpdatedUpdate]) {
            expect(build(message, "session", 1, "update").body).toMatchObject({ message: { inputAdmissionReceipt } });
        }
    });
    it("persists the verified model and permission-mode constraints with each Account input", () => {
        const input = {
            issuer: "authenticatedAccount" as const, access,
            callerInputConstraints: { models: null, permissionModes: ["default" as const] },
        };
        expect(buildSessionInputAdmissionReceipt(input)).toMatchObject({
            actorAccountId: "owner", callerInputConstraints: input.callerInputConstraints,
        });
        expect(buildSessionInputAdmissionReceipt({ issuer: "authenticatedAccount", access }))
            .not.toHaveProperty("callerInputConstraints");
    });
    it("persists immutable verified invocation constraints with protected machine input", () => {
        const callerInputConstraints = { models: null, permissionModes: ["default" as const] };
        expect(buildSessionInputAdmissionReceipt({ issuer: "authenticatedMachine", callerInputConstraints }))
            .toEqual({ v: 1, issuer: "authenticatedMachine", callerInputConstraints });
        expect(buildSessionInputAdmissionReceipt({ issuer: "authenticatedMachine" }))
            .not.toHaveProperty("callerInputConstraints");
    });
});
