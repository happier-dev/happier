import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuthMtls } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { registerMachineIdentity } from '../../src/testkit/machineIdentity';
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

type DraftAddress =
    | Readonly<{ kind: 'newSession'; draftId: string }>
    | Readonly<{ kind: 'session'; sessionId: string }>;

type DraftDocument = Readonly<{
    composer: Readonly<{ text: Readonly<{ value: unknown }> }>;
    target: Readonly<{
        kind: string;
        authoring?: Readonly<Record<string, Readonly<{ value: unknown }>>>;
    }>;
}>;

type DraftReadResponse = Readonly<{
    status?: unknown;
    record?: Readonly<{
        revision?: unknown;
        content?: Readonly<{ t?: unknown; v?: Readonly<{ document?: DraftDocument }> }> | null;
    }>;
}>;

const DRAFT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

async function openNewSessionDraft(params: Readonly<{
    page: Page;
    uiBaseUrl: string;
    draftId?: string;
}>): Promise<Readonly<{ draftId: string; composer: ReturnType<Page['getByTestId']> }>> {
    const target = params.draftId
        ? `${params.uiBaseUrl}/new?draftId=${encodeURIComponent(params.draftId)}&happier_hmr=0`
        : `${params.uiBaseUrl}/new?happier_hmr=0`;
    await gotoDomContentLoadedWithRetries(params.page, target, 180_000);
    const composer = params.page.getByTestId('new-session-composer-input');
    if ((await composer.count()) === 0) {
        // mTLS auto-provisioning can consume the first intended route.
        await gotoDomContentLoadedWithRetries(params.page, target, 180_000);
    }
    await expect(composer).toBeVisible({ timeout: 120_000 });
    await expect.poll(() => new URL(params.page.url()).searchParams.get('draftId'), { timeout: 60_000 })
        .toMatch(DRAFT_ID_PATTERN);
    const draftId = new URL(params.page.url()).searchParams.get('draftId');
    if (!draftId || !DRAFT_ID_PATTERN.test(draftId)) throw new Error(`Missing canonical draftId in ${params.page.url()}`);
    if (params.draftId) expect(draftId).toBe(params.draftId);
    return { draftId, composer };
}

async function waitForDraftMutation(page: Page, action: () => Promise<void>): Promise<void> {
    const mutation = page.waitForResponse(
        (response) => response.url().endsWith('/v1/account/session-drafts/mutate')
            && response.request().method() === 'POST'
            && response.status() === 200,
        { timeout: 60_000 },
    );
    await action();
    await mutation;
}

async function fillAndFlushDraft(page: Page, composer: ReturnType<Page['getByTestId']>, value: string): Promise<void> {
    await waitForDraftMutation(page, async () => {
        await composer.fill(value);
        await composer.blur();
    });
}

async function readDraft(params: Readonly<{
    baseUrl: string;
    token: string;
    address: DraftAddress;
}>): Promise<DraftReadResponse> {
    const response = await fetchJson<DraftReadResponse>(`${params.baseUrl}/v1/account/session-drafts/read`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ address: params.address }),
        timeoutMs: 20_000,
    });
    if (response.status !== 200 || !response.data) {
        throw new Error(`Failed to read session draft (status=${response.status})`);
    }
    return response.data;
}

function requirePlainDraftDocument(response: DraftReadResponse): DraftDocument {
    expect(response.status).toBe('present');
    expect(response.record?.content?.t).toBe('plain');
    const document = response.record?.content?.v?.document;
    if (!document) throw new Error('Missing plain draft document');
    return document;
}

async function openSecondContext(params: Readonly<{
    browser: Browser;
    uiBaseUrl: string;
    draftId: string;
}>): Promise<Readonly<{ context: BrowserContext; page: Page; composer: ReturnType<Page['getByTestId']> }>> {
    const context = await params.browser.newContext();
    const page = await context.newPage();
    const opened = await openNewSessionDraft({ page, uiBaseUrl: params.uiBaseUrl, draftId: params.draftId });
    return { context, page, composer: opened.composer };
}

