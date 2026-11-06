import { describe, expect, it, vi } from "vitest";
import { UpdateContainerSchema } from "@happier-dev/protocol/updates";
import { sealSessionOwnerDisplayEnvelopeV1 } from '@happier-dev/protocol';
import { createPlainSessionOwnerMetadataEnvelopeV1, encodeSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { publishSessionCurrentViewUpdates } from '@/app/session/metadata/publishSessionCurrentViewUpdates';
import {
    buildDeleteSessionUpdate,
    buildNewMachineUpdate,
    buildNewMessageUpdate,
    buildPendingResolvedMessageUpdate,
    buildNewSessionUpdate,
    buildPublicShareCreatedUpdate,
    buildPublicShareDeletedUpdate,
    buildPublicShareUpdatedUpdate,
    buildPendingChangedUpdate,
    buildSessionMetadataRecipientUpdate,
    buildUpdateSessionUpdate,
    buildSessionSharedUpdate,
    buildSessionShareRevokedUpdate,
    buildSessionShareUpdatedUpdate,
    buildUpdateAccountUpdate,
    eventRouter,
} from "./eventRouter";

describe("eventRouter payloads (protocol container)", () => {
    it('publishes accepted Project identity beside the existing owner and participant metadata tuples', async () => {
        // Observe transport output without replacing the router or its internal recipient projection.
        const emitted = vi.spyOn(eventRouter, 'emitUpdate');
        const source = {
            kind: 'envelope_tuple_v1' as const, sessionOwnerId: 'project-owner', ownerAccountMode: 'plain' as const,
            projectKey: 'accepted-project',
            sharedMetadata: { version: 1, value: '{"v":1}' },
            ownerMetadata: { value: encodeSessionOwnerMetadataEnvelopeV1(createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 })) },
            agentState: { version: 1, value: '{}' },
        };
        try {
            expect(await publishSessionCurrentViewUpdates({ sessionId: 'project-session', source,
                recipientCursors: [{ accountId: 'project-owner', cursor: 1 }, { accountId: 'project-viewer', cursor: 2 }],
            })).toEqual({ ok: true });
            for (const accountId of ['project-owner', 'project-viewer']) {
                const packet = emitted.mock.calls.find(([input]) => input.userId === accountId)?.[0].payload;
                expect(UpdateContainerSchema.parse(packet).body).toMatchObject({
                    t: 'update-session', id: 'project-session', projectKey: 'accepted-project',
                });
            }
            const viewer = emitted.mock.calls.find(([input]) => input.userId === 'project-viewer')?.[0].payload;
            expect(UpdateContainerSchema.parse(viewer).body).not.toHaveProperty('ownerMetadata');
            emitted.mockClear();
            const { projectKey: _projectKey, ...ordinaryMetadataSource } = source;
            expect(await publishSessionCurrentViewUpdates({ sessionId: 'project-session', source: ordinaryMetadataSource,
                recipientCursors: [{ accountId: 'project-owner', cursor: 3 }, { accountId: 'project-viewer', cursor: 4 }],
            })).toEqual({ ok: true });
            for (const [input] of emitted.mock.calls) {
                expect(UpdateContainerSchema.parse(input.payload).body).not.toHaveProperty('projectKey');
            }
        } finally { emitted.mockRestore(); }
    });
    it("validates Account encryption facts and explicit invalidation through the update consumer", () => {
        const currentness = {
            mode: "plain" as const, version: 7, settingsVersion: 11,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 100,
            recipientEnvelopeReadiness: { status: "unavailable" as const, reason: "plain_account" as const },
        };
        const update = buildUpdateAccountUpdate("account-1", {}, 7, "encryption-update", currentness);
        expect(UpdateContainerSchema.parse(update).body).toMatchObject({ encryptionCurrentness: currentness });
        expect(UpdateContainerSchema.parse(buildUpdateAccountUpdate("account-1", {}, 7, "invalidation", null)).body)
            .toMatchObject({ encryptionCurrentness: null });
        expect(UpdateContainerSchema.safeParse({
            ...update,
            body: { ...update.body, encryptionCurrentness: { ...currentness, contentPublicKey: "private-binding" } },
        }).success).toBe(false);
    });

    it("preserves the ready transcript local identity in the live projection", () => {
        const projection = {
            latestReadyEventSeq: 47,
            latestReadyEventAt: 200,
            latestReadyEventLocalId: "ready-local-id",
        };
        const payload = buildUpdateSessionUpdate("s1", 101, "ready-update", undefined, undefined, projection);

        expect(UpdateContainerSchema.parse(payload).body).toMatchObject(projection);
    });

    it("buildNewMessageUpdate emits a full container", () => {
        const payload = buildNewMessageUpdate(
            {
                id: "m1",
                seq: 1,
                localId: "l1",
                sidechainId: null,
                messageRole: "user",
                content: { t: "encrypted", c: "abc" },
                deliveryResolution: { v: 1, kind: "manual_handled" },
                createdAt: new Date(1),
                updatedAt: new Date(1),
            },
            "s1",
            101,
            "upd-1",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).sid).toBe("s1");
        expect((payload.body as any).id).toBe("s1");
        expect((payload.body as any).message.messageRole).toBe("user");
        expect((payload.body as any).message.deliveryResolution).toEqual({ v: 1, kind: "manual_handled" });
        expect(Object.prototype.hasOwnProperty.call((payload.body as any).message ?? {}, "sidechainId")).toBe(false);
    });

    it("buildPendingResolvedMessageUpdate always projects explicit user attention", () => {
        const message = {
            id: "m-pending",
            seq: 7,
            localId: "pending-user-message",
            sidechainId: null,
            messageRole: "user" as const,
            content: {
                t: "plain" as const,
                v: {
                    role: "agent" as const,
                    content: {
                        type: "event" as const,
                        id: "quota-wait-event",
                        data: {
                            type: "provider-quota-wait" as const,
                            serviceId: "openai-codex",
                            groupId: "main",
                            resetAtMs: 1_900_000,
                            reason: "connected_service_group_quota_exhausted" as const,
                        },
                    },
                },
            },
            createdAt: new Date(1),
            updatedAt: new Date(2),
        };

        for (const eventKind of ["new-message", "message-updated"] as const) {
            const payload = buildPendingResolvedMessageUpdate(
                message,
                "s1",
                101,
                `upd-${eventKind}`,
                eventKind,
            );

            expect(payload.body).toMatchObject({
                t: eventKind,
                message: {
                    attentionImpact: {
                        affectsUnread: true,
                        affectsMeaningfulActivity: true,
                    },
                },
            });
        }
    });

    it("buildNewSessionUpdate emits a full container", () => {
        const payload = buildNewSessionUpdate(
            {
                id: "s1",
                seq: 1,
                metadata: "enc-meta",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                // Already Base64-projected from the canonical `(Session, Account)`
                // tuple, which is what the builder and the wire schema require;
                // raw column bytes are not a `new-session` payload.
                dataEncryptionKey: "AQID",
                encryptionMode: "e2ee",
                active: true,
                lastActiveAt: new Date(1),
                createdAt: new Date(1),
                updatedAt: new Date(1),
            },
            102,
            "upd-2",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).id).toBe("s1");
        expect((payload.body as any).sid).toBe("s1");
        expect((payload.body as any).encryptionMode).toBe("e2ee");
    });

    it("buildNewSessionUpdate carries the Session's storage state (an imported external session is machine_only)", () => {
        const payload = buildNewSessionUpdate(
            {
                id: "s_import",
                seq: 0,
                metadata: "enc-meta",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                dataEncryptionKey: "AQID",
                encryptionMode: "e2ee",
                active: true,
                lastActiveAt: new Date(1),
                createdAt: new Date(1),
                updatedAt: new Date(1),
                currentStorageState: "machine_only",
            },
            103,
            "upd-3",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).currentStorageState).toBe("machine_only");
    });

    it("buildNewSessionUpdate emits explicit plaintext mode", () => {
        const payload = buildNewSessionUpdate(
            {
                id: "s_plain",
                seq: 1,
                metadata: JSON.stringify({ name: "Plain session" }),
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                dataEncryptionKey: null,
                encryptionMode: "plain",
                active: true,
                lastActiveAt: new Date(1),
                createdAt: new Date(1),
                updatedAt: new Date(1),
            },
            103,
            "upd-plain",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).encryptionMode).toBe("plain");
        expect((payload.body as any).dataEncryptionKey).toBeNull();
    });

    it("buildUpdateSessionUpdate emits a full container", () => {
        const payload = buildUpdateSessionUpdate(
            "s1",
            103,
            "upd-3",
            { value: "enc-meta", version: 2 },
            { value: null, version: 3 },
            {
                active: false,
                activeAt: 222,
                lastViewedSessionSeq: 7,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
                pendingRequestObservedAt: 1_111,
                latestReadyEventSeq: 8,
                latestReadyEventAt: 1_222,
                latestTurnId: "turn-1",
                archivedAt: 1234,
                latestTurnStatus: "failed",
                latestTurnStatusObservedAt: 2_222,
                rollbackEligibleTurnStarts: [3, 7],
                lastRuntimeIssue: {
                    v: 1,
                    scope: "primary_session",
                    status: "failed",
                    code: "agent_process_exit",
                    source: "agent_process_exit",
                    occurredAt: 10,
                    agentId: "pi",
                    sanitizedPreview: "Provider process exited",
                },
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: 3_333,
                runtimeActivityRevision: 4,
                meaningfulActivityAt: 5_555,
            },
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).id).toBe("s1");
        expect((payload.body as any).sid).toBe("s1");
        expect((payload.body as any).active).toBe(false);
        expect((payload.body as any).activeAt).toBe(222);
        expect((payload.body as any).lastViewedSessionSeq).toBe(7);
        expect((payload.body as any).pendingPermissionRequestCount).toBe(2);
        expect((payload.body as any).pendingUserActionRequestCount).toBe(1);
        expect((payload.body as any).pendingRequestObservedAt).toBe(1_111);
        expect((payload.body as any).latestReadyEventSeq).toBe(8);
        expect((payload.body as any).latestReadyEventAt).toBe(1_222);
        expect((payload.body as any).archivedAt).toBe(1234);
        expect((payload.body as any).latestTurnId).toBe("turn-1");
        expect((payload.body as any).latestTurnStatus).toBe("failed");
        expect((payload.body as any).latestTurnStatusObservedAt).toBe(2_222);
        expect((payload.body as any).rollbackEligibleTurnStarts).toEqual([3, 7]);
        expect((payload.body as any).lastRuntimeIssue).toMatchObject({
            source: "agent_process_exit",
            agentId: "pi",
        });
        expect((payload.body as any).runtimeActivityState).toBe("active");
        expect((payload.body as any).runtimeActivityActiveCount).toBe(1);
        expect((payload.body as any).runtimeActivityObservedAt).toBe(3_333);
        expect((payload.body as any).runtimeActivityRevision).toBe(4);
        expect(payload.body).not.toHaveProperty("runtimeActivitySourceClass");
        expect((payload.body as any).meaningfulActivityAt).toBe(5_555);
    });

    it("buildSessionMetadataRecipientUpdate serializes only the strict recipient tuple", () => {
        const ownerDisplay = sealSessionOwnerDisplayEnvelopeV1({
            accountMode: 'e2ee', display: { v: 1, name: 'Display-only private name' },
            material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) },
            randomBytes: length => new Uint8Array(length).fill(4),
        });
        if (!ownerDisplay.ok || ownerDisplay.envelope.t !== 'encrypted') throw new Error('Canonical owner-display sealing failed');
        const displayProjectionV1 = { v: 1 as const, sourceMetadataVersion: 5, metadataLayoutVersion: 1 as const,
            shared: { t: 'encrypted' as const, c: 'opaque-shared-display' }, owner: ownerDisplay.envelope };
        const ownerPayload = buildSessionMetadataRecipientUpdate(
            "s1",
            104,
            "upd-owner",
            {
                metadata: "shared-safe",
                metadataVersion: 5,
                metadataLayoutVersion: 1,
                displayProjectionV1,
                ownerMetadata: {
                    t: "encrypted",
                    c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==",
                },
                agentState: "owner-state",
                agentStateVersion: 9,
            },
        );
        const sharedPayload = buildSessionMetadataRecipientUpdate(
            "s1",
            105,
            "upd-shared",
            {
                metadata: "shared-safe",
                metadataVersion: 5,
                metadataLayoutVersion: 1,
                agentState: null,
                agentStateVersion: 9,
            },
        );

        expect(UpdateContainerSchema.safeParse(ownerPayload).success).toBe(true);
        expect(ownerPayload.body).toMatchObject({
            metadata: { value: "shared-safe", version: 5 },
            metadataLayoutVersion: 1,
            ownerMetadata: {
                value: {
                    t: "encrypted",
                    c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==",
                },
            },
            agentState: { value: "owner-state", version: 9 },
        });
        expect(sharedPayload.body).toMatchObject({
            metadata: { value: "shared-safe", version: 5 },
            metadataLayoutVersion: 1,
            agentState: { value: null, version: 9 },
        });
        expect(sharedPayload.body).not.toHaveProperty("ownerMetadata");
        // Socket consumers already receive these full admitted documents. The
        // cold-read sidecar is intentionally not another Socket egress surface.
        expect(ownerPayload.body).not.toHaveProperty('displayProjectionV1');
        expect(sharedPayload.body).not.toHaveProperty('displayProjectionV1');
        expect(JSON.stringify(ownerPayload)).not.toContain(ownerDisplay.envelope.c);
    });

    it("buildSessionMetadataRecipientUpdate rejects a partial owner projection", () => {
        expect(() => buildSessionMetadataRecipientUpdate(
            "s1",
            106,
            "upd-invalid-owner",
            // @ts-expect-error Missing Agent state is the malformed contract.
            {
                metadata: "shared-safe",
                metadataVersion: 5,
                metadataLayoutVersion: 1,
                ownerMetadata: {
                    t: "encrypted",
                    c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==",
                },
            },
        )).toThrow();
    });

    it("buildUpdateSessionUpdate rejects a partial runtime activity projection", () => {
        expect(() => buildUpdateSessionUpdate(
            "s1",
            103,
            "upd-partial-runtime",
            undefined,
            undefined,
            {
                runtimeActivityState: "active",
                runtimeActivityRevision: 4,
            },
        )).toThrow(/runtime activity projection/i);
    });

    it("buildPendingChangedUpdate emits exact meaningful activity when supplied", () => {
        const pendingChange = {
            sessionId: "s1",
            pendingVersion: 2,
            pendingCount: 1,
            changedByAccountId: "u1",
            recipient: { kind: "execution_run" as const, runId: "run-1" },
            meaningfulActivityAt: new Date(1_234),
            pendingActivationRequestId: "pending-local-1",
            pendingActivationAuthorization: {
                requestId: "pending-local-1",
                requestedAt: 1_000,
                status: "waiting" as const,
            },
        };
        const payload = buildPendingChangedUpdate(
            pendingChange,
            104,
            "upd-4",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).sessionId).toBe("s1");
        expect((payload.body as any).sid).toBe("s1");
        expect((payload.body as any).meaningfulActivityAt).toBe(1_234);
        expect((payload.body as any).recipient).toEqual({ kind: "execution_run", runId: "run-1" });
        expect((payload.body as any).pendingActivationRequestId).toBe("pending-local-1");
        expect((payload.body as any).pendingActivationAuthorization).toEqual({
            requestId: "pending-local-1",
            requestedAt: 1_000,
            status: "waiting",
        });
    });

    it("buildPendingChangedUpdate preserves an explicit null activation authorization", () => {
        const payload = buildPendingChangedUpdate({
            sessionId: "s1",
            pendingVersion: 3,
            pendingCount: 0,
            pendingActivationAuthorization: null,
        }, 105, "upd-5");

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).pendingActivationAuthorization).toBeNull();
    });

    it("buildDeleteSessionUpdate emits a full container", () => {
        const payload = buildDeleteSessionUpdate("s1", 104, "upd-4");
        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect((payload.body as any).sid).toBe("s1");
        expect((payload.body as any).id).toBe("s1");
    });

    it("buildNewMachineUpdate emits a full container", () => {
        const payload = buildNewMachineUpdate(
            {
                id: "m1",
                managedResource: null,
                seq: 1,
                metadata: "enc-meta",
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 1,
                dataEncryptionKey: null,
                installationId: "install-1",
                installationPublicKey: new Uint8Array([1, 2, 3]),
                contentPublicKeyFingerprint: "content-public-key-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                replacedByMachineId: "m-current",
                replacedAt: new Date(2),
                replacementReason: "reauth",
                replacementSource: "automatic",
                replacementActorUserId: null,
                active: true,
                lastActiveAt: new Date(1),
                revokedAt: null,
                createdAt: new Date(1),
                updatedAt: new Date(1),
            },
            105,
            "upd-5",
        );

        expect(UpdateContainerSchema.safeParse(payload).success).toBe(true);
        expect(payload.body).toEqual(expect.objectContaining({
            installationId: "install-1",
            installationPublicKey: Buffer.from([1, 2, 3]).toString("base64"),
            contentPublicKeyFingerprint: "content-public-key-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            replacedByMachineId: "m-current",
            replacedAt: new Date(2).getTime(),
            replacementReason: "reauth",
            replacementSource: "automatic",
            replacementActorUserId: null,
            revokedAt: null,
        }));
    });

    it("sharing updates include sessionId + sid for compatibility", () => {
        const shared = buildSessionSharedUpdate(
            {
                id: "shr-1",
                sessionId: "s1",
                sharedByUser: { id: "u1", firstName: null, lastName: null, username: "x", avatar: null },
                accessLevel: "view",
                canApprovePermissions: false,
                createdAt: new Date(1),
            },
            106,
            "upd-6",
        );
        const updated = buildSessionShareUpdatedUpdate("shr-1", "s1", "edit", true, new Date(2), 107, "upd-7");
        const revoked = buildSessionShareRevokedUpdate("shr-1", "s1", 108, "upd-8");

        expect(UpdateContainerSchema.safeParse(shared).success).toBe(true);
        expect(UpdateContainerSchema.safeParse(updated).success).toBe(true);
        expect(UpdateContainerSchema.safeParse(revoked).success).toBe(true);
        expect((shared.body as any).sessionId).toBe("s1");
        expect((shared.body as any).sid).toBe("s1");
        expect((shared.body as any).canApprovePermissions).toBe(false);
        expect((updated.body as any).sessionId).toBe("s1");
        expect((updated.body as any).canApprovePermissions).toBe(true);
        expect((updated.body as any).sid).toBe("s1");
        expect((revoked.body as any).sessionId).toBe("s1");
        expect((revoked.body as any).sid).toBe("s1");
    });

    it("public share updates include sessionId + sid for compatibility", () => {
        const created = buildPublicShareCreatedUpdate(
            {
                id: "ps-1",
                sessionId: "s1",
                token: "tok",
                expiresAt: null,
                maxUses: null,
                isConsentRequired: false,
                createdAt: new Date(1),
            },
            109,
            "upd-9",
        );
        const updated = buildPublicShareUpdatedUpdate(
            {
                id: "ps-1",
                sessionId: "s1",
                expiresAt: null,
                maxUses: 1,
                isConsentRequired: true,
                updatedAt: new Date(2),
            },
            110,
            "upd-10",
        );
        const deleted = buildPublicShareDeletedUpdate("s1", 111, "upd-11");

        expect(UpdateContainerSchema.safeParse(created).success).toBe(true);
        expect(UpdateContainerSchema.safeParse(updated).success).toBe(true);
        expect(UpdateContainerSchema.safeParse(deleted).success).toBe(true);
        expect((created.body as any).sessionId).toBe("s1");
        expect((created.body as any).sid).toBe("s1");
        expect((updated.body as any).sessionId).toBe("s1");
        expect((updated.body as any).sid).toBe("s1");
        expect((deleted.body as any).sessionId).toBe("s1");
        expect((deleted.body as any).sid).toBe("s1");
    });
});
