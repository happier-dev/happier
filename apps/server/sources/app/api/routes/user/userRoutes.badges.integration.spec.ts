import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { userRoutes } from "./userRoutes";
import { auth } from "@/app/auth/auth";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import tweetnacl from "tweetnacl";
import { signAccountContentKeyBindingV1 } from "@happier-dev/protocol";

function createTestApp(authenticatedUserId?: string) {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        if (authenticatedUserId) {
            request.userId = authenticatedUserId;
            return;
        }
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });

    return typed;
}

describe("userRoutes (profile badges) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-user-badges-",
            initAuth: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(() => {
        harness.resetEnv();
        vi.unstubAllGlobals();
    });

    it("batches exact People profiles without substituting the viewer or exposing unrequested accounts", async () => {
        const viewer = await db.account.create({ data: { publicKey: 'batch-viewer', name: 'Viewer' } });
        const editor = await db.account.create({ data: { publicKey: 'batch-editor', name: 'Ada Chen' } });
        const unrelated = await db.account.create({ data: { publicKey: 'batch-unrelated', name: 'Other' } });
        await db.userRelationship.create({ data: { fromUserId: viewer.id, toUserId: editor.id, status: 'friend' } });
        await db.userRelationship.create({ data: { fromUserId: unrelated.id, toUserId: editor.id, status: 'rejected' } });
        const app = createTestApp(viewer.id);
        await userRoutes(app);
        await app.ready();
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/user/profiles',
                payload: { ids: [editor.id, viewer.id, editor.id, 'missing-account'] } });
            expect(response.statusCode).toBe(200);
            const users = response.json().users;
            expect(users).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: editor.id, name: 'Ada Chen', status: 'friend' }),
                expect.objectContaining({ id: viewer.id, name: 'Viewer' }),
            ]));
            expect(users).toHaveLength(2);
            expect(users).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: unrelated.id })]));
        } finally {
            await app.close();
        }
    });

    it('keeps the existing authenticated People read boundary for an empty batch too', async () => {
        const app = createTestApp();
        await userRoutes(app);
        await app.ready();
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/user/profiles', payload: { ids: [] } });
            expect(response.statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it("includes GitHub badge when an identity is linked and showOnProfile=true", async () => {
        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const viewer = await db.account.create({ data: { publicKey: "pk-viewer", username: "viewer" }, select: { id: true } });
        const target = await db.account.create({ data: { publicKey: "pk-target", username: "target" }, select: { id: true } });

        await db.accountIdentity.create({
            data: {
                accountId: target.id,
                provider: "github",
                providerUserId: "123",
                providerLogin: "octocat",
                profile: { id: 123, login: "octocat", name: "Octo Cat", avatar_url: "x" } as any,
                showOnProfile: true,
            },
        });

        const res = await app.inject({
            method: "GET",
            url: `/v1/user/${encodeURIComponent(target.id)}`,
            headers: { "x-test-user-id": viewer.id },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as any;
        expect(body.user?.badges).toEqual([
            {
                id: "github",
                label: "@octocat",
                url: "https://github.com/octocat",
            },
        ]);

        await app.close();
    });

    it("returns publicKey=null for keyless accounts", async () => {
        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const viewer = await db.account.create({ data: { publicKey: "pk-viewer-keyless", username: "viewer_keyless" }, select: { id: true } });
        const target = await db.account.create({
            // TDD: keyless accounts allow publicKey to be null.
            data: { publicKey: null as any, username: "target_keyless" },
            select: { id: true },
        });

        const res = await app.inject({
            method: "GET",
            url: `/v1/user/${encodeURIComponent(target.id)}`,
            headers: { "x-test-user-id": viewer.id },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json() as any;
        expect(body.user?.publicKey).toBeNull();

        await app.close();
    });

    it("projects a Plain recipient as key-unavailable even when legacy binding columns remain", async () => {
        const app = createTestApp();
        await userRoutes(app as any);
        await app.ready();

        const viewer = await db.account.create({ data: { publicKey: "pk-viewer-readiness", username: "viewer_readiness" }, select: { id: true } });
        const signing = tweetnacl.sign.keyPair();
        const content = tweetnacl.box.keyPair();
        const signature = signAccountContentKeyBindingV1({
            accountSigningSecretKey: signing.secretKey,
            contentPublicKey: content.publicKey,
        });
        const target = await db.account.create({
            data: {
                encryptionMode: "plain",
                publicKey: Buffer.from(signing.publicKey).toString("hex"),
                contentPublicKey: Buffer.from(content.publicKey),
                contentPublicKeySig: Buffer.from(signature),
                username: "target_plain_retained_binding",
            },
            select: { id: true },
        });

        const res = await app.inject({
            method: "GET",
            url: `/v1/user/${encodeURIComponent(target.id)}`,
            headers: { "x-test-user-id": viewer.id },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().user?.recipientEnvelopeReadiness).toEqual({
            status: "unavailable",
            reason: "plain_account",
        });

        await app.close();
    });
});
