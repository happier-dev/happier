import { dirname, join } from 'node:path';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { parseStoredInstalledVoiceModelPackMetadataV1 } from '@/daemon/voiceInference/publicModelPacks/state';
import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';
import { readStoragePathIdentity, removeStoragePath } from '../trash/removeStoragePath';
import { check, entries, inUse, isInUse, item, unavailableDirectory, opaqueItemTitle } from './filesystem';
import { StorageCategoryAdapterError } from './types';
import type { StorageCategoryDefinition, StorageCategoryContext, StorageCategoryVerdict, StorageCategoryCatalogDeps, StorageCategoryAdapter } from './types';

const OwnerDataSchema = z.strictObject({ key: z.string().check(z.minLength(1)), metadata: z.unknown() });
const StoredOwnerDataSchema = createStoredReadSchema(OwnerDataSchema);
function adapter(data: JsonValue, deps: StorageCategoryCatalogDeps): StorageCategoryAdapter {
    const parsed = StoredOwnerDataSchema.safeParse(data);
    if (!parsed.success) throw new StorageCategoryAdapterError('owner_data_invalid');
    const metadata = parseStoredInstalledVoiceModelPackMetadataV1(parsed.data.metadata);
    const key = `${metadata.identity.pluginId}/${metadata.identity.packId}`;
    if (key !== parsed.data.key) throw new StorageCategoryAdapterError('owner_data_invalid');
    const runtime = () => {
        const owner = deps.readModelPackRuntime?.() ?? deps.modelPackRuntime;
        if (!owner) throw new StorageCategoryAdapterError('owner_unavailable');
        return owner;
    };
    const originalPath = join(deps.activeServerDir, 'voiceInference', 'packs', metadata.directoryKey);
    return { ownerData: normalizeStrictJsonValue({ key, metadata }), restorable: true,
        retire: ({ payloadPath, beforeEffect }) => runtime().remove(key, { retainTo: payloadPath, beforeEffect }),
        reinstate: async ({ payloadPath, restorePath, beforeEffect }) => {
            if (!canonicalAbsolutePathsEqual(originalPath, restorePath)) throw new StorageCategoryAdapterError('restore_path_unsupported');
            await runtime().adopt(key, payloadPath, { metadata, beforeEffect });
        },
        discard: async ({ payloadPath, beforeEffect }) => {
            if (!payloadPath) { await runtime().remove(key, { beforeEffect }); return; }
            const expectedIdentity = await readStoragePathIdentity(payloadPath);
            await removeStoragePath(payloadPath, { allowedRoot: dirname(payloadPath), expectedIdentity, beforeEffect });
        },
    };
}

export function modelPackCanGo(lastUsedAt: number | undefined, context: StorageCategoryContext): StorageCategoryVerdict {
    if (lastUsedAt === undefined) return check;
    if (lastUsedAt > context.unusedBefore) return { verdict: 'keep', reason: { code: 'recent' }, collectable: true };
    return { verdict: 'caution', reason: { code: 'feature_waits' }, collectable: true, loses: [{ code: 'feature_waits' }] };
}
export const modelPacks: StorageCategoryDefinition = {
    descendantCleanup: 'whole-item-only',
    async bindAdapter(item, context) {
        const pack = context.modelPacks.find(pack => join(context.deps.activeServerDir, 'voiceInference', 'packs', pack.directoryKey) === item.path);
        if (!pack?.installedMetadata) throw new StorageCategoryAdapterError('owner_unavailable');
        return adapter(normalizeStrictJsonValue({ key: pack.key, metadata: pack.installedMetadata }), context.deps);
    },
    async adapterForEntry(data, deps) { return adapter(data, deps); },
    id: 'modelPacks', roots: context => ['packs', 'models'].map(name => join(context.deps.activeServerDir, 'voiceInference', name)),
    async items(context) {
        const result = [];
        const packsRoot = join(context.deps.activeServerDir, 'voiceInference', 'packs');
        const owned = new Map(context.modelPacks.map(pack => [join(packsRoot, pack.directoryKey), pack]));
        for (const root of modelPacks.roots(context)) for (const path of await entries(root, unavailableDirectory(context, 'modelPacks'), context.discoveryPaths)) {
            const pack = owned.get(path);
            result.push(item('modelPacks', path, isInUse(path, context) ? inUse : pack ? modelPackCanGo(pack.lastUsedAt, context) : check,
                { title: opaqueItemTitle(path, 'Model pack'),
                    evidence: [pack ? 'voice_model_pack_install_record' : 'model_pack_facts_unavailable'],
                    ...(pack?.lastUsedAt !== undefined ? { lastUsedAt: pack.lastUsedAt } : {}) }));
        }
        return result;
    },
};
