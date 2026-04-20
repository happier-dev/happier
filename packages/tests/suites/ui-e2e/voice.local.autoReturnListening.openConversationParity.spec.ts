import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import {
    VOICE_SURFACE_E2E_FIXTURE_LOCAL_AUTO_RETURN_LISTENING,
    VOICE_SURFACE_E2E_MESSAGE_IDS,
    openVoiceE2eConversationFromSidebar,
    reachSidebarVoiceSurfaceFixtureHome,
} from '../../src/testkit/uiE2e/voiceSurfaceFixture';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: voice local auto return listening (opened conversation parity)', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('voice-local-auto-return-listening-open-conversation-parity-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let storageScope: string | null = null;

    test.beforeAll(async () => {
        // Export-mode web builds bake a single storage scope at build time (see uiWebExport.ts);
        // keep this empty so the auth bootstrap snapshot uses the same unscoped storage ids.
        storageScope = '';
        const uiWebEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: storageScope,
            // The local-conversation fixture can trigger Metro lazy-bundle fan-out that intermittently
            // stalls in CI mode; use the exported web build for deterministic module loading.
            HAPPIER_E2E_UI_WEB_MODE: 'export',
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

    test('keeps the opened conversation transcript in parity while the sidebar surface is listening', async ({ page }) => {
        test.setTimeout(360_000);
        if (!uiBaseUrl || !server || storageScope == null) {
            throw new Error('missing ui/sidebar fixture');
        }

        await reachSidebarVoiceSurfaceFixtureHome({
            page,
            uiBaseUrl,
            serverBaseUrl: server.baseUrl,
            storageScope,
            fixtureId: VOICE_SURFACE_E2E_FIXTURE_LOCAL_AUTO_RETURN_LISTENING,
        });

        await expect(page.getByTestId('voice-surface:sidebar')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('voice-surface-mode:sidebar:listening')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('voice-surface-status:sidebar:connected')).toHaveCount(1, { timeout: 120_000 });

        await expect(page.getByTestId('voice-surface-activity-count:sidebar')).toHaveText('2', { timeout: 120_000 });
        await page.getByTestId('voice-surface-activity-toggle:sidebar').click();
        await expect(page.getByTestId(`voice-surface-activity-entry:sidebar:${VOICE_SURFACE_E2E_MESSAGE_IDS.user}`)).toHaveCount(1, {
            timeout: 120_000,
        });
        await expect(page.getByTestId(`voice-surface-activity-entry:sidebar:${VOICE_SURFACE_E2E_MESSAGE_IDS.assistant}`)).toHaveCount(1, {
            timeout: 120_000,
        });

        await openVoiceE2eConversationFromSidebar({ page });
        const transcriptChatList = page.getByTestId('transcript-chat-list');
        await expect(transcriptChatList).toHaveCount(1, { timeout: 120_000 });
        await expect(transcriptChatList.getByText('first')).toHaveCount(1, { timeout: 120_000 });
        await expect(transcriptChatList.getByText('second')).toHaveCount(1, { timeout: 120_000 });
    });
});
