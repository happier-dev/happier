import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { io as ioClient } from "socket.io-client";
import { startSocket } from "../../socket";
import { eventRouter } from "@/app/events/eventRouter";
import { pushRoutes } from "./pushRoutes";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    pushRoutes(typed);
    return trackApp(typed);
}

describe("pushRoutes (clientServerUrl) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-push-clientServerUrl-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        await db.accountPushToken.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("stores and returns clientServerUrl for each push token", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_push_1" } });
        const token = await auth.createToken(account.id);

        const post = await app.inject({
            method: "POST",
            url: "/v1/push-tokens",
            headers: { authorization: `Bearer ${token}` },
            payload: { token: "ExponentPushToken[test-1]", clientServerUrl: "http://lan.example.test:3005/" },
        });
        expect(post.statusCode).toBe(200);

        const get = await app.inject({
            method: "GET",
            url: "/v1/push-tokens",
            headers: { authorization: `Bearer ${token}` },
        });
        expect(get.statusCode).toBe(200);

        const body = get.json() as any;
        expect(body.tokens).toHaveLength(1);
        expect(body.tokens[0]).toMatchObject({
            token: "ExponentPushToken[test-1]",
            clientServerUrl: "http://lan.example.test:3005",
        });
    });

    it("suppresses only opted-in reads while a computer sync socket is focused", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_focus_push" } });
        const token = await auth.createToken(account.id);
        await db.accountPushToken.create({ data: { accountId: account.id, token: "ExponentPushToken[focus]" } });
        const socket = { connected: true, data: { clientType: 'user-scoped', clientPurpose: 'sync', uiFocus: { computer: true, focused: true } } };
        // Boundary fixture: the event-router focus query reads only connected/data, not the full Socket.IO Socket.
        const connection = { connectionType: 'user-scoped' as const, userId: account.id, socket: socket as any };
        eventRouter.addConnection(account.id, connection);
        const get = async (query = '') => (await app.inject({ method: 'GET', url: `/v1/push-tokens${query}`, headers: { authorization: `Bearer ${token}` } })).json();
        try {
            expect((await get()).tokens).toHaveLength(1);
            expect((await get('?suppressIfComputerFocused=1')).tokens).toHaveLength(0);
            socket.data.uiFocus.focused = false;
            expect((await get('?suppressIfComputerFocused=1')).tokens).toHaveLength(1);
            socket.data.uiFocus = { computer: false, focused: true };
            expect((await get('?suppressIfComputerFocused=1')).tokens).toHaveLength(1);
            socket.data.uiFocus = { computer: true, focused: true };
            eventRouter.removeConnection(account.id, connection);
            expect((await get('?suppressIfComputerFocused=1')).tokens).toHaveLength(1);
        } finally { eventRouter.removeConnection(account.id, connection); }
    });

    it("uses real authenticated sockets and restores phone delivery on blur and last computer disconnect", async () => {
        const app = createTestApp();
        startSocket(app);
        const account = await db.account.create({ data: { publicKey: "pk_focus_live" } });
        const token = await auth.createToken(account.id);
        await db.accountPushToken.create({ data: { accountId: account.id, token: "ExponentPushToken[live]" } });
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Expected bound server');
        const url = `http://127.0.0.1:${address.port}`;
        const clients: ReturnType<typeof ioClient>[] = [];
        const connect = async (clientPurpose = 'sync') => {
            const client = ioClient(url, { path: '/v1/updates', transports: ['websocket'], reconnection: false,
                auth: { token, clientType: 'user-scoped', clientPurpose } });
            clients.push(client);
            await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
            return client;
        };
        const focus = async (client: ReturnType<typeof ioClient>, computer: boolean, focused: boolean) => {
            expect(await client.emitWithAck('ui-focus', { computer, focused })).toEqual({ ok: true });
        };
        const tokens = async (optIn = true) => (await app.inject({ method: 'GET',
            url: `/v1/push-tokens${optIn ? '?suppressIfComputerFocused=1' : ''}`,
            headers: { authorization: `Bearer ${token}` } })).json().tokens;
        try {
            const phone = await connect();
            await focus(phone, false, true);
            expect(await tokens()).toHaveLength(1);
            const desktop = await connect();
            expect(await tokens()).toHaveLength(1); // Older client or merely connected window.
            await focus(desktop, true, true);
            expect(await tokens()).toHaveLength(0);
            expect(await tokens(false)).toHaveLength(1); // Security/manual sends remain outside opt-in.
            await focus(desktop, true, false);
            expect(await tokens()).toHaveLength(1);
            const secondDesktop = await connect();
            await focus(secondDesktop, true, true);
            await focus(desktop, true, true);
            await focus(secondDesktop, true, false);
            expect(await tokens()).toHaveLength(0); // Another window is still focused.
            const serverSocket = eventRouter.getConnections(account.id);
            const desktopSocket = [...(serverSocket ?? [])].find((connection) => connection.socket.id === desktop.id)?.socket;
            if (!desktopSocket) throw new Error('Expected authenticated desktop socket');
            const disconnected = new Promise<void>((resolve) => desktopSocket.once('disconnect', () => resolve()));
            desktop.disconnect();
            await disconnected;
            expect(await tokens()).toHaveLength(1);
            const rpc = await connect('rpc');
            expect(await rpc.emitWithAck('ui-focus', { computer: true, focused: true })).toEqual({ ok: false });
            expect(await tokens()).toHaveLength(1);
        } finally {
            for (const client of clients) client.close();
            await closeTrackedApps();
            eventRouter.clearIo();
        }
    });

    it("replaces Android presentation support when the same Expo token is re-registered", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_push_presentation" } });
        const headers = { authorization: `Bearer ${await auth.createToken(account.id)}` };
        const token = "ExponentPushToken[presentation]";
        const register = async (presentation = {}) => app.inject({
            method: "POST", url: "/v1/push-tokens", headers, payload: { token, ...presentation },
        });
        const getTokens = async () => (await app.inject({ method: "GET", url: "/v1/push-tokens", headers })).json().tokens;

        expect((await register()).statusCode).toBe(200);
        expect(await getTokens()).toEqual([expect.objectContaining({ token })]);
        expect((await register({ androidActionPresentationV1: true })).statusCode).toBe(200);
        expect(await getTokens()).toEqual([expect.objectContaining({ token, androidActionPresentationV1: true })]);
        expect((await register()).statusCode).toBe(200);
        expect((await getTokens())[0]).not.toHaveProperty('androidActionPresentationV1');
    });

    it("returns clientServerUrl=null when the client hint is invalid", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_push_2" } });
        const token = await auth.createToken(account.id);

        const post = await app.inject({
            method: "POST",
            url: "/v1/push-tokens",
            headers: { authorization: `Bearer ${token}` },
            payload: { token: "ExponentPushToken[test-2]", clientServerUrl: "not a url" },
        });
        expect(post.statusCode).toBe(200);

        const get = await app.inject({
            method: "GET",
            url: "/v1/push-tokens",
            headers: { authorization: `Bearer ${token}` },
        });
        expect(get.statusCode).toBe(200);

        const body = get.json() as any;
        expect(body.tokens).toHaveLength(1);
        expect(body.tokens[0]).toMatchObject({
            token: "ExponentPushToken[test-2]",
            clientServerUrl: null,
        });
    });
});


// Existing authenticated route and SQLite harness above exercise the real token boundary.
