import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { io as ioClient } from "socket.io-client";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auth } from "@/app/auth/auth";
import { eventRouter, type UpdatePayload } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { startSocket } from "./socket";
import type { Fastify as AppFastify } from "./types";
import { enableAuthentication } from './utils/enableAuthentication';
import { registerAccountApiTokenManagementRoutes } from './routes/auth/registerAccountApiTokenManagementRoutes';
import { EphemeralUpdateSchema } from '@happier-dev/protocol/updates';
import { preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";

describe("API-token Session viewer", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-api-token-viewer-", initAuth: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: "", HAPPIER_SOCKET_ADAPTER: "memory" },
        });
    }, 120_000);
    afterAll(async () => harness.close());

    it.each(["revoke", "narrow"] as const)("isolates Session delivery and evicts the credential on %s (B4)", async mutation => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        const otherSession = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        const parentToken = await auth.createApiToken({ accountId: account.id, tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, "viewer"),
            expiresAt: new Date(Date.now() + 60_000), grant: {
                v: 1, actions: { families: ["session_transcripts"], ids: [] },
                targets: { sessions: [session.id, otherSession.id], machines: [] }, approve: false,
                origins: [], models: null, permissionModes: null, create: null,
            } });
        const verifications = vi.spyOn(auth, "verifyTokenForRoute");
        const app = Fastify({ logger: false }) as AppFastify;
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerAccountApiTokenManagementRoutes(app);
        startSocket(app);
        const io = app.machineDaemonPresence;
        if (!(io instanceof Server)) throw new Error("Missing socket test server");
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("Missing socket test address");
        const minted = await app.inject({ method: 'POST', url: '/v1/auth/api-tokens/children/create',
            headers: { authorization: `Bearer ${parentToken.token}` }, payload: {
                tokenId: randomUUID(), label: 'viewer child', expiresAt: new Date(Date.now() + 30_000).toISOString(),
                grant: { ...parentToken.grant, targets: { sessions: [session.id], machines: [] } },
            } });
        expect(minted.statusCode, minted.body).toBe(200);
        const token = { token: minted.json().token as string, tokenId: minted.json().apiToken.tokenId as string };
        const client = ioClient(`http://127.0.0.1:${address.port}`, {
            path: "/v1/updates", transports: ["websocket"], reconnection: false, autoConnect: false,
            auth: { token: token.token, clientType: "session-scoped", sessionId: session.id },
        });
        try {
            await new Promise<void>((resolve, reject) => {
                client.once("connect", resolve); client.once("connect_error", reject); client.connect();
            });
            await vi.waitFor(() => expect(io.sockets.sockets.get(client.id!)?.rooms.has(`session:${session.id}:${account.id}`)).toBe(true));
            const admitted = io.sockets.sockets.get(client.id!)!;
            // B4: connect authenticates once; packets consume the admitted identity.
            expect(verifications.mock.calls.length).toBe(1);
            expect(admitted.rooms.has(`user:${account.id}`)).toBe(false);
            expect(admitted.rooms.has(`api-token-revocation:${token.tokenId}`)).toBe(true);
            const updates: unknown[] = [];
            client.on("update", update => updates.push(update));
            const access = { v: 1 as const, level: "owner" as const, sources: [{ kind: "owner" as const }], capabilities: {}, audienceContext: null };
            const payload = { id: "viewer-update", seq: 1, createdAt: Date.now(), body: { t: "update-session" as const, id: session.id, access } } satisfies UpdatePayload;
            await eventRouter.emitUpdate({ userId: account.id, payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: session.id } });
            await vi.waitFor(() => expect(updates).toHaveLength(1));
            expect(updates[0]).toEqual({ ...payload, body: { t: "update-session", id: session.id } });
            expect(payload.body.access).toBe(access);
            await eventRouter.emitUpdate({ userId: account.id, payload: { ...payload, id: "other-update", body: { ...payload.body, id: otherSession.id } },
                recipientFilter: { type: "all-interested-in-session", sessionId: otherSession.id } });
            const ping = await client.timeout(5_000).emitWithAck("ping");
            expect(ping).toBeDefined();
            expect(verifications.mock.calls.length).toBe(1);
            expect(updates).toHaveLength(1);
            const signed = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
            const presentationChanges: unknown[] = [];
            client.on('ephemeral', payload => {
                if (payload.type === 'api-token-embed-config-changed') presentationChanges.push(EphemeralUpdateSchema.parse(payload));
            });
            const embedConfig = { v: 1, ui: { attachments: false }, newChat: null,
                organization: { folderId: null, tagIds: [] }, style: { v: 1, mode: 'dark' } };
            const edit = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/auth/api-tokens/update',
                headers: { authorization: `Bearer ${signed}`, 'content-type': 'application/json' }, payload: JSON.stringify(payload),
                // The body is serialized explicitly to keep this helper's input untrusted.
            });
            const changed = await edit({ tokenId: parentToken.tokenId, embedConfig });
            expect(changed.statusCode, changed.body).toBe(200);
            await vi.waitFor(() => expect(presentationChanges).toEqual([{ type: 'api-token-embed-config-changed' }]));
            expect(client.connected).toBe(true);
            expect((await edit({ tokenId: parentToken.tokenId, embedConfig })).statusCode).toBe(200);
            expect((await edit({ tokenId: parentToken.tokenId, label: 'Renamed' })).statusCode).toBe(200);
            await client.timeout(5_000).emitWithAck('ping');
            expect(presentationChanges).toHaveLength(1);
            const disconnected = new Promise<void>(resolve => client.once("disconnect", () => resolve()));
            if (mutation === 'narrow') {
                const narrowed = await edit({ tokenId: parentToken.tokenId,
                    grant: { ...parentToken.grant, targets: { sessions: [otherSession.id], machines: [] } } });
                expect(narrowed.statusCode, narrowed.body).toBe(200);
            } else {
                const revoked = await auth.revokeApiToken({ accountId: account.id, tokenId: parentToken.tokenId });
                expect(revoked.revoked).toBe(true);
                if (!app.disconnectApiTokenSockets) throw new Error("Missing token socket revocation callback");
                app.disconnectApiTokenSockets(revoked.revokedTokenIds);
            }
            await disconnected;
            expect(client.connected).toBe(false);
            const refused = new Promise<Error>(resolve => client.once('connect_error', resolve));
            client.connect();
            expect(await refused).toBeInstanceOf(Error);
            expect(client.connected).toBe(false);
        } finally {
            verifications.mockRestore();
            client.disconnect(); await io.close(); await app.close();
            // The harness owns disposal of the isolated database, including audit rows.
        }
    });
});
