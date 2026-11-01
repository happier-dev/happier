import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import * as privacyKit from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { readHappierCliChoiceSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { writeUpdateCache } from '@happier-dev/cli-common/update';
import { SETUP_CLI_CHOICE_PROMPT_KIND, SETUP_PAIRING_PROMPT_KIND } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { fetchJson } from '../../src/testkit/http';
import { fetchMachineIdentities, type MachineIdentityRow } from '../../src/testkit/machineIdentity';
import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import {
    attachDesktopSystemTaskHost,
    createDesktopSystemTaskHost,
    type DesktopSystemTaskHost,
    type DesktopSystemTaskRecord,
} from '../../src/testkit/uiE2e/desktopSetup/desktopSystemTaskHost';
import { createHermeticDesktopComputer, type HermeticDesktopComputer } from '../../src/testkit/uiE2e/desktopSetup/hermeticDesktopComputer';
import { attachRelayMachineRpcTap, readinessProofCalls, type RelayMachineRpcTap } from '../../src/testkit/uiE2e/desktopSetup/relayMachineRpcTap';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { installFakeTauriDesktopBridge, navigateSpa } from '../../src/testkit/uiE2e/fakeTauriDesktop';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

/**
 * Desktop first-run setup, end to end, with nothing between the UI and the real setup executor but
 * the desktop bridge's transport: the page is the real app (fake Tauri internals only), system
 * tasks run the real `hsetup` built from this checkout, which drives the real CLI built from this
 * checkout (installed as the desktop-managed CLI) against a real relay, in a hermetic HOME whose
 * only test double is the systemd user manager. Every assertion reads UI state, task results or
 * relay/computer state; no step waits a fixed time. "Ready" is the production proof itself: the
 * machine answered the coordinator's read-only `capabilities.describe` through the relay (INV10),
 * read from the page's relay socket.
 */

const run = createRunDirs({ runLabel: 'ui-e2e' });

type SeededAccount = Readonly<{ token: string; secret: Uint8Array; accountId: string }>;

async function createSeededAccount(baseUrl: string): Promise<SeededAccount> {
    const secret = Uint8Array.from(randomBytes(32));
    const keyPair = tweetnacl.sign.keyPair.fromSeed(secret);
    const challenge = Uint8Array.from(randomBytes(32));
    const signature = tweetnacl.sign.detached(challenge, keyPair.secretKey);
    const auth = await fetchJson<{ token?: string }>(`${baseUrl}/v1/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            publicKey: privacyKit.encodeBase64(Uint8Array.from(keyPair.publicKey)),
            challenge: privacyKit.encodeBase64(challenge),
            signature: privacyKit.encodeBase64(Uint8Array.from(signature)),
        }),
        timeoutMs: 15_000,
    });
    if (auth.status !== 200 || typeof auth.data?.token !== 'string') throw new Error(`account creation failed (status=${auth.status})`);
    return { token: auth.data.token, secret, accountId: await readAccountId(baseUrl, auth.data.token) };
}

async function readAccountId(baseUrl: string, token: string): Promise<string> {
    const profile = await fetchJson<{ id?: string }>(`${baseUrl}/v1/account/profile`, {
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 15_000,
    });
    if (profile.status !== 200 || typeof profile.data?.id !== 'string') throw new Error(`profile read failed (status=${profile.status})`);
    return profile.data.id;
}

/** The app's own credentials for the relay it is signed in to (`auth_credentials__srv_*`). */
async function readAppCredentials(page: Page): Promise<Readonly<{ token: string; secret: Uint8Array }>> {
    const raw = await page.evaluate(() => {
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (!key?.startsWith('auth_credentials__srv_')) continue;
            const value = localStorage.getItem(key);
            if (value) return value;
        }
        return null;
    });
    const parsed = raw ? JSON.parse(raw) as { token?: unknown; secret?: unknown } : null;
    if (typeof parsed?.token !== 'string' || typeof parsed.secret !== 'string') throw new Error('app has no stored credentials');
    return { token: parsed.token, secret: Uint8Array.from(Buffer.from(parsed.secret, 'base64url')) };
}

function accountIdHint(accountId: string): RegExp {
    // Prove both ends identify the same account without duplicating the UI's display formatter.
    return new RegExp(accountId.slice(0, 6) + '[^ ]*' + accountId.slice(-4));
}

function relayHost(url: string): string {
    return new URL(url).host;
}

type DesktopApp = Readonly<{ page: Page; host: DesktopSystemTaskHost; relay: RelayMachineRpcTap; diagnostics: () => string }>;

/**
 * Opens the app as the desktop shell would: Tauri internals present from the first script, system
 * tasks relayed to this computer's hsetup. `launchEnv` is what the shell that started the app adds
 * to hsetup's environment (a stack-launched app inherits its stack's relay selection).
 */
async function openDesktopApp(params: Readonly<{
    context: BrowserContext;
    computer: HermeticDesktopComputer;
    uiBaseUrl: string;
    path?: string;
    launchEnv?: NodeJS.ProcessEnv;
}>): Promise<DesktopApp> {
    const page = await params.context.newPage();
    await page.setViewportSize({ width: 1280, height: 820 });
    const diagnostics = collectBrowserDiagnostics({ page });
    await installFakeTauriDesktopBridge(page, { state: { platform: 'linux' } });
    const relay = await attachRelayMachineRpcTap(page);
    const launch = params.launchEnv
        ? { ...params.computer.hsetup, env: { ...params.computer.hsetup.env, ...params.launchEnv } }
        : params.computer.hsetup;
    const host = await attachDesktopSystemTaskHost(page, (emit) => createDesktopSystemTaskHost({
        launch,
        emit,
        logPath: `${params.computer.logDir}/system-tasks.log`,
    }));
    await gotoDomContentLoadedWithRetries(page, `${params.uiBaseUrl}${params.path ?? '/'}?happier_hmr=0`, 180_000);
    return { page, host, relay, diagnostics };
}

function tasksOfKind(host: DesktopSystemTaskHost, kind: string): DesktopSystemTaskRecord[] {
    return host.tasks().filter((task) => task.kind === kind);
}

/** Answers the app sent to prompts a person would have to see (everything but silent pairing approval). */
function userFacingPromptKinds(host: DesktopSystemTaskHost): string[] {
    return host.tasks().flatMap((task) => task.snapshot.events
        .filter((event) => event.type === 'prompt')
        .map((event) => String((event.data as { kind?: unknown } | null)?.kind ?? 'unknown'))
        .filter((kind) => kind !== SETUP_PAIRING_PROMPT_KIND));
}

async function waitForSuccessfulSetupRun(host: DesktopSystemTaskHost, timeoutMs: number): Promise<DesktopSystemTaskRecord> {
    await expect.poll(() => tasksOfKind(host, 'setup.thisComputer.v1').some((task) => task.snapshot.result?.ok === true), {
        message: 'setup.thisComputer.v1 never succeeded',
        timeout: timeoutMs,
    }).toBe(true);
    return tasksOfKind(host, 'setup.thisComputer.v1').find((task) => task.snapshot.result?.ok === true)!;
}

function readSetupMachineId(task: DesktopSystemTaskRecord): string {
    const result = task.snapshot.result;
    if (!result?.ok) throw new Error('setup run did not succeed');
    const machineId = (result.data as { machineId?: unknown } | null)?.machineId;
    if (typeof machineId !== 'string' || !machineId) throw new Error('setup result has no machine id');
    return machineId;
}

async function confirmRelayMove(page: Page): Promise<void> {
    // Move/Switch is the last configured action. The three-button modal renders 0, 2, 1,
    // so DOM order would select Connect too instead of the final configured action.
    const buttons = page.locator('[data-testid^="web-modal-button-"]');
    const move = page.getByTestId(`web-modal-button-${await buttons.count() - 1}`);
    await expect(move).toBeEnabled();
    await move.click();
}

async function waitForActiveMachine(params: Readonly<{ baseUrl: string; token: string; machineId: string; timeoutMs: number }>): Promise<MachineIdentityRow> {
    let row: MachineIdentityRow | undefined;
    await expect.poll(async () => {
        row = (await fetchMachineIdentities({ baseUrl: params.baseUrl, token: params.token })).find((machine) => machine.id === params.machineId);
        return row?.active === true;
    }, { message: `machine ${params.machineId} never became active for the account`, timeout: params.timeoutMs }).toBe(true);
    return row!;
}

/**
 * This computer was proven ready by the production proof (INV8 + INV10): the machine answered the
 * app's read-only `capabilities.describe` through the relay — a real acknowledgement, not the
 * armed fault — and the Home panel left with nothing blocking.
 */
async function expectThisComputerReady(app: DesktopApp, machineId: string, timeoutMs: number): Promise<void> {
    try {
        await expect.poll(() => readinessProofCalls(app.relay, machineId).some((call) => !call.injected
            && call.ack?.ok === true
            && typeof call.ack.result === 'string'), {
            message: `machine ${machineId} never answered the app's ${RPC_METHODS.CAPABILITIES_DESCRIBE} through the relay`,
            timeout: timeoutMs,
        }).toBe(true);
    } catch (error) {
        // Which boundary failed: no proof asked (the coordinator never saw a converged runtime),
        // or asked and not answered.
        const proofs = app.relay.calls().filter((call) => call.method.endsWith(`:${RPC_METHODS.CAPABILITIES_DESCRIBE}`));
        if (error instanceof Error) error.message += `\nreadiness proofs seen: ${JSON.stringify(proofs.map((call) => ({ method: call.method, ok: call.ack?.ok ?? null, error: call.ack?.error ?? null, injected: call.injected })))}`;
        throw error;
    }
    await expect(app.page.getByTestId('desktop-setup-panel:veil')).toHaveCount(0, { timeout: timeoutMs });
    await expect(app.page.getByTestId('desktop-setup-panel:blocked')).toHaveCount(0);
}

