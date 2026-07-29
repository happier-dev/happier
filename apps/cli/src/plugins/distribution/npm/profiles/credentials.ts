import { createPluginSecretStore } from '@/plugins/runtime/context/secrets';
import { NPM_REGISTRY_SECRETS_LOCK_NAME, withPluginStoreLock } from '@/plugins/store/lock';
import { resolvePluginStorePaths } from '@/plugins/store/paths';

const HOST_NAMESPACE = 'happier.npm.registry.credentials';

export function createNpmRegistryCredentialStore(params?: Readonly<{ happyHomeDir?: string }>): Readonly<{
  set(ref: string, authorizationHeader: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
  has(ref: string): Promise<boolean>;
  listRefs(): Promise<readonly string[]>;
}> {
  const paths = resolvePluginStorePaths(params);
  const service = createPluginSecretStore({
    pluginId: HOST_NAMESPACE,
    paths,
    enforceLocalKeyFileProtection: true,
  });
  const locked = async <T>(fn: () => Promise<T>) => await withPluginStoreLock({
    paths,
    lockName: NPM_REGISTRY_SECRETS_LOCK_NAME,
    fn,
  });
  return Object.freeze({
    set: async (ref, value) => await locked(async () => await service.set(ref, value)),
    get: async (ref) => await locked(async () => await service.get(ref)),
    delete: async (ref) => await locked(async () => await service.delete(ref)),
    has: async (ref) => await locked(async () => (await service.list()).some((entry) => entry.name === ref)),
    listRefs: async () => await locked(async () => (await service.list()).map((entry) => entry.name)),
  });
}
