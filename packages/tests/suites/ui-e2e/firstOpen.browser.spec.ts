import { expect, test, type Page, type Request } from '@playwright/test';
import { parseTerminalConnectLinkV4Parameters } from '@happier-dev/protocol/auth/terminalConnectLinkV4';
import { join } from 'node:path';

import { ensureQaUiUrlHasHmrDisabled, resolveQaUiUrl } from '../../../../scripts/qa/resolveQaUiUrl.mjs';
import { resolveTestDbProvider, startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { startCliAuthLoginForTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { assertSameHomeComposerRestingBox, measureHomeComposerRestingBox } from '../../src/testkit/uiE2e/homeComposerRestingBox';
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
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
});
test.describe.configure({ timeout: 120_000 });

let server: StartedServer | undefined;
let ui: StartedUiWeb | undefined;
let uiBaseUrl: string;
const liveStack = Boolean(process.env.HAPPIER_QA_STACK_RUNTIME_JSON_PATH);

test.beforeAll(async () => {
    if (liveStack) {
        uiBaseUrl = ensureQaUiUrlHasHmrDisabled(resolveQaUiUrl());
        const serverUrl = new URL(uiBaseUrl).searchParams.get('server');
        if (!serverUrl) throw new Error('First-open QA requires a running Expo web and Home server');
        const response = await fetch(new URL('/v1/features', serverUrl));
        const features = await response.json();
        const advertised = features.capabilities?.server;
        if (advertised?.canonicalServerUrl) {
            const url = new URL(uiBaseUrl);
            url.searchParams.set('server', advertised.canonicalServerUrl);
            uiBaseUrl = url.href;
        }
        console.log('First-open Home', response.status, advertised?.webappUrl);
        return;
    }
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
    const url = new URL(path, uiBaseUrl);
    if (liveStack) {
        for (const [key, value] of new URL(uiBaseUrl).searchParams) {
            if (!url.searchParams.has(key)) url.searchParams.set(key, value);
        }
        page.on('response', response => {
            if (new URL(response.url()).pathname.endsWith('/index.ts.bundle')) {
                console.log('First-open bundle', response.status(), response.url());
            }
        });
    }
    await gotoCommittedWithRetries(page, url.href);
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
    if (liveStack) {
        // Metro can register an async factory before any caller evaluates it.
        const openingModules = await page.evaluate(() => {
            const metro = (globalThis as typeof globalThis & {
                __r?: { getModules?: () => Map<number, { verboseName?: string; isInitialized?: boolean }> };
            }).__r;
            const modules = metro?.getModules?.();
            if (!modules?.size) throw new Error('The repo-dev Metro module registry is unavailable');
            return Array.from(modules.values())
                .filter(module => module.isInitialized && /\/firstOpen\/FirstOpen(?:Host|Scene)\.tsx$/.test(module.verboseName ?? ''))
                .map(module => module.verboseName);
        });
        expect(openingModules).toEqual([]);
    }
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
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    const welcome = page.getByTestId('welcome-decision-panel');
    await expect(welcome).toBeAttached({ timeout: 60_000 });

    const scene = page.getByTestId('first-open.scene');
    await expect(scene.locator('[data-glyph-first-draw-ms]')).toBeAttached();
    await expect.poll(() => readOpeningMarker(page)).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(scene).not.toBeAttached();
    await expect(welcome.getByTestId('welcome-primary-start')).toBeVisible();
    await expect(welcome.getByRole('heading').first()).toBeFocused();
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName('first_open:destination-handoff').length)).toBe(1);
});

