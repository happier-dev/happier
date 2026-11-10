import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createStorageService } from './storageService';
import { createStoragePolicyFixture } from './storagePolicy.testkit';

it('reads the selected filesystem once, preserves zero and reports unavailable without scanning', async () => {
    await withTempDir('local-backup-capacity-', async root => {
        const selected = join(root, 'other-disk');
        await mkdir(selected);
        const canonical = await realpath(selected);
        let available: number | undefined = 0;
        const calls: string[] = [];
        const service = createStorageService(Object.assign({ resourcesPolicy: await createStoragePolicyFixture(),
            catalog: { happyHomeDir: root, activeServerDir: root },
            readVolumes: () => [{ id: 'root', label: 'System', mount: root, totalBytes: 10000, availableBytes: 9999 },
                { id: 'archive', label: 'Archive', mount: canonical, totalBytes: 10000, availableBytes: 8000 }], nowMs: () => 1234 }, {
            async readFilesystemCapacity(path: string) {
                calls.push(path);
                if (available === undefined) throw Object.assign(new Error('unavailable'), { code: 'ENOTSUP' });
                return { bavail: available, bsize: 4096 };
            },
        }));
        try {
            expect(calls).toEqual([]);
            expect(await service.capacityForPath(selected)).toMatchObject({ status: 'known', path: canonical, freeBytes: 0, observedAt: 1234,
                volume: { volumeId: 'archive', mountPath: canonical, label: 'Archive' } });
            available = undefined;
            expect(await service.capacityForPath(selected)).toMatchObject({ status: 'unknown', path: canonical, reason: 'ENOTSUP' });
            expect(calls).toEqual([canonical, canonical]);
        } finally { service.dispose(); }
    });
});
