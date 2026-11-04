import { randomUUID } from "node:crypto";
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    encodeSessionOwnerMetadataEnvelopeV1,
} from "@happier-dev/protocol";
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, buildAccountStoredContentCompatibilityHttpHeadersV1, buildAccountStoredContentCompatibilitySocketAuthV1 } from "@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1";

import { db } from "@/storage/db";
import { eventRouter, type ClientConnection } from "@/app/events/eventRouter";
import { createAuthenticatedFakeSocket } from '@/app/api/testkit/socketHarness';
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionPatchRoute } from "@/app/api/routes/session/registerSessionPatchRoute";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

/**
 * A tuple write re-sends only the parts it changed. Shared metadata carries the
 * tuple revision and is always present; the owner envelope and Agent state are
 * present only when their stored bytes changed in this commit.
 */
describe("Session current-view publication carries only changed tuple parts (SQLite)", () => {
    let harness: LightSqliteHarness;
    // Owner-private facts dominate the live frame (an 18,080-char envelope on a real Codex Session).
    const homeDir = `/home/${"owner".repeat(1_600)}`;
    const ownerEnvelope = createPlainSessionOwnerMetadataEnvelopeV1({
        v: 1, workspace: { name: "repo", path: "/private/owner/repo", homeDir },
    });
    const renamedOwnerEnvelope = createPlainSessionOwnerMetadataEnvelopeV1({
        v: 1, workspace: { name: "renamed", path: "/private/owner/repo", homeDir },
    });

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-current-view-delta-", initAuth: false, initEncrypt: false, initFiles: false,
        });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it("sends the owner envelope and Agent state only when the commit changed them", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: "plain", active: true, currentStorageState: "hosted",
            metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1(ownerEnvelope), agentState: "{}",
        } });
        const app = createAuthenticatedTestApp();
        registerSessionPatchRoute(app);
        await app.ready();
        // Substitute only the receiving sockets; tuple persistence, projection,
        // audience qualification and routing remain real.
        const viewerSocket = createAuthenticatedFakeSocket({ id: 'owner-viewer', data: {
            userId: account.id, clientType: 'session-scoped', clientPurpose: 'sdk-live', sessionId: session.id,
        } }) as unknown as ClientConnection['socket'];
        const machineSocket = createAuthenticatedFakeSocket({ id: 'owner-machine' }) as unknown as ClientConnection['socket'];
        for (const socket of [viewerSocket, machineSocket]) writeAccountStoredContentCompatibilityForSocket(socket,
            evaluateAccountStoredContentSocketCompatibility(buildAccountStoredContentCompatibilitySocketAuthV1(
                CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION)));
        const viewer: ClientConnection = { connectionType: 'session-scoped', userId: account.id, sessionId: session.id, socket: viewerSocket };
        const machine: ClientConnection = { connectionType: 'machine-scoped', userId: account.id, machineId: 'machine', socket: machineSocket };
        eventRouter.addConnection(account.id, viewer);
        eventRouter.addConnection(account.id, machine);
        const viewerFrames = vi.mocked(viewerSocket.emit);
        const machineFrames = vi.mocked(machineSocket.emit);
        const receivedCurrentViews = () => viewerFrames.mock.calls
            .map(([, payload]) => UpdateContainerSchema.parse(payload))
            .filter(payload => payload.body.t === 'update-session');
        const patch = async (body: Record<string, unknown>) => {
            const response = await app.inject({ method: "PATCH", url: `/v2/sessions/${session.id}`,
                headers: { "x-test-user-id": account.id,
                    ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
                payload: { mode: "owner", metadataLayoutVersion: 1, ...body } });
            expect(response.statusCode).toBe(200);
            // Publication is submitted after the reply; let it settle.
            await vi.waitFor(() => expect(receivedCurrentViews().length).toBeGreaterThan(frames.length));
            const body0 = receivedCurrentViews().at(-1)!.body;
            frames.push({ parts: ["metadata", "ownerMetadata", "agentState"].filter(key => Reflect.get(body0, key) !== undefined),
                bytes: JSON.stringify(body0).length });
        };
        const frames: Array<{ parts: string[]; bytes: number }> = [];
        try {
            // 1. Agent-state write (a permission request): owner envelope unchanged.
            await patch({ expectedOwnerMetadata: ownerEnvelope, ownerMetadata: ownerEnvelope,
                sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }), expectedVersion: 0 },
                agentState: { ciphertext: JSON.stringify({ requests: { r1: { tool: "Bash" } } }), expectedVersion: 0 } });
            // 2. Metadata write (turn progress): exact Agent-state bytes and owner envelope retained.
            await patch({ expectedOwnerMetadata: ownerEnvelope, ownerMetadata: ownerEnvelope,
                sharedMetadata: { ciphertext: JSON.stringify({ v: 1, summary: { text: "t", updatedAt: 1 } }), expectedVersion: 1 },
                agentState: { ciphertext: JSON.stringify({ requests: { r1: { tool: "Bash" } } }), expectedVersion: 1 } });
            // 3. Owner metadata write (rename): the owner envelope changed.
            await patch({ expectedOwnerMetadata: ownerEnvelope, ownerMetadata: renamedOwnerEnvelope,
                sharedMetadata: { ciphertext: JSON.stringify({ v: 1, summary: { text: "t", updatedAt: 1 } }), expectedVersion: 2 },
                agentState: { ciphertext: JSON.stringify({ requests: { r1: { tool: "Bash" } } }), expectedVersion: 1 } });

            expect(frames.map(frame => frame.parts)).toEqual([
                ["metadata", "agentState"],
                ["metadata"],
                ["metadata", "ownerMetadata"],
            ]);
            // A committed current-view frame already delivers this cursor. The
            // durable feed remains recovery evidence, without a second wake.
            expect(viewerFrames.mock.calls.map(([, payload]) => payload.body.t))
                .toEqual(["update-session", "update-session", "update-session"]);
            expect(machineFrames.mock.calls.map(([, payload]) => payload.body.t))
                .toEqual(["account-change", "account-change", "account-change"]);
            expect(await db.accountChange.count({ where: { accountId: account.id, kind: "session", entityId: session.id } }))
                .toBe(1);
            // Frames without the unchanged owner envelope stay far below its size.
            expect(frames[0]!.bytes).toBeLessThan(2_000);
            expect(frames[1]!.bytes).toBeLessThan(2_000);
            expect(frames[2]!.bytes).toBeGreaterThan(8_000);
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
                metadataVersion: 3, agentStateVersion: 1,
            });
        } finally {
            eventRouter.removeConnection(account.id, viewer);
            eventRouter.removeConnection(account.id, machine);
            await app.close();
        }
    });
});
