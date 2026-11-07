import { exists, inUse, item, isCategoryPathInScope, unavailableDirectory } from './filesystem';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { StorageCategoryAdapterError } from './types';
import type { StorageCategoryDefinition, StorageCategoryAdapter, StorageCategoryCatalogDeps, StorageCategoryItem } from './types';
const OwnerDataSchema = z.strictObject({ recordingId: z.string().check(z.minLength(1)) });
const StoredOwnerDataSchema = createStoredReadSchema(OwnerDataSchema);
function adapter(data: JsonValue, deps: StorageCategoryCatalogDeps): StorageCategoryAdapter {
    const parsed = StoredOwnerDataSchema.safeParse(data);
    if (!parsed.success) throw new StorageCategoryAdapterError('owner_data_invalid');
    return { ownerData: parsed.data, restorable: false,
        async retire() { throw new StorageCategoryAdapterError('restore_unsupported'); },
        async reinstate() { throw new StorageCategoryAdapterError('restore_unsupported'); },
        async discard({ payloadPath, beforeEffect }) {
            if (payloadPath) throw new StorageCategoryAdapterError('restore_unsupported');
            const owner = deps.readRecordingRuntime?.() ?? deps.recordingRuntime;
            if (!owner) throw new StorageCategoryAdapterError('owner_unavailable');
            await owner.discardStorageRecording({ recordingId: parsed.data.recordingId, beforeEffect });
        },
    };
}
export const recordings: StorageCategoryDefinition = {
    descendantCleanup: 'whole-item-only',
    async bindAdapter(item, context) {
        const recording = context.recordings.find(recording => recording.path === item.path);
        if (!recording) throw new StorageCategoryAdapterError('owner_unavailable');
        return adapter({ recordingId: recording.recordingId }, context.deps);
    },
    async adapterForEntry(data, deps) { return adapter(data, deps); },
    id: 'recordings', roots: context => context.recordings.map(recording => recording.path),
    async items(context) {
        const result = [];
        for (const recording of context.recordings) if (await isCategoryPathInScope(recording.path, context.discoveryPaths)
            && await exists(recording.path, unavailableDirectory(context, 'recordings'))) result.push(item('recordings', recording.path,
            recording.active ? inUse : { verdict: 'caution', reason: { code: 'not_rebuildable' }, collectable: true, loses: [{ code: 'not_rebuildable' }] },
            { title: recording.title ?? recording.recordingId, evidence: ['browser_recording_owner',
                ...(recording.expiresAtMs !== undefined && recording.expiresAtMs <= context.now ? ['recording_expired'] satisfies StorageCategoryItem['evidence'] : [])] }));
        return result;
    },
};
