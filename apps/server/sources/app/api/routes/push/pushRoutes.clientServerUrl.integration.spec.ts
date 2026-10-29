import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { pushRoutes } from "./pushRoutes";
import { eventRouter } from '@/app/events/eventRouter';

const diagnosticSend = vi.hoisted(() => vi.fn(async (messages: unknown[]) => messages.map((): { status: string; id?: string; details?: { error: string } } => ({ status: 'ok', id: 'ticket' }))));
// Only Expo's network boundary is replaced; authentication, SQLite, route selection,
// payload construction and the canonical Account push transport remain real.
vi.mock('expo-server-sdk', () => ({ Expo: class {
    static isExpoPushToken(token: unknown) { return typeof token === 'string' && token.startsWith('ExponentPushToken['); }
    chunkPushNotifications(messages: unknown[]) { return [messages]; }
    sendPushNotificationsAsync = diagnosticSend;
} }));
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
        eventRouter.clearIo();
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        await db.accountPushToken.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it('sends a deliberate diagnostic only to the addressed authenticated registration', async () => {
        diagnosticSend.mockClear();
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: 'pk_diagnostic_owner' } });
        const other = await db.account.create({ data: { publicKey: 'pk_diagnostic_other' } });
        const credential = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const headers = { authorization: `Bearer ${credential}` };
        const registration = await db.accountPushToken.create({ data: { accountId: account.id, token: 'ExponentPushToken[diagnostic]', clientServerUrl: 'https://diagnostic-home.test' } });
        const foreign = await db.accountPushToken.create({ data: { accountId: other.id, token: 'ExponentPushToken[foreign]' } });
        const send = (id: string, payload = {}) => app.inject({ method: 'POST', url: `/v1/push-tokens/${id}/test`, headers, payload });
        const accepted = await send(registration.id);
        expect(accepted.statusCode).toBe(200);
        expect(accepted.json()).toEqual({ status: 'accepted' });
        expect(diagnosticSend.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ to: registration.token, title: 'Happier notification test' })]);
        expect((await send(foreign.id)).json()).toEqual({ status: 'not_registered' });
        expect((await send('missing')).json()).toEqual({ status: 'not_registered' });
        expect((await send(registration.id, { to: foreign.token, body: 'Caller text' })).statusCode).toBe(400);
        expect(diagnosticSend).toHaveBeenCalledTimes(1);
    });

    it.each(['MessageTooBig', 'InvalidCredentials'])('reports a known service failure without claiming delivery: %s', async error => {
        diagnosticSend.mockResolvedValueOnce([{ status: 'error', details: { error } }]);
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: `pk_diagnostic_${error}` } });
        const credential = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const registration = await db.accountPushToken.create({ data: { accountId: account.id, token: 'ExponentPushToken[diagnostic]' } });
        const result = await app.inject({ method: 'POST', url: `/v1/push-tokens/${registration.id}/test`, headers: { authorization: `Bearer ${credential}` }, payload: {} });
        expect(result.statusCode).toBe(200);
        expect(result.json()).toEqual({ status: error === 'InvalidCredentials' ? 'invalid_credentials' : 'rejected' });
    });

    it('filters only opted-in focused-account alert requests and fails open on unavailable focus', async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: 'pk_focus_push' } });
        const credential = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const headers = { authorization: `Bearer ${credential}` };
        const token = 'ExponentPushToken[focus]';
        await app.inject({ method: 'POST', url: '/v1/push-tokens', headers, payload: { token } });
        let focused = true;
        let unavailable = false;
        eventRouter.setIo({ to: () => ({ emit() {}, disconnectSockets() {} }), in: (room) => ({ fetchSockets: async () => {
            if (unavailable) throw new Error('adapter unavailable');
            return room === `user-scoped:${account.id}`
                ? [{ id: 'focus', data: { clientType: 'user-scoped', clientPurpose: 'sync', uiFocus: { computer: true, focused } } }]
                : [];
        } }) });
        const read = (optIn = true) => app.inject({ method: 'GET', headers,
            url: `/v1/push-tokens${optIn ? '?suppressIfComputerFocused=1' : ''}` });
        expect((await read(false)).json().tokens).toHaveLength(1);
        expect((await read()).json()).toEqual({ tokens: [], suppressedByFocusedComputer: true });
        focused = false;
        expect((await read()).json().tokens).toHaveLength(1);
        focused = true; unavailable = true;
        expect((await read()).json().tokens).toHaveLength(1);
    });

    it("stores and returns clientServerUrl for each push token", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_push_1" } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });

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

    it("negotiates remote enrollment and rejects a stale registration after token deletion and recreation", async () => {
        process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED = "true";
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_push_remote" } });
        const credential = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const headers = { authorization: `Bearer ${credential}` };
        const token = "ExponentPushToken[remote]";
        const ordinary = () => app.inject({ method: "POST", url: "/v1/push-tokens", headers, payload: { token } });
        const projection = () => app.inject({ method: "GET", url: "/v1/push-tokens?projectionVersion=2", headers });
        await ordinary();
        const initial = (await projection()).json();
        expect(initial).toMatchObject({ v: 2, accountRemoteAlerts: { settingsVersion: 0, status: "disabled" }, tokens: [{ remoteAlerts: null }] });
        const policy = { v: 1, enabled: true, nativeConsumer: "ios_service_extension_v1", quietHoursOverride: { mode: "account" },
            foregroundBehavior: "account", previewCeiling: "status_only", soundVolume: 1 };
        const enroll = () => app.inject({ method: "POST", url: "/v1/push-tokens", headers,
            payload: { token, remoteAlerts: { registrationId: initial.tokens[0].id, policy } } });
        expect((await enroll()).statusCode).toBe(200);
        await ordinary();
        expect((await projection()).json().tokens[0].remoteAlerts).toEqual(policy);
        expect((await app.inject({ method: "GET", url: "/v1/push-tokens", headers })).json().tokens[0]).not.toHaveProperty("remoteAlerts");
        await app.inject({ method: "DELETE", url: `/v1/push-tokens/${encodeURIComponent(token)}`, headers });
        await ordinary();
        expect((await enroll()).statusCode).toBe(404);
        expect((await projection()).json().tokens[0].remoteAlerts).toBeNull();
    });

    it("keeps ordinary push registration active but refuses remote enrollment when Session Follow is disabled", async () => {
        process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED = "false";
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_push_remote_off" } });
        const credential = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const headers = { authorization: `Bearer ${credential}` };
        const token = "ExponentPushToken[remote-off]";
        expect((await app.inject({ method: "POST", url: "/v1/push-tokens", headers, payload: { token } })).statusCode).toBe(200);
        const row = await db.accountPushToken.findUniqueOrThrow({ where: { accountId_token: { accountId: account.id, token } } });

        const enrollment = await app.inject({
            method: "POST",
            url: "/v1/push-tokens",
            headers,
            payload: { token, remoteAlerts: { registrationId: row.id, policy: {
                v: 1, enabled: true, nativeConsumer: "ios_service_extension_v1",
                quietHoursOverride: { mode: "account" }, foregroundBehavior: "account",
                previewCeiling: "status_only", soundVolume: 1,
            } } },
        });
        expect(enrollment.statusCode).toBe(404);
        expect((await app.inject({ method: "GET", url: "/v1/push-tokens?projectionVersion=2", headers })).json())
            .not.toHaveProperty("accountRemoteAlerts");
        expect((await db.accountPushToken.findUniqueOrThrow({ where: { id: row.id } })).remoteAlerts).toBeNull();
    });

    it("returns clientServerUrl=null when the client hint is invalid", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: "pk_push_2" } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });

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
