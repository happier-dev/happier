import { join } from 'node:path';
import { hasLocalConnectedServiceResumeState } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import { directoriesAtDepth, entries, check, inUse, isInUse, item, safe, unavailableDirectory, isPermissionError, opaqueItemTitle } from './filesystem';
import type { StorageCategoryContext, StorageCategoryDefinition, StorageCategoryItem } from './types';
import { filesystemCategoryAdapters } from './filesystemAdapters';

export const agentHomes: StorageCategoryDefinition = {
    ...filesystemCategoryAdapters,
    id: 'agentHomes', roots: context => [join(context.deps.activeServerDir, 'daemon', 'connected-services', 'homes'),
        join(context.deps.happyHomeDir, 'daemon', 'connected-services', 'materialized'), join(context.deps.activeServerDir, 'isolation')],
    async items(context) {
        const result = [];
        const [homes, materialized, isolation] = agentHomes.roots(context);
        for (const root of [homes!, materialized!]) for (const path of await entries(root, unavailableDirectory(context, 'agentHomes'), context.discoveryPaths)) result.push(item('agentHomes', path,
            { verdict: 'keep', reason: { code: 'agent_home' }, collectable: true, loses: [{ code: 'agent_home' }] },
            { title: opaqueItemTitle(path, 'Agent home'), evidence: ['connected_service_home'] }));
        const facts = new Map(context.isolationFacts.map(fact => [fact.path, fact.state]));
        for (const path of await directoriesAtDepth(isolation!, 3, unavailableDirectory(context, 'agentHomes'), context.discoveryPaths)) {
            const state = facts.get(path);
            const live = state === 'running' || isInUse(path, context);
            let resumeState: boolean | null = false;
            if (!live) {
                try { resumeState = await hasLocalConnectedServiceResumeState(path); }
                catch (error) { if (!isPermissionError(error)) throw error; resumeState = null; }
            }
            result.push(item('agentHomes', path, live ? inUse : resumeState === null ? check
                : resumeState ? { verdict: 'keep', reason: { code: 'agent_home' }, collectable: true, loses: [{ code: 'agent_home' }] }
                : state === 'finished' || state === 'unknown_owner' ? { ...safe, reason: { code: 'stopped' } } : check,
                { title: opaqueItemTitle(path, 'Agent run home'), evidence: [state ? 'execution_run_isolation_owner' : 'execution_run_isolation_facts_unavailable',
                    ...(resumeState === null ? ['directory_permission_unavailable'] satisfies StorageCategoryItem['evidence'] : [])] }));
        }
        return result;
    },
};
