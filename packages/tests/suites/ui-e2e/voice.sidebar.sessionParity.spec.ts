import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import {
    VOICE_SURFACE_E2E_MESSAGE_IDS,
    openVoiceE2eConversationFromSidebar,
    reachSidebarVoiceSurfaceFixtureHome,
} from '../../src/testkit/uiE2e/voiceSurfaceFixture';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: voice sidebar session parity', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('voice-sidebar-session-parity-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let storageScope: string | null = null;

    test.beforeAll(async () => {
        storageScope = `e2e-voice-sidebar-parity-${run.runId}`;
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

    test('keeps the sidebar activity projection in parity with the opened hidden conversation transcript', async ({ page }) => {
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
        });

        await expect(page.getByTestId('voice-surface:sidebar')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('voice-surface-activity-toggle:sidebar').click();
        await expect(page.getByTestId(`voice-surface-activity-entry:sidebar:${VOICE_SURFACE_E2E_MESSAGE_IDS.assistant}`)).toHaveCount(1, {
            timeout: 120_000,
        });
        await expect(page.getByTestId(`voice-surface-activity-entry:sidebar:${VOICE_SURFACE_E2E_MESSAGE_IDS.user}`)).toHaveCount(1, {
            timeout: 120_000,
        });

        await openVoiceE2eConversationFromSidebar({ page });
        const transcriptChatList = page.getByTestId('transcript-chat-list');
        await expect(transcriptChatList).toHaveCount(1, { timeout: 120_000 });

        const transcriptMessageCount = await page.locator('[data-testid^="transcript-message-"]').count();
        expect(transcriptMessageCount).toBeGreaterThanOrEqual(2);
        await expect(transcriptChatList.getByText('first')).toHaveCount(1, { timeout: 120_000 });
        await expect(transcriptChatList.getByText('second')).toHaveCount(1, { timeout: 120_000 });
    });
});
