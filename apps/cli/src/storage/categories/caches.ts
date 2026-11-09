import { join } from 'node:path';
import { z } from 'zod/mini';
import { managedAcpAccountNamespace } from '@happier-dev/cli-common/agents';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { StorageReasonV1 } from '@happier-dev/protocol/storage/storageV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { listManagedAcpInstalls, removeManagedAcpInstall, type ManagedAcpInstall } from '@/agent/acp/catalog/registry/managedAgentInstalls';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';
import { check, entries, inUse, isInUse, item, safe, contains, unavailableDirectory, opaqueItemTitle } from './filesystem';
import type { StorageCategoryDefinition, StorageCategoryContext, StorageCategoryVerdict, StorageCategoryCatalogDeps, StorageCategoryAdapter } from './types';
import { StorageCategoryAdapterError } from './types';
import { bindFilesystemItem, filesystemAdapterForEntry } from './filesystemAdapters';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';

const AcpOwnerSchema = z.strictObject({ kind: z.literal('managed_acp'), accountNamespace: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
    definitionId: z.string().check(z.minLength(1)), version: z.string().check(z.minLength(1)), installKind: z.enum(['archive', 'npm', 'uv']) });
const StoredAcpOwnerSchema = createStoredReadSchema(AcpOwnerSchema);
const environment = (deps: StorageCategoryCatalogDeps) => ({ ...process.env, HAPPIER_HOME_DIR: deps.happyHomeDir });
function acpAdapter(ownerData: JsonValue, deps: StorageCategoryCatalogDeps): StorageCategoryAdapter {
    const parsed = StoredAcpOwnerSchema.safeParse(ownerData);
    if (!parsed.success) throw new StorageCategoryAdapterError('owner_data_invalid');
    return { ownerData: parsed.data, restorable: false,
        async retire() { throw new StorageCategoryAdapterError('restore_unsupported'); },
        async reinstate() { throw new StorageCategoryAdapterError('restore_unsupported'); },
        async discard({ payloadPath, beforeEffect }) {
            if (payloadPath) throw new StorageCategoryAdapterError('restore_unsupported');
            await beforeEffect?.();
            const removed = await removeManagedAcpInstall({ ...parsed.data, env: environment(deps),
                isDefinitionInUse: deps.isAcpDefinitionInUse ?? (() => true) });
            if (!removed.ok) throw Object.assign(new StorageCategoryAdapterError('owner_unavailable'), { cause: removed.code });
        },
    };
}

/** Indexed parents and inner paths must not bypass the install lifecycle owner. */
export async function managedAcpCacheCleanupLimitation(path: string, deps: StorageCategoryCatalogDeps): Promise<StorageReasonV1 | null> {
    const install = (await listManagedAcpInstalls({ env: environment(deps) })).find(install =>
        !canonicalAbsolutePathsEqual(path, install.installRoot) && (contains(path, install.installRoot) || contains(install.installRoot, path)));
    return install ? { code: 'unsupported', detail: { cause: 'owner_requires_whole_item', categoryId: 'caches', path: install.installRoot } } : null;
}

async function cacheLeaves(path: string, installs: readonly ManagedAcpInstall[], context: StorageCategoryContext): Promise<readonly string[]> {
    if (!installs.some(install => !canonicalAbsolutePathsEqual(path, install.installRoot) && contains(path, install.installRoot))) return [path];
    return (await Promise.all((await entries(path, unavailableDirectory(context, 'caches'), context.discoveryPaths))
        .map(child => cacheLeaves(child, installs, context)))).flat();
}

