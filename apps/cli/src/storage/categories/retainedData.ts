import { join } from 'node:path';
import { getHappierTempRoot } from '@happier-dev/cli-common/tempDirs';
import { exists, item, unavailableDirectory } from './filesystem';
import type { StorageCategoryDefinition } from './types';

export const trash: StorageCategoryDefinition = {
    id: 'trash', roots: context => context.deps.trashRoots?.() ?? [join(context.deps.happyHomeDir, 'trash')],
    async items(context) {
        const result = [];
        for (const path of trash.roots(context)) if (await exists(path, unavailableDirectory(context, 'trash'))) result.push(item('trash', path,
            { verdict: 'forbidden', reason: { code: 'happier_data' }, collectable: false }, { evidence: ['happier_trash_root'] }));
        return result;
    },
};
export const ownData: StorageCategoryDefinition = {
    id: 'ownData', roots: context => [...new Set([context.deps.happyHomeDir, context.deps.activeServerDir,
        getHappierTempRoot(context.deps.tempRoot)])],
    async items(context) {
        const result = [];
        for (const path of ownData.roots(context)) if (await exists(path, unavailableDirectory(context, 'ownData'))) result.push(item('ownData', path,
            { verdict: 'forbidden', reason: { code: 'happier_data' }, collectable: false },
            { evidence: ['happier_data_remainder'], title: 'Happier data' }));
        return result;
    },
};
