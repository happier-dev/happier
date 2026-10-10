import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
beforeAll(prepareSessionFilesViewTestkit);

describe('generic UI transfer custody', () => {
    it('refuses before the signed API-token execute or preparation transport', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const request = vi.fn(async () => Response.json({}));
        const executor = createDefaultActionExecutor({ apiTokenAction: { request, target: { kind: 'machine', machineId: 'machine' } } });
        const input = { rootPath: '/repo', path: 'binary', destination: { destinationId: 'arbitrary' }, asZip: false };
        expect(await executor.execute('daemon.filesystem.download', input, { surface: 'voice' }))
            .toMatchObject({ ok: false, errorCode: 'filesystem_transfer_custody_required' });
        expect(await executor.prepare('daemon.filesystem.download', input, { surface: 'voice' }))
            .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'filesystem_transfer_custody_required' } });
        expect(request).not.toHaveBeenCalled();
    });
    it('refuses a caller-authored entry manifest without original export custody before public preparation', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const request = vi.fn(async () => Response.json({}));
        const executor = createDefaultActionExecutor({ apiTokenAction: { request, target: { kind: 'machine', machineId: 'machine' } } });
        const input = { kind: 'prepared_transfer', source: { kind: 'entry_tree', serverId: 'home', machineId: 'source', rootPath: '/source', path: 'tree',
            sourceId: 'arbitrary', sizeBytes: 4, sha256: '0'.repeat(64), entryTree: { operationId: 'arbitrary',
                expectation: { kind: 'directory', fingerprint: '1'.repeat(64) }, blobs: [] } },
            destination: { serverId: 'home', machineId: 'machine', rootPath: '/destination', path: 'tree' }, overwrite: false, recursive: true };
        expect(await executor.prepare('daemon.filesystem.copy', input, { surface: 'voice' }))
            .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'filesystem_transfer_custody_required' } });
        expect(await executor.execute('daemon.filesystem.copy', input, { surface: 'voice' }))
            .toMatchObject({ ok: false, errorCode: 'filesystem_transfer_custody_required' });
        expect(request).not.toHaveBeenCalled();
    });
});
