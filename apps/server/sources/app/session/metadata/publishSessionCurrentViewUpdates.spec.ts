import { describe, expect, it, vi } from "vitest";

import { eventRouter, type ClientConnection } from "@/app/events/eventRouter";
import { createFakeSocket } from "@/app/api/testkit/socketHarness";
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, buildAccountStoredContentCompatibilitySocketAuthV1 } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { publishSessionCurrentViewUpdates } from "./publishSessionCurrentViewUpdates";

describe("Session current-view publication", () => {
    it("keeps cursor recovery reachable when a committed tuple cannot be projected", async () => {
        // Only receiving transports are substituted; recovery audience and routing stay real.
        const recipients = ['owner', 'editor'].map(userId => {
            const socket = createFakeSocket({ id: userId, data: {} });
            writeAccountStoredContentCompatibilityForSocket(socket,
                evaluateAccountStoredContentSocketCompatibility(buildAccountStoredContentCompatibilitySocketAuthV1(
                    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION)));
            const connection: ClientConnection = { connectionType: 'user-scoped', userId,
                socket: socket as unknown as ClientConnection['socket'] };
            eventRouter.addConnection(userId, connection);
            return { userId, socket, connection };
        });
        try {
            expect(await publishSessionCurrentViewUpdates({
                sessionId: "session",
                recipientCursors: [{ accountId: "owner", cursor: 9 }, { accountId: "editor", cursor: 12 }],
                source: { kind: "envelope_tuple_v1", sessionOwnerId: "owner", ownerAccountMode: "plain",
                    sharedMetadata: { version: 2, value: '{"v":1}' },
                    ownerMetadata: { value: "invalid-owner-envelope" }, agentState: { version: 1, value: "{}" } },
            })).toEqual({ ok: false });
            expect(recipients.flatMap(({ userId, socket }) => socket.emit.mock.calls.map(([, payload]) => ({ userId, payload }))))
                .toEqual([
                    { userId: "owner", payload: expect.objectContaining({ seq: 9,
                        body: { t: "account-change", changeKinds: ["session"], entityIds: ["session"], sessionSystemRecords: [] } }) },
                    { userId: "editor", payload: expect.objectContaining({ seq: 12,
                        body: { t: "account-change", changeKinds: ["session"], entityIds: ["session"], sessionSystemRecords: [] } }) },
                ]);
        } finally { for (const { userId, connection } of recipients) eventRouter.removeConnection(userId, connection); }
    });
    it("publishes an admitted legacy partial change only to its owner, excluding the sender", async () => {
        // Substitute only socket delivery; payload construction and audience selection stay real.
        const emit = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => undefined);
        const sender: ClientConnection = { connectionType: "user-scoped", userId: "owner",
            socket: createFakeSocket() as unknown as ClientConnection["socket"] };
        try {
            expect(await publishSessionCurrentViewUpdates({
                sessionId: "session",
                recipientCursors: [{ accountId: "owner", cursor: 3 }, { accountId: "editor", cursor: 4 }],
                source: { kind: "legacy_v0", sessionOwnerId: "owner",
                    metadata: { value: "owner-private-metadata", version: 2 } },
                skipSenderConnection: sender,
            })).toEqual({ ok: true });
            expect(emit.mock.calls).toHaveLength(1);
            expect(emit.mock.calls[0]?.[0]).toMatchObject({
                userId: "owner", skipSenderConnection: sender,
                payload: { seq: 3, body: { t: "update-session", id: "session",
                    metadata: { value: "owner-private-metadata", version: 2 } } },
            });
            expect(emit.mock.calls[0]?.[0].payload.body).toHaveProperty("agentState", undefined);
        } finally { emit.mockRestore(); }
    });
});
