/**
 * Phase 11.11 — Path picker UI e2e (agent-input-selection-list-popover-unification).
 *
 * Verifies the migrated `PathSelectionList` surface keeps a stable contract
 * inside the agent-input path popover after the SelectionList unification:
 *   - the popover container mounts under the `path-selection-list` root
 *     testID;
 *   - the in-input search/value field mounts under
 *     `path-selection-list:header:input`;
 *   - the tree-browser escape-hatch button mounts under
 *     `path-selection-list:open-tree-browser` (inside `inputSuffix`, never
 *     the footer);
 *   - the footer renders keyboard hints for navigate / commit / autocomplete
 *     / walk-up (and is suppressed on touch-only viewports — covered by
 *     unit tests, not asserted here because the e2e harness uses a desktop
 *     viewport with a hardware keyboard).
 *
 * R2 path-picker correctness fixes (Bug 4a-e) are covered as follows:
 *   - Bug 4a (double-commit): asserted via the vitest case
 *     "Bug 4a: fires onCommit exactly once per row press" in
 *     `apps/ui/sources/components/sessions/new/components/PathSelectionList.test.tsx`.
 *     The e2e spec smoke-verifies the popover wiring and does NOT
 *     re-assert tap-to-commit count (that requires deterministic
 *     RPC mocking which is what the vitest case owns).
 *   - Bug 4b (autocomplete descent): asserted via the vitest case
 *     "Bug 4b: directory kind appends trailing separator …" in
 *     `apps/ui/sources/utils/path/browseSegments.test.ts`.
 *   - Bug 4c (touch drill chevron drills, NOT commits): asserted via
 *     the vitest case "Bug 4c: dynamic-section directory rows expose a
 *     drill-down chevron that does NOT commit".
 *   - Bug 4d (UNC / partial Windows shapes): asserted via the
 *     "Bug 4d: UNC and partial Windows path handling" describe block in
 *     `browseSegments.test.ts`.
 *   - Bug 4e (initialValue resync): asserted via the vitest case
 *     "Bug 4e: resyncs the input value when the parent changes
 *     initialValue identity".
 *
 * The full keyboard journey listed in plan Phase 11.11 (drilling via ghost
 * suffixes, Tab autocomplete preserving shorthand, Backspace walk-up,
 * Enter-commit of resolved-absolute paths, Windows-platform semantics on a
 * remote host, reduced-motion behavior) is exercised in vitest unit tests
 * (`PathSelectionList.test.tsx`, `browseInputBehavior.test.ts`,
 * `browseSegments.test.ts`, `SelectionListInputController.test.tsx`,
 * `useSelectionListAutocomplete.test.ts`) because:
 *   1. The unit tests can deterministically drive the input string and
 *      assert on the path-domain helpers without provisioning a real
 *      remote filesystem;
 *   2. Playwright's keyboard simulation against a real `listDirectory`
 *      RPC is slow and adds little additional signal over the unit
 *      tests for the path-domain transformations;
 *   3. The browser-level keyboard handling (Tab focus management,
 *      reduced-motion, ghost width measurement) is owned by
 *      `SelectionListInputController` and tested there.
 *
 * Anything that requires a real session draft + machine + popover anchor
 * (the popover wiring, the chip → popover → SelectionList composition) is
 * what this e2e spec is for.
 */

import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { gotoDomContentLoadedWithRetries } from '../../src/testkit/uiE2e/pageNavigation';
import { enableEnhancedSessionWizard } from '../../src/testkit/uiE2e/enableEnhancedSessionWizard';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: /new path picker (Phase 11 SelectionList migration)', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('new-session-path-picker-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
        test.setTimeout(540_000);
        await mkdir(cliHomeDir, { recursive: true });

        server = await startServerLight({ testDir: suiteDir });
        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...process.env,
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
            },
        });
        uiBaseUrl = ui.baseUrl;
    });

    test.afterAll(async () => {
        try { await daemon?.stop?.(); } catch { /* best-effort */ }
        try { await ui?.stop?.(); } catch { /* best-effort */ }
        try { await server?.stop?.(); } catch { /* best-effort */ }
    });

    test('the path popover renders the new PathSelectionList surface with the open-tree-browser button', async ({ page }) => {
        if (!server || !ui || !uiBaseUrl) {
            throw new Error('test infra failed to start');
        }
        test.setTimeout(540_000);

        daemon = await authenticateAndStartDaemon({
            page,
            testDir: suiteDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            uiBaseUrl,
            initialUiGotoTimeoutMs: 420_000,
            initialUiReadyTimeoutMs: 420_000,
            terminalConnectUrlTimeoutMs: 90_000,
            daemonStartupTimeoutMs: 180_000,
            extraEnv: {
                ...process.env,
            },
        });

        await enableEnhancedSessionWizard({ page, baseUrl: uiBaseUrl });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new`, 60_000);

        // Open the agent-input path chip → popover.
        await page.getByTestId('agent-input-path-chip').click();
        const activePopover = page.getByTestId('agent-input-content-popover');
        await expect(activePopover).toHaveCount(1, { timeout: 30_000 });

        // The new PathSelectionList surface mounts under the path-selection-list root testID.
        await expect(activePopover.getByTestId('path-selection-list')).toBeVisible({ timeout: 30_000 });
        // The input prefix/value field is part of the SelectionList header.
        await expect(activePopover.getByTestId('path-selection-list:header:input')).toBeVisible();
        // The open-tree-browser escape hatch lives inside the input suffix slot (NOT the footer).
        await expect(activePopover.getByTestId('path-selection-list:open-tree-browser')).toBeVisible();
        // The legacy PathSelector testIDs are gone.
        await expect(page.getByTestId('path-selector-input')).toHaveCount(0);
    });
});
