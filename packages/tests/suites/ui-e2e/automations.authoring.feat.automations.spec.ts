import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
    AutomationDefinitionListItem,
    AutomationDefinitionListResponse,
    AutomationV3RunListItem,
    AutomationV3RunListResponse,
} from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import {
    releaseFakeClaudeRuntimeContinuityTurn,
    waitForFakeClaudeRuntimeContinuityEffect,
} from '../../src/testkit/providers/fakeClaudeContinuity';
import { createSessionFromNewSessionComposer, openNewSessionMachineSelection } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { enableEnhancedSessionWizard } from '../../src/testkit/uiE2e/enableEnhancedSessionWizard';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function getVisibleSessionComposer(page: Page) {
    return page.locator('[data-testid="session-composer-input"]:visible');
}

async function clickLocatorWithFallback(locator: Locator): Promise<void> {
    try {
        await locator.click({ timeout: 15_000 });
    } catch {
        await locator.click({ timeout: 15_000, force: true });
    }
}

async function ensureSwitchEnabled(toggle: Locator) {
    await expect(toggle).toHaveCount(1, { timeout: 60_000 });
    if ((await toggle.getAttribute('aria-checked')) !== 'true') {
        await toggle.click();
    }
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
}

async function enableAutomationsInSettings(params: Readonly<{ baseUrl: string; page: Page }>) {
    await enableEnhancedSessionWizard({ page: params.page, baseUrl: params.baseUrl, timeoutMs: 180_000 });
    await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/settings/features?happier_hmr=0`, 180_000);
    await ensureSwitchEnabled(params.page.getByTestId('settings-feature-experiments-toggle'));
    await ensureSwitchEnabled(params.page.getByTestId('settings-feature-toggle-automations'));
}

async function selectMachineForNewSession(params: Readonly<{
    page: Page;
    uiBaseUrl: string;
    machineId: string;
}>) {
    const selectionResult = await openNewSessionMachineSelection({ page: params.page, uiBaseUrl: params.uiBaseUrl });

    if (selectionResult === 'picker_open') {
        const exact = params.page.locator(
            `[data-testid="new-session-machine:${params.machineId}"], [data-testid="new-session-machine-option:${params.machineId}"]`,
        );
        const anyOption = params.page.locator(
            '[data-testid^="new-session-machine:"], [data-testid^="new-session-machine-option:"]',
        );

        await expect.poll(async () => await anyOption.count(), { timeout: 120_000 }).toBeGreaterThan(0);
        if (await exact.count()) {
            await clickLocatorWithFallback(exact.first());
        } else {
            await clickLocatorWithFallback(anyOption.first());
        }
    }

    await params.page.waitForURL((url: URL) => url.pathname.endsWith('/new'), { timeout: 60_000 });
    await expect(params.page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 180_000 });
}

async function readAuthTokenFromBrowserStorage(page: Page): Promise<string> {
    const token = await page.evaluate(() => {
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (!key?.startsWith('auth_credentials')) continue;
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            try {
                const parsed = JSON.parse(raw) as { token?: unknown };
                if (typeof parsed.token === 'string' && parsed.token.trim()) {
                    return parsed.token.trim();
                }
            } catch {
                // ignore malformed storage entries and keep scanning
            }
        }
        return null;
    });

    if (typeof token === 'string' && token.trim()) {
        return token.trim();
    }
    throw new Error('Failed to read auth token from browser storage');
}

async function readMachineIdFromCliAuthLoginStdout(stdoutPath: string): Promise<string> {
    const stdout = (await readFile(stdoutPath, 'utf8')).replaceAll(/\u001b\[[0-9;]*m/g, '');
    const match = stdout.match(/Machine ID:\s*([^\s]+)/);
    if (match?.[1]) {
        return match[1].trim();
    }
    throw new Error(`Failed to read machine id from CLI auth login stdout: ${stdoutPath}`);
}

async function getJson<T>(params: Readonly<{
    baseUrl: string;
    token: string;
    path: string;
}>): Promise<T> {
    const response = await fetch(`${params.baseUrl}${params.path}`, {
        headers: {
            Authorization: `Bearer ${params.token}`,
        },
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(`Request failed (${response.status}) ${params.path}: ${JSON.stringify(payload)}`);
    }
    return payload as T;
}

type PersistedAutomationListItem = AutomationDefinitionListItem;
type PersistedAutomationRunRow = AutomationV3RunListItem;

async function listPersistedAutomations(params: Readonly<{
    baseUrl: string;
    token: string;
}>): Promise<ReadonlyArray<PersistedAutomationListItem>> {
    const response = await getJson<AutomationDefinitionListResponse>({
        baseUrl: params.baseUrl,
        token: params.token,
        path: '/v3/automations',
    });
    return response.automations;
}

async function listPersistedAutomationRuns(params: Readonly<{
    baseUrl: string;
    token: string;
    automationId: string;
}>): Promise<ReadonlyArray<PersistedAutomationRunRow>> {
    const response = await getJson<AutomationV3RunListResponse>({
        baseUrl: params.baseUrl,
        token: params.token,
        path: `/v3/automations/${params.automationId}/runs?limit=20`,
    });
    return response.runs;
}

async function expectPersistedAutomation(params: Readonly<{
    baseUrl: string;
    token: string;
    name: string;
    targetType: 'newSession' | 'existingSession';
    existingSessionId?: string;
    expectedTriggers?: ReadonlyArray<Readonly<{ id: string; kind: string; everyMs: number | null }>>;
}>): Promise<string> {
    let persistedAutomationId: string | null = null;
    await expect.poll(async () => {
        const automations = await listPersistedAutomations({
            baseUrl: params.baseUrl,
            token: params.token,
        });
        const found = automations.find((automation) => automation.name === params.name);
        persistedAutomationId = found?.id ?? null;
        if (!found) return null;
        return {
            name: found.name,
            targetType: found.targetType,
            ...(params.existingSessionId !== undefined
                ? { existingSessionId: found.existingSessionId }
                : {}),
            triggers: found.triggers.map((trigger) => ({
                id: trigger.id,
                kind: trigger.kind,
                everyMs: trigger.schedule?.everyMs ?? null,
            })),
        };
    }, { timeout: 60_000 }).toEqual({
        name: params.name,
        targetType: params.targetType,
        ...(params.existingSessionId !== undefined
            ? { existingSessionId: params.existingSessionId }
            : {}),
        triggers: params.expectedTriggers ?? [],
    });
    if (persistedAutomationId === null) {
        throw new Error(`Automation ${params.name} was not persisted`);
    }
    return persistedAutomationId;
}

async function addScheduleTrigger(page: Page): Promise<string> {
    const rows = page.locator('[data-testid^="automation-trigger-row-"]');
    const previousCount = await rows.count();
    await page.getByTestId('automation-trigger-add').click();
    await page.getByTestId('automation-trigger-kind-schedule').click();
    await expect(rows).toHaveCount(previousCount + 1, { timeout: 30_000 });
    const testId = await rows.nth(previousCount).getAttribute('data-testid');
    if (!testId?.startsWith('automation-trigger-row-')) {
        throw new Error('Plural Automation editor did not expose the new trigger identity');
    }
    await page.getByTestId('automation-trigger-editor-done').click();
    return testId.slice('automation-trigger-row-'.length);
}

async function submitAutomationViaComposer(params: Readonly<{
    page: Page;
    testId: 'new-session-composer-send' | 'session-composer-send';
    expectedPathname: string;
}>) {
    const submit = params.page.getByTestId(params.testId);
    await expect(submit).toBeEnabled({ timeout: 60_000 });

    const [response] = await Promise.all([
        params.page.waitForResponse((candidate) => {
            try {
                return candidate.request().method() === 'POST'
                    && new URL(candidate.url()).pathname === '/v3/automations';
            } catch {
                return false;
            }
        }, { timeout: 60_000 }),
        params.page.waitForURL((url) => url.pathname === params.expectedPathname, { timeout: 60_000 }),
        submit.click(),
    ]);

    expect(response.ok()).toBe(true);
}

/** One independently identified trigger row id from its stable row testID. */
function triggerIdFromRowTestId(rowTestId: string | null): string {
    if (!rowTestId?.startsWith('automation-trigger-row-')) {
        throw new Error('Automation editor did not expose the trigger identity');
    }
    return rowTestId.slice('automation-trigger-row-'.length);
}

async function saveAutomationEditorViaSubmit(params: Readonly<{
    page: Page;
    automationId: string;
}>): Promise<void> {
    const [response] = await Promise.all([
        params.page.waitForResponse((candidate) => {
            try {
                return candidate.request().method() === 'PUT'
                    && new URL(candidate.url()).pathname === `/v3/automations/${params.automationId}`;
            } catch {
                return false;
            }
        }, { timeout: 60_000 }),
        params.page.getByTestId('automation-editor-submit').click(),
    ]);
    expect(response.ok()).toBe(true);
}

test.describe('ui e2e: automations authoring', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('automations-authoring-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
        test.setTimeout(900_000);
        await mkdir(cliHomeDir, { recursive: true });
        await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
                HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '900000',
                HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '900000',
                HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
            },
        });

        const uiWebEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_SERVER_URL: '',
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
            HAPPIER_E2E_UI_WEB_MODE: 'metro',
            HAPPIER_E2E_UI_WEB_NO_DEV: '0',
            HAPPIER_E2E_UI_WEB_BASE_URL_TIMEOUT_MS: '600000',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '900000',
        };

        test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...uiWebEnv,
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
            },
        });

        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        await daemon?.stop().catch(() => {});
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('authors plural V3 Automations and completes one exact-turn lifecycle journey', async ({ page }) => {
        test.setTimeout(900_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
        await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

        const testDir = resolve(join(suiteDir, 't1-automations-authoring'));
        await mkdir(testDir, { recursive: true });

        const exactTurnFixtureDir = resolve(join(suiteDir, 't2-exact-turn'));
        await mkdir(exactTurnFixtureDir, { recursive: true });
        const fakeClaudeLogPath = resolve(join(exactTurnFixtureDir, 'fake-claude.jsonl'));
        const exactTurnHoldReleaseFile = resolve(join(exactTurnFixtureDir, 'release-exact-turn-hold'));

        daemon = await authenticateAndStartDaemon({
            page,
            testDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            uiBaseUrl,
            createAccount: false,
            extraEnv: {
                HOME: cliHomeDir,
                // The exact-turn lane holds one real parent turn open through the
                // scenario-owned fake Claude boundary (no agent is mocked inside
                // the app); writing the release file later settles it.
                HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
                HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
                HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
                HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'daemon-runtime-continuity',
                HAPPIER_E2E_FAKE_CLAUDE_RUNTIME_CONTINUITY_RELEASE_FILE: exactTurnHoldReleaseFile,
            },
        });

        await page.goto(uiBaseUrl, { waitUntil: 'domcontentloaded' });
        const authToken = await readAuthTokenFromBrowserStorage(page);
        const machineId = await readMachineIdFromCliAuthLoginStdout(resolve(join(testDir, 'cli.auth.login.stdout.log')));

        await enableAutomationsInSettings({ page, baseUrl: uiBaseUrl });

        const inlineAutomationName = `Inline automation ${run.runId}`;
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new?automation=1&happier_hmr=0`, 180_000);
        await selectMachineForNewSession({ page, uiBaseUrl, machineId });
        await expect(page.getByTestId('new-session-automation-chip')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('new-session-automation-chip').click();
        await expect(page.getByTestId('automation-plural-editor')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByRole('switch')).toBeChecked({ timeout: 60_000 });
        await page.getByTestId('automation-name').first().fill(inlineAutomationName);
        const firstTriggerId = await addScheduleTrigger(page);
        const secondTriggerId = await addScheduleTrigger(page);
        expect(secondTriggerId).not.toBe(firstTriggerId);
        await page.getByTestId(`automation-trigger-row-${firstTriggerId}`).click();
        await page.getByTestId('automation-trigger-interval-minutes').fill('7');
        await page.getByTestId('automation-trigger-editor-done').click();
        await page.getByTestId(`automation-trigger-row-${secondTriggerId}`).click();
        await expect(page.getByTestId('automation-trigger-interval-minutes')).toHaveValue('60');
        await page.getByTestId('automation-trigger-editor-done').click();
        await page.getByTestId('new-session-composer-input').fill(`inline automation prompt ${run.runId}`);

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new?happier_hmr=0`, 180_000);
        await expect(page.getByTestId('automation-name')).toHaveCount(0, { timeout: 60_000 });
        await expect(page.getByTestId('new-session-automation-chip')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('automation-plural-editor')).toHaveCount(0, { timeout: 60_000 });

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new?automation=1&happier_hmr=0`, 180_000);
        await selectMachineForNewSession({ page, uiBaseUrl, machineId });
        await expect(page.getByTestId('new-session-automation-chip')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('new-session-automation-chip').click();
        await expect(page.getByTestId('automation-plural-editor')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByRole('switch')).toBeChecked({ timeout: 60_000 });
        await page.getByTestId('automation-name').first().fill(inlineAutomationName);
        await expect(page.getByTestId(`automation-trigger-row-${firstTriggerId}`)).toHaveCount(1);
        await expect(page.getByTestId(`automation-trigger-row-${secondTriggerId}`)).toHaveCount(1);
        await page.getByTestId('new-session-composer-input').fill(`inline automation prompt ${run.runId}`);
        await submitAutomationViaComposer({
            page,
            testId: 'new-session-composer-send',
            expectedPathname: '/automations',
        });
        const inlineAutomationId = await expectPersistedAutomation({
            baseUrl: server.baseUrl,
            token: authToken,
            name: inlineAutomationName,
            targetType: 'newSession',
            expectedTriggers: [
                { id: firstTriggerId, kind: 'schedule', everyMs: 7 * 60_000 },
                { id: secondTriggerId, kind: 'schedule', everyMs: 60 * 60_000 },
            ],
        });
        const inlineAutomationsBeforeRename = await listPersistedAutomations({
            baseUrl: server.baseUrl,
            token: authToken,
        });
        const inlineBeforeRename = inlineAutomationsBeforeRename.find(
            (automation) => automation.id === inlineAutomationId,
        );
        if (!inlineBeforeRename) {
            throw new Error('Inline automation disappeared from the definition list after creation');
        }

        const session = await createSessionFromNewSessionComposer({
            page,
            uiBaseUrl,
            machineId,
            prompt: `session for automation ${run.runId}`,
        });
        const { sessionId } = session;

        const existingSessionAutomationName = `Existing automation ${run.runId}`;
        const automationAuthoringUrl = new URL(session.sessionHref);
        automationAuthoringUrl.pathname = `${automationAuthoringUrl.pathname}/automations/new`;
        automationAuthoringUrl.searchParams.set('happier_hmr', '0');
        await gotoDomContentLoadedWithRetries(page, automationAuthoringUrl.toString(), 180_000);
        await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('automation-name')).toHaveCount(0, { timeout: 60_000 });
        await page.getByTestId('new-session-automation-chip').click();
        await expect(page.getByTestId('automation-name')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('automation-name').fill(existingSessionAutomationName);
        await getVisibleSessionComposer(page).fill(`existing-session automation prompt ${run.runId}`);
        await submitAutomationViaComposer({
            page,
            testId: 'session-composer-send',
            expectedPathname: `/session/${sessionId}/automations`,
        });
        const existingAutomationId = await expectPersistedAutomation({
            baseUrl: server.baseUrl,
            token: authToken,
            name: existingSessionAutomationName,
            targetType: 'existingSession',
        });

        // 10.1.1/10.1.3: a zero-trigger Automation still accepts an
        // authenticated Run Now, and the admitted Run records the immutable
        // manual invocation cause.
        const runNowButton = page.getByRole('button', { name: `Run now: ${existingSessionAutomationName}` });
        await expect(runNowButton).toHaveCount(1, { timeout: 60_000 });
        const [runNowResponse] = await Promise.all([
            page.waitForResponse((candidate) => {
                try {
                    return candidate.request().method() === 'POST'
                        && new URL(candidate.url()).pathname === `/v3/automations/${existingAutomationId}/run-now`;
                } catch {
                    return false;
                }
            }, { timeout: 60_000 }),
            runNowButton.click(),
        ]);
        expect(runNowResponse.ok()).toBe(true);
        const runNowBody = await runNowResponse.json() as { run?: PersistedAutomationRunRow };
        expect(runNowBody.run?.cause.kind).toBe('manual');
        const manualRunId = runNowBody.run?.id ?? null;
        if (manualRunId === null) {
            throw new Error('Run Now did not return the admitted Run identity');
        }
        await expect.poll(async () => (
            (await listPersistedAutomationRuns({
                baseUrl: server.baseUrl,
                token: authToken,
                automationId: existingAutomationId,
            })).filter((candidate) => candidate.cause.kind === 'manual').length
        ), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);

        // 10.4.4/10.2: the exact-turn Session action captures the exact current
        // parent turn and converges with the Automations editor on the one
        // canonical trigger writer, targeting a Session distinct from the source.
        const sourceSession = await createSessionFromNewSessionComposer({
            page,
            uiBaseUrl,
            machineId,
            prompt: `DAEMON_RUNTIME_CONTINUITY_HOLD_${run.runId}`,
        });
        await waitForFakeClaudeRuntimeContinuityEffect({
            logPath: fakeClaudeLogPath,
            promptMarker: `DAEMON_RUNTIME_CONTINUITY_HOLD_${run.runId}`,
            timeoutMs: 120_000,
        });

        await gotoDomContentLoadedWithRetries(
            page,
            `${uiBaseUrl}/session/${sourceSession.sessionId}?happier_hmr=0`,
            180_000,
        );
        await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
        await page.getByLabel('Open session actions').click();
        const exactTurnMenuItem = page.getByTestId('dropdown-option-header_automateExactTurnCompletion');
        await expect(exactTurnMenuItem).toHaveCount(1, { timeout: 180_000 });

        // 7.2: a failed automations refresh yields a typed retry state instead of
        // presenting cached destinations as current.
        await page.route('**/v3/automations', (route) => route.abort());
        await exactTurnMenuItem.click();
        await page.waitForURL((url) => url.pathname.endsWith('/automations/when-turn-finishes'), { timeout: 60_000 });
        const exactTurnRouteUrl = new URL(page.url());
        const observedTurnId = exactTurnRouteUrl.searchParams.get('sourceTurnId');
        const observedServerId = exactTurnRouteUrl.searchParams.get('sourceServerId');
        if (!observedTurnId || !observedServerId) {
            throw new Error('Session action did not preserve the exact observed turn identity');
        }
        const refreshFailedCard = page.getByTestId('exact-turn-automation-refresh-failed');
        await expect(refreshFailedCard).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('exact-turn-automation-destination')).toHaveCount(0);
        await page.unroute('**/v3/automations');
        await refreshFailedCard.getByTestId('exact-turn-automation-refresh-failed-action').click();
        const exactTurnDestination = page.getByTestId('exact-turn-automation-destination');
        await expect(exactTurnDestination).toHaveCount(1, { timeout: 60_000 });
        // The destination stays one searchable virtualized single-select list.
        await expect(exactTurnDestination.getByRole('listbox')).toHaveCount(1);
        const createNewDestinationOption = page.getByTestId('exact-turn-automation-create-new');
        await expect(createNewDestinationOption).toHaveCount(1);
        await expect(createNewDestinationOption).toHaveAttribute('role', 'option');
        await expect(createNewDestinationOption).toHaveAttribute('aria-selected', 'false');
        const existingDestinationOption = page.getByTestId(`exact-turn-automation-existing-${existingAutomationId}`);
        await expect(existingDestinationOption).toHaveCount(1);
        await existingDestinationOption.click();
        await page.waitForURL((url) => url.pathname.endsWith('/automations/edit'), { timeout: 60_000 });
        await expect(page.getByTestId('automation-plural-editor')).toHaveCount(1, { timeout: 120_000 });
        // The zero-trigger target owns no other rows, so the appended exact-turn
        // prefill is the one independently identified trigger row.
        const prefillRows = page.locator('[data-testid^="automation-trigger-row-"]');
        await expect(prefillRows).toHaveCount(1, { timeout: 60_000 });
        const prefillTriggerId = triggerIdFromRowTestId(await prefillRows.first().getAttribute('data-testid'));
        await expect(page.getByTestId(`automation-trigger-enabled-${prefillTriggerId}`))
            .toHaveAttribute('aria-checked', 'true', { timeout: 60_000 });

        await saveAutomationEditorViaSubmit({ page, automationId: existingAutomationId });

        // 3.5/10.4: the saved trigger names the exact source turn while the
        // Automation target stays the distinct existing Session, and the
        // machine assignment survives the authoring flow.
        let savedLifecycleTriggerId: string | null = null;
        await expect.poll(async () => {
            const found = (await listPersistedAutomations({
                baseUrl: server.baseUrl,
                token: authToken,
            })).find((automation) => automation.id === existingAutomationId);
            const lifecycle = found?.triggers.find((candidate) => candidate.kind === 'sessionLifecycle') ?? null;
            if (!found || !lifecycle) return null;
            savedLifecycleTriggerId = lifecycle.id;
            return {
                triggerId: lifecycle.id,
                enabled: lifecycle.enabled,
                sourceSessionId: lifecycle.scope?.sourceSessionId ?? null,
                sourceTurnId: lifecycle.scope?.sourceTurnId ?? null,
                consumption: lifecycle.consumption,
                status: lifecycle.status?.state ?? null,
                existingSessionId: found.existingSessionId,
                hasEnabledAssignment: found.assignments.some((assignment) => assignment.enabled),
            };
        }, { timeout: 60_000 }).toEqual({
            triggerId: expect.any(String),
            enabled: true,
            sourceSessionId: sourceSession.sessionId,
            sourceTurnId: observedTurnId,
            consumption: 'once',
            status: 'waiting',
            existingSessionId: sessionId,
            hasEnabledAssignment: true,
        });
        if (savedLifecycleTriggerId === null) {
            throw new Error('Exact-turn trigger was not persisted with a durable identity');
        }

        // 10.2.2: settling the held parent turn admits exactly one exact-turn Run
        // whose immutable cause names the exact trigger and source facts.
        await releaseFakeClaudeRuntimeContinuityTurn(exactTurnHoldReleaseFile);
        let lifecycleRun: PersistedAutomationRunRow | null = null;
        await expect.poll(async () => {
            const runs = await listPersistedAutomationRuns({
                baseUrl: server.baseUrl,
                token: authToken,
                automationId: existingAutomationId,
            });
            lifecycleRun = runs.find((candidate) => (
                candidate.cause.kind === 'trigger'
                && candidate.cause.triggerKind === 'sessionLifecycle'
                && candidate.cause.evidence?.sourceSessionId === sourceSession.sessionId
                && candidate.cause.evidence?.sourceTurnId === observedTurnId
            )) ?? null;
            return lifecycleRun?.id ?? null;
        }, { timeout: 180_000 }).not.toBeNull();
        if (lifecycleRun === null) {
            throw new Error('Exact-turn Run was not admitted after the parent turn settled');
        }
        expect(lifecycleRun.triggerId).toBe(savedLifecycleTriggerId);
        expect(lifecycleRun.triggerRetired).toBe(false);
        // The owning trigger's projected status follows its admitted Run.
        await expect.poll(async () => {
            const found = (await listPersistedAutomations({
                baseUrl: server.baseUrl,
                token: authToken,
            })).find((automation) => automation.id === existingAutomationId);
            const lifecycle = found?.triggers.find((candidate) => candidate.kind === 'sessionLifecycle') ?? null;
            return lifecycle ? { state: lifecycle.status?.state ?? null, runId: lifecycle.status?.runId ?? null } : null;
        }, { timeout: 60_000 }).toEqual({
            state: expect.stringMatching(/^(triggered|running|finished)$/u),
            runId: lifecycleRun.id,
        });

        // 10.1.6: removing the trigger through the loaded editor keeps every
        // historical Run renderable from its immutable cause.
        await gotoDomContentLoadedWithRetries(
            page,
            `${uiBaseUrl}/automations/edit?id=${existingAutomationId}&happier_hmr=0`,
            180_000,
        );
        await expect(page.getByTestId('automation-plural-editor')).toHaveCount(1, { timeout: 120_000 });
        const persistedTriggerRows = page.locator('[data-testid^="automation-trigger-row-"]');
        await expect(persistedTriggerRows).toHaveCount(1, { timeout: 60_000 });
        await persistedTriggerRows.first().click();
        await page.getByTestId('automation-trigger-remove').click();
        await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 30_000 });
        await page.getByTestId('web-modal-confirm').click();
        await expect(persistedTriggerRows).toHaveCount(0, { timeout: 30_000 });
        await saveAutomationEditorViaSubmit({ page, automationId: existingAutomationId });

        await expect.poll(async () => {
            const found = (await listPersistedAutomations({
                baseUrl: server.baseUrl,
                token: authToken,
            })).find((automation) => automation.id === existingAutomationId);
            if (!found) return null;
            // The ordinary definition no longer carries a retired-trigger
            // census; per-Run retired truth below stays the history evidence.
            return found.triggers.map((candidate) => candidate.kind);
        }, { timeout: 60_000 }).toEqual([]);
        await expect.poll(async () => (
            (await listPersistedAutomationRuns({
                baseUrl: server.baseUrl,
                token: authToken,
                automationId: existingAutomationId,
            })).map((candidate) => ({
                id: candidate.id,
                causeKind: candidate.cause.kind,
                triggerId: candidate.triggerId,
                triggerRetired: candidate.triggerRetired,
            }))
        ), { timeout: 60_000 }).toContainEqual({
            id: lifecycleRun.id,
            causeKind: 'trigger',
            triggerId: savedLifecycleTriggerId,
            triggerRetired: true,
        });
        const runHistoryAfterRemoval = await listPersistedAutomationRuns({
            baseUrl: server.baseUrl,
            token: authToken,
            automationId: existingAutomationId,
        }).then((runs) => runs.map((candidate) => ({
            id: candidate.id,
            causeKind: candidate.cause.kind,
            triggerId: candidate.triggerId,
            triggerRetired: candidate.triggerRetired,
        })));
        expect(runHistoryAfterRemoval).toContainEqual({
            id: lifecycleRun.id,
            causeKind: 'trigger',
            triggerId: savedLifecycleTriggerId,
            triggerRetired: true,
        });
        // The manual zero-trigger Run keeps its own cause facts untouched.
        expect(runHistoryAfterRemoval).toContainEqual({
            id: manualRunId,
            causeKind: 'manual',
            triggerId: null,
            triggerRetired: false,
        });

        // The retired row stays presented and the retired trigger's historical
        // Run detail remains renderable from its immutable cause snapshot.
        await gotoDomContentLoadedWithRetries(
            page,
            `${uiBaseUrl}/automations/${existingAutomationId}?happier_hmr=0`,
            180_000,
        );
        await expect(page.getByTestId(`automation-retired-trigger-${savedLifecycleTriggerId}`))
            .toHaveCount(1, { timeout: 120_000 });
        await gotoDomContentLoadedWithRetries(
            page,
            `${uiBaseUrl}/automations/${existingAutomationId}/runs/${lifecycleRun.id}?happier_hmr=0`,
            180_000,
        );
        await expect(page.getByTestId('automation-run-trigger-retired')).toHaveCount(1, { timeout: 120_000 });

        // 10.1.7: a name-only save plus one independent enablement edit must not
        // rotate the untouched trigger's identity, revision, or runtime state.
        const renamedAutomationName = `Inline automation renamed ${run.runId}`;
        await gotoDomContentLoadedWithRetries(
            page,
            `${uiBaseUrl}/automations/edit?id=${inlineAutomationId}&happier_hmr=0`,
            180_000,
        );
        await expect(page.getByTestId('automation-plural-editor')).toHaveCount(1, { timeout: 120_000 });
        const inlineTriggerRows = page.locator('[data-testid^="automation-trigger-row-"]');
        await expect(inlineTriggerRows).toHaveCount(2, { timeout: 60_000 });
        const firstTriggerSwitch = page.getByTestId(`automation-trigger-enabled-${firstTriggerId}`);
        const secondTriggerSwitch = page.getByTestId(`automation-trigger-enabled-${secondTriggerId}`);
        await expect(firstTriggerSwitch).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 });
        await expect(secondTriggerSwitch).toHaveAttribute('aria-checked', 'true');
        const firstTriggerSwitchName = await firstTriggerSwitch.getAttribute('aria-label');
        const secondTriggerSwitchName = await secondTriggerSwitch.getAttribute('aria-label');
        expect(firstTriggerSwitchName).toBeTruthy();
        expect(secondTriggerSwitchName).toBeTruthy();
        expect(firstTriggerSwitchName).not.toBe(secondTriggerSwitchName);
        // Trigger kind choices stay named, keyboard-focusable buttons.
        await page.getByTestId('automation-trigger-add').click();
        for (const kind of ['schedule', 'pluginEvent', 'sessionLifecycle'] as const) {
            const kindChoice = page.getByTestId(`automation-trigger-kind-${kind}`);
            await expect(kindChoice).toHaveCount(1);
            await expect(kindChoice).toHaveAttribute('role', 'button');
            expect(((await kindChoice.innerText()) || '').trim().length).toBeGreaterThan(0);
        }
        // Leave the kind chooser without appending a row.
        await page.getByTestId(`automation-trigger-row-${firstTriggerId}`).click();
        await page.getByTestId('automation-trigger-editor-done').click();
        await expect(inlineTriggerRows).toHaveCount(2);
        await page.getByTestId(`automation-trigger-enabled-${firstTriggerId}`).click();
        await expect(page.getByTestId(`automation-trigger-enabled-${firstTriggerId}`))
            .toHaveAttribute('aria-checked', 'false', { timeout: 30_000 });
        await expect(page.getByTestId(`automation-trigger-enabled-${secondTriggerId}`))
            .toHaveAttribute('aria-checked', 'true');
        await page.getByTestId('automation-name').first().fill(renamedAutomationName);
        await saveAutomationEditorViaSubmit({ page, automationId: inlineAutomationId });

        await expect.poll(async () => {
            const found = (await listPersistedAutomations({
                baseUrl: server.baseUrl,
                token: authToken,
            })).find((automation) => automation.id === inlineAutomationId);
            if (!found) return null;
            return {
                name: found.name,
                triggersById: Object.fromEntries(found.triggers.map((candidate) => [candidate.id, {
                    revision: candidate.revision,
                    enabled: candidate.enabled,
                }])),
            };
        }, { timeout: 60_000 }).toEqual({
            name: renamedAutomationName,
            triggersById: {
                [firstTriggerId]: { revision: expect.any(Number), enabled: false },
                [secondTriggerId]: { revision: expect.any(Number), enabled: true },
            },
        });
        const inlineAfterRename = (await listPersistedAutomations({
            baseUrl: server.baseUrl,
            token: authToken,
        })).find((automation) => automation.id === inlineAutomationId);
        if (!inlineAfterRename) {
            throw new Error('Inline automation disappeared from the definition list after the rename save');
        }
        expect(inlineAfterRename.triggers.find((candidate) => candidate.id === firstTriggerId)?.revision)
            .toBeGreaterThan(inlineBeforeRename.triggers.find((candidate) => candidate.id === firstTriggerId)?.revision ?? -1);
        expect(inlineAfterRename.triggers.find((candidate) => candidate.id === secondTriggerId)?.revision)
            .toBe(inlineBeforeRename.triggers.find((candidate) => candidate.id === secondTriggerId)?.revision);

        // 7.2: a stale observed turn with no current replacement shows typed
        // truth and never offers silent retargeting.
        await gotoDomContentLoadedWithRetries(
            page,
            `${uiBaseUrl}/session/${sourceSession.sessionId}/automations/when-turn-finishes`
                + `?sourceSessionId=${sourceSession.sessionId}&sourceTurnId=${observedTurnId}`
                + `&sourceServerId=${observedServerId}&happier_hmr=0`,
            180_000,
        );
        const staleTurnCard = page.getByTestId('exact-turn-automation-stale');
        await expect(staleTurnCard).toHaveCount(1, { timeout: 120_000 });
        await expect(staleTurnCard).toHaveAttribute('role', 'alert');
        await expect(page.getByTestId('exact-turn-automation-stale-action')).toHaveCount(0);
        await expect(page.getByTestId('exact-turn-automation-destination')).toHaveCount(0);
    });
});
