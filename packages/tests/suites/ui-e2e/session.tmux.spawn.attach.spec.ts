import { test, expect, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { ensureCliDistSnapshotEntrypoint } from '../../src/testkit/process/cliDist';
import { repoRootDir } from '../../src/testkit/paths';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

type TerminalAttachmentInfoV1 = {
    version: 1;
    sessionId: string;
    terminal: { mode: 'plain' | 'tmux'; tmux?: { target?: string; tmpDir?: string } };
    updatedAt: number;
};

const run = createRunDirs({ runLabel: 'ui-e2e' });

function tmuxAvailable(): boolean {
    if (process.platform === 'win32') return false;
    const res = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
    return res.status === 0;
}

function attachmentInfoPath(happyHomeDir: string, sessionId: string): string {
    return join(happyHomeDir, 'terminal', 'sessions', `${encodeURIComponent(sessionId)}.json`);
}

async function sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

async function waitForAttachmentInfo(happyHomeDir: string, sessionId: string): Promise<TerminalAttachmentInfoV1> {
    const path = attachmentInfoPath(happyHomeDir, sessionId);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30_000) {
        if (!existsSync(path)) {
            await sleep(100);
            continue;
        }

        // Best-effort: avoid reading while another process is mid-write (can yield partial JSON).
        const s1 = await stat(path).catch(() => null);
        if (!s1) {
            await sleep(100);
            continue;
        }
        await sleep(25);
        const s2 = await stat(path).catch(() => null);
        if (!s2 || s2.size !== s1.size) {
            await sleep(100);
            continue;
        }

        const raw = await readFile(path, 'utf8').catch(() => '');
        try {
            const parsed = JSON.parse(raw) as Partial<TerminalAttachmentInfoV1>;
            if (parsed && parsed.version === 1 && parsed.sessionId === sessionId && parsed.terminal) {
                return parsed as TerminalAttachmentInfoV1;
            }
        } catch {
            // ignore
        }
        await sleep(100);
    }
    throw new Error(`Timed out waiting for terminal attachment info at ${path}`);
}

function resolveServerLightSqliteDbPath(params: { suiteDir: string }): string {
    return resolve(join(params.suiteDir, 'server-light-data', 'happier-server-light.sqlite'));
}

function readLatestMachineIdFromServerLightDb(params: { suiteDir: string }): string {
    const dbPath = resolveServerLightSqliteDbPath({ suiteDir: params.suiteDir });
    try {
        const raw = execFileSync('sqlite3', ['-json', dbPath, 'select id from Machine order by createdAt desc limit 1;'], {
            encoding: 'utf8',
        });
        const parsed = JSON.parse(raw) as Array<{ id?: unknown }>;
        const id = parsed?.[0]?.id;
        if (typeof id === 'string' && id.trim()) return id.trim();
    } catch {
        // ignore - pollers can retry
    }
    throw new Error(`Failed to read machine id from server light sqlite db: ${dbPath}`);
}

async function waitForLatestMachineId(params: { suiteDir: string; timeoutMs?: number }): Promise<string> {
    const timeoutMs = params.timeoutMs ?? 60_000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            return readLatestMachineIdFromServerLightDb({ suiteDir: params.suiteDir });
        } catch {
            await sleep(250);
        }
    }
    return readLatestMachineIdFromServerLightDb({ suiteDir: params.suiteDir });
}

function parseSessionIdFromUrl(url: string): string {
    const pathname = new URL(url).pathname;
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[0] === 'session' ? parts[1] : null;
    if (!sessionId) throw new Error(`failed to parse session id from url: ${url}`);
    return sessionId;
}

