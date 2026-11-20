import { expect, test, type Page, type Request } from '@playwright/test';

import { resolveTestDbProvider, startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { gotoCommittedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { secretBearingBrowserCapturePolicy } from '../../src/testkit/uiE2e/secretBearingBrowserCapture';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const testDir = run.testDir('first-open-browser');
const uiEnv = {
    ...process.env,
    EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-first-open`,
};

test.use({
    ...secretBearingBrowserCapturePolicy,
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1440, height: 900 },
});
test.describe.configure({ timeout: 120_000 });

let server: StartedServer | undefined;
let ui: StartedUiWeb | undefined;
let uiBaseUrl: string;

test.beforeAll(async () => {
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiEnv));
    server = await startServerLight({
        testDir,
        dbProvider: resolveTestDbProvider(process.env, { fallbackProvider: 'sqlite' }),
        extraEnv: {
            AUTH_ANONYMOUS_SIGNUP_ENABLED: '1',
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
            HAPPIER_FEATURE_AUTH_PAIRING__DESKTOP_QR_MOBILE_SCAN_ENABLED: '1',
            HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_ENABLED: '0',
        },
    });
    ui = await startUiWeb({
        testDir,
        env: { ...uiEnv, EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl },
    });
    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
});

test.afterAll(async () => {
    try {
        await ui?.stop();
    } finally {
        await server?.stop();
    }
});

async function openApp(page: Page, path = '/') {
    await gotoCommittedWithRetries(page, new URL(path, uiBaseUrl).href);
}

async function expectHome(page: Page) {
    await expect(page.getByTestId('home-hub')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('welcome-decision-panel')).toBeHidden();
}

async function waitForWelcomeMethods(page: Page) {
    const welcome = page.getByTestId('welcome-decision-panel');
    await expect(welcome).toBeVisible({ timeout: 60_000 });
    await expect(welcome.getByTestId('welcome-auth-loading')).toBeHidden({ timeout: 60_000 });
}

async function revealRecoveryKey(page: Page): Promise<string> {
    await openApp(page, '/settings/account');
    const reveal = page.getByTestId('settings-account-recovery-key-reveal');
    await reveal.press('Enter');
    const key = (await page.getByTestId('settings-account-recovery-key-value').innerText()).trim();
    await reveal.press('Enter');
    if (!key) throw new Error('The recovery key is empty');
    return key;
}

async function enterRecoveryKey(page: Page, key: string) {
    await page.getByTestId('restore-manual-secret-input').fill(key);
    await page.getByTestId('restore-manual-submit').click();
    await expectHome(page);
}

async function openRecoveryKeyWay(page: Page) {
    await waitForWelcomeMethods(page);
    await page.getByTestId('welcome-scan-existing-home').click();
    const input = page.getByTestId('restore-manual-secret-input');
    const recoveryWay = page.getByTestId('restore-open-manual');
    await expect(input.or(recoveryWay).first()).toBeVisible();
    if (await recoveryWay.isVisible()) await recoveryWay.click();
    await expect(input).toBeVisible();
}

function countRequests(page: Page, path: string, method: string) {
    let count = 0;
    const observe = (request: Request) => {
        if (request.method() === method && new URL(request.url()).pathname === path) count += 1;
    };
    page.on('request', observe);
    return {
        value: () => count,
        stop: () => page.off('request', observe),
    };
}

function readOpeningMarker(page: Page) {
    return page.evaluate(() => {
        const key = 'mmkv.default\\ui-state:onboarding-history-v1:openingSeenAt';
        return Number(localStorage.getItem(key));
    });
}

async function observeOpeningScene(page: Page) {
    await page.addInitScript(() => {
        const observer = new MutationObserver(() => {
            if (!document.querySelector('[data-testid="first-open.scene"]')) return;
            document.documentElement.dataset.openingSceneMounted = 'true';
            observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true });
    });
    return () => page.evaluate(() => document.documentElement.dataset.openingSceneMounted === 'true');
}

test('firstOpen.02.F2 and firstOpen.02.F3 remember a first open across a second signed-out boot', async ({ page }) => {
    const sceneMounted = await observeOpeningScene(page);
    await openApp(page);
    const welcome = page.getByTestId('welcome-decision-panel');
    await expect(welcome).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => readOpeningMarker(page)).toBeGreaterThan(0);
    const firstOpenedAt = await readOpeningMarker(page);

    await page.reload({ waitUntil: 'commit' });
    await expect(welcome).toBeVisible({ timeout: 60_000 });
    expect(await readOpeningMarker(page)).toBe(firstOpenedAt);
    expect(await sceneMounted()).toBe(false);
});

test('firstOpen.02.F5 opens a usable welcome in the Still form with system reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const sceneMounted = await observeOpeningScene(page);

    await openApp(page);
    await expect(page.getByTestId('welcome-primary-start')).toBeEnabled({ timeout: 60_000 });
    await expect.poll(() => readOpeningMarker(page)).toBeGreaterThan(0);
    await page.getByTestId('welcome-scan-existing-home').click();
    await expect(page.getByTestId('restore-requester-qr').or(page.getByTestId('restore-sign-in-ways')).first()).toBeVisible();
    expect(await sceneMounted()).toBe(false);
});

test('firstOpen.02.F4 skips a playing opening with Escape and lands focus in welcome', async ({ page }) => {
    await openApp(page);
    const welcome = page.getByTestId('welcome-decision-panel');
    await expect(welcome).toBeAttached({ timeout: 60_000 });
    test.fail(true, 'FO-L2-OPENING: this browser reaches Still before the Escape and focus path can be exercised');

    const scene = page.getByTestId('first-open.scene');
    await expect(scene.locator('[data-glyph-first-draw-ms]')).toBeAttached();
    await page.keyboard.press('Escape');
    await expect(scene).not.toBeAttached();
    await expect(welcome.getByTestId('welcome-primary-start')).toBeVisible();
    await expect(welcome.locator(':focus')).toBeVisible();
});

test('firstOpen.F1.newHere | firstOpen.03.F1 provisions one Account and reaches Home in one tap', async ({ page }) => {
    await openApp(page);
    const start = page.getByTestId('welcome-primary-start');
    const provision = countRequests(page, '/v1/auth', 'POST');
    try {
        await expect(page.getByTestId('welcome-decision-panel')).toBeVisible({ timeout: 60_000 });
        await start.click();
        await expectHome(page);
        expect(provision.value()).toBe(1);
    } finally {
        provision.stop();
    }

    // A reload proves the real landing persisted an Account on this device.
    await page.reload({ waitUntil: 'commit' });
    await expectHome(page);
});

test('firstOpen.01.F2.write changes Home background once and keeps the selection after reload', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('welcome-primary-start').click();
    await expectHome(page);

    const look = page.getByTestId('look-chip');
    const none = page.getByTestId('look-source:none');
    await look.press('Enter');
    await expect(page.getByTestId('look-panel')).toBeVisible();
    await expect(page.getByTestId('look-source:planet')).toHaveAttribute('aria-checked', 'true');

    const settings = countRequests(page, '/v2/account/settings', 'POST');
    try {
        const [saved] = await Promise.all([
            page.waitForResponse(response =>
                response.request().method() === 'POST' && new URL(response.url()).pathname === '/v2/account/settings',
            ),
            none.press('Enter'),
        ]);
        expect(saved.ok()).toBe(true);
        expect(settings.value()).toBe(1);
    } finally {
        settings.stop();
    }

    await page.reload({ waitUntil: 'commit' });
    await expectHome(page);
    await look.press('Enter');
    await expect(none).toHaveAttribute('aria-checked', 'true');
});

test('firstOpen.01.F1.rest produces zero Home planet draws over 60 seconds with Digits off', async ({ page }) => {
    await page.clock.install();
    await page.addInitScript(() => {
        let draws = 0;
        const record = (canvas: HTMLCanvasElement | OffscreenCanvas) => {
            if (!(canvas instanceof HTMLCanvasElement) || !canvas.closest('[data-testid="home-planet"]')) return;
            document.documentElement.dataset.homePlanetTestDraws = String(++draws);
        };
        const gl = WebGL2RenderingContext.prototype;
        const drawArrays = gl.drawArrays;
        gl.drawArrays = function (...args) {
            drawArrays.apply(this, args);
            record(this.canvas);
        };
        const drawArraysInstanced = gl.drawArraysInstanced;
        gl.drawArraysInstanced = function (...args) {
            drawArraysInstanced.apply(this, args);
            record(this.canvas);
        };
        const ctx = CanvasRenderingContext2D.prototype;
        const clearRect = ctx.clearRect;
        ctx.clearRect = function (...args) {
            clearRect.apply(this, args);
            record(this.canvas);
        };
    });

    await openApp(page);
    await page.getByTestId('welcome-primary-start').click();
    await expectHome(page);
    await expect(page.getByTestId('home-planet').locator('[data-glyph-first-draw-ms]')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('look-chip').press('Enter');
    const digits = page.getByTestId('look-digits').getByRole('switch');
    await expect(digits).toBeVisible();
    if (await digits.getAttribute('aria-checked') === 'true') {
        const [saved] = await Promise.all([
            page.waitForResponse(response =>
                response.request().method() === 'POST' && new URL(response.url()).pathname === '/v2/account/settings',
            ),
            digits.press('Space'),
        ]);
        expect(saved.ok()).toBe(true);
    }
    await expect(digits).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('look-panel')).toBeHidden();
    const drawCount = () => page.evaluate(() => Number(document.documentElement.dataset.homePlanetTestDraws));
    const before = await drawCount();
    expect(before).toBeGreaterThan(0);
    await page.clock.runFor(60_000);
    expect((await drawCount()) - before).toBe(0);
});

test('firstOpen.F2.approve | firstOpen.03.F2 confirms the new device before approving it and lands it on the same Account', async ({ page, browser }) => {
    await openApp(page);
    await page.getByTestId('welcome-primary-start').click();
    await expectHome(page);

    const requesterContext = await browser.newContext();
    let stage = 'showing the requester QR';
    try {
        const requester = await requesterContext.newPage();
        await openApp(requester);
        await requester.bringToFront();
        await waitForWelcomeMethods(requester);
        await requester.getByTestId('welcome-scan-existing-home').click();
        const qr = requester.getByTestId('restore-requester-qr');
        await expect(qr).toBeVisible();

        stage = 'disclosing the requester link';
        await requester.getByTestId('restore-requester-link-details').click();
        const link = (await requester.getByTestId('restore-requester-link-value').innerText()).trim();
        if (!link) throw new Error('Pairing link is empty');

        const rendezvous = countRequests(page, '/v1/auth/pairing/start', 'POST');
        const approval = countRequests(page, '/v1/auth/account/response', 'POST');
        try {
            stage = 'landing on the signed-in device confirmation';
            await openApp(page, '/restore?view=link');
            await page.bringToFront();
            await page.getByTestId('restore-pairing-link-input').fill(link);
            const confirm = page.getByText(/^Add .+ to your Account on .+\?$/);
            const approve = page.getByTestId('restore-enrollment-approve');
            await expect(confirm).toBeVisible();
            await expect(approve).toBeEnabled();
            stage = 'checking that confirmation preceded the writes';
            expect(rendezvous.value()).toBe(0);
            expect(approval.value()).toBe(0);

            stage = 'showing Approved';
            await approve.click();
            await requester.bringToFront();
            await expect(requester.getByTestId('restore-requester-approved')).toHaveText('Approved', { timeout: 45_000 });
            stage = 'checking the approver write counts';
            expect(rendezvous.value()).toBe(1);
            expect(approval.value()).toBe(1);
            stage = 'reaching Home after approval';
            await expectHome(requester);
        } finally {
            rendezvous.stop();
            approval.stop();
        }
        stage = 'checking both devices opened the same Account';
        await Promise.all([openApp(page, '/settings/account'), openApp(requester, '/settings/account')]);
        const [original, paired] = await Promise.all([
            page.getByTestId('settings-account-id').innerText(),
            requester.getByTestId('settings-account-id').innerText(),
        ]);
        if (!original || paired !== original) throw new Error('Pairing opened a different Account');
    } catch {
        // Never attach the QR bearer or the Playwright call log for credential-bearing input.
        throw new Error(`Pairing stopped while ${stage}`);
    } finally {
        await requesterContext.close();
    }
});

test('firstOpen.F3.newAccountWay | firstOpen.03.F3 leaves approval and provisions one new Account', async ({ page }) => {
    await openApp(page);
    await waitForWelcomeMethods(page);
    await page.getByTestId('welcome-scan-existing-home').click();
    const qr = page.getByTestId('restore-requester-qr');
    await expect(qr).toBeVisible();

    const provision = countRequests(page, '/v1/auth', 'POST');
    try {
        await page.getByTestId('restore-new-account').click();
        await expectHome(page);
        await expect(qr).toBeHidden();
        expect(provision.value()).toBe(1);
    } finally {
        provision.stop();
    }
});

test('firstOpen.F4.recoveryKey | firstOpen.03.F4 opens the same Account from a fresh profile using its recovery key', async ({ page, browser }) => {
    await openApp(page);
    await page.getByTestId('welcome-primary-start').click();
    await expectHome(page);

    const restoredContext = await browser.newContext();
    try {
        const restored = await restoredContext.newPage();
        await openApp(restored);
        await openRecoveryKeyWay(restored);

        const key = await revealRecoveryKey(page);
        const accountId = await page.getByTestId('settings-account-id').innerText();

        const challenge = countRequests(restored, '/v1/auth/challenge', 'POST');
        const redeem = countRequests(restored, '/v1/auth', 'POST');
        try {
            await enterRecoveryKey(restored, key);
            expect(challenge.value()).toBe(1);
            expect(redeem.value()).toBe(1);
        } finally {
            challenge.stop();
            redeem.stop();
        }

        await openApp(restored, '/settings/account');
        const restoredAccount = await restored.getByTestId('settings-account-id').innerText();
        if (!accountId || restoredAccount !== accountId) throw new Error('Recovery opened a different Account');
    } catch {
        // The browser can include the recovery credential in locator and navigation error details.
        throw new Error('Recovery key sign-in did not redeem one challenge and open the same Account');
    } finally {
        await restoredContext.close();
    }
});

test('firstOpen.F14.returning | firstOpen.03.F14 reopens the recovery-key way after signing out on the same device', async ({ page, browser }) => {
    await openApp(page);
    await page.getByTestId('welcome-primary-start').click();
    await expectHome(page);

    const returningContext = await browser.newContext();
    try {
        const returning = await returningContext.newPage();
        const key = await revealRecoveryKey(page);
        await openApp(returning);
        await openRecoveryKeyWay(returning);
        await enterRecoveryKey(returning, key);

        await openApp(returning, '/settings/account');
        await returning.getByTestId('settings-account-logout').click();
        const greeting = returning.getByText(/^(Welcome back\.|Good to see you\.|Glad you're here\.|Welcome home\.)$/);
        await expect(greeting).toBeVisible();
        await openRecoveryKeyWay(returning);
        await enterRecoveryKey(returning, key);
    } catch {
        throw new Error('The returning device did not lead with recovery key after sign-out and reach Home again');
    } finally {
        await returningContext.close();
    }
});

test('firstOpen.02.F6 | firstOpen.03.F12 | firstOpen.F12.inviteOutcomes remembers first open on the invitation route and preserves its invalid outcome', async ({ page }) => {
    await openApp(page, '/join/invalid');
    await expect(page.getByTestId('team-join-invalid')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => readOpeningMarker(page)).toBeGreaterThan(0);
    await expect(page.getByTestId('home-hub')).toBeHidden();
    await page.getByTestId('unauth-shell-back-chevron').click();
    await expect(page.getByTestId('welcome-decision-panel')).toBeVisible();
});

test('firstOpen.04.F1 and firstOpen.04.F2 keep a double-click on the Approve step and return focus on Back', async ({ page }) => {
    await openApp(page);
    await waitForWelcomeMethods(page);
    const login = page.getByTestId('welcome-scan-existing-home');
    await expect(login).toBeVisible({ timeout: 60_000 });
    await login.dblclick();
    const qr = page.getByTestId('restore-requester-qr');
    await expect(qr).toBeVisible();
    const destination = qr.or(page.getByTestId('onboarding-wizard-bare-title'));
    const focused = page.locator(':focus').and(destination);
    const receivedFocus = await expect(focused).toHaveCount(1).then(() => true, () => false);
    await page.getByTestId('unauth-shell-back-chevron').click();
    await expect(login).toBeFocused();
    await expect(qr).toBeHidden();

    test.fail(true, 'FO-L3-MOTION: after a rapid double-click the Approve step mounts but browser focus stays on the document');
    expect(receivedFocus, 'the incoming Approve heading or QR receives focus').toBe(true);
});

test('firstOpen.04.F7 keeps Back usable and returns focus under the system reduced-motion preference', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page);
    await waitForWelcomeMethods(page);
    const login = page.getByTestId('welcome-scan-existing-home');
    await login.press('Enter');
    const qr = page.getByTestId('restore-requester-qr');
    await expect(qr.or(page.getByTestId('restore-sign-in-ways')).first()).toBeVisible();
    await page.getByTestId('unauth-shell-back-chevron').click();
    await expect(login).toBeVisible();

    await expect(login).toBeFocused();
});
