import { readFile, realpath, stat } from 'node:fs/promises';
import { RegistryFetchErrorV1, type RegistryFetchContextV1 } from '@happier-dev/protocol/registries';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { resolvePortablePluginRelativePath } from '@/plugins/manifest/portableRelativePath';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

/** Read inert content from the existing admitted source; never import an author module. */
export function createCliRegistryPackageContentV1(input: Readonly<{
  pluginRuntime?: PluginReloadController; signal?: AbortSignal;
}> = {}): NonNullable<RegistryFetchContextV1['packageContent']> {
  const controller = input.pluginRuntime ?? pluginReloadController;
  return { async read(source) {
    input.signal?.throwIfAborted();
    const lease = controller.tryAcquireRuntimeRegistry();
    if (!lease) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    try {
      const reference = source.packageContent;
      const current = lease.registry.contributes;
      const declaration = current.registrySources?.find(entry => entry.pluginId === reference.pluginId
        && entry.definition.id === source.origin.localId);
      const assertCurrent = () => {
        input.signal?.throwIfAborted();
        if (!controller.isRuntimeRegistryCurrent(lease.registry)
          || current.occurrenceIdsByPluginId?.[reference.pluginId] !== reference.occurrenceId
          || declaration?.pluginVersion !== reference.pluginVersion
          || !('packageContent' in declaration.definition)
          || declaration.definition.packageContent.path !== reference.path) {
          throw new RegistryFetchErrorV1({ state: 'invalid_source' });
        }
      };
      assertCurrent();
      const root = await realpath(declaration!.pluginRootPath);
      const resolved = resolvePortablePluginRelativePath({ rootPath: root, value: reference.path, label: 'registry package content' });
      if (!resolved.ok) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      const path = await realpath(resolved.path);
      if (!isCanonicalAbsolutePathInsideRoot(root, path) || !(await stat(path)).isFile()) {
        throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      }
      const text = await readFile(path, 'utf8');
      assertCurrent();
      return { text, fetchedAt: Date.now() };
    } catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof RegistryFetchErrorV1) throw error;
      if (error && typeof error === 'object' && 'code' in error
        && ['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(String(error.code))) {
        throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      }
      throw error;
    } finally { await lease.release(); }
  } };
}
