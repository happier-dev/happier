import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    resolveProcessOwnershipLeasesDir,
    sweepProcessOwnershipLeases,
    writeProcessOwnershipLease,
} from './processOwnershipLease';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('process ownership leases', () => {
    it('isolates lease writes and stale-process sweeps beneath the configured scratch root', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-owned-process-isolation-'));
        try {
            const defaultLeaseDir = join(rootDir, '.project', 'tmp', 'generic-worker-processes');
            await mkdir(defaultLeaseDir, { recursive: true });
            const existingMarker = join(defaultLeaseDir, 'pid-8123.json');
            const marker = JSON.stringify({
                childPid: 8123, childStartTime: 'child-start', ownerPid: 9001,
                ownerStartTime: 'owner-start', createdAtMs: 123,
            });
            await writeFile(existingMarker, marker);
            const scratchLeaseRoot = join(rootDir, 'isolated-leases');
            vi.stubEnv('HAPPIER_E2E_PROCESS_LEASES_DIR', ` ${scratchLeaseRoot} `);

            // OS process inspection/termination are genuine boundaries; the lease selection and sweep stay real.
            const terminate = vi.fn(async () => {});
            await sweepProcessOwnershipLeases({
                rootDir, leaseKind: 'generic-worker', currentOwnerPid: 1337,
                currentOwnerStartTime: 'current-start',
                inspectProcess: (pid) => pid === 8123
                    ? { ok: true, command: 'generic-worker', startTime: 'child-start' }
                    : { ok: false, reason: 'not_found' },
                terminateProcessTreeByPid: terminate,
                isOwnedProcessCommand: (command) => command === 'generic-worker',
            });
            expect(terminate).not.toHaveBeenCalled();
            expect(await readFile(existingMarker, 'utf8')).toBe(marker);
            const isolatedMarker = await writeProcessOwnershipLease({
                rootDir, leaseKind: 'generic-worker', childPid: 8124, childStartTime: 'child-start',
                ownerPid: 1337, ownerStartTime: 'current-start',
            });
            expect(isolatedMarker).toBe(join(scratchLeaseRoot, 'generic-worker-processes', 'pid-8124.json'));
            expect(JSON.parse(await readFile(isolatedMarker, 'utf8'))).toMatchObject({ childPid: 8124, ownerPid: 1337 });
        } finally {
            await rm(rootDir, { recursive: true, force: true });
        }
    });

    it('preserves the explicit repository-root default when the scratch override is absent or blank', () => {
        vi.stubEnv('HAPPIER_E2E_PROCESS_LEASES_DIR', undefined);
        const rootDir = tmpdir();
        const expected = join(rootDir, '.project', 'tmp', 'generic-worker-processes');
        expect(resolveProcessOwnershipLeasesDir({ rootDir, leaseKind: 'generic-worker' })).toBe(expected);
        vi.stubEnv('HAPPIER_E2E_PROCESS_LEASES_DIR', '   ');
        expect(resolveProcessOwnershipLeasesDir({ rootDir, leaseKind: 'generic-worker' })).toBe(expected);
    });

    it('reclaims a stale owned process lease when the owner is gone and the child start time still matches', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-owned-process-lease-'));
        try {
            const leaseDir = resolveProcessOwnershipLeasesDir({ rootDir, leaseKind: 'generic-worker' });
            await mkdir(leaseDir, { recursive: true });

            const markerPath = join(leaseDir, 'pid-8123.json');
            await writeFile(
                markerPath,
                JSON.stringify({
                    childPid: 8123,
                    childStartTime: 'Tue Mar 18 10:10:10 2026',
                    ownerPid: 9001,
                    ownerStartTime: 'Tue Mar 18 09:09:09 2026',
                    createdAtMs: 123,
                    metadata: { purpose: 'test' },
                }),
                'utf8',
            );

            const terminateProcessTreeByPid = vi.fn(async () => {});
            const inspectProcess = vi.fn((pid: number) => {
                if (pid === 9001) {
                    return { ok: false as const, reason: 'not_found' as const };
                }
                if (pid === 8123) {
                    return {
                        ok: true as const,
                        command: 'node /tmp/fake-worker.js --label generic-worker',
                        startTime: 'Tue Mar 18 10:10:10 2026',
                    };
                }
                return { ok: false as const, reason: 'inspect_failed' as const };
            });

            await sweepProcessOwnershipLeases({
                rootDir,
                leaseKind: 'generic-worker',
                currentOwnerPid: 1337,
                currentOwnerStartTime: 'Tue Mar 18 11:11:11 2026',
                inspectProcess,
                terminateProcessTreeByPid,
                isOwnedProcessCommand: (command) => command.includes('generic-worker'),
            });

            expect(terminateProcessTreeByPid).toHaveBeenCalledTimes(1);
            expect(terminateProcessTreeByPid).toHaveBeenCalledWith(8123, expect.any(Object));
            await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(rootDir, { recursive: true, force: true });
        }
    });

    it('keeps a lease marker when the child pid no longer matches the stored start time', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'happier-owned-process-lease-mismatch-'));
        try {
            const leaseDir = resolveProcessOwnershipLeasesDir({ rootDir, leaseKind: 'generic-worker' });
            await mkdir(leaseDir, { recursive: true });

            const markerPath = join(leaseDir, 'pid-8125.json');
            await writeFile(
                markerPath,
                JSON.stringify({
                    childPid: 8125,
                    childStartTime: 'Tue Mar 18 14:14:14 2026',
                    ownerPid: 9003,
                    ownerStartTime: 'Tue Mar 18 15:15:15 2026',
                    createdAtMs: 789,
                }),
                'utf8',
            );

            const terminateProcessTreeByPid = vi.fn(async () => {});
            const inspectProcess = vi.fn((pid: number) => {
                if (pid === 9003) {
                    return { ok: false as const, reason: 'not_found' as const };
                }
                if (pid === 8125) {
                    return {
                        ok: true as const,
                        command: 'node /tmp/fake-worker.js --label generic-worker',
                        startTime: 'Tue Mar 18 16:16:16 2026',
                    };
                }
                return { ok: false as const, reason: 'inspect_failed' as const };
            });

            await sweepProcessOwnershipLeases({
                rootDir,
                leaseKind: 'generic-worker',
                currentOwnerPid: 1337,
                currentOwnerStartTime: 'Tue Mar 18 17:17:17 2026',
                inspectProcess,
                terminateProcessTreeByPid,
                isOwnedProcessCommand: (command) => command.includes('generic-worker'),
            });

            expect(terminateProcessTreeByPid).not.toHaveBeenCalled();
            expect(await readFile(markerPath, 'utf8')).toContain('"childPid":8125');
        } finally {
            await rm(rootDir, { recursive: true, force: true });
        }
    });
});