/** What a person does from a terminal: sign the CLI in to `account` on `relayUrl` and install the service. */
async function setUpFromTerminal(computer: HermeticDesktopComputer, relayUrl: string, account: Readonly<{ token: string; secret: Uint8Array }>): Promise<Readonly<{ serverId: string }>> {
    const { serverId } = await seedCliAuthForServer({ cliHome: computer.happierHomeDir, serverUrl: relayUrl, token: account.token, secret: account.secret });
    await computer.runCli(['daemon', 'service', 'install', '--json'], { timeoutMs: 180_000 });
    const status = await readDaemonStatus(computer);
    // The terminal setup itself must be healthy, or every later assertion reads a broken fixture.
    expect(status.runtimeConvergence, 'terminal-installed service did not converge').toEqual({
        controlReachable: true,
        serviceOwnsRunningDaemon: true,
        machineIdMatches: true,
        cliVersionMatches: true,
    });
    return { serverId };
}

type DaemonStatus = Readonly<{
    server?: { serverUrl?: string | null };
    auth?: { accountId?: string | null; machineId?: string | null };
    runtimeConvergence?: Record<string, boolean> | null;
}>;

async function readDaemonStatus(computer: HermeticDesktopComputer): Promise<DaemonStatus> {
    const result = await computer.runCli(['daemon', 'status', '--json'], { timeoutMs: 60_000, allowFailure: true });
    const start = result.stdout.indexOf('{');
    if (start < 0) throw new Error(`daemon status printed no JSON:\n${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout.slice(start)) as { data?: DaemonStatus } & DaemonStatus;
    return parsed.data ?? parsed;
}

/** The running daemon's pid, from the state file the daemon writes for its relay profile. */
function readRunningDaemonPids(computer: HermeticDesktopComputer): number[] {
    const serversDir = join(computer.happierHomeDir, 'servers');
    if (!existsSync(serversDir)) return [];
    return readdirSync(serversDir).flatMap((serverId) => {
        const statePath = join(serversDir, serverId, 'daemon.state.json');
        if (!existsSync(statePath)) return [];
        const pid = Number((JSON.parse(readFileSync(statePath, 'utf8')) as { pid?: unknown }).pid);
        return Number.isInteger(pid) && isProcessAlive(pid) ? [pid] : [];
    });
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

const MUTATING_SYSTEMCTL_VERBS = new Set(['daemon-reload', 'enable', 'disable', 'restart', 'stop']);

function mutatingSystemctlCalls(computer: HermeticDesktopComputer): string[][] {
    return computer.systemctlInvocations().filter((argv) => argv.some((arg) => MUTATING_SYSTEMCTL_VERBS.has(arg)));
}

/** Signs up a new account in a plain browser tab (no desktop shell, so no local setup runs). */
async function signUpInPlainBrowser(context: BrowserContext, uiBaseUrl: string): Promise<Readonly<{ token: string; secret: Uint8Array }>> {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 820 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
    await ensureAccountReadyForConnect({ page, timeoutMs: 180_000 });
    const credentials = await readAppCredentials(page);
    await page.close();
    return credentials;
}

/** A proven-ready computer as the Home shows it: the panel left and a session can start on a machine. */
async function expectHomeOffersThisComputer(app: DesktopApp, machineId: string, timeoutMs: number): Promise<void> {
    await expect(app.page.getByTestId('session-getting-started-kind-create_session')).toHaveCount(1, { timeout: timeoutMs });
    await expectThisComputerReady(app, machineId, timeoutMs);
}

/** R12's question as the executor asked it (the prompt events the app answered), newest last. */
function cliChoicePrompts(host: DesktopSystemTaskHost): Array<Readonly<{ command?: unknown; missing?: unknown }>> {
    return host.tasks().flatMap((task) => task.snapshot.events
        .filter((event) => event.type === 'prompt' && (event.data as { kind?: unknown } | null)?.kind === SETUP_CLI_CHOICE_PROMPT_KIND)
        .map((event) => event.data as { command?: unknown; missing?: unknown }));
}

/**
 * Waits for this app's first R12 question, checks it names `command`, and answers it in the app:
 * `web-modal-button-0` is "Keep my own", `-1` "Let Happier manage it" (`presentCliChoice`).
 */
async function answerCliChoice(app: DesktopApp, command: string, answer: 'own' | 'managed', timeoutMs: number): Promise<Readonly<{ command?: unknown; missing?: unknown }>> {
    await expect.poll(() => cliChoicePrompts(app.host).length, { message: 'setup never asked which command line to use', timeout: timeoutMs })
        .toBeGreaterThan(0);
    const question = cliChoicePrompts(app.host)[0]!;
    expect(question.command).toBe(command);
    await app.page.getByTestId(answer === 'own' ? 'web-modal-button-0' : 'web-modal-button-1').click({ timeout: 60_000 });
    return question;
}

test.describe('ui e2e: desktop local setup through the real hsetup (hermetic computer)', () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(process.platform !== 'linux', 'the hermetic computer models the systemd user manager (Linux only)');

    const suiteDir = run.testDir('desktop-local-setup-real-hsetup-suite');
    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl = '';
    const computers: HermeticDesktopComputer[] = [];

    const uiWebEnv: NodeJS.ProcessEnv = {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
        // No runner-mode override: with Tauri internals present the app picks its real Tauri bridge.
        EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE: '',
        // Socket.IO over WebSocket from the first packet, so every relay RPC crosses the one route
        // the readiness proof is read from (`relayMachineRpcTap`). Transport only: the relay's RPC
        // handler, encryption and the coordinator's proof are unchanged.
        EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET: '1',
    };

    test.beforeAll(async () => {
        test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
        await mkdir(suiteDir, { recursive: true });
        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: { HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys' },
        });
        ui = await startUiWeb({ testDir: suiteDir, env: { ...uiWebEnv, EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl } });
        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterEach(async () => {
        for (const computer of computers.splice(0)) await computer.destroy();
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    async function newComputer(label: string, options: Readonly<{ ring?: 'stable' | 'publicdev'; foreignCli?: boolean; foreignCliFirst?: boolean }> = {}): Promise<HermeticDesktopComputer> {
        const computer = await createHermeticDesktopComputer({ label, testDir: run.testDir(`desktop-local-setup-${label}`), ...options });
        computers.push(computer);
        return computer;
    }

    test('fresh first setup: the app is usable at once and this computer becomes ready without a question', async ({ context }) => {
        test.setTimeout(180_000);
        if (!server) throw new Error('missing server');
        const computer = await newComputer('fresh');
        const app = await openDesktopApp({ context, computer, uiBaseUrl });
        try {
            await ensureAccountReadyForConnect({ page: app.page, timeoutMs: 180_000 });
            // R11: while this computer is still being set up the shell is already usable, and
            // leaving the Home does not pause setup (its owner is the shell, not the Home route).
            await expect.poll(async () => (await app.page.getByTestId('desktop-setup-panel:veil').count()) > 0
                && await app.page.getByTestId('nav-settings').first().isVisible(), {
                message: 'the shell was never usable while the setup panel was up',
                timeout: 120_000,
                intervals: [100, 250, 500],
            }).toBe(true);
            await app.page.getByTestId('nav-settings').first().click();
            await expect(app.page).toHaveURL(/\/settings/, { timeout: 60_000 });

            const setup = await waitForSuccessfulSetupRun(app.host, 240_000);
            expect(setup.params).toMatchObject({ activeRelayUrl: server.baseUrl, activeLocalRelayUrl: null, channel: 'dev' });
            const machineId = readSetupMachineId(setup);
            await navigateSpa(app.page, '/?happier_hmr=0');
            await expectHomeOffersThisComputer(app, machineId, 120_000);

            const credentials = await readAppCredentials(app.page);
            await waitForActiveMachine({ baseUrl: server.baseUrl, token: credentials.token, machineId, timeoutMs: 60_000 });
            expect(userFacingPromptKinds(app.host)).toEqual([]);
            await expect(app.page.getByTestId('web-modal-confirm')).toHaveCount(0);
        } catch (error) {
            throw appendBrowserDiagnostics(error, app.diagnostics());
        }
    });

    test('daemon paired to another account: the question names both accounts; Keep leaves it, Switch moves it', async ({ context }) => {
        test.setTimeout(180_000);
        if (!server) throw new Error('missing server');
        const computer = await newComputer('account');
        const accountB = await createSeededAccount(server.baseUrl);
        await setUpFromTerminal(computer, server.baseUrl, accountB);
        const before = computer.stateFingerprint();
        const daemonPidsBefore = readRunningDaemonPids(computer);
        expect(daemonPidsBefore).toHaveLength(1);

        const app = await openDesktopApp({ context, computer, uiBaseUrl });
        try {
            await ensureAccountReadyForConnect({ page: app.page, timeoutMs: 180_000 });
            const title = app.page.getByText(/^Switch this computer to .+\?$/);
            await expect(title).toBeVisible({ timeout: 240_000 });
            const toLabel = /^Switch this computer to (.+)\?$/.exec((await title.textContent()) ?? '')?.[1] ?? '';
            const body = app.page.getByText(/^This computer is signed in to /);
            await expect(body).toContainText(accountIdHint(accountB.accountId));
            await expect(body).toContainText(toLabel);
            await expect(body).toContainText(relayHost(server.baseUrl));

            // Keep: B's credentials, relay, service definition and running daemon stay exactly as they were.
            await app.page.getByTestId('web-modal-button-0').click();
            await expect(title).toHaveCount(0);
            await expect(app.page.getByTestId('nav-settings').first()).toBeVisible();
            await expect(app.page.getByTestId('desktop-setup-panel:veil')).toHaveCount(0, { timeout: 60_000 });
            // The Home says, in one sentence with one action, that this computer stays with B (R17).
            await expect(app.page.getByTestId('relay-drift-banner')).toContainText(accountIdHint(accountB.accountId), { timeout: 60_000 });
            // The same recovery action must remain readable inside the narrow desktop sidebar.
            await app.page.setViewportSize({ width: 1042, height: 680 });
            const driftCard = app.page.getByTestId('relay-drift-banner');
            const driftAction = app.page.getByTestId('relay-drift-banner-primary');
            await expect.poll(async () => {
                const card = await driftCard.boundingBox();
                const action = await driftAction.boundingBox();
                return Boolean(card && action && action.x >= card.x && action.x + action.width <= card.x + card.width);
            }).toBe(true);
            await expect.poll(() => driftAction.evaluate((button) => {
                const bounds = button.getBoundingClientRect();
                const text = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
                let node: Node | null;
                while ((node = text.nextNode())) {
                    if (!node.textContent?.trim()) continue;
                    const range = document.createRange();
                    range.selectNodeContents(node);
                    for (const line of range.getClientRects()) {
                        if (line.left < bounds.left || line.right > bounds.right || line.top < bounds.top || line.bottom > bounds.bottom) return false;
                    }
                }
                return true;
            })).toBe(true);
            await app.page.setViewportSize({ width: 1280, height: 820 });
            expect(tasksOfKind(app.host, 'setup.thisComputer.v1').filter((task) => task.snapshot.result?.ok === true)).toEqual([]);
            expect(computer.stateFingerprint()).toEqual(before);
            expect(readRunningDaemonPids(computer)).toEqual(daemonPidsBefore);
            expect((await readDaemonStatus(computer)).auth?.accountId).toBe(accountB.accountId);

            // Switch, from Settings › This computer: the same question, then this computer moves to A.
            await navigateSpa(app.page, '/settings/machines/this-computer?happier_hmr=0');
            const start = app.page.getByTestId('settings.machineSetup.startLocalTask').or(app.page.getByTestId('settings.localDaemonControl.repair'));
            await start.first().click({ timeout: 120_000 });
            await expect(title).toBeVisible({ timeout: 120_000 });
            await app.page.getByTestId('web-modal-button-1').click();

            const setup = await waitForSuccessfulSetupRun(app.host, 240_000);
            expect(setup.snapshot.result).toMatchObject({ ok: true, data: { credentialsChanged: true } });
            const credentials = await readAppCredentials(app.page);
            await waitForActiveMachine({ baseUrl: server.baseUrl, token: credentials.token, machineId: readSetupMachineId(setup), timeoutMs: 120_000 });
            expect((await readDaemonStatus(computer)).auth?.accountId).toBe(setup.params && (setup.params as { expectedAccountId?: string }).expectedAccountId);
            await expectThisComputerReady(app, readSetupMachineId(setup), 120_000);
        } catch (error) {
            throw appendBrowserDiagnostics(error, app.diagnostics());
        }
    });

    /**
     * A computer whose daemon was set up from the terminal on another relay. With that relay up the
     * daemon's account is validated there, so leaving it is an account change (D1); with it gone
     * nothing validates the account and the question is the relay move alone (UD5).
     */
    async function setUpOnAnotherRelay(label: string): Promise<Readonly<{ computer: HermeticDesktopComputer; otherRelay: StartedServer; otherRelayUrl: string; otherServerId: string; otherAccount: SeededAccount }>> {
        const otherRelay = await startServerLight({
            testDir: run.testDir(`desktop-local-setup-${label}-other-relay`),
            dbProvider: 'sqlite',
            extraEnv: { HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys' },
        });
        // `localhost` rather than the app relay's 127.0.0.1, so the two hosts read differently.
        const otherRelayUrl = otherRelay.baseUrl.replace('127.0.0.1', 'localhost');
        const computer = await newComputer(label);
        const otherAccount = await createSeededAccount(otherRelay.baseUrl);
        const { serverId: otherServerId } = await setUpFromTerminal(computer, otherRelayUrl, otherAccount);
        return { computer, otherRelay, otherRelayUrl, otherServerId, otherAccount };
    }

    async function expectConvergedOnAppRelay(app: DesktopApp, computer: HermeticDesktopComputer, appRelayUrl: string, options: Readonly<{ proveReady?: boolean }> = {}): Promise<Readonly<{ machineId: string; appAccountId: string; daemonAccountId: string | null }>> {
        const setup = await waitForSuccessfulSetupRun(app.host, 240_000);
        expect(setup.snapshot.result).toMatchObject({ ok: true, data: { relayChanged: true } });
        const machineId = readSetupMachineId(setup);
        if (options.proveReady !== false) await expectHomeOffersThisComputer(app, machineId, 180_000);
        const credentials = await readAppCredentials(app.page);
        await waitForActiveMachine({ baseUrl: appRelayUrl, token: credentials.token, machineId, timeoutMs: 120_000 });
        const status = await readDaemonStatus(computer);
        expect(status.server?.serverUrl).toBe(appRelayUrl);
        return { machineId, appAccountId: await readAccountId(appRelayUrl, credentials.token), daemonAccountId: status.auth?.accountId ?? null };
    }

    test('daemon on another relay (still up): the account question names both relays and both accounts; Switch converges', async ({ context }) => {
        test.setTimeout(180_000);
        if (!server) throw new Error('missing server');
        const { computer, otherRelay, otherRelayUrl, otherAccount } = await setUpOnAnotherRelay('relay-account');
        try {
            const app = await openDesktopApp({ context, computer, uiBaseUrl });
            try {
                await ensureAccountReadyForConnect({ page: app.page, timeoutMs: 180_000 });
                await expect(app.page.getByText(/^Switch this computer to .+\?$/)).toBeVisible({ timeout: 240_000 });
                const body = app.page.getByText(/^This computer is signed in to /);
                await expect(body).toContainText(relayHost(otherRelayUrl));
                await expect(body).toContainText(relayHost(server.baseUrl));
                await expect(body).toContainText(accountIdHint(otherAccount.accountId));
                await confirmRelayMove(app.page);
                const converged = await expectConvergedOnAppRelay(app, computer, server.baseUrl);
                expect(converged.daemonAccountId).toBe(converged.appAccountId);
            } catch (error) {
                throw appendBrowserDiagnostics(error, app.diagnostics());
            }
        } finally {
            await otherRelay.stop().catch(() => {});
        }
    });

    test('daemon on a relay that is gone: the relay question names both hosts and Move converges on the app relay', async ({ context }) => {
        test.setTimeout(180_000);
        if (!server) throw new Error('missing server');
        const { computer, otherRelay, otherRelayUrl } = await setUpOnAnotherRelay('relay-gone');
        await otherRelay.stop();

        const app = await openDesktopApp({ context, computer, uiBaseUrl });
        try {
            await ensureAccountReadyForConnect({ page: app.page, timeoutMs: 180_000 });
            await expect(app.page.getByText('Move the background service to this Relay?')).toBeVisible({ timeout: 240_000 });
            const body = app.page.getByText(/^This computer’s background service is connected to /);
            await expect(body).toContainText(relayHost(otherRelayUrl));
            await expect(body).toContainText(relayHost(server.baseUrl));
            await confirmRelayMove(app.page);
            await expectConvergedOnAppRelay(app, computer, server.baseUrl);
        } catch (error) {
            throw appendBrowserDiagnostics(error, app.diagnostics());
        }
    });

    test('daemon already set up from the terminal on this relay and account: a cold deep link asks nothing, changes nothing, and offers the CLI update', async ({ context }) => {
        test.setTimeout(180_000);
        if (!server) throw new Error('missing server');
        const computer = await newComputer('terminal');
        const account = await signUpInPlainBrowser(context, uiBaseUrl);
        await setUpFromTerminal(computer, server.baseUrl, account);
        // What the CLI's own daily check records when its channel has a newer release (R17). The
        // check itself calls the public release API, so this offline computer carries its result.
        const latestVersion = '0.2.99-dev.1';
        writeUpdateCache(join(computer.happierHomeDir, 'cache', 'update.dev.json'), {
            checkedAt: Date.now(),
            latest: latestVersion,
            current: computer.managedCli.version,
            runtimeVersion: null,
            invokerVersion: null,
            updateAvailable: true,
            notifiedAt: null,
        });
        const machineId = (await readDaemonStatus(computer)).auth?.machineId;
        if (!machineId) throw new Error('terminal setup left no machine id');
        const before = computer.stateFingerprint();
        const daemonPidsBefore = readRunningDaemonPids(computer);
        const mutatingCallsBefore = mutatingSystemctlCalls(computer).length;

        // Cold deep link (R11 b): the lifecycle owner mounts at the shell, not the Home route.
        const app = await openDesktopApp({ context, computer, uiBaseUrl, path: '/settings/machines/this-computer' });
        try {
            await expect(app.page.getByTestId('settings.localDaemonControl.cli')).toContainText(computer.managedCli.version, { timeout: 240_000 });
            await expect(app.page.getByTestId('settings.localDaemonControl.updateCli')).toContainText(latestVersion);

            await navigateSpa(app.page, '/?happier_hmr=0');
            await expectHomeOffersThisComputer(app, machineId, 240_000);
            expect(tasksOfKind(app.host, 'daemon.service.status.v1').some((task) => task.snapshot.result?.ok === true)).toBe(true);
            expect(tasksOfKind(app.host, 'setup.thisComputer.v1')).toEqual([]);
            expect(tasksOfKind(app.host, 'cli.update.v1')).toEqual([]);
            expect(userFacingPromptKinds(app.host)).toEqual([]);
            expect(computer.stateFingerprint()).toEqual(before);
            expect(readRunningDaemonPids(computer)).toEqual(daemonPidsBefore);
            expect(mutatingSystemctlCalls(computer).slice(mutatingCallsBefore)).toEqual([]);
        } catch (error) {
            throw appendBrowserDiagnostics(error, app.diagnostics());
        }
    });

    test('a failure Retry cannot fix: one sentence, Continue without this computer, and the app stays usable', async ({ context }) => {
        test.setTimeout(180_000);
        const computer = await newComputer('blocked');
        computer.setUserManagerAvailable(false);
        const app = await openDesktopApp({ context, computer, uiBaseUrl });
        try {
            await ensureAccountReadyForConnect({ page: app.page, timeoutMs: 180_000 });
            const blocked = app.page.getByTestId('desktop-setup-panel:blocked');
            await expect(blocked).toBeVisible({ timeout: 240_000 });
            const status = app.page.getByTestId('desktop-setup-panel:status');
            const sentence = ((await status.textContent()) ?? '').trim();
            expect(sentence.length).toBeGreaterThan(0);
            expect(sentence.split(/(?<=[.!?])\s+/).filter(Boolean)).toHaveLength(1);
            await expect(app.page.getByTestId('nav-settings').first()).toBeVisible();

            // Retry runs setup again and lands on the same honest failure.
            const failedRunsBefore = tasksOfKind(app.host, 'setup.thisComputer.v1').filter((task) => task.snapshot.result?.ok === false).length;
            await app.page.getByTestId('desktop-setup-panel:retry').click();
            await expect.poll(
                () => tasksOfKind(app.host, 'setup.thisComputer.v1').filter((task) => task.snapshot.result?.ok === false).length,
                { message: 'Retry did not run setup again', timeout: 180_000 },
            ).toBeGreaterThan(failedRunsBefore);
            await expect(blocked).toBeVisible({ timeout: 60_000 });

            await app.page.getByTestId('desktop-setup-panel:continue-without').click();
            await expect(app.page.getByTestId('desktop-setup-panel:veil')).toHaveCount(0, { timeout: 60_000 });
            await app.page.getByTestId('nav-settings').first().click();
            await expect(app.page).toHaveURL(/\/settings/, { timeout: 60_000 });
        } catch (error) {
            throw appendBrowserDiagnostics(error, app.diagnostics());
        }
    });

    /**
     * INV10, fail closed (the case the retired deterministic-runner spec carried): setup converged —
     * service, daemon, machine id and CLI version agree (INV8) and the relay lists the machine — but
     * the machine never acknowledges the relay-forwarded proof (a half-open socket). The app must not
     * call this computer ready: one sentence naming the relay, Retry, and a usable shell. Once the
     * machine answers, Retry proves it ready.
     */
    test('converged but not answering through the relay: fails closed with one sentence, then Retry proves it ready', async ({ context }) => {
        test.setTimeout(180_000);
        if (!server) throw new Error('missing server');
        const computer = await newComputer('unreachable');
        const app = await openDesktopApp({ context, computer, uiBaseUrl });
        app.relay.setUnresponsiveMethod(RPC_METHODS.CAPABILITIES_DESCRIBE);
        try {
            await ensureAccountReadyForConnect({ page: app.page, timeoutMs: 180_000 });
            const setup = await waitForSuccessfulSetupRun(app.host, 240_000);
            const machineId = readSetupMachineId(setup);
            const blocked = app.page.getByTestId('desktop-setup-panel:blocked');
            await expect(blocked).toBeVisible({ timeout: 120_000 });
            // The proof was asked and only the relay's unanswered forward made it fail.
            const proofs = readinessProofCalls(app.relay, machineId);
            expect(proofs.length).toBeGreaterThan(0);
            expect(proofs.every((call) => call.injected)).toBe(true);
            expect((await readDaemonStatus(computer)).runtimeConvergence).toEqual({
                controlReachable: true,
                serviceOwnsRunningDaemon: true,
                machineIdMatches: true,
                cliVersionMatches: true,
            });
            const credentials = await readAppCredentials(app.page);
            await waitForActiveMachine({ baseUrl: server.baseUrl, token: credentials.token, machineId, timeoutMs: 60_000 });
            const sentence = ((await app.page.getByTestId('desktop-setup-panel:status').textContent()) ?? '').trim();
            expect(sentence.split(/(?<=[.!?])\s+/).filter(Boolean)).toHaveLength(1);
            expect(sentence).toContain(new URL(server.baseUrl).hostname);
            await expect(app.page.getByTestId('nav-settings').first()).toBeVisible();

            app.relay.setUnresponsiveMethod(null);
            await app.page.getByTestId('desktop-setup-panel:retry').click();
            await expectThisComputerReady(app, machineId, 180_000);
        } catch (error) {
            throw appendBrowserDiagnostics(error, app.diagnostics());
        }
    });

    /**
     * R12 + R13 (b), "Keep my own" round trip: the user's npm `happier` is kept (its pairing takes the
     * one attended confirmation), then uninstalled. The kept CLI is still this computer's answer, so
     * the next app open asks again — about the copy that is gone — before any other CLI is used;
     * "Let Happier manage it" then moves this computer onto the managed CLI and proves it ready.
     */
    test('R12: Keep my own, then that CLI is uninstalled: the next open asks again before using another CLI', async ({ context }) => {
        test.setTimeout(180_000);
        if (!server) throw new Error('missing server');
        // Cross-ring on purpose: this dev app's leftover managed CLI is dev while the kept npm CLI's
        // service is the default channel's; Manage must still be a pure runtime switch (R13 b).
        const computer = await newComputer('cli-keep', { foreignCli: true, foreignCliFirst: true });
        const own = computer.foreignCli!;
        const first = await openDesktopApp({ context, computer, uiBaseUrl });
        try {
            await ensureAccountReadyForConnect({ page: first.page, timeoutMs: 180_000 });
            await answerCliChoice(first, own.command, 'own', 240_000);
            await first.page.getByTestId('web-modal-confirm').click({ timeout: 240_000 });
            const setup = await waitForSuccessfulSetupRun(first.host, 240_000);
            expect(readHappierCliChoiceSync({ processEnv: computer.env })).toEqual({ mode: 'own', command: own.command });
            await expectThisComputerReady(first, readSetupMachineId(setup), 180_000);
        } catch (error) {
            throw appendBrowserDiagnostics(error, first.diagnostics());
        }
        await first.page.close();

        own.remove();
        const second = await openDesktopApp({ context, computer, uiBaseUrl });
        try {
            const question = await answerCliChoice(second, own.command, 'managed', 240_000);
            expect(question.missing).toBe(true);
            const setup = await waitForSuccessfulSetupRun(second.host, 240_000);
            expect(readHappierCliChoiceSync({ processEnv: computer.env })).toEqual({ mode: 'managed' });
            // R13 (b): the answer is the consent for moving the service to the managed CLI.
            expect(userFacingPromptKinds(second.host)).toEqual([SETUP_CLI_CHOICE_PROMPT_KIND]);
            await expectThisComputerReady(second, readSetupMachineId(setup), 180_000);
        } catch (error) {
            throw appendBrowserDiagnostics(error, second.diagnostics());
        }
    });

    /**
     * R12 + R13 (b): the managed stable CLI's `happier` shim leads PATH, so no CLI-choice question
     * is needed. The user's npm copy stays installed, and Settings › This computer names it with the command
     * that removes it (shown, never run): discovery walks past the managed shim.
     */
    test('R12: managed CLI first needs no choice and Settings still lists the old copy', async ({ context }) => {
        test.setTimeout(180_000);
        if (!server) throw new Error('missing server');
        const computer = await newComputer('cli-manage', { ring: 'stable', foreignCli: true });
        const own = computer.foreignCli!;
        const app = await openDesktopApp({ context, computer, uiBaseUrl });
        try {
            await ensureAccountReadyForConnect({ page: app.page, timeoutMs: 180_000 });
            const setup = await waitForSuccessfulSetupRun(app.host, 240_000);
            expect(readHappierCliChoiceSync({ processEnv: computer.env })).toBeNull();
            expect(userFacingPromptKinds(app.host)).toEqual([]);
            await expectThisComputerReady(app, readSetupMachineId(setup), 180_000);

            await navigateSpa(app.page, '/settings/machines/this-computer?happier_hmr=0');
            const oldCli = app.page.getByTestId('settings.localDaemonControl.oldCli');
            await expect(oldCli).toContainText(own.command, { timeout: 120_000 });
            await expect(oldCli).toContainText('npm uninstall -g @happier-dev/cli');
            expect(existsSync(own.command)).toBe(true);
        } catch (error) {
            throw appendBrowserDiagnostics(error, app.diagnostics());
        }
    });

    /**
     * R13 (a): the app was started by a stack pinned to relay X (hsetup inherits X's server
     * selection) while it is signed in to relay Y. Setup must run every command against Y — X's
     * credentials are never written, and the CLI, service and daemon all end on Y as the app's
     * account — and this computer must then be proven ready for Y.
     */
    test('R13 (a): app launched pinned to another relay: setup puts everything on the app relay and proves it ready', async ({ context }) => {
        test.setTimeout(180_000);
        if (!server) throw new Error('missing server');
        const { computer, otherRelay, otherRelayUrl, otherServerId } = await setUpOnAnotherRelay('relay-pinned');
        const otherCredentialsPath = join(computer.happierHomeDir, 'servers', otherServerId, 'access.key');
        const otherCredentialsBefore = computer.stateFingerprint()[otherCredentialsPath];
        expect(otherCredentialsBefore, 'the terminal setup wrote no credentials for the other relay').toBeTruthy();
        try {
            const app = await openDesktopApp({
                context,
                computer,
                uiBaseUrl,
                launchEnv: { HAPPIER_ACTIVE_SERVER_ID: otherServerId, HAPPIER_SERVER_URL: otherRelayUrl },
            });
            try {
                await ensureAccountReadyForConnect({ page: app.page, timeoutMs: 180_000 });
                await expect(app.page.getByText(/^Switch this computer to .+\?$/)).toBeVisible({ timeout: 240_000 });
                await confirmRelayMove(app.page);
                // Placement first (the executor's contract), then the readiness proof.
                const converged = await expectConvergedOnAppRelay(app, computer, server.baseUrl, { proveReady: false });
                expect(converged.daemonAccountId).toBe(converged.appAccountId);
                expect(computer.stateFingerprint()[otherCredentialsPath], 'setup for the app relay wrote the pinned relay\'s credentials').toBe(otherCredentialsBefore);
                const settings = JSON.parse(readFileSync(join(computer.happierHomeDir, 'settings.json'), 'utf8')) as { activeServerId?: unknown };
                expect(settings.activeServerId).not.toBe(otherServerId);
                await expectHomeOffersThisComputer(app, converged.machineId, 180_000);
            } catch (error) {
                throw appendBrowserDiagnostics(error, app.diagnostics());
            }
        } finally {
            await otherRelay.stop().catch(() => {});
        }
    });
});
