import type { MachineResourcesPolicyRuntime } from '@/daemon/resources/machineResourcesPolicy';
import type { MachineResourcesPolicyMutationResultV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import type { StorageOperationActor } from '@/storage/storageService';
import { resolveCanonicalAbsolutePath } from '@/utils/path/expandHomeDirPath';
import { physicalPathWithoutFollowingLeaf, realpathWithAbsentSuffix } from '@/utils/path/physicalAncestorPath';
import { realStoragePathWithAbsentSuffix } from '../storagePath';
import { storagePhysicalPathComparisonKey, storageProtectionRules, type StorageProtectionFacts } from './protectedPaths';

export type StorageProtectedFoldersDeps = Readonly<{
  resourcesPolicy?: Pick<MachineResourcesPolicyRuntime, 'read' | 'set'>;
  readProtectionFacts: () => StorageProtectionFacts | Promise<StorageProtectionFacts>;
}>;
export function createStorageProtectedFolders(deps: StorageProtectedFoldersDeps) {
  async function mutate(mode: 'add' | 'remove', request: Readonly<{ path: string }>,
    options: Readonly<{ actor: StorageOperationActor; signal?: AbortSignal }>): Promise<MachineResourcesPolicyMutationResultV1> {
    const { actor, signal } = options;
    if (actor.sessionIds !== undefined) {
      throw Object.assign(new Error('Storage policy access denied'), { code: 'unauthorized' });
    }
    await actor.assertCurrent();
    const resourcesPolicy = deps.resourcesPolicy;
    if (!resourcesPolicy) return { status: 'unavailable', reason: 'policy_unavailable' };
    const facts = await deps.readProtectionFacts();
    const platform = facts.platform ?? process.platform;
    const normalize = async (path: string) => {
      if (path.startsWith('bytes:')) return realStoragePathWithAbsentSuffix(path);
      const absolute = resolveCanonicalAbsolutePath(path, { platform, env: { ...(facts.env ?? process.env), HOME: facts.homeDir, USERPROFILE: facts.homeDir } });
      if (!absolute) throw Object.assign(new Error('Storage path must be absolute'), { code: 'invalid_storage_path' });
      return realpathWithAbsentSuffix(absolute.path);
    };
    const path = await normalize(request.path);
    const identity = (value: string) => storagePhysicalPathComparisonKey(value, platform);
    if (mode === 'remove') {
      // Consume the classifier's actual rules, never a second built-in folder list.
      const builtIns = storageProtectionRules({ ...facts, userProtectedFolders: [], inUsePaths: [], mainCheckouts: [] })
        .filter(rule => rule.tier === 'forbidden' || rule.tier === 'keep');
      for (const rule of builtIns) {
        let builtIn: string;
        try { builtIn = await normalize(rule.path); }
        catch (error) {
          if (!['EACCES', 'EPERM', 'EBUSY'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
          builtIn = await physicalPathWithoutFollowingLeaf(rule.path);
        }
        if (identity(builtIn) === identity(path)) {
          await actor.assertCurrent();
          return { status: 'unsupported', reason: 'built_in_protection' };
        }
      }
    }
    const snapshot = resourcesPolicy.read();
    if (snapshot.status !== 'ready') return { status: 'unavailable', reason: snapshot.status };
    const previous = snapshot.policy.storage.protectedFolders;
    const normalized = await Promise.all(previous.map(entry => normalize(entry.path)));
    const matching = normalized.map(value => identity(value) === identity(path));
    const protectedFolders = mode === 'add' ? matching.some(Boolean) ? previous : [...previous, { path, addedAt: Date.now() }]
      : previous.filter((_value, index) => !matching[index]);
    await actor.assertCurrent();
    const answer = await resourcesPolicy.set({ expectedRevision: snapshot.revision, patch: { storage: { protectedFolders } } }, {
      ...(signal ? { signal } : {}), verifyCurrent: async () => { await actor.assertCurrentAuthority(); return true; },
    });
    await actor.assertCurrent();
    return answer;
  }
  return {
    add: (request: Readonly<{ path: string }>, options: Readonly<{ actor: StorageOperationActor; signal?: AbortSignal }>) => mutate('add', request, options),
    remove: (request: Readonly<{ path: string }>, options: Readonly<{ actor: StorageOperationActor; signal?: AbortSignal }>) => mutate('remove', request, options),
  };
}
