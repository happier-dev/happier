import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createTestAuth } from '../../src/testkit/auth';
import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl, waitForAuthenticatedRouteUi } from '../../src/testkit/uiE2e/pageNavigation';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function openActionDetailFromList(params: Readonly<{
    page: Page;
    baseUrl: string;
    actionId: string;
    requiredTestId?: string;
}>): Promise<void> {
    const actionRowId = `settings-actions:action:${params.actionId}`;
    await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/settings/actions?happier_hmr=0`, 180_000);
    await waitForAuthenticatedRouteUi({
        page: params.page,
        expectedPathname: '/settings/actions',
        requiredTestIds: [actionRowId],
        timeoutMs: 120_000,
    });
    await params.page.getByTestId(actionRowId).scrollIntoViewIfNeeded();
    await params.page.getByTestId(actionRowId).click({ timeout: 60_000 });
    await expect(params.page).toHaveURL(new RegExp(`/settings/actions/${encodeURIComponent(params.actionId)}(?:[?#].*)?$`), {
        timeout: 60_000,
    });
    if (params.requiredTestId) {
        await expect(params.page.getByTestId(params.requiredTestId)).toHaveCount(1, { timeout: 120_000 });
    }
}

function exposureControl(actionId: string, targetId: string): string {
    return `settings-actions:action:${actionId}:target:${targetId}:tool-exposure`;
}

function exposureOption(actionId: string, targetId: string, option: 'default' | 'direct' | 'discoverable_only'): string {
    return `${exposureControl(actionId, targetId)}:${option}`;
}

function resolvedExposureMarker(actionId: string, targetId: string, mode: 'direct' | 'discoverable_only'): string {
    return `settings-actions:action:${actionId}:target:${targetId}:tool-exposure:resolved:${mode}`;
}

async function expectResolvedExposure(params: Readonly<{
    page: Page;
    actionId: string;
    targetId: string;
    mode: 'direct' | 'discoverable_only';
}>): Promise<void> {
    await expect(params.page.getByTestId(resolvedExposureMarker(params.actionId, params.targetId, params.mode)))
        .toHaveCount(1, { timeout: 60_000 });
}

async function chooseExposureOption(params: Readonly<{
    page: Page;
    actionId: string;
    targetId: string;
    option: 'default' | 'direct' | 'discoverable_only';
}>): Promise<void> {
    const control = params.page.getByTestId(exposureControl(params.actionId, params.targetId));
    await expect(control).toHaveCount(1, { timeout: 60_000 });
    await control.scrollIntoViewIfNeeded();
    await control.click({ timeout: 60_000 });

    const option = params.page.getByTestId(exposureOption(params.actionId, params.targetId, params.option));
    await expect(option).toHaveCount(1, { timeout: 60_000 });
    await option.click({ timeout: 60_000 });
}

async function hasPersistedSettingsRecord(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
        const accountSettingsLogicalKeyPrefix = 'account-settings:v2:';
        const legacySettingsKeys = ['mmkv.default\\settings', 'settings'];
        if (legacySettingsKeys.some((key) => window.localStorage.getItem(key) !== null)) {
            return true;
        }

        let scopedCount = 0;
        for (let index = 0; index < window.localStorage.length; index += 1) {
            const rawKey = window.localStorage.key(index);
            if (!rawKey) continue;

            const separatorIndex = rawKey.lastIndexOf('\\');
            if (separatorIndex <= 0 || separatorIndex >= rawKey.length - 1) continue;

            const logicalKey = rawKey.slice(separatorIndex + 1);
            if (logicalKey.startsWith(accountSettingsLogicalKeyPrefix)) {
                scopedCount += 1;
            }
        }
        return scopedCount === 1;
    });
}

async function waitForPersistedSettingsRecord(page: Page): Promise<void> {
    await expect.poll(async () => hasPersistedSettingsRecord(page), { timeout: 120_000 }).toBe(true);
}