async function ensureTmuxSettingsInUi(params: {
    page: Page;
    uiBaseUrl: string;
    tmuxSessionName: string;
    tmuxTmpDir: string;
}): Promise<void> {
    const { page, uiBaseUrl, tmuxSessionName, tmuxTmpDir } = params;

    await page.goto(`${uiBaseUrl}/settings/session`, { waitUntil: 'domcontentloaded' });

    const enabledItem = page.getByTestId('settings-session-tmux-enabled-item');
    await expect(enabledItem).toHaveCount(1, { timeout: 60_000 });
    await enabledItem.scrollIntoViewIfNeeded();

    const sessionNameInput = page.getByTestId('settings-session-tmux-sessionName-input');
    if ((await sessionNameInput.count()) === 0) {
        await enabledItem.click();
    }
    await expect(sessionNameInput).toHaveCount(1, { timeout: 60_000 });
    await sessionNameInput.fill(tmuxSessionName);

    const isolatedItem = page.getByTestId('settings-session-tmux-isolated-item');
    await expect(isolatedItem).toHaveCount(1, { timeout: 60_000 });
    await isolatedItem.scrollIntoViewIfNeeded();

    const tmpDirInput = page.getByTestId('settings-session-tmux-tmpDir-input');
    if ((await tmpDirInput.count()) === 0) {
        await isolatedItem.click();
    }
    await expect(tmpDirInput).toHaveCount(1, { timeout: 60_000 });
    await tmpDirInput.fill(tmuxTmpDir);
}

async function createSessionFromComposer(params: {
    page: Page;
    uiBaseUrl: string;
    machineId: string;
    prompt: string;
}): Promise<string> {
    const { page, uiBaseUrl, machineId, prompt } = params;
    await page.goto(`${uiBaseUrl}/new`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 120_000 });

    await page.getByTestId('agent-input-machine-chip').click();
    await page.waitForURL((url) => url.pathname.endsWith('/new/pick/machine'), { timeout: 60_000 });

    const exact = page.getByTestId(`new-session-machine:${machineId}`);
    await expect(exact).toHaveCount(1, { timeout: 120_000 });
    await exact.click();

    await page.waitForURL((url) => url.pathname.endsWith('/new'), { timeout: 60_000 });
    await page.getByTestId('new-session-composer-input').fill(prompt);
    await page.getByTestId('new-session-composer-input').press('Enter');

    await expect(page.locator('textarea[data-testid="session-composer-input"]:visible')).toHaveCount(1, { timeout: 180_000 });
    return parseSessionIdFromUrl(page.url());
}