for (const phase of ['covered', 'revealed'] as const) {
    test(`firstOpen.04.F6 handles a trusted ${phase} Welcome press on first boot`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.bringToFront();
        await page.addInitScript(() => {
            const openingPressProbe = {
                readControlOpacity(control: Element) {
                    const welcome = control.closest('[data-testid="welcome-decision-panel"]');
                    for (let node: Element | null = control; node && node !== welcome; node = node.parentElement) {
                        if (node.getAnimations().some(animation => animation.effect instanceof KeyframeEffect
                            && animation.effect.getKeyframes().some(frame => 'opacity' in frame))) {
                            return Number(getComputedStyle(node).opacity);
                        }
                    }
                    return null;
                },
            };
            Object.assign(window, { openingPressProbe });
            document.addEventListener('pointerdown', event => {
                const target = event.target instanceof Element
                    ? event.target.closest('[data-testid="welcome-scan-existing-home"]')
                    : null;
                if (!target) return;
                document.documentElement.dataset.openingPress = JSON.stringify({
                    trusted: event.isTrusted,
                    scene: document.querySelector('[data-testid="first-open.scene"]') !== null,
                    opacity: openingPressProbe.readControlOpacity(target),
                });
            }, true);
        });
        await openApp(page);
        const login = page.getByTestId('welcome-scan-existing-home');
        const scene = page.getByTestId('first-open.scene');
        const restore = page.getByTestId('restore-requester-qr').or(page.getByTestId('restore-sign-in-ways')).first();
        const target = await page.waitForFunction(phase => {
            const login = document.querySelector('[data-testid="welcome-scan-existing-home"]');
            const opening = document.querySelector('[data-testid="first-open.scene"]');
            if (!(login instanceof HTMLElement) || !opening) return false;
            const opacity = (window as Window & { openingPressProbe: { readControlOpacity: (control: Element) => number | null } })
                .openingPressProbe.readControlOpacity(login);
            if (opacity === null || (phase === 'covered' ? opacity !== 0 : opacity < 0.05)) return false;
            const { x, y, width, height } = login.getBoundingClientRect();
            const center = { x: x + width / 2, y: y + height / 2 };
            return login.contains(document.elementFromPoint(center.x, center.y)) && center;
        }, phase, { timeout: 60_000 });
        const { x, y } = await target.jsonValue();
        await page.mouse.click(x, y);
        const press = await page.evaluate(() => JSON.parse(document.documentElement.dataset.openingPress ?? 'null'));
        expect(press).toMatchObject({ trusted: true, scene: true });
        if (phase === 'covered') {
            expect(press.opacity).toBe(0);
            await expect(scene).not.toBeAttached();
            await expect(restore).toBeHidden();
            await expect(login).toBeVisible();
            await expect(page.getByTestId('welcome-decision-panel').getByRole('heading').first()).toBeFocused();
            await login.click();
        } else {
            expect(press.opacity).toBeGreaterThan(0);
        }
        await expect(restore).toBeVisible();
    });
}

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