async function selectPermissionMode(page: Page, mode: 'default' | 'yolo'): Promise<void> {
    const compactTrigger = page.getByTestId('agent-input-permission-chip');
    const wizardTrigger = page.getByTestId('new-session-permission-dropdown-trigger');
    const trigger = (await compactTrigger.count()) > 0 ? compactTrigger : wizardTrigger;
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await trigger.click();
    const option = page.getByTestId(`permission-mode-${mode}`);
    await expect(option).toBeVisible({ timeout: 30_000 });
    await option.click();
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
    test.describe.configure({ mode: 'serial' });
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
                HAPPIER_FEATURE_SESSIONS_DRAFTS__ENABLED: '1',

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
        const machineRegistration = await registerMachineIdentity({
            baseUrl: server.baseUrl,
            token,
            metadata: 'session-composer-draft-continuity-machine',
        });
        if (machineRegistration.status !== 200) {
            throw new Error(`Failed to register composer continuity machine (status=${machineRegistration.status})`);
        }

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

    test('keeps stable UUID identities across reload/resume and preserves multiple new-session drafts', async ({ page }) => {
        test.setTimeout(360_000);
        if (!uiBaseUrl) throw new Error('missing ui base url');

        const draftAText = `new-session draft A ${run.runId}`;
        const draftBText = `new-session draft B ${run.runId}`;
        const draftA = await openNewSessionDraft({ page, uiBaseUrl });
        await fillAndFlushDraft(page, draftA.composer, draftAText);

        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(new RegExp(`[?&]draftId=${draftA.draftId}(?:&|$)`), { timeout: 60_000 });
        await expect(page.getByTestId('new-session-composer-input')).toHaveValue(draftAText, { timeout: 60_000 });

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 120_000);
        const rowA = page.getByTestId(`session-draft-row:new-session:${draftA.draftId}`);
        await expect(page.getByTestId('session-drafts-section')).toBeVisible({ timeout: 60_000 });
        await expect(rowA).toBeVisible();

        await page.getByTestId('session-draft-new').click();
        await expect(page.getByTestId('new-session-composer-input')).toBeVisible({ timeout: 60_000 });
        const draftBId = await expect.poll(
            () => new URL(page.url()).searchParams.get('draftId'),
            { timeout: 60_000 },
        ).toMatch(DRAFT_ID_PATTERN).then(() => new URL(page.url()).searchParams.get('draftId'));
        if (!draftBId) throw new Error('fresh New session action did not establish a draftId');
        expect(draftBId).not.toBe(draftA.draftId);
        await fillAndFlushDraft(page, page.getByTestId('new-session-composer-input'), draftBText);

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 120_000);
        await expect(page.getByTestId(`session-draft-row:new-session:${draftA.draftId}`)).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId(`session-draft-row:new-session:${draftBId}`)).toBeVisible();

        await rowA.click();
        await expect(page).toHaveURL(new RegExp(`[?&]draftId=${draftA.draftId}(?:&|$)`), { timeout: 60_000 });
        await expect(page.getByTestId('new-session-composer-input')).toHaveValue(draftAText, { timeout: 60_000 });
    });

    test('projects an existing-session draft and preserves edits made while the captured send is in flight', async ({ page }) => {
        test.setTimeout(360_000);
        if (!uiBaseUrl || !sessionA) throw new Error('missing existing-session fixtures');

        const submitted = `captured send ${run.runId}`;
        const newer = `newer edit during send ${run.runId}`;
        const composer = await openSession({ page, uiBaseUrl, session: sessionA });
        await fillAndFlushDraft(page, composer, submitted);

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 120_000);
        await expect(page.getByTestId(`session-list-draft-indicator:${sessionA.id}`)).toBeVisible({ timeout: 60_000 });

        const reopened = await openSession({ page, uiBaseUrl, session: sessionA });
        await expect(reopened).toHaveValue(submitted);
        const send = page.getByTestId('session-composer-send');
        await expect(send).toBeEnabled({ timeout: 30_000 });

        let releaseResponse!: () => void;
        const mayRespond = new Promise<void>((resolve) => { releaseResponse = resolve; });
        let didIntercept = false;
        await page.route(`**/v2/sessions/${sessionA.id}/messages`, async (route) => {
            didIntercept = true;
            const response = await route.fetch();
            await mayRespond;
            await route.fulfill({ response });
        });
        await send.click();
        await expect.poll(() => didIntercept, { timeout: 30_000 }).toBe(true);
        await reopened.fill(newer);
        releaseResponse();
        await expect(reopened).toHaveValue(newer, { timeout: 60_000 });
        await page.unroute(`**/v2/sessions/${sessionA.id}/messages`);
    });

    test('rebases distinct fields, exposes same-field conflict, and does not resurrect a deleted draft across two contexts', async ({ page, browser }) => {
        test.setTimeout(420_000);
        if (!server || !token || !uiBaseUrl) throw new Error('missing synchronized draft fixtures');

        const seed = `two-context base ${run.runId}`;
        const clientA = await openNewSessionDraft({ page, uiBaseUrl });
        await fillAndFlushDraft(page, clientA.composer, seed);
        const clientB = await openSecondContext({ browser, uiBaseUrl, draftId: clientA.draftId });
        try {
            await expect(clientB.composer).toHaveValue(seed, { timeout: 60_000 });

            await clientB.context.setOffline(true);
            await clientB.composer.fill(`offline distinct text ${run.runId}`);
            await clientB.composer.blur();
            await waitForDraftMutation(page, () => selectPermissionMode(page, 'yolo'));
            await clientB.context.setOffline(false);

            await expect.poll(async () => {
                const document = requirePlainDraftDocument(await readDraft({
                    baseUrl: server!.baseUrl,
                    token: token!,
                    address: { kind: 'newSession', draftId: clientA.draftId },
                }));
                return {
                    text: document.composer.text.value,
                    permissionMode: document.target.authoring?.permissionMode?.value,
                };
            }, { timeout: 90_000 }).toEqual({
                text: `offline distinct text ${run.runId}`,
                permissionMode: 'yolo',
            });
            await expect(clientA.composer).toHaveValue(`offline distinct text ${run.runId}`, { timeout: 60_000 });
            await expect(clientB.composer).toHaveValue(`offline distinct text ${run.runId}`, { timeout: 60_000 });

            await clientB.context.setOffline(true);
            await clientB.composer.fill(`client B conflict ${run.runId}`);
            await clientB.composer.blur();
            await fillAndFlushDraft(page, clientA.composer, `client A conflict ${run.runId}`);
            await clientB.context.setOffline(false);

            const conflict = clientB.page.getByTestId('session-draft-conflict:composer.text');
            await expect(conflict).toBeVisible({ timeout: 90_000 });
            await clientB.page.getByTestId('session-draft-conflict-action:composer.text:use-synced').click();
            await expect(clientB.composer).toHaveValue(`client A conflict ${run.runId}`, { timeout: 60_000 });

            await clientB.context.setOffline(true);
            await clientB.composer.fill(`stale edit must not resurrect ${run.runId}`);
            await clientB.composer.blur();
            await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 120_000);
            await page.getByTestId(`session-draft-menu:new-session:${clientA.draftId}`).click();
            await page.getByTestId(`session-draft-delete:new-session:${clientA.draftId}`).click();
            await expect(page.getByTestId('web-modal-confirm')).toBeVisible({ timeout: 30_000 });
            await page.getByTestId('web-modal-confirm').click();
            await expect(page.getByTestId(`session-draft-row:new-session:${clientA.draftId}`)).toHaveCount(0, { timeout: 60_000 });
            const deleted = await readDraft({
                baseUrl: server.baseUrl,
                token,
                address: { kind: 'newSession', draftId: clientA.draftId },
            });
            expect(deleted.status).toBe('deleted');
            const tombstoneRevision = deleted.record?.revision;

            await clientB.context.setOffline(false);
            await expect.poll(async () => (await readDraft({
                baseUrl: server!.baseUrl,
                token: token!,
                address: { kind: 'newSession', draftId: clientA.draftId },
            })).record?.revision, { timeout: 60_000 }).toBe(tombstoneRevision);
        } finally {
            await clientB.context.close();
        }
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
