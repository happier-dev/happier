import { lstat, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import {
  createPurposeKeyedPluginSecretStore,
  resealPurposeKeyedPluginSecretStore,
} from '@/plugins/runtime/context/secrets';
import { normalizePluginStorageNamespace } from '@/plugins/runtime/context/pluginNamespace';
import { NPM_REGISTRY_SECRETS_LOCK_NAME, withPluginStoreLock } from '@/plugins/store/lock';
import { resolvePluginStorePaths, type PluginStorePaths } from '@/plugins/store/paths';

const HOST_NAMESPACE = 'happier.npm.registry.credentials';
const LEGACY_KEY_FILE_NAME = 'plugin-secrets-key.v1';
const LEGACY_KEY_TYPE = 'happier_plugin_secret_key_v1';

type NpmCredentialSecretStore = ReturnType<typeof createPurposeKeyedPluginSecretStore>;
type StoreReadability = Readonly<
  | { readable: true }
  | { readable: false; error: unknown }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function legacyKeyPath(paths: PluginStorePaths): string {
  return join(paths.secretsDir, LEGACY_KEY_FILE_NAME);
}

function legacyMigrationError(code: string): Error {
  return new Error(`NPM_REGISTRY_CREDENTIALS_${code}`);
}

function decodeLegacyKey(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw legacyMigrationError('LEGACY_KEY_INVALID');
  }
  const key = Buffer.from(value, 'base64');
  if (key.byteLength !== 32 || key.toString('base64') !== value) {
    throw legacyMigrationError('LEGACY_KEY_INVALID');
  }
  return new Uint8Array(key);
}

async function readLegacyNpmKey(paths: PluginStorePaths): Promise<Uint8Array | null> {
  const path = legacyKeyPath(paths);
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw legacyMigrationError('LEGACY_KEY_INVALID');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw legacyMigrationError('LEGACY_KEY_PERMISSIONS_INVALID');
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw legacyMigrationError('LEGACY_KEY_INVALID');
  }
  if (
    !isRecord(value)
    || value.t !== LEGACY_KEY_TYPE
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'key')
  ) {
    throw legacyMigrationError('LEGACY_KEY_INVALID');
  }
  return decodeLegacyKey(value.key);
}

/**
 * The retired global key could have encrypted arbitrary old plugin folders.
 * NPM only has authority to reseal its own namespace, so do not retire that
 * key if another namespace would become unreadable.
 */
async function assertLegacyKeyIsNpmExclusive(paths: PluginStorePaths): Promise<void> {
  const npmNamespace = normalizePluginStorageNamespace(HOST_NAMESPACE);
  const entries = await readdir(paths.secretsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === LEGACY_KEY_FILE_NAME || entry.name === `${LEGACY_KEY_FILE_NAME}.lock`) continue;
    if (entry.name === npmNamespace) continue;
    throw legacyMigrationError('LEGACY_NAMESPACE_NOT_EXCLUSIVE');
  }
}

/**
 * The secret-file envelope has no embedded key provenance. Prove every
 * bounded entry opens with a candidate owner before selecting it for a
 * migration step; listing encrypted metadata alone cannot make that claim.
 */
async function inspectStoreReadability(store: NpmCredentialSecretStore): Promise<StoreReadability> {
  try {
    const entries = await store.list();
    for (const entry of entries) {
      if (await store.get(entry.name) === null) {
        throw legacyMigrationError('MIGRATION_RECORD_MISSING');
      }
    }
    return { readable: true };
  } catch (error) {
    return { readable: false, error };
  }
}