test('firstOpen.F13.terminal reads the CLI request at Accept and stops URL-only legacy links before transport', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page);
    await page.getByTestId('welcome-primary-start').click();
    await expectHome(page);
    const serverUrl = server?.baseUrl ?? new URL(uiBaseUrl).searchParams.get('server');
    if (!serverUrl) throw new Error('The terminal replay needs the selected Home');
    const cli = await startCliAuthLoginForTerminalConnect({
        testDir: testInfo.outputPath('terminal'),
        cliHomeDir: testInfo.outputPath(join('terminal', 'cli-home')),
        serverUrl, webappUrl: uiBaseUrl,
        waitForConnectUrlReady: false,
        env: { ...process.env, CI: '1', HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_VARIANT: 'dev' },
    });
    const reads = countRequests(page, '/v1/auth/request/status', 'GET');
    const approvals = countRequests(page, '/v1/auth/response', 'POST');
    const observe = () => ({ reads: reads.value(), approvals: approvals.value() });
    const openLink = async (href: string) => {
        // Navigation diagnostics must not reveal the CLI's pairing proof.
        await page.goto(href, { waitUntil: 'commit' }).catch(() => { throw new Error('Could not open the terminal link'); });
    };
    try {
        const legacy = new URL(cli.connectUrl);
        const params = new URLSearchParams(legacy.hash.slice(1));
        const envelope = parseTerminalConnectLinkV4Parameters(params);
        if (envelope) {
            params.delete('v4');
            params.set('key', envelope.publicKeyB64Url);
            params.set('server', envelope.homeConnectionDescriptor.canonicalServerUrl);
            params.set('pairingSecret', envelope.pairing.secretB64Url);
            params.set('createdAt', String(envelope.pairing.createdAtMs));
            params.set('expiresAt', String(envelope.pairing.expiresAtMs));
        }
        params.delete('serverIdentityId');
        params.delete('supportsTokenOnly');
        legacy.hash = params.toString();
        await openLink(legacy.href);
        await expect(page.getByTestId('terminal-connect-next')).toBeVisible();
        await expect(page.getByText('Update required', { exact: true })).toBeVisible();
        expect(observe()).toEqual({ reads: 0, approvals: 0 });

        await openLink(cli.connectUrl);
        const approve = page.getByTestId('terminal-connect-approve');
        await expect(approve).toBeEnabled();
        expect(observe()).toEqual({ reads: 0, approvals: 0 });
        const status = page.waitForResponse(response => response.request().method() === 'GET'
            && new URL(response.url()).pathname === '/v1/auth/request/status');
        await approve.click();
        expect(await (await status).json()).toMatchObject({ status: 'pending', supportsV2: true });
        await expect(page.getByTestId('terminal-connect-continue')).toBeVisible();
        expect(observe()).toEqual({ reads: 1, approvals: 1 });
        await cli.waitForSuccess();
        await page.getByTestId('terminal-connect-continue').click();
        await expect.poll(() => new URL(page.url()).pathname).toBe('/');
        expect(observe()).toEqual({ reads: 1, approvals: 1 });
    } finally {
        reads.stop();
        approvals.stop();
        await cli.stop();
    }
});

