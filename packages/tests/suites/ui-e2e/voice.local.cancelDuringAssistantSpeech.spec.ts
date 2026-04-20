import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import {
    VOICE_SURFACE_E2E_FIXTURE_CANCEL_DURING_ASSISTANT_SPEECH,
    reachSidebarVoiceSurfaceFixtureHome,
} from '../../src/testkit/uiE2e/voiceSurfaceFixture';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: voice cancel during assistant speech', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('voice-cancel-during-assistant-speech-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let storageScope: string | null = null;

    test.beforeAll(async () => {
        storageScope = `e2e-voice-cancel-speech-${run.runId}`;
        const uiWebEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: storageScope,
            HAPPIER_E2E_UI_WEB_MODE: 'metro',
        };

        test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
        await mkdir(suiteDir, { recursive: true });

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_FEATURE_VOICE__ENABLED: '1',
                HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: '0',
            },
        });

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
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('stops a speaking turn when pressing cancel (no stuck speaking/connecting)', async ({ page }) => {
        test.setTimeout(360_000);
        if (!uiBaseUrl || !server || !storageScope) {
            throw new Error('missing ui/sidebar fixture');
        }

        await page.setViewportSize({ width: 1440, height: 900 });
        await reachSidebarVoiceSurfaceFixtureHome({
            page,
            uiBaseUrl,
            serverBaseUrl: server.baseUrl,
            storageScope,
            fixtureId: VOICE_SURFACE_E2E_FIXTURE_CANCEL_DURING_ASSISTANT_SPEECH,
        });

        await expect(page.getByTestId('voice-surface:sidebar')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('voice-surface-status:sidebar:connected')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('voice-surface-mode:sidebar:speaking')).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('voice-surface-cancel:sidebar').click({ timeout: 30_000 });

        await expect(page.getByTestId('voice-surface-status:sidebar:disconnected')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('voice-surface-mode:sidebar:idle')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('voice-surface-toggle:sidebar')).toBeEnabled({ timeout: 120_000 });
    });
});