async function readLocalPersistedExposure(params: Readonly<{
    page: Page;
    actionId: string;
    targetId: string;
}>): Promise<'direct' | 'discoverable_only' | null> {
    return await params.page.evaluate(({ actionId, targetId }) => {
        const accountSettingsLogicalKeyPrefix = 'account-settings:v2:';
        const legacySettingsKeys = ['mmkv.default\\settings', 'settings'];
        type UnknownRecord = Record<string, unknown>;
        const asRecord = (value: unknown): UnknownRecord | null => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
            return value as UnknownRecord;
        };
        const readLegacySettingsRaw = (): string | null => {
            for (const key of legacySettingsKeys) {
                const raw = window.localStorage.getItem(key);
                if (raw !== null) return raw;
            }
            return null;
        };

        const scopedSettingsKeys: string[] = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
            const rawKey = window.localStorage.key(index);
            if (!rawKey) continue;

            const separatorIndex = rawKey.lastIndexOf('\\');
            if (separatorIndex <= 0 || separatorIndex >= rawKey.length - 1) continue;

            const logicalKey = rawKey.slice(separatorIndex + 1);
            if (logicalKey.startsWith(accountSettingsLogicalKeyPrefix)) {
                scopedSettingsKeys.push(rawKey);
            }
        }

        const rawSettings = scopedSettingsKeys.length === 1
            ? window.localStorage.getItem(scopedSettingsKeys[0]!)
            : readLegacySettingsRaw();
        if (!rawSettings) return null;

        const envelope = asRecord(JSON.parse(rawSettings));
        const settings = asRecord(envelope?.settings);
        const actionsSettings = asRecord(settings?.actionsSettingsV1);
        const actions = asRecord(actionsSettings?.actions);
        const actionOverride = asRecord(actions?.[actionId]);
        const toolExposureModes = asRecord(actionOverride?.toolExposureModes);
        const mode = toolExposureModes?.[targetId];
        return mode === 'direct' || mode === 'discoverable_only' ? mode : null;
    }, {
        actionId: params.actionId,
        targetId: params.targetId,
    });
}

async function waitForLocalPersistedExposure(params: Readonly<{
    page: Page;
    actionId: string;
    targetId: string;
    mode: 'direct' | 'discoverable_only' | null;
}>): Promise<void> {
    await expect.poll(async () => readLocalPersistedExposure(params), { timeout: 120_000 }).toBe(params.mode);
}

test.describe('ui e2e: actions settings tool exposure', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('settings-actions-tool-exposure-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;

    test.beforeAll(async () => {
        test.setTimeout(540_000);
        await mkdir(suiteDir, { recursive: true });

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
            },
        });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...process.env,
                EXPO_PUBLIC_DEBUG: '1',
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-settings-actions-tool-exposure-${run.runId}`,
            },
        });

        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        test.setTimeout(60_000);
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('persists per-surface action tool exposure overrides', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing fixtures');

        const actionId = 'agents.backends.list';

        await page.setViewportSize({ width: 1440, height: 900 });
        const auth = await createTestAuth(server.baseUrl);
        await installAuthBootstrapStorageSnapshot(page, buildAuthBootstrapStorageSnapshot({
            serverUrl: server.baseUrl,
            credentials: { token: auth.token, secret: auth.token },
            storageScope: `e2e-settings-actions-tool-exposure-${run.runId}`,
        }));

        await openActionDetailFromList({
            page,
            baseUrl: uiBaseUrl,
            actionId,
            requiredTestId: exposureControl(actionId, 'session_agent'),
        });

        await expectResolvedExposure({ page, actionId, targetId: 'session_agent', mode: 'discoverable_only' });
        await expectResolvedExposure({ page, actionId, targetId: 'mcp', mode: 'direct' });
        await expectResolvedExposure({ page, actionId, targetId: 'cli', mode: 'direct' });
        await waitForPersistedSettingsRecord(page);

        await chooseExposureOption({
            page,
            actionId,
            targetId: 'session_agent',
            option: 'direct',
        });
        await expectResolvedExposure({ page, actionId, targetId: 'session_agent', mode: 'direct' });
        await waitForLocalPersistedExposure({
            page,
            actionId,
            targetId: 'session_agent',
            mode: 'direct',
        });

        await openActionDetailFromList({
            page,
            baseUrl: uiBaseUrl,
            actionId,
            requiredTestId: resolvedExposureMarker(actionId, 'session_agent', 'direct'),
        });
        await expectResolvedExposure({ page, actionId, targetId: 'session_agent', mode: 'direct' });

        await chooseExposureOption({
            page,
            actionId,
            targetId: 'session_agent',
            option: 'default',
        });
        await expectResolvedExposure({ page, actionId, targetId: 'session_agent', mode: 'discoverable_only' });
        await waitForLocalPersistedExposure({
            page,
            actionId,
            targetId: 'session_agent',
            mode: null,
        });

        await openActionDetailFromList({
            page,
            baseUrl: uiBaseUrl,
            actionId,
            requiredTestId: resolvedExposureMarker(actionId, 'session_agent', 'discoverable_only'),
        });
        await expectResolvedExposure({ page, actionId, targetId: 'session_agent', mode: 'discoverable_only' });
    });
});