export function createNpmRegistryCredentialStore(params?: Readonly<{ happyHomeDir?: string }>): Readonly<{
  set(ref: string, authorizationHeader: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
  has(ref: string): Promise<boolean>;
  listRefs(): Promise<readonly string[]>;
}> {
  const paths = resolvePluginStorePaths(params);
  let destinationKeyPromise: Promise<Uint8Array> | null = null;
  let servicePromise: Promise<ReturnType<typeof createPurposeKeyedPluginSecretStore>> | null = null;
  let legacyMigrationComplete = false;
  const resolveDestinationKey = async (): Promise<Uint8Array> => {
    destinationKeyPromise ??= readOrCreateDeviceLocalSecretStorage({
      path: join(paths.happyHomeDir, 'device-local-secret-key.json'),
    }).then((storage) => storage.deriveSecretKey({
      purpose: 'npm_registry_credentials',
    }));
    return await destinationKeyPromise;
  };
  const resolveService = async (): Promise<ReturnType<typeof createPurposeKeyedPluginSecretStore>> => {
    servicePromise ??= resolveDestinationKey().then((secretKey) => createPurposeKeyedPluginSecretStore({
      pluginId: HOST_NAMESPACE,
      paths,
      secretKey,
    }));
    return await servicePromise;
  };
  const resolveStoreForOperation = async (): Promise<NpmCredentialSecretStore> => {
    const destination = await resolveService();
    if (legacyMigrationComplete) return destination;

    // A prior invocation may have committed the atomic destination rewrite but
    // died before it retired the legacy key. Destination provenance wins in
    // that state; retry key retirement without attempting a source decrypt.
    const destinationReadability = await inspectStoreReadability(destination);
    if (destinationReadability.readable) {
      try {
        const sourceKey = await readLegacyNpmKey(paths);
        if (!sourceKey) {
          legacyMigrationComplete = true;
          return destination;
        }
        await assertLegacyKeyIsNpmExclusive(paths);
        await unlink(legacyKeyPath(paths));
        legacyMigrationComplete = true;
      } catch {
        // The destination has already proven readable. Retaining the legacy
        // key until a later cleanup attempt is safer than making credentials
        // unavailable after the migration commit point.
      }
      return destination;
    }

    const sourceKey = await readLegacyNpmKey(paths);
    if (!sourceKey) throw destinationReadability.error;
    const source = createPurposeKeyedPluginSecretStore({
      pluginId: HOST_NAMESPACE,
      paths,
      secretKey: sourceKey,
    });
    const sourceReadability = await inspectStoreReadability(source);
    if (!sourceReadability.readable) throw sourceReadability.error;

    try {
      await resealPurposeKeyedPluginSecretStore({
        pluginId: HOST_NAMESPACE,
        paths,
        sourceKey,
        destinationKey: await resolveDestinationKey(),
      });
    } catch (error) {
      // The owner file write is atomic. Re-observe rather than infer whether a
      // fault occurred before or after that commit point. A pre-commit fault
      // may continue through the proven legacy owner until the next retry.
      if ((await inspectStoreReadability(destination)).readable) return destination;
      if ((await inspectStoreReadability(source)).readable) return source;
      throw error;
    }

    const resealedReadability = await inspectStoreReadability(destination);
    if (!resealedReadability.readable) throw resealedReadability.error;
    try {
      // The canonical secret owner rewrote the exact NPM namespace atomically.
      // Only then may this distribution owner retire the global legacy key.
      await assertLegacyKeyIsNpmExclusive(paths);
      await unlink(legacyKeyPath(paths));
      legacyMigrationComplete = true;
    } catch {
      // The new owner is proven current, so an interrupted retirement cannot
      // strand the credential. A later invocation retries only key cleanup.
    }
    return destination;
  };
  const locked = async <T>(fn: (store: NpmCredentialSecretStore) => Promise<T>) => await withPluginStoreLock({
    paths,
    lockName: NPM_REGISTRY_SECRETS_LOCK_NAME,
    fn: async () => {
      return await fn(await resolveStoreForOperation());
    },
  });
  return Object.freeze({
    set: async (ref, value) => await locked(async (store) => await store.set(ref, value)),
    get: async (ref) => await locked(async (store) => await store.get(ref)),
    delete: async (ref) => await locked(async (store) => await store.delete(ref)),
    has: async (ref) => await locked(async (store) => (await store.list()).some((entry) => entry.name === ref)),
    listRefs: async () => await locked(async (store) => (await store.list()).map((entry) => entry.name)),
  });
}