test('Home reserves the resting composer box before opening the editor', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
    await openApp(page);
    await page.getByTestId('welcome-primary-start').click();
    await expectHome(page);

    const closed = page.getByTestId('hub-composer.open');
    const seat = page.getByTestId('hub-composer.intent');
    const editor = seat.getByTestId('agent-input-composer');
    await expect(closed).toBeVisible();
    await expect(closed.getByTestId('agent-input-document-preview-text')).toHaveText(/\S/);
    await expect(editor).toHaveCount(0);
    await page.evaluate(async () => { await document.fonts.ready; });
    const before = await measureHomeComposerRestingBox(page);
    await closed.press('Enter');
    await expect(editor).toBeVisible();
    await expect(closed).toHaveCount(0);
    assertSameHomeComposerRestingBox(before, await measureHomeComposerRestingBox(page));
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

for (const [width, height] of [[1224, 600], [390, 640], [1440, 900], [390, 844]] as const) {
    test(`firstOpen.F15.notices keeps Login fixed through notice arrival, replacement and retry at ${width}×${height}`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        let response: 'outage' | 'incompatible' | 'available' = 'outage';
        let releaseDiscovery = () => {};
        let discoveryPending = new Promise<void>(resolve => { releaseDiscovery = resolve; });
        const discovery = /^https?:\/\/[^/]+\/v1\/(features|auth\/entry)(\?.*)?$/;
        await page.route(discovery, async route => {
            await discoveryPending;
            if (response === 'outage') await route.abort('connectionrefused');
            else if (response === 'incompatible' && route.request().method() === 'GET') {
                await route.fulfill({ json: { features: null }, headers: { 'access-control-allow-origin': '*' } });
            } else await route.continue();
        });
        const features = countRequests(page, '/v1/features', 'GET');
        const entry = countRequests(page, '/v1/auth/entry', 'POST');
        try {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await openApp(page);
            const welcome = page.getByTestId('welcome-decision-panel').and(page.locator(':not([aria-hidden="true"])'));
            const notice = welcome.getByTestId('welcome-auth-blocked');
            const login = welcome.getByTestId('welcome-scan-existing-home');
            await expect(login).toBeVisible({ timeout: 60_000 });
            // While the Home's ways in load, the welcome holds the primary door's place and offers no dead-end door.
            const pendingDoor = welcome.getByTestId('welcome-primary-door-pending');
            await expect(pendingDoor).toHaveCount(1);
            await expect(welcome.getByTestId('welcome-account-service-choose')).toHaveCount(0);
            releaseDiscovery();
            // An unreachable Home settles into its own ways (a truthful change of form); from here the notice changes alone.
            await expect(notice).toBeVisible({ timeout: 60_000 });
            const hideNotice = await page.addStyleTag({ content:
                '[data-testid="welcome-notice-slot"] { height: 0 !important; padding: 0 !important; margin: 0 !important; overflow: hidden; }',
            });
            const settledFrame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await login.focus();
            await settledFrame();
            const door = await login.boundingBox();
            expect(door).not.toBeNull();

            // Isolate notice arrival from the different controls shown while discovery is still pending.
            await hideNotice.evaluate(element => element.remove());
            await settledFrame();
            await expect(login).toBeFocused();
            expect(await login.boundingBox()).toEqual(door);

            const before = { features: features.value(), entry: entry.value() };
            const firstNotice = await notice.innerText();
            const firstNoticeBox = await notice.boundingBox();
            expect(firstNoticeBox).not.toBeNull();
            const retry = welcome.getByTestId('welcome-auth-blocked-retry');
            response = 'incompatible';
            discoveryPending = new Promise<void>(resolve => { releaseDiscovery = resolve; });
            await retry.press('Enter');
            await login.focus();
            // Give the replacement the space a longer translation needs, regardless of the runner fonts.
            await page.addStyleTag({ content: `[data-testid="welcome-auth-blocked"] { min-height: ${(firstNoticeBox?.height ?? 0) + 48}px; }` });
            releaseDiscovery();
            await expect.poll(() => notice.innerText()).not.toBe(firstNotice);
            expect((await notice.boundingBox())?.height).toBeGreaterThan(firstNoticeBox?.height ?? 0);
            await expect(login).toBeFocused();
            expect(await login.boundingBox()).toEqual(door);
            expect(features.value() - before.features).toBe(1);
            expect(entry.value() - before.entry).toBe(1);

            response = 'available';
            await retry.press('Enter');
            await expect(welcome.getByTestId('welcome-primary-start')).toBeVisible();
            await expect(notice).toBeHidden();
            await expect(login).toBeVisible();
            expect(features.value() - before.features).toBe(2);
            expect(entry.value() - before.entry).toBe(2);
        } finally {
            releaseDiscovery();
            features.stop();
            entry.stop();
        }
    });
}

// Samples every painted frame of a Welcome step move: the departing heading (live or its paint copy) and the
// arriving step's heading. A string keeps the transpiler's helper names out of the page.
const welcomeMoveSampler = `(() => {
    const frames = [];
    const opacity = (element) => {
        if (!element || !element.getBoundingClientRect().width) return 0;
        let value = 1;
        for (let node = element; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.visibility === 'hidden') return 0;
            value *= Number(style.opacity);
        }
        return value;
    };
    const state = { frame: 0, frames };
    const tick = (at) => {
        const live = document.querySelector('[data-testid="welcome-decision-panel"] [role="heading"]');
        const copy = document.querySelector('body > [inert][aria-hidden="true"] [role="heading"]');
        const incoming = Array.from(document.querySelectorAll('[role="heading"]'))
            .find(element => !element.closest('[data-testid="welcome-decision-panel"]') && !element.closest('body > [inert]'));
        frames.push({ at, outgoing: Math.max(opacity(live), opacity(copy)), incoming: opacity(incoming ?? null) });
        state.frame = requestAnimationFrame(tick);
    };
    state.frame = requestAnimationFrame(tick);
    return state;
})()`;

