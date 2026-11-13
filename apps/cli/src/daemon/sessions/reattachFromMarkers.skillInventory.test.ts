import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { reloadConfiguration } from '@/configuration';
import { reattachTrackedSessionsFromMarkers } from './reattachFromMarkers';

it('reports a malformed retained runner marker as unknown inventory rather than no live Sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-impl-p3b-store-inventory-'));
    vi.stubEnv('HAPPIER_HOME_DIR', home); reloadConfiguration();
    try {
        // The historical preview marker directory is still a canonical inventory input on every ring.
        const marker = join(home, 'tmp', 'daemon-sessions.preview', 'pid-424242.json');
        await mkdir(dirname(marker), { recursive: true });
        await writeFile(marker, '{unreadable');
        const result = await reattachTrackedSessionsFromMarkers({ trackedSessionsByKey: new Map() });
        expect(result.inventoryReliable).toBe(false);
    } finally {
        vi.unstubAllEnvs(); reloadConfiguration();
        await rm(home, { recursive: true, force: true });
    }
});
