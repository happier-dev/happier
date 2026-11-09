import { describe, expect, it } from "vitest";
import type { EffectiveSessionAccess } from "@/app/session/access/sessionAccess";
import { projectSessionAccessCapabilitiesV1, SessionMessagesPageV1Schema, SessionExternalShareableMessagesPageV1Schema, SessionInputAdmissionReceiptV1Schema } from "@happier-dev/protocol";
import { UpdateBodySchema } from "@happier-dev/protocol/updates";
import { buildSessionInputAdmissionReceipt, readStoredSessionInputAdmissionReceipt, isSameSessionInputAdmissionIssuer, projectSessionInputAdmissionReceipt } from "./sessionInputAdmission";
import { buildNewMessageUpdate, buildMessageUpdatedUpdate } from "@/app/events/eventPayloadBuilders";
import { serializePendingMaterializedMessage } from '@/app/session/pending/serializePendingMaterializedMessage';

const access: EffectiveSessionAccess = {
    accountId: "owner", sessionId: "session", level: "owner", sources: [{ kind: "owner" }],
    audienceContext: null, relationshipKinds: [], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }),
};

describe("Session input admission constraints", () => {
    it.each(['authenticatedAccount', 'authenticatedMachine'] as const)('retains only explicit quiet review intent through the %s receipt and transport projection', issuer => {
        const inputAdmissionReceipt = buildSessionInputAdmissionReceipt({
            ...(issuer === 'authenticatedAccount' ? { issuer, access } : { issuer }),
            nextTurnNote: 'file_review_note.v1',
        });
        expect(inputAdmissionReceipt.nextTurnNote).toBe('file_review_note.v1');
        expect(projectSessionInputAdmissionReceipt(inputAdmissionReceipt)).toEqual({ inputAdmissionReceipt });
        const ordinary = buildSessionInputAdmissionReceipt(issuer === 'authenticatedAccount' ? { issuer, access } : { issuer });
        expect(isSameSessionInputAdmissionIssuer(inputAdmissionReceipt, ordinary)).toBe(false);
        const message = { id: 'note', seq: 1, localId: 'note', messageRole: 'user' as const,
            content: { t: 'encrypted' as const, c: 'opaque-note' }, createdAt: new Date(1), updatedAt: new Date(1), inputAdmissionReceipt };
        expect(serializePendingMaterializedMessage(message, { nativeAdmission: true })).toHaveProperty('inputAdmissionReceipt', inputAdmissionReceipt);
    });
    it.each(['authenticatedMachine', 'authenticatedAccount'] as const)('keeps private Follow proof inside %s admission custody, including native materialization', issuer => {
        const publicReceipt = { v: 1, issuer, ...(issuer === 'authenticatedAccount' ? { actorAccountId: 'owner', sessionRelationship: 'owner' } : {}) };
        const inputAdmissionReceipt = SessionInputAdmissionReceiptV1Schema.parse({ ...publicReceipt,
            followSources: [{ destinationSessionId: 'destination', sourceSessionId: 'source',
                selectedDelivery: 'wake',
                rule: { ruleId: 'private-rule', ruleVersion: 3 }, sourceMessage: { localId: 'original', seq: 1 },
                expectedSourcePublisherGeneration: '1', machineId: 'source-machine', installationId: 'source-installation' }] });
        const message = { id: 'message', seq: 1, localId: 'accepted', messageRole: 'user' as const,
            content: { t: 'encrypted' as const, c: 'opaque-receiver-content' },
            createdAt: new Date(1), updatedAt: new Date(1), inputAdmissionReceipt };
        expect(projectSessionInputAdmissionReceipt(inputAdmissionReceipt)).toEqual({ inputAdmissionReceipt: publicReceipt });
        for (const build of [buildNewMessageUpdate, buildMessageUpdatedUpdate]) {
            expect(build(message, 'destination', 1, 'update').body).toMatchObject({ message: {
                inputAdmissionReceipt: publicReceipt,
            } });
            expect(JSON.stringify(build(message, 'destination', 1, 'update'))).not.toContain('private-rule');
        }
        expect(serializePendingMaterializedMessage(message)).toHaveProperty('inputAdmissionReceipt', publicReceipt);
        expect(serializePendingMaterializedMessage(message, { nativeAdmission: true })).toHaveProperty('inputAdmissionReceipt', publicReceipt);
        expect(JSON.stringify(serializePendingMaterializedMessage(message, { nativeAdmission: true }))).not.toContain('private-rule');
    });
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
    it.each(['authenticatedAccount', 'authenticatedMachine'] as const)('projects retained %s attribution without re-admitting obsolete private Follow proof', issuer => {
        const target = { homeId: 'home', accountId: 'owner', sessionId: 'destination', machineId: 'machine', installationId: 'installation' };
        const publicReceipt = { v: 1, issuer, admittedTarget: target,
            ...(issuer === 'authenticatedAccount' ? { actorAccountId: 'owner', sessionRelationship: 'owner' } : {}) };
        // Retained 2026-10-21 receipt shape: selectedDelivery became required in
        // 035e023dab1, after these server-private receiver witnesses were stored.
        const retainedReceipt = { ...publicReceipt, followSources: [{
            sourceSessionId: 'source', destinationSessionId: 'destination', evaluation: 'receiver',
            rule: { ruleId: 'private-rule', ruleVersion: 3 }, sourceMessage: { localId: 'original', seq: 1 },
        }] };
        expect(SessionInputAdmissionReceiptV1Schema.safeParse(retainedReceipt).success).toBe(false);
        expect(readStoredSessionInputAdmissionReceipt(retainedReceipt)).toBeUndefined();
        expect(projectSessionInputAdmissionReceipt(retainedReceipt)).toEqual({ inputAdmissionReceipt: publicReceipt });
        const message = { id: 'message', seq: 1, localId: 'accepted', messageRole: 'user' as const,
            content: { t: 'encrypted' as const, c: 'opaque-content' }, createdAt: new Date(1), updatedAt: new Date(1),
            inputAdmissionReceipt: retainedReceipt };
        for (const build of [buildNewMessageUpdate, buildMessageUpdatedUpdate]) {
            expect(build(message, 'destination', 1, 'update').body).toMatchObject({ message: {
                inputAdmissionReceipt: publicReceipt,
            } });
        }
        expect(() => projectSessionInputAdmissionReceipt({ ...retainedReceipt,
            admittedTarget: { ...target, installationId: 42 } })).toThrow();
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
    it.each([undefined, 'finished', 'failed_or_stopped'] as const)("carries the trusted receipt through direct and updated message fanout (%s)", kind => {
        const inputAdmissionReceipt = { v: 1 as const, issuer: "authenticatedAccount" as const,
            actorAccountId: "owner", sessionRelationship: "owner" as const,
            ...(kind ? { followDeliveryV1: { v: 1 as const, delivery: 'wake' as const,
                original: { sourceSessionId: 'source', sourceMessage: { localId: 'terminal', seq: 7 } }, event: { kind } } } : {}) };
        const message = {
            id: "message", seq: 1, localId: "local", messageRole: "user" as const,
            content: { t: "encrypted" as const, c: "opaque" }, createdAt: new Date(1), updatedAt: new Date(1),
            inputAdmissionReceipt,
        };
        for (const build of [buildNewMessageUpdate, buildMessageUpdatedUpdate]) {
            const body = UpdateBodySchema.parse(build(message, "session", 1, "update").body);
            expect(body).toMatchObject({ message: { inputAdmissionReceipt } });
        }
        expect(serializePendingMaterializedMessage(message)).toHaveProperty('inputAdmissionReceipt', inputAdmissionReceipt);
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
