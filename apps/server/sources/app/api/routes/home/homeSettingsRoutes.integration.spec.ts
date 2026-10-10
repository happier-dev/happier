import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auth } from "@/app/auth/auth";
import type { AuthEmailMessage } from "@/app/auth/email/authEmailDelivery";
import { createPerSendAuthEmailDelivery } from "@/app/auth/email/resolveAuthEmailDelivery";
import { readHomeConfigEnv, setHomeSettings } from "@/app/home/settings/homeSettings";
import { logger } from '@/utils/logging/log';
import { enableServeUi } from '../../utils/enableServeUi';
import { bugReportDiagnosticsRoutes } from '../diagnostics/bugReportDiagnosticsRoutes';
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { db } from "@/storage/db";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { homeGovernanceRoutes } from "./homeGovernanceRoutes";
import { registerHomeSettingsRoutes } from "./homeSettingsRoutes";
import { registerHomeReachabilityRoutes } from './homeReachabilityRoutes';
import { registerHomeRetentionRoutes } from './homeRetentionRoutes';
import { homeDomainActionPathForMethod } from '../actions/homeDomainActionRoute';
import { resolveRateLimitEnvKeysForId } from '../../utils/apiRateLimitDefaults';
import { applyStartupHomeEnvToProcess, loadStartupHomeEnv } from '@/app/home/settings/startupHomeEnv';

const { trackApp, closeTrackedApps } = createAppCloseTracker();

const PASSWORD = "route-smtp-password";
const sent: Array<Readonly<{ kind: AuthEmailMessage["kind"]; to: string; password: string | null; host: string }>> = [];

/**
 * The composed per-send delivery over the Home overlay, with only the SMTP socket replaced: the
 * transport records the configuration it was built from for the message it sends.
 */
function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    homeGovernanceRoutes(typed);
    registerHomeSettingsRoutes(typed, {
        authEmailDelivery: createPerSendAuthEmailDelivery({
            readEnv: () => readHomeConfigEnv({}),
            createSmtpTransport: (config) => ({
                async send(envelope) {
                    sent.push({ kind: "mail_delivery_test", to: envelope.to, password: config.password, host: config.host });
                },
            }),
        }),
    });
    return trackApp(typed);
}

let harness: LightSqliteHarness;
let sequence = 0;

async function createAccount(homeRole: "owner" | "admin" | "member"): Promise<Readonly<{ accountId: string; token: string }>> {
    sequence += 1;
    const account = await db.account.create({
        data: { publicKey: `pk_home_settings_${sequence}`, encryptionMode: "plain", homeRole },
        select: { id: true },
    });
    const token = await auth.createToken(account.id, undefined, {
        kind: "account",
        authority: "present_user",
        authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
    });
    return { accountId: account.id, token };
}

async function post(app: ReturnType<typeof createTestApp>, url: string, token: string, payload: unknown) {
    return await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });
}

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-home-settings-routes-",
        initAuth: true,
        initEncrypt: true,
        initFiles: true,
    });
}, 120_000);
afterAll(async () => await harness.close());
afterEach(async () => {
    await closeTrackedApps();
    sent.length = 0;
    await db.homeAdministrationEvent.deleteMany({});
    await db.homeSettings.deleteMany({});
    await db.account.deleteMany({});
});

