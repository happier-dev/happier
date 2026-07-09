import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { PluginSourceSpecV1Schema } from '@happier-dev/protocol';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { PluginCompatibilityDiagnosticSchema } from '@/plugins/validation/diagnostics/types';
import { PLUGIN_STATE_LOCK_NAME, withPluginStoreLock } from './lock';
import { ensurePluginStoreDirectories, resolvePluginStorePaths, type PluginStorePaths } from './paths';

export const PluginCompatibilityStatusSchema = z.enum(['unknown', 'compatible', 'incompatible', 'load_error']);
export type PluginCompatibilityStatus = z.infer<typeof PluginCompatibilityStatusSchema>;

export const PluginInstallModeSchema = z.enum(['link', 'managed_install']);
export type PluginInstallMode = z.infer<typeof PluginInstallModeSchema>;

export const PluginStateSourceRecordSchema = PluginSourceSpecV1Schema.extend({
  resolvedPath: z.string().min(1),
  manifestPath: z.string().min(1),
  devWatch: z.boolean().optional(),
}).strict();
export type PluginStateSourceRecord = z.infer<typeof PluginStateSourceRecordSchema>;

export const PluginStateCompatibilityRecordSchema = z.object({
  status: PluginCompatibilityStatusSchema,
  checkedAtMs: z.number().int().nonnegative().optional(),
  diagnostics: z.array(PluginCompatibilityDiagnosticSchema).default([]),
}).strict();
export type PluginStateCompatibilityRecord = z.infer<typeof PluginStateCompatibilityRecordSchema>;

export const PluginStateInstallRecordSchema = z.object({
  mode: PluginInstallModeSchema,
  manifestVersion: z.string().min(1),
  manifestDigest: z.string().min(1).nullable().optional(),
  installedPath: z.string().min(1).nullable().optional(),
}).strict();
export type PluginStateInstallRecord = z.infer<typeof PluginStateInstallRecordSchema>;

export const PluginStateLifecycleRecordSchema = z.object({
  enabled: z.boolean(),
  lastLoadedAtMs: z.number().int().nonnegative().optional(),
  lastError: z.string().min(1).nullable().optional(),
}).strict();
export type PluginStateLifecycleRecord = z.infer<typeof PluginStateLifecycleRecordSchema>;

export const PluginStateRecordSchema = z.object({
  source: PluginStateSourceRecordSchema,
  compatibility: PluginStateCompatibilityRecordSchema,
  install: PluginStateInstallRecordSchema,
  state: PluginStateLifecycleRecordSchema,
}).strict();
export type PluginStateRecord = z.infer<typeof PluginStateRecordSchema>;

export const PluginStateFileV1Schema = z.object({
  t: z.literal('happier_plugin_state_v1'),
  schemaVersion: z.literal(1),
  plugins: z.record(z.string(), PluginStateRecordSchema),
}).strict();
export type PluginStateFileV1 = z.infer<typeof PluginStateFileV1Schema>;

function createEmptyPluginStateFile(): PluginStateFileV1 {
  return {
    t: 'happier_plugin_state_v1',
    schemaVersion: 1,
    plugins: {},
  };
}

export function createPluginStateStore(params?: Readonly<{ happyHomeDir?: string }>): Readonly<{
  paths: PluginStorePaths;
  read: () => Promise<PluginStateFileV1>;
  write: (next: PluginStateFileV1) => Promise<void>;
  update: (transform: (current: PluginStateFileV1) => Promise<PluginStateFileV1> | PluginStateFileV1) => Promise<PluginStateFileV1>;
}> {
  const paths = resolvePluginStorePaths(params);

  async function readUnlocked(): Promise<PluginStateFileV1> {
    try {
      const raw = await readFile(paths.stateFilePath, 'utf8');
      const parsedJson = JSON.parse(raw) as unknown;
      const parsed = PluginStateFileV1Schema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new Error('Invalid plugin state file');
      }
      return parsed.data;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') {
        return createEmptyPluginStateFile();
      }
      if (error instanceof SyntaxError) {
        throw new Error('Invalid plugin state file');
      }
      throw error;
    }
  }

  async function writeUnlocked(next: PluginStateFileV1): Promise<void> {
    const parsed = PluginStateFileV1Schema.parse(next);
    await ensurePluginStoreDirectories({ happyHomeDir: paths.happyHomeDir });
    await writeJsonAtomic(paths.stateFilePath, parsed);
  }

  return {
    paths,
    async read(): Promise<PluginStateFileV1> {
      return await readUnlocked();
    },
    async write(next: PluginStateFileV1): Promise<void> {
      await withPluginStoreLock({
        paths,
        lockName: PLUGIN_STATE_LOCK_NAME,
        fn: async () => {
          await writeUnlocked(next);
        },
      });
    },
    async update(transform): Promise<PluginStateFileV1> {
      return await withPluginStoreLock({
        paths,
        lockName: PLUGIN_STATE_LOCK_NAME,
        fn: async () => {
          const current = await readUnlocked();
          const next = PluginStateFileV1Schema.parse(await transform(current));
          await writeUnlocked(next);
          return next;
        },
      });
    },
  };
}

export { resolvePluginStorePaths } from './paths';