test.describe('ui e2e: tmux spawn → attach', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('session-tmux-spawn-attach-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    let tmuxTmpDir: string | null = null;
    let tmuxSessionName: string | null = null;

    test.beforeAll(async () => {
        // Expo web cold starts can take several minutes on developer machines (initial Metro + bundling).
        // Keep this generous so we fail on real errors, not just slow bundle readiness.
        test.setTimeout(900_000);
        await mkdir(cliHomeDir, { recursive: true });
        await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
                HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
                HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
                HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
            },
        });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...process.env,
                EXPO_PUBLIC_DEBUG: '1',
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
            },
        });

        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        await daemon?.stop().catch(() => {});
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});

        if (tmuxTmpDir && tmuxSessionName && tmuxAvailable()) {
            spawnSync('tmux', ['kill-session', '-t', tmuxSessionName], { env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir } });
        }
        if (tmuxTmpDir) {
            await rm(tmuxTmpDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    test('starts a UI-created session in tmux and can attach via CLI', async ({ page }) => {
        test.setTimeout(900_000);
        if (!tmuxAvailable()) test.skip(true, 'tmux is not available on this machine');
        if (typeof (process as any).getuid !== 'function') test.skip(true, 'process.getuid is not available');
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

        await page.getByTestId('welcome-create-account').click();
        await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

        const testDir = resolve(join(suiteDir, 't1-tmux-spawn-attach'));
        await mkdir(testDir, { recursive: true });

        tmuxSessionName = `happy-ui-e2e-${run.runId.slice(0, 8)}`;
        const shortTmpBase = process.platform === 'win32' ? tmpdir() : '/tmp';
        tmuxTmpDir = await mkdtemp(join(shortTmpBase, 'happy-ui-e2e-tmux-'));

        await ensureTmuxSettingsInUi({ page, uiBaseUrl, tmuxSessionName, tmuxTmpDir });

        const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
            testDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            webappUrl: uiBaseUrl,
            env: {
                ...process.env,
                HOME: cliHomeDir,
                CI: '1',
                HAPPIER_DISABLE_CAFFEINATE: '1',
                HAPPIER_VARIANT: 'dev',
            },
        });

        await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('terminal-connect-approve').click();
        await cliLogin.waitForSuccess();
        await cliLogin.stop().catch(() => {});

        try {
            const okButton = page.getByRole('button', { name: 'OK' });
            await expect(okButton).toBeVisible({ timeout: 5_000 });
            await okButton.click();
            await expect(okButton).toBeHidden({ timeout: 30_000 });
        } catch {
            // ignore missing/changed success dialog
        }

        const fakeClaudePath = fakeClaudeFixturePath();
        daemon = await startTestDaemon({
            testDir,
            happyHomeDir: cliHomeDir,
            env: {
                ...process.env,
                HOME: cliHomeDir,
                CI: '1',
                HAPPIER_HOME_DIR: cliHomeDir,
                HAPPIER_SERVER_URL: server.baseUrl,
                HAPPIER_WEBAPP_URL: uiBaseUrl,
                HAPPIER_DISABLE_CAFFEINATE: '1',
                HAPPIER_VARIANT: 'dev',
                HAPPIER_CLAUDE_PATH: fakeClaudePath,
                HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
                HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
            },
        });

        const machineId = await waitForLatestMachineId({ suiteDir, timeoutMs: 120_000 });

        const sessionId = await createSessionFromComposer({ page, uiBaseUrl, machineId, prompt: `hello ${run.runId}` });
        await page.goto(`${uiBaseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByText('FAKE_CLAUDE_OK_1')).toHaveCount(1, { timeout: 180_000 });

        const info = await waitForAttachmentInfo(cliHomeDir, sessionId);
        expect(info.terminal.mode).toBe('tmux');
        const target = info.terminal.tmux?.target;
        expect(typeof target).toBe('string');
        if (typeof target !== 'string' || target.length === 0) throw new Error('Missing terminal.tmux.target in attachment info');
        expect(target.startsWith(`${tmuxSessionName}:`)).toBe(true);

        // Verify isolated tmux server socket exists.
        const uid = (process as any).getuid() as number;
        const socketPath = `${tmuxTmpDir}/tmux-${uid}/default`;
        expect(existsSync(socketPath)).toBe(true);

        // Attach non-interactively: emulate being already inside the same isolated tmux server.
        const cliDistEntrypoint = await ensureCliDistSnapshotEntrypoint(
            { testDir, env: process.env },
            { snapshotDir: resolve(testDir, 'cli-dist') },
        );
        const attachRes = spawnSync(
            process.execPath,
            [cliDistEntrypoint, 'attach', sessionId],
            {
                cwd: repoRootDir(),
                env: {
                    ...process.env,
                    CI: '1',
                    HAPPIER_VARIANT: 'dev',
                    HAPPIER_HOME_DIR: cliHomeDir,
                    TMUX: `${socketPath},0,0`,
                    TMUX_PANE: '%0',
                },
                encoding: 'utf8',
            },
        );
        expect(attachRes.status).toBe(0);

        // Assert tmux now has the target window active.
        const parts = target.split(':');
        expect(parts.length).toBeGreaterThanOrEqual(2);
        const windowName = parts[1];
        expect(windowName.length).toBeGreaterThan(0);
        const windows = spawnSync('tmux', ['list-windows', '-t', tmuxSessionName, '-F', '#{window_active} #{window_name}'], {
            env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir, TMUX: `${socketPath},0,0` },
            encoding: 'utf8',
        });
        expect(windows.status).toBe(0);
        const active = (windows.stdout || '')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .find((l) => l.startsWith('1 '));
        expect(active).toBe(`1 ${windowName}`);

        // UI should allow switching remote → local → remote using stable selectors (testIDs).
        await expect(page.getByTestId('session-chatFooter-switchToLocal')).toHaveCount(1, { timeout: 180_000 });
        await page.getByTestId('session-chatFooter-switchToLocal').click();
        await expect(page.getByTestId('session-chatFooter-switchToRemote')).toHaveCount(1, { timeout: 180_000 });
        await page.getByTestId('session-chatFooter-switchToRemote').click();
        await expect(page.getByTestId('session-chatFooter-switchToLocal')).toHaveCount(1, { timeout: 180_000 });
    });
});