function cacheRoots(context: StorageCategoryContext) {
    const home = context.deps.happyHomeDir;
    const plugins = resolvePluginStorePaths({ happyHomeDir: home });
    return [
        { path: join(home, 'cache'), title: 'Happier cache' },
        { path: join(home, 'tools'), title: 'Managed tool cache' },
        { path: plugins.cacheDir, title: 'Plugin cache' },
        { path: plugins.installedDir, title: 'Plugin installation' },
        { path: join(home, 'providers', 'materialized'), title: 'Provider configuration' },
        { path: join(home, 'runtime'), title: 'Runtime cache' },
        { path: join(home, '.runner-snapshots'), title: 'Session runner snapshot' },
        { path: join(home, 'skills'), title: 'Skill cache' },
    ];
}
const roots = (context: StorageCategoryContext) => cacheRoots(context).map(root => root.path);
export function cacheCanGo(path: string, context: StorageCategoryContext, requiresLiveFacts = false): StorageCategoryVerdict {
    if (isInUse(path, context)) return inUse;
    if (requiresLiveFacts && !context.inUse.reliable) return check;
    return safe;
}
export const caches: StorageCategoryDefinition = {
    async bindAdapter(item, context) {
        const install = (await listManagedAcpInstalls({ env: environment(context.deps) })).find(install => canonicalAbsolutePathsEqual(install.installRoot, item.path));
        return install ? acpAdapter({ kind: 'managed_acp', accountNamespace: install.accountNamespace,
            definitionId: install.definitionId, version: install.version, installKind: install.kind }, context.deps) : bindFilesystemItem(item);
    },
    async adapterForEntry(data, deps) {
        return data && typeof data === 'object' && !Array.isArray(data) && 'kind' in data && data.kind === 'managed_acp'
            ? acpAdapter(data, deps) : filesystemAdapterForEntry(data);
    },
    id: 'caches', roots,
    async items(context) {
        const result = [];
        const installs = await listManagedAcpInstalls({ env: environment(context.deps) });
        const byPath = new Map(installs.map(install => [install.installRoot, install]));
        const catalog = context.deps.readAcpCatalog?.();
        const snapshots = join(context.deps.happyHomeDir, '.runner-snapshots');
        const liveSnapshots = context.deps.readLiveRunnerSnapshotPaths?.();
        const skillRoot = join(context.deps.happyHomeDir, 'skills');
        const liveSkills = await timeWebLatencyPhase('storage.catalog.skill-store', () => context.deps.readLiveSkillCachePaths?.());
        for (const { path: root, title } of cacheRoots(context)) for (const entry of await entries(root, unavailableDirectory(context, 'caches'), context.discoveryPaths)) {
          const leaves = root === skillRoot && entry === join(skillRoot, 'cache')
            ? await entries(entry, unavailableDirectory(context, 'caches'), context.discoveryPaths) : await cacheLeaves(entry, installs, context);
          for (const path of leaves) {
            let verdict: StorageCategoryVerdict;
            const install = byPath.get(path);
            if (install) {
                verdict = !context.deps.isAcpDefinitionInUse ? check
                    : await context.deps.isAcpDefinitionInUse(install.definitionId) ? inUse : safe;
                const removed = context.deps.acpAccountId !== undefined && install.accountNamespace === managedAcpAccountNamespace(context.deps.acpAccountId) && catalog?.status === 'ready'
                    && !catalog.record.definitions.some(definition => definition.id === install.definitionId);
                result.push(item('caches', path, verdict, { title: `${install.title}${removed ? ' · removed agent' : ''}`,
                    evidence: ['managed_acp_install'] }));
                continue;
            }
            if (root === snapshots) {
                verdict = !liveSnapshots?.reliable ? check : [...liveSnapshots.paths].some(live => contains(path, live)) ? inUse : safe;
            } else if (root === skillRoot) {
                verdict = !liveSkills?.reliable ? check
                    : [...liveSkills.paths].some(live => contains(path, live)) ? inUse : safe;
            } else {
                const basicCache = root === join(context.deps.happyHomeDir, 'cache') || root === resolvePluginStorePaths({ happyHomeDir: context.deps.happyHomeDir }).cacheDir;
                verdict = cacheCanGo(path, context, !basicCache);
            }
            result.push(item('caches', path, verdict, { title: opaqueItemTitle(path, title),
                evidence: [root === snapshots ? 'runner_snapshot_root' : 'managed_cache_root'] }));
          }
        }
        return result;
    },
};
