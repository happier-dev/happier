import { expect, it, vi } from 'vitest';
import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { FileDownloadResultV1 } from '@happier-dev/plugin-sdk/protocol';
import { createDatabaseActions } from './actions.js';
import { exportSelectedRows } from './selectedExport.js';
import { DATABASE_ROWS_EXPORT_DOWNLOAD_ACTION_ID_V1, type DatabaseSelectedRowsExportInputV1 } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/plugin-sdk/actions';
const downloadId = databaseActionLocalIdV1(DATABASE_ROWS_EXPORT_DOWNLOAD_ACTION_ID_V1);

const destination = { destinationId: 'receiver-issued' };
const receipt: FileDownloadResultV1 = { success: true, status: 'accepted', operationId: 'host-operation',
    destinationId: destination.destinationId, prepared: { transferId: 'host-transfer', name: 'database-rows.csv',
        sizeBytes: 1, manifestHash: `sha256:${'a'.repeat(64)}`, expiresAt: 1, endpointCandidates: [] } };
const input: DatabaseSelectedRowsExportInputV1 = { format: 'csv', result: {
    columns: [{ name: 'name', nativeType: 'text', semanticType: 'text' }],
    rows: [{ cells: [{ type: 'text', value: 'Élodie,"東京"' }] }], completeness: { complete: false, reason: 'page' },
} };

async function fixture(publicationError = false) {
    // Only the host filesystem/custody boundary is substituted; SDK Action admission and serialization stay real.
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected filesystem operation'); };
    const prepareDownload = vi.fn<PluginInvocationContext['services']['fs']['prepareDownload']>(async () => {
        if (publicationError) throw new Error('Publication response lost');
        return receipt;
    });
    const plugin = definePlugin({ id: 'happier.database', version: '0.0.0', actions: createDatabaseActions({}) });
    const host = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { fs: {
        prepareDownload, observeMachinePath: unavailable, readFile: unavailable, writeFile: unavailable,
        stat: unavailable, list: unavailable, remove: unavailable,
    } } });
    return { host, plugin, prepareDownload };
}

it.each(['csv', 'json'] as const)('exports selected %s bytes through canonical host download custody', async format => {
    const f = await fixture();
    try {
        const selected = { ...input, format };
        const signal = new AbortController().signal;
        expect(await f.host.invokeAction(downloadId, { ...selected, destination }, { signal })).toEqual(receipt);
        expect(f.prepareDownload).toHaveBeenCalledTimes(1);
        const [download, options] = f.prepareDownload.mock.calls[0]!;
        expect({ name: download.name, destination: download.destination }).toEqual({ name: `database-rows.${format}`, destination });
        expect(Array.from(download.bytes)).toEqual(Array.from(new TextEncoder().encode(exportSelectedRows(selected).content)));
        expect(options?.signal).toBeDefined();
        expect(options?.signal?.aborted).toBe(false);
        expect(f.plugin.manifest.contributes.actions!.find(action => action.id === downloadId)).toMatchObject({
            dangerLevel: 'writesLocal', readOnly: false, operation: { version: 1 },
        });
        await expect(f.host.invokeAction(downloadId, { ...selected, destination: { path: '/arbitrary' } }))
            .rejects.toMatchObject({ code: 'plugin_action_input_schema_invalid' });
        expect(f.prepareDownload).toHaveBeenCalledTimes(1);
    } finally { await f.host.dispose(); }
});

it('does not replay or reinterpret an uncertain publication result', async () => {
    const f = await fixture(true);
    try {
        await expect(f.host.invokeAction(downloadId, { ...input, destination })).rejects.toThrow('Publication response lost');
        expect(f.prepareDownload).toHaveBeenCalledTimes(1);
    } finally { await f.host.dispose(); }
});
