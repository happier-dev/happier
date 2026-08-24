import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuthMtls } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

const IDENTITY_HEADERS = {
    email: 'session-composer-draft-continuity@example.com',
    issuer: 'CN=Example Root CA',
    fingerprint: 'sha256:session-composer-draft-continuity',
} as const;

type SessionCreateResponse = Readonly<{
    session?: Readonly<{ id?: unknown }>;
}>;

type MessageCreateResponse = Readonly<{
    didWrite?: unknown;
}>;

type SeededSession = Readonly<{
    id: string;
    title: string;
}>;

function requireString(value: unknown, context: string): string {
    if (typeof value === 'string' && value.trim().length > 0) return value;
    throw new Error(`Missing ${context}`);
}

async function createPlainSession(params: Readonly<{
    baseUrl: string;
    token: string;
    title: string;
}>): Promise<SeededSession> {
    const tag = `composer-draft-${randomUUID()}`;
    const response = await fetchJson<SessionCreateResponse>(`${params.baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            tag,
            metadata: JSON.stringify({
                v: 1,
                name: params.title,
                path: `/tmp/${tag}`,
                flavor: 'claude',
            }),
            agentState: null,
            dataEncryptionKey: null,
            encryptionMode: 'plain',
        }),
        timeoutMs: 20_000,
    });

    if (response.status !== 200) {
        throw new Error(`Failed to create seeded session ${params.title} (status=${response.status})`);
    }

    return {
        id: requireString(response.data?.session?.id, `session id for ${params.title}`),
        title: params.title,
    };
}

async function postPlainUserMessage(params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    text: string;
}>): Promise<void> {
    const localId = `composer-history-${randomUUID()}`;
    const response = await fetchJson<MessageCreateResponse>(`${params.baseUrl}/v2/sessions/${params.sessionId}/messages`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': localId,
        },
        body: JSON.stringify({
            localId,
            content: {
                t: 'plain',
                v: {
                    role: 'user',
                    content: { type: 'text', text: params.text },
                },
            },
        }),
        timeoutMs: 20_000,
    });

    if (response.status !== 200 || response.data?.didWrite !== true) {
        throw new Error(`Failed to seed user message ${localId} (status=${response.status})`);
    }
}

async function openSession(params: Readonly<{
    page: Page;
    uiBaseUrl: string;
    session: SeededSession;
}>): Promise<ReturnType<Page['locator']>> {
    await gotoDomContentLoadedWithRetries(params.page, `${params.uiBaseUrl}/?happier_hmr=0`, 180_000);
    await waitForInitialAppUi({ page: params.page, timeoutMs: 180_000 });

    const sessionUrl = `${params.uiBaseUrl}/session/${params.session.id}?happier_hmr=0`;
    await gotoDomContentLoadedWithRetries(params.page, sessionUrl, 180_000);
    const composer = params.page.locator('textarea[data-testid="session-composer-input"]:visible').first();
    await expect(composer).toHaveCount(1, { timeout: 120_000 });
    await expect(composer).toBeVisible({ timeout: 120_000 });
    return composer;
}

async function setTextareaScrollTopToEnd(locator: ReturnType<Page['locator']>): Promise<number> {
    return await locator.evaluate((element) => {
        if (!(element instanceof HTMLTextAreaElement)) {
            throw new Error('session composer input is not a textarea');
        }
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
        return element.scrollTop;
    });
}

async function getTextareaMeasurements(locator: ReturnType<Page['locator']>): Promise<Readonly<{
    clientHeight: number;
    scrollTop: number;
    scrollHeight: number;
}>> {
    return await locator.evaluate((element) => {
        if (!(element instanceof HTMLTextAreaElement)) {
            throw new Error('session composer input is not a textarea');
        }
        return {
            clientHeight: element.clientHeight,
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
        };
    });
}

test.describe('ui e2e: session composer draft continuity', () => {
    const suiteDir = run.testDir('session-composer-draft-continuity-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let proxyStop: (() => Promise<void>) | null = null;
    let token: string | null = null;
    let sessionA: SeededSession | null = null;
    let sessionB: SeededSession | null = null;

    test.beforeAll(async () => {
        test.setTimeout(540_000);
        await mkdir(suiteDir, { recursive: true });

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '0',
                AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
                AUTH_SIGNUP_PROVIDERS: '',

                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',

                HAPPIER_FEATURE_AUTH_MTLS__ENABLED: '1',
                HAPPIER_FEATURE_AUTH_MTLS__MODE: 'forwarded',
                HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: '1',
                HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: '1',
                HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: 'san_email',
                HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: 'example.com',
                HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: IDENTITY_HEADERS.issuer,
                HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: 'x-happier-client-cert-email',
                HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: 'x-happier-client-cert-issuer',
                HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: 'x-happier-client-cert-sha256',

                HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_ENABLED: '1',
                HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_PROVIDER_ID: 'mtls',
            },
        });

        const { startForwardedHeaderProxy } = await import('../../src/testkit/uiE2e/forwardedHeaderProxy');
        const proxy = await startForwardedHeaderProxy({
            targetBaseUrl: server.baseUrl,
            identityHeaders: {
                'x-happier-client-cert-email': IDENTITY_HEADERS.email,
                'x-happier-client-cert-issuer': IDENTITY_HEADERS.issuer,
                'x-happier-client-cert-sha256': IDENTITY_HEADERS.fingerprint,
            },
        });
        proxyStop = proxy.stop;

        const auth = await createTestAuthMtls(server.baseUrl, {
            email: IDENTITY_HEADERS.email,
            issuer: IDENTITY_HEADERS.issuer,
            fingerprint: IDENTITY_HEADERS.fingerprint,
        });
        token = auth.token;

        sessionA = await createPlainSession({ baseUrl: server.baseUrl, token, title: 'Composer draft continuity A' });
        sessionB = await createPlainSession({ baseUrl: server.baseUrl, token, title: 'Composer draft continuity B' });

        await postPlainUserMessage({ baseUrl: server.baseUrl, token, sessionId: sessionA.id, text: 'older session A user prompt' });
        await postPlainUserMessage({ baseUrl: server.baseUrl, token, sessionId: sessionA.id, text: 'newer session A user prompt' });
        await postPlainUserMessage({ baseUrl: server.baseUrl, token, sessionId: sessionB.id, text: 'session B user prompt must stay isolated' });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...process.env,
                EXPO_PUBLIC_DEBUG: '1',
                EXPO_PUBLIC_HAPPY_SERVER_URL: proxy.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-session-composer-draft-${run.runId}`,
                HAPPIER_E2E_UI_WEB_MODE: 'export',
            },
        });
        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        await ui?.stop().catch(() => {});
        await proxyStop?.().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('restores long draft expansion and web scroll position after switching sessions', async ({ page }) => {
        test.setTimeout(420_000);
        if (!uiBaseUrl || !sessionA || !sessionB) throw new Error('missing composer continuity fixtures');

        const longDraft = Array.from({ length: 36 }, (_, index) => `line ${index + 1} composer continuity ${run.runId}`).join('\n');
        const composerA = await openSession({ page, uiBaseUrl, session: sessionA });
        await composerA.fill(longDraft);
        await expect(composerA).toHaveValue(longDraft);

        const expansionToggle = page.getByTestId('agent-input-expand-toggle');
        await expect(expansionToggle).toHaveCount(1, { timeout: 60_000 });
        const collapsedMeasurements = await getTextareaMeasurements(composerA);
        await expansionToggle.click();
        await expect.poll(
            async () => (await getTextareaMeasurements(composerA)).clientHeight,
            { timeout: 30_000 },
        ).toBeGreaterThan(collapsedMeasurements.clientHeight + 8);
        const expandedMeasurements = await getTextareaMeasurements(composerA);
        const savedScrollTop = await setTextareaScrollTopToEnd(composerA);
        expect(savedScrollTop).toBeGreaterThan(0);

        const composerB = await openSession({ page, uiBaseUrl, session: sessionB });
        await expect(composerB).toHaveValue('');

        const restoredComposerA = await openSession({ page, uiBaseUrl, session: sessionA });
        await expect(restoredComposerA).toHaveValue(longDraft);
        await expect.poll(
            async () => (await getTextareaMeasurements(restoredComposerA)).clientHeight,
            { timeout: 30_000 },
        ).toBeGreaterThan(expandedMeasurements.clientHeight - 8);
        await expect.poll(
            async () => (await getTextareaMeasurements(restoredComposerA)).scrollTop,
            { timeout: 30_000 },
        ).toBeGreaterThan(0);
    });

    test('cycles only current-session user messages with repeated ArrowUp in per-session history scope', async ({ page }) => {
        test.setTimeout(300_000);
        if (!uiBaseUrl || !sessionA || !sessionB) throw new Error('missing composer history fixtures');

        const composerA = await openSession({ page, uiBaseUrl, session: sessionA });
        await composerA.fill('');
        await composerA.click();

        await composerA.press('ArrowUp');
        await expect(composerA).toHaveValue('newer session A user prompt', { timeout: 30_000 });

        await composerA.press('ArrowUp');
        await expect(composerA).toHaveValue('older session A user prompt', { timeout: 30_000 });

        await composerA.press('ArrowDown');
        await expect(composerA).toHaveValue('newer session A user prompt', { timeout: 30_000 });

        await composerA.press('ArrowDown');
        await expect(composerA).toHaveValue('', { timeout: 30_000 });

        const composerB = await openSession({ page, uiBaseUrl, session: sessionB });
        await composerB.fill('');
        await composerB.click();
        await composerB.press('ArrowUp');
        await expect(composerB).toHaveValue('session B user prompt must stay isolated', { timeout: 30_000 });
        await expect(composerB).not.toHaveValue('newer session A user prompt');
    });
});