async function sampleWelcomeMove(page: Page) {
    const probe = await page.evaluateHandle(welcomeMoveSampler);
    return async () => {
        const frames = await probe.evaluate((state: { frame: number; frames: Array<{ at: number; outgoing: number; incoming: number }> }) => {
            cancelAnimationFrame(state.frame);
            return state.frames;
        });
        await probe.dispose();
        expect(frames.some(frame => frame.outgoing > 0)).toBe(true);
        expect(frames.some(frame => frame.incoming > 0)).toBe(true);
        // One continuous move: no painted frame shows neither step.
        expect(frames.filter(frame => frame.outgoing === 0 && frame.incoming === 0)).toEqual([]);
    };
}

test('firstOpen.04.F1 and firstOpen.04.F2 keep a double-click on the Approve step and return focus on Back', async ({ page }) => {
    await openApp(page);
    await waitForWelcomeMethods(page);
    const login = page.getByTestId('welcome-scan-existing-home');
    await expect(login).toBeVisible({ timeout: 60_000 });
    const qrRequest = '**/v2/auth/account/request';
    let releaseRegistration = () => {};
    const registrationPending = new Promise<void>(resolve => { releaseRegistration = resolve; });
    const starts = countRequests(page, '/v2/auth/account/request', 'POST');
    await page.route(qrRequest, async route => {
        await registrationPending;
        await route.continue();
    });
    const captures = await page.evaluateHandle(() => {
        const count = { freezes: 0 };
        const observer = new MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (node instanceof HTMLElement && node.inert && node.getAttribute('aria-hidden') === 'true') {
                        count.freezes++;
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true });
        return { count, observer };
    });
    const checkContinuity = await sampleWelcomeMove(page);
    try {
        await login.dblclick();
        const pendingQr = page.getByTestId('restore-requester-qr-pending');
        const qr = page.getByTestId('restore-requester-qr');
        await expect(pendingQr).toBeVisible();
        await expect(qr).toBeHidden();
        const destination = pendingQr.or(page.getByTestId('onboarding-wizard-bare-title'));
        await expect(page.locator(':focus').and(destination)).toHaveCount(1);
        await expect.poll(starts.value).toBe(1);
        releaseRegistration();
        await expect(qr).toBeFocused();
        expect(starts.value()).toBe(1);
        expect(await captures.evaluate(probe => probe.count.freezes)).toBe(1);
        await checkContinuity();
        // Settled: no retained paint copy.
        await expect(page.locator('body > [inert][aria-hidden="true"]')).toHaveCount(0);

        await page.getByTestId('unauth-shell-back-chevron').click();
        await expect(login).toBeFocused();
        await expect(qr).toBeHidden();
        await expect(page.getByTestId('step-motion-glyphs')).toHaveCount(0);
        await expect(page.locator('body > [inert][aria-hidden="true"]')).toHaveCount(0);
    } finally {
        await captures.evaluate(probe => probe.observer.disconnect());
        await captures.dispose();
        releaseRegistration();
        starts.stop();
        await page.unroute(qrRequest);
    }
});

test('firstOpen.04.F7 keeps Back usable and returns focus under the system reduced-motion preference', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page);
    await waitForWelcomeMethods(page);
    const login = page.getByTestId('welcome-scan-existing-home');
    const checkContinuity = await sampleWelcomeMove(page);
    await login.press('Enter');
    const qr = page.getByTestId('restore-requester-qr');
    await expect(qr.or(page.getByTestId('restore-sign-in-ways')).first()).toBeVisible();
    await checkContinuity();
    await page.getByTestId('unauth-shell-back-chevron').click();
    await expect(login).toBeVisible();

    await expect(login).toBeFocused();
});