describe("Home settings routes", () => {
    it('registers Home rate limits from saved startup values after the route modules were imported', async () => {
        const keys = resolveRateLimitEnvKeysForId('account.settings');
        const claimKeys = resolveRateLimitEnvKeysForId('home.governance.claim');
        const mailKeys = resolveRateLimitEnvKeysForId('home.mailDelivery.test');
        vi.stubEnv(keys.maxEnvKey, '');
        vi.stubEnv(claimKeys.maxEnvKey, '');
        vi.stubEnv(mailKeys.maxEnvKey, '');
        try {
            const startup = await loadStartupHomeEnv({ env: {}, readStored: async () => ({ values: { [keys.maxEnvKey]: 17, [claimKeys.maxEnvKey]: 7, [mailKeys.maxEnvKey]: 5 }, secrets: {} }), log: () => {} });
            applyStartupHomeEnvToProcess(startup, process.env);
            const app = trackApp(Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>());
            const limits = new Map<string, unknown>();
            app.addHook('onRoute', (route) => { limits.set(route.url, route.config?.rateLimit); });
            enableAuthentication(app);
            homeGovernanceRoutes(app);
            registerHomeSettingsRoutes(app, { authEmailDelivery: createPerSendAuthEmailDelivery({ readEnv: () => readHomeConfigEnv({}), createSmtpTransport: () => ({ async send() {} }) }) });
            registerHomeReachabilityRoutes(app);
            registerHomeRetentionRoutes(app);
            expect(limits.get('/v1/home/settings/get')).toMatchObject({ max: 17 });
            expect(limits.get('/v1/home/governance/get')).toMatchObject({ max: 17 });
            expect(limits.get(homeDomainActionPathForMethod('identity.providers.list', 'POST'))).toMatchObject({ max: 17 });
            expect(limits.get(homeDomainActionPathForMethod('home.reachability.get', 'POST'))).toMatchObject({ max: 17 });
            expect(limits.get(homeDomainActionPathForMethod('home.retention.dryRun', 'POST'))).toMatchObject({ max: 17 });
            expect(limits.get(homeDomainActionPathForMethod('home.governance.claim', 'POST'))).toMatchObject({ max: 7 });
            expect(limits.get(homeDomainActionPathForMethod('home.mailDelivery.test', 'POST'))).toMatchObject({ max: 5 });
        } finally {
            vi.unstubAllEnvs();
            await loadStartupHomeEnv({ env: {}, readStored: async () => ({ values: {}, secrets: {} }), log: () => {} });
        }
    });

    it("uses saved live log locations, auth diagnostics and UI fallback disclosure on the next request", async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-home-live-diagnostics-'));
        const path = join(dir, 'server.log');
        await writeFile(path, 'Home diagnostic marker\n');
        const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
        vi.stubEnv('NODE_ENV', 'production');
        try {
            const owner = await createAccount('owner');
            const saved = await setHomeSettings({ actorAccountId: owner.accountId, write: { expectedRevision: 0, values: {
                HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: true,
                HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: 'authenticated',
                HAPPIER_BUG_REPORTS_SERVER_LOG_PATH: path,
                HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: true,
                HAPPIER_SERVER_UI_DEBUG_PATH: true,
            } } });
            expect(saved.status).toBe('applied');
            const app = createTestApp();
            bugReportDiagnosticsRoutes(app);
            enableServeUi(app, { dir: join(dir, 'missing-ui'), prefix: '/', mountRoot: true, required: false });
            const snapshot = await app.inject({ method: 'GET', url: '/v1/diagnostics/bug-report-snapshot', headers: { authorization: `Bearer ${owner.token}` } });
            expect(snapshot.statusCode).toBe(200);
            expect(snapshot.json().logs.tail).toContain('Home diagnostic marker');
            expect(info.mock.calls.some(([entry]) => typeof entry === 'object' && entry !== null && 'module' in entry && entry.module === 'auth-decorator')).toBe(true);
            const fallback = await app.inject({ method: 'GET', url: '/' });
            expect(fallback.body).toContain(join(dir, 'missing-ui', 'index.html'));
            await setHomeSettings({ actorAccountId: owner.accountId, write: { expectedRevision: 1, values: {
                HAPPIER_BUG_REPORTS_SERVER_LOG_PATH: null,
                HAPPIER_SELF_HOST_LOG_DIR: dir,
                HAPPIER_SERVER_UI_DEBUG_PATH: false,
            } } });
            const byDirectory = await app.inject({ method: 'GET', url: '/v1/diagnostics/bug-report-snapshot', headers: { authorization: `Bearer ${owner.token}` } });
            expect(byDirectory.json().logs.tail).toContain('Home diagnostic marker');
            const hidden = await app.inject({ method: 'GET', url: '/' });
            expect(hidden.body).not.toContain(join(dir, 'missing-ui', 'index.html'));
        } finally {
            info.mockRestore();
            vi.unstubAllEnvs();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("saves SMTP from the console and the next test email uses the stored password, which no read ever returns", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const admin = await createAccount("admin");

        const before = await post(app, "/v1/home/mail-delivery/get", owner.token, {});
        expect(before.statusCode).toBe(200);
        expect(before.json()).toMatchObject({ transportConfigured: false, linkOrigin: null, ready: false, passwordUnreadable: false });

        const saved = await post(app, "/v1/home/settings/set", owner.token, {
            expectedRevision: 0,
            values: {
                HAPPIER_AUTH_EMAIL_SMTP_HOST: "smtp.home.test",
                HAPPIER_AUTH_EMAIL_SMTP_USERNAME: "mailer",
                HAPPIER_AUTH_EMAIL_FROM_ADDRESS: "home@home.test",
            },
            secrets: { HAPPIER_AUTH_EMAIL_SMTP_PASSWORD: { replace: PASSWORD } },
        });
        expect(saved.statusCode).toBe(200);
        expect(saved.body).not.toContain(PASSWORD);

        const test = await post(app, "/v1/home/mail-delivery/test", owner.token, { to: "owner@home.test" });
        expect(test.statusCode).toBe(200);
        expect(test.json()).toEqual({ status: "sent" });
        expect(sent).toEqual([{ kind: "mail_delivery_test", to: "owner@home.test", password: PASSWORD, host: "smtp.home.test" }]);

        const readiness = await post(app, "/v1/home/mail-delivery/get", admin.token, {});
        expect(readiness.json()).toMatchObject({ transportConfigured: true, passwordUnreadable: false });

        const read = await post(app, "/v1/home/settings/get", admin.token, {});
        expect(read.statusCode).toBe(200);
        expect(read.body).not.toContain(PASSWORD);
        const password = read.json().entries.find((entry: { key: string }) => entry.key === "HAPPIER_AUTH_EMAIL_SMTP_PASSWORD");
        expect(password).toMatchObject({ value: null, secretSet: true, source: "home" });

        const audit = await post(app, "/v1/home/audit/list", admin.token, {});
        expect(audit.statusCode).toBe(200);
        expect(audit.body).not.toContain(PASSWORD);
        expect(audit.json().items).toEqual(expect.arrayContaining([
            expect.objectContaining({
                action: "home.settings.set",
                actor: expect.objectContaining({ kind: "account", accountId: owner.accountId }),
                target: { kind: "setting", id: "HAPPIER_AUTH_EMAIL_SMTP_PASSWORD", profile: null },
                summary: { secret: true, key: "HAPPIER_AUTH_EMAIL_SMTP_PASSWORD", from: "unset", to: "set" },
            }),
        ]));
    });

    it("keeps writes and the test send to owners and names the refused key", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const admin = await createAccount("admin");
        const member = await createAccount("member");

        expect((await post(app, "/v1/home/settings/get", member.token, {})).statusCode).toBe(403);
        expect((await post(app, "/v1/home/audit/list", member.token, {})).statusCode).toBe(403);
        expect((await post(app, "/v1/home/settings/set", admin.token, { expectedRevision: 0, values: { METRICS_PORT: 9191 } })).statusCode).toBe(403);
        expect((await post(app, "/v1/home/mail-delivery/test", admin.token, { to: "a@home.test" })).statusCode).toBe(403);

        const bootstrap = await post(app, "/v1/home/settings/set", owner.token, { expectedRevision: 0, values: { HAPPIER_INSTANCE_ID: "replica-a" } });
        expect(bootstrap.statusCode).toBe(400);
        expect(bootstrap.json()).toEqual({ error: "home_settings_invalid", key: "HAPPIER_INSTANCE_ID", reason: "not_home_editable" });

        await post(app, "/v1/home/settings/set", owner.token, { expectedRevision: 0, values: { METRICS_PORT: 9191 } });
        const stale = await post(app, "/v1/home/settings/set", owner.token, { expectedRevision: 0, values: { METRICS_PORT: 9292 } });
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toEqual({ error: "home_settings_revision_conflict" });

        const notConfigured = await post(app, "/v1/home/mail-delivery/test", owner.token, { to: "owner@home.test" });
        expect(notConfigured.json()).toEqual({ status: "failed", reason: "not_configured" });
        expect(sent).toEqual([]);
    });

    it("records role changes in the audit trail about the person", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const member = await createAccount("member");

        expect((await post(app, "/v1/home/accounts/role/set", owner.token, { accountId: member.accountId, homeRole: "admin" })).statusCode).toBe(200);
        const audit = await post(app, "/v1/home/audit/list", owner.token, { targetId: member.accountId });
        expect(audit.json().items).toEqual([
            expect.objectContaining({
                action: "account.role.set",
                summary: { from: "member", to: "admin" },
                target: expect.objectContaining({ kind: "account", id: member.accountId }),
            }),
        ]);
    });
});
