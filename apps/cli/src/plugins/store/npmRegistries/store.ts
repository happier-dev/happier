import { readFile } from 'node:fs/promises';

import {
  NpmRegistryOriginV1Schema,
  NpmRegistryProfileIdV1Schema,
  NpmRegistryScopeV1Schema,
} from '@happier-dev/protocol/rpc';
import { z } from 'zod';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { NPM_REGISTRY_PROFILES_LOCK_NAME, withPluginStoreLock } from '@/plugins/store/lock';
import { ensurePluginStoreDirectories, resolvePluginStorePaths, type PluginStorePaths } from '@/plugins/store/paths';

const MAX_PROFILES = 64;
const MAX_PAUSED_SOURCES = 64;
const MAX_MUTATIONS = 128;

const PersistedProfileSchema = z.object({
  profileId: NpmRegistryProfileIdV1Schema,
  displayName: z.string().trim().min(1).max(128),
  origin: NpmRegistryOriginV1Schema,
  scopes: z.array(NpmRegistryScopeV1Schema).max(64),
  useAsDefault: z.boolean(),
  allowPrivateNetwork: z.boolean(),
  credentialSecretRef: z.string().trim().min(1).max(256).nullable(),
  credentialRevision: z.number().int().nonnegative(),
  availability: z.enum(['unknown', 'available', 'sign_in_required', 'offline']),
  lastSuccessfulCheckAtMs: z.number().int().nonnegative().nullable(),
  updatedAtMs: z.number().int().nonnegative(),
}).strict();

const PausedSourceSchema = z.object({
  origin: NpmRegistryOriginV1Schema,
  reason: z.enum(['credentials_missing', 'authentication_failed', 'profile_removed', 'offline']),
  updatedAtMs: z.number().int().nonnegative(),
}).strict();

const MutationReceiptSchema = z.object({
  mutationId: z.string().trim().min(8).max(128),
  fingerprint: z.string().min(1).max(4096),
  revision: z.number().int().nonnegative(),
}).strict();

const RegistryFileSchema = z.object({
  t: z.literal('happier_npm_registry_profiles_v1'),
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  profiles: z.array(PersistedProfileSchema).max(MAX_PROFILES),
  pausedSources: z.array(PausedSourceSchema).max(MAX_PAUSED_SOURCES),
  mutations: z.array(MutationReceiptSchema).max(MAX_MUTATIONS),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  const origins = new Set<string>();
  for (const [index, profile] of value.profiles.entries()) {
    if (ids.has(profile.profileId)) ctx.addIssue({ code: 'custom', path: ['profiles', index, 'profileId'], message: 'Duplicate registry profile id' });
    if (origins.has(profile.origin)) ctx.addIssue({ code: 'custom', path: ['profiles', index, 'origin'], message: 'Duplicate registry origin' });
    ids.add(profile.profileId);
    origins.add(profile.origin);
  }
});

export type PersistedNpmRegistryProfile = z.infer<typeof PersistedProfileSchema>;
export type NpmRegistryPausedSource = z.infer<typeof PausedSourceSchema>;
export type NpmRegistryProfileFile = z.infer<typeof RegistryFileSchema>;

function emptyRegistry(): NpmRegistryProfileFile {
  return { t: 'happier_npm_registry_profiles_v1', version: 1, revision: 0, profiles: [], pausedSources: [], mutations: [] };
}

export class NpmRegistryProfileStoreError extends Error {
  readonly code: 'revision_conflict' | 'mutation_conflict' | 'invalid_store';
  readonly currentRevision?: number;

  constructor(code: NpmRegistryProfileStoreError['code'], currentRevision?: number) {
    super(code);
    this.name = 'NpmRegistryProfileStoreError';
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

export function createNpmRegistryProfileStore(params?: Readonly<{ happyHomeDir?: string }>): Readonly<{
  paths: PluginStorePaths;
  read(): Promise<NpmRegistryProfileFile>;
  mutate(input: Readonly<{
    expectedRevision: number;
    mutationId: string;
    fingerprint: string;
    apply(current: NpmRegistryProfileFile): NpmRegistryProfileFile;
  }>): Promise<NpmRegistryProfileFile>;
}> {
  const paths = resolvePluginStorePaths(params);

  async function readUnlocked(): Promise<NpmRegistryProfileFile> {
    try {
      const raw = await readFile(paths.npmRegistryProfilesFilePath, 'utf8');
      const parsed = RegistryFileSchema.safeParse(JSON.parse(raw) as unknown);
      if (!parsed.success) throw new NpmRegistryProfileStoreError('invalid_store');
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return emptyRegistry();
      if (error instanceof NpmRegistryProfileStoreError) throw error;
      throw new NpmRegistryProfileStoreError('invalid_store');
    }
  }

  async function read(): Promise<NpmRegistryProfileFile> {
    return await readUnlocked();
  }

  async function mutate(input: Readonly<{
    expectedRevision: number;
    mutationId: string;
    fingerprint: string;
    apply(current: NpmRegistryProfileFile): NpmRegistryProfileFile;
  }>): Promise<NpmRegistryProfileFile> {
    return await withPluginStoreLock({
      paths,
      lockName: NPM_REGISTRY_PROFILES_LOCK_NAME,
      fn: async () => {
        const current = await readUnlocked();
        const prior = current.mutations.find((entry) => entry.mutationId === input.mutationId);
        if (prior) {
          if (prior.fingerprint !== input.fingerprint) throw new NpmRegistryProfileStoreError('mutation_conflict', current.revision);
          return current;
        }
        if (input.expectedRevision !== current.revision) throw new NpmRegistryProfileStoreError('revision_conflict', current.revision);
        const proposed = input.apply(current);
        const revision = current.revision + 1;
        const next = RegistryFileSchema.parse({
          ...proposed,
          t: 'happier_npm_registry_profiles_v1',
          version: 1,
          revision,
          mutations: [
            ...current.mutations,
            { mutationId: input.mutationId, fingerprint: input.fingerprint, revision },
          ].slice(-MAX_MUTATIONS),
        });
        await ensurePluginStoreDirectories({ happyHomeDir: paths.happyHomeDir });
        await writeJsonAtomic(paths.npmRegistryProfilesFilePath, next);
        return next;
      },
    });
  }

  return Object.freeze({ paths, read, mutate });
}
