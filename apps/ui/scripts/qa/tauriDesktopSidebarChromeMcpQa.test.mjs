import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('tauri desktop-sidebar-chrome QA exposes a deterministic capture plan', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriDesktopSidebarChromeMcpQa.mjs');

    const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
        cwd: dirname(dirname(scriptsDir)),
        env: { ...process.env },
        encoding: 'utf8',
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.plan.driverSessionPort, 9225);
    assert.match(String(payload.plan.artifactRoot), /desktop-sidebar-chrome-qa[\\/]/);
    assert.deepEqual(payload.plan.chromePolicyProbe, {
        artifact: '00-window-chrome-policy.json',
        command: 'desktop_get_window_chrome_policy',
    });
    assert.deepEqual(
        payload.plan.steps.map((step) => step.id),
        [
            'authenticated_sidebar_expanded',
            'authenticated_sidebar_collapsed',
            'authenticated_focus_mode',
            'unauthenticated_shell',
            'narrow_desktop_fallback',
        ],
    );
    assert.deepEqual(payload.plan.steps[0].selectors, [
        '[data-testid="desktop-sidebar-chrome"]',
        '[data-testid="desktop-window-controls-host"]',
        '[data-testid="desktop-update-indicator-host"]',
    ]);
    assert.deepEqual(payload.plan.steps[1].selectors, [
        '[data-testid="desktop-collapsed-shell-chrome"]',
        '[data-testid="desktop-window-controls-host"]',
        '[data-testid="desktop-update-indicator-host"]',
    ]);
    assert.deepEqual(payload.plan.steps[2].selectors, [
        '[data-testid="desktop-focus-mode-shell-chrome"]',
        '[data-testid="desktop-window-controls-host"]',
    ]);
    assert.deepEqual(payload.plan.steps[3].selectors, [
        '[data-testid="desktop-unauth-shell-chrome"]',
        '[data-testid="desktop-window-controls-host"]',
        '[data-testid="desktop-update-indicator-host"]',
    ]);
    assert.deepEqual(payload.plan.steps[4].selectors, [
        '[data-testid="desktop-narrow-shell-chrome"]',
        '[data-testid="desktop-window-controls-host"]',
        '[data-testid="desktop-update-indicator-host"]',
    ]);
});
