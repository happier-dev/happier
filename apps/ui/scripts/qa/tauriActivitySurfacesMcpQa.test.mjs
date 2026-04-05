import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('tauri activity-surfaces QA exposes a deterministic capture plan', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriActivitySurfacesMcpQa.mjs');

    const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
        cwd: dirname(dirname(scriptsDir)),
        env: { ...process.env },
        encoding: 'utf8',
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.match(String(payload.plan.artifactRoot), /activity-surfaces-qa[\\/]/);
    assert.match(String(payload.plan.trackerPath), /happier-activity-surfaces-qa-tracking-2026-04-05\.md$/);
    assert.deepEqual(
        payload.plan.steps.map((step) => step.id),
        ['settings_overlay', 'overlay_route', 'overlay_collapsed', 'overlay_expanded'],
    );
    assert.equal(payload.plan.steps[0].selectors.includes('[data-testid="settings-desktop-overlay-enabled"]'), true);
});
