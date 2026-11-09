import { storageLogRoots } from '@/utils/logs/logRetention';
import { entries, inUse, isInUse, item, listedEntryStat, safe, contains, unavailableDirectory } from './filesystem';
import type { StorageCategoryDefinition, StorageCategoryItem } from './types';
import { filesystemCategoryAdapters } from './filesystemAdapters';

export const logs: StorageCategoryDefinition = {
    ...filesystemCategoryAdapters,
    id: 'logs', roots: context => storageLogRoots(context.deps.happyHomeDir),
    async items(context) {
        const result: StorageCategoryItem[] = [];
        const currentLogs = await context.deps.currentLogPaths?.() ?? [];
        const days = context.logRetentionDays;
        const oldBefore = days === null ? null : context.now - days * 86_400_000;
        async function visit(root: string): Promise<void> {
            // These independent metadata reads share the directory's existing
            // listing boundary. Serial awaits let active scan ingestion delay
            // every log separately on each retained-page/catalog projection.
            const listed = await Promise.all((await entries(root, unavailableDirectory(context, 'logs'), context.discoveryPaths))
                .map(async path => ({ path, stat: await listedEntryStat(path, unavailableDirectory(context, 'logs')) })));
            for (const { path, stat } of listed) {
                if (!stat) continue;
                if (stat.isDirectory() && !stat.isSymbolicLink()) { await visit(path); continue; }
                const live = currentLogs.some(current => contains(path, current)) || isInUse(path, context);
                const old = !live && oldBefore !== null && stat.mtimeMs <= oldBefore;
                result.push({ ...item('logs', path, live ? inUse : old ? { ...safe, reason: { code: 'old' } }
                    : { verdict: 'keep', reason: { code: 'recent' }, collectable: true },
                    { lastChangedAt: Math.trunc(stat.mtimeMs), evidence: ['log_file_modified_time'] }),
                    categoryGroup: old && days !== null ? { id: 'old', olderThanDays: days } : { id: 'recent' } });
            }
        }
        for (const root of logs.roots(context)) await visit(root);
        return result;
    },
};
