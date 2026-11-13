import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSkillStore } from '@/prompts/skills/store/skillStore';
import type { TrackedSession } from '../types';
import { createOnChildExited } from './onChildExited';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(
    replacement: boolean,
    readLibraryDigests: () => Promise<readonly string[] | null> = async () => [],
) {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-impl-p3b-store-exit-')); roots.push(happyHomeDir);
    const sessionId = 'PID-424242'; const pid = 424242;
    const pluginRoot = join(happyHomeDir, 'skills', 'sessions', sessionId);
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, 'session.json'), JSON.stringify({ items: [] }));
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: sessionId, startedBy: 'terminal' };
    const sessions = new Map([[legacyPidSessionTrackingKey(pid), tracked]]);
    if (replacement) sessions.set(legacyPidSessionTrackingKey(process.pid), { trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, happySessionId: sessionId, startedBy: 'terminal' });
    const store = createSkillStore({ happyHomeDir, readLibraryDigests });
    const exited = createOnChildExited({ trackedSessionsByKey: sessions, spawnResourceCleanupByKey: new Map(),
        sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null,
        // Persistence is an OS boundary; this fixture never writes a real Session marker.
        removeSessionMarkerFn: async () => {}, skillStore: store });
    await exited(pid, { reason: 'process-exited', code: 0, signal: null });
    return { pluginRoot, sessions };
}
it('releases the skill folder when the runner exits', async () => {
    const f = await fixture(false);
    await expect(lstat(f.pluginRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('retains the skill folder for a live replacement runner of the same Session', async () => {
    const f = await fixture(true);
    expect(await lstat(f.pluginRoot)).toBeDefined();
    expect(f.sessions.has(legacyPidSessionTrackingKey(process.pid))).toBe(true);
});

it('retires the exited runner without waiting for remote skill cache inventory', async () => {
    let releaseInventory!: (value: readonly string[]) => void;
    let inventoryStarted!: () => void;
    const inventory = new Promise<readonly string[]>(resolve => { releaseInventory = resolve; });
    const started = new Promise<void>(resolve => { inventoryStarted = resolve; });
    let retired = false;
    // The real SkillStore and exit owner run beneath the remote inventory boundary.
    const exit = fixture(false, async () => {
        inventoryStarted();
        return await inventory;
    }).then(result => { retired = true; return result; });
    try {
        await started;
        await vi.waitFor(() => expect(retired).toBe(true));
        const result = await exit;
        expect(result.sessions.has(legacyPidSessionTrackingKey(424242))).toBe(false);
        await expect(lstat(result.pluginRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
        releaseInventory([]);
        await exit;
    }
});
