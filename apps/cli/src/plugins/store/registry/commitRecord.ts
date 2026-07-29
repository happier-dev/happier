import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import { PluginIdSchema } from '@happier-dev/protocol';
import { readPortablePathSegmentViolation } from '@happier-dev/protocol/filesystem/portablePathSegment';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { flushDirectoryDurably, flushFileDurably } from './durability';

import type { PluginStorePaths } from '../paths';

const AlgorithmQualifiedDigestSchema = z.string().regex(
  /^(?:sha256:[a-f0-9]{64}|sha384:[a-f0-9]{96}|sha512:[a-f0-9]{128})$/u,
  'Expected an algorithm-qualified hexadecimal digest',
);

function isPortableSegment(segment: string): boolean {
  return readPortablePathSegmentViolation(segment) === null;
}

export const PortableStorageIdSchema = z.string().min(1).max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
  .refine(isPortableSegment, 'Expected a portable storage id');
export const PortableRelativePathSchema = z.string().min(1).max(512).superRefine((value, context) => {
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) {
    context.addIssue({ code: 'custom', message: 'Expected a portable relative path' });
    return;
  }
  const segments = value.split('/');
  if (Buffer.byteLength(value, 'utf8') > 512 || segments.length > 64 || segments.some((segment) => !isPortableSegment(segment))) {
    context.addIssue({ code: 'custom', message: 'Expected a normalized portable relative path' });
  }
});

export const PluginRegistryGenerationReferenceSchema = z.object({
  immutableGenerationId: PortableStorageIdSchema,
  generationRecordDigest: AlgorithmQualifiedDigestSchema,
  installedArtifactRecord: z.object({
    relativePath: PortableRelativePathSchema,
    digest: AlgorithmQualifiedDigestSchema,
  }).strict(),
}).strict();
export type PluginRegistryGenerationReference = z.infer<typeof PluginRegistryGenerationReferenceSchema>;

const CanonicalPluginGenerationMapSchema = z.record(PluginIdSchema, PluginRegistryGenerationReferenceSchema)
  .superRefine((value, context) => {
    for (const pluginId of Object.keys(value)) {
      if (PluginIdSchema.safeParse(pluginId).data !== pluginId) {
        context.addIssue({ code: 'custom', path: [pluginId], message: 'Expected a canonical plugin id' });
      }
    }
  });

export const PluginRegistryCommitRecordSchema = z.object({
  t: z.literal('happier_plugin_registry_commit_v1'),
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  transactionId: PortableStorageIdSchema,
  baseRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  installationState: z.object({
    revisionId: PortableStorageIdSchema,
    digest: AlgorithmQualifiedDigestSchema,
  }).strict(),
  pluginGenerations: CanonicalPluginGenerationMapSchema,
  createdAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  creator: z.object({
    pid: z.number().int().positive().max(0x7fffffff),
    instanceId: PortableStorageIdSchema,
  }).strict(),
}).strict().superRefine((record, context) => {
  const expectedBase = record.revision === 0 ? null : record.revision - 1;
  if (record.baseRevision !== expectedBase) {
    context.addIssue({
      code: 'custom',
      path: ['baseRevision'],
      message: `Revision ${record.revision} must name base revision ${String(expectedBase)}`,
    });
  }
});
export type PluginRegistryCommitRecord = z.infer<typeof PluginRegistryCommitRecordSchema>;

function invalidCommitRecord(cause?: unknown): Error {
  return new Error('Invalid plugin registry commit record', cause === undefined ? undefined : { cause });
}

export function createEmptyPluginRegistryCommitRecord(input: Readonly<{
  transactionId: string;
  createdAtMs: number;
  creatorPid: number;
  creatorInstanceId: string;
}>): PluginRegistryCommitRecord {
  return PluginRegistryCommitRecordSchema.parse({
    t: 'happier_plugin_registry_commit_v1',
    schemaVersion: 1,
    revision: 0,
    transactionId: input.transactionId,
    baseRevision: null,
    installationState: {
      revisionId: 'state-0',
      digest: `sha256:${'0'.repeat(64)}`,
    },
    pluginGenerations: {},
    createdAtMs: input.createdAtMs,
    creator: { pid: input.creatorPid, instanceId: input.creatorInstanceId },
  });
}

export async function readPluginRegistryCommitRecord(
  paths: PluginStorePaths,
): Promise<PluginRegistryCommitRecord | null> {
  try {
    const raw = await readFile(paths.registryCurrentFilePath, 'utf8');
    const parsed = PluginRegistryCommitRecordSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) throw invalidCommitRecord(parsed.error);
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw invalidCommitRecord(error);
    throw error;
  }
}

export async function replacePluginRegistryCommitRecord(input: Readonly<{
  paths: PluginStorePaths;
  expectedRevision: number | null;
  next: PluginRegistryCommitRecord;
  flushDurable?: (path: string) => Promise<void>;
}>): Promise<void> {
  const next = PluginRegistryCommitRecordSchema.parse(input.next);
  const current = await readPluginRegistryCommitRecord(input.paths);
  const actualRevision = current?.revision ?? null;
  if (actualRevision !== input.expectedRevision) {
    throw new Error(`Plugin registry base revision conflict: expected ${String(input.expectedRevision)}, found ${String(actualRevision)}`);
  }
  const expectedNextRevision = input.expectedRevision === null ? 0 : input.expectedRevision + 1;
  if (next.revision !== expectedNextRevision || next.baseRevision !== input.expectedRevision) {
    throw new Error(`Plugin registry revision must advance monotonically to ${expectedNextRevision}`);
  }
  // Cross-process serialization belongs to PluginRegistryCommitCoordinator. A callback check here
  // would create a check-to-replace gap without adding ownership; the coordinator's exact-owner
  // fence instead remains stable for this entire atomic replacement.
  await writeJsonAtomic(input.paths.registryCurrentFilePath, next);
  await (input.flushDurable ?? flushPluginRegistryCommitRecord)(input.paths.registryCurrentFilePath);
}

export async function flushPluginRegistryCommitRecord(path: string): Promise<void> {
  await flushFileDurably(path);
  await flushDirectoryDurably(dirname(path));
}

export { AlgorithmQualifiedDigestSchema };
