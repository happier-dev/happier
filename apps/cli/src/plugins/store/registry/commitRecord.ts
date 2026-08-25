import { readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import { PluginIdSchema } from '@happier-dev/protocol';
import { readPortablePathSegmentViolation } from '@happier-dev/protocol/filesystem/portablePathSegment';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';
import { flushDirectoryDurably, flushFileDurably } from './durability';

import type { PluginStorePaths } from '../paths';

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
}).strict();
export type PluginRegistryGenerationReference = z.infer<typeof PluginRegistryGenerationReferenceSchema>;

const CanonicalPluginGenerationMapSchema = z.record(asHostProtocolZod(PluginIdSchema), PluginRegistryGenerationReferenceSchema)
  .superRefine((value, context) => {
    for (const pluginId of Object.keys(value)) {
      const parsedPluginId = PluginIdSchema.safeParse(pluginId);
      if (!parsedPluginId.success || parsedPluginId.data !== pluginId) {
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

function parsePluginRegistryCommitRecordFromDisk(
  filePath: string,
  value: unknown,
): PluginRegistryCommitRecord {
  const parsed = PluginRegistryCommitRecordSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw invalidCommitRecord(filePath, projectCommitRecordIssues(parsed.error), parsed.error);
}

function projectCommitRecordIssues(error: z.ZodError): readonly string[] {
  return Object.freeze(error.issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  }));
}

export function pluginRegistryCommitRecordsEqual(
  left: PluginRegistryCommitRecord | null,
  right: PluginRegistryCommitRecord | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return isDeepStrictEqual(left, right);
}

/**
 * The coordinator owns cross-process serialization, while this record owner
 * supplies its one durable current-record fence. Keep the exact observed
 * record on the error so the coordinator can distinguish a stale writer from
 * a post-write durability-report failure without reinterpreting either.
 */
export class PluginRegistryCommitCurrentConflictError extends Error {
  readonly expectedRevision: number | null;
  readonly actualRevision: number | null;

  constructor(
    expectedCurrent: PluginRegistryCommitRecord | null,
    actualCurrent: PluginRegistryCommitRecord | null,
  ) {
    const expectedRevision = expectedCurrent?.revision ?? null;
    const actualRevision = actualCurrent?.revision ?? null;
    super(
      `Plugin registry current-record identity conflict: expected revision ${String(expectedRevision)}, found ${String(actualRevision)}`,
    );
    this.name = 'PluginRegistryCommitCurrentConflictError';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

/**
 * The durable current record is persisted state, so a rejection is an operator
 * situation rather than a transient fault: it recurs on every start until a
 * human acts. The daemon's fatal sink serializes only `name` and `message`, so
 * the offending file and the exact rejected clauses belong in the message —
 * "Invalid plugin registry commit record" alone names no field, no path and no
 * file, and cannot be acted on.
 */
export class PluginRegistryCommitRecordInvalidError extends Error {
  readonly filePath: string;
  readonly issues: readonly string[];

  constructor(filePath: string, issues: readonly string[], cause?: unknown) {
    super(
      `Invalid plugin registry commit record '${filePath}': ${
        issues.length > 0 ? issues.join('; ') : 'record did not match the current schema'
      }`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'PluginRegistryCommitRecordInvalidError';
    this.filePath = filePath;
    this.issues = Object.freeze([...issues]);
  }
}

function invalidCommitRecord(
  filePath: string,
  issues: readonly string[],
  cause?: unknown,
): PluginRegistryCommitRecordInvalidError {
  return new PluginRegistryCommitRecordInvalidError(filePath, issues, cause);
}

/**
 * Moves an unreadable current record aside so an explicitly requested recovery
 * start can bootstrap a fresh one. The record is renamed, never deleted, and a
 * record that still parses is refused: recovery must not discard durable plugin
 * state that the current reader can actually consume.
 */
export async function quarantineInvalidPluginRegistryCommitRecord(input: Readonly<{
  paths: PluginStorePaths;
  nowMs?: () => number;
}>): Promise<string> {
  const filePath = input.paths.registryCurrentFilePath;
  const raw = await readFile(filePath, 'utf8');
  const parsed = (() => {
    try {
      return PluginRegistryCommitRecordSchema.safeParse(JSON.parse(raw) as unknown).success;
    } catch {
      return false;
    }
  })();
  if (parsed) {
    throw new Error(
      `Plugin registry commit record '${filePath}' is readable and must not be quarantined`,
    );
  }
  const quarantinePath = `${filePath}.invalid-${String((input.nowMs ?? Date.now)())}`;
  await rename(filePath, quarantinePath);
  await flushDirectoryDurably(dirname(filePath));
  return quarantinePath;
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
    return parsePluginRegistryCommitRecordFromDisk(
      paths.registryCurrentFilePath,
      JSON.parse(raw) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw invalidCommitRecord(
        paths.registryCurrentFilePath,
        [`file is not valid JSON: ${error.message}`],
        error,
      );
    }
    throw error;
  }
}

export async function replacePluginRegistryCommitRecord(input: Readonly<{
  paths: PluginStorePaths;
  expectedCurrent: PluginRegistryCommitRecord | null;
  next: PluginRegistryCommitRecord;
  flushDurable?: (path: string) => Promise<void>;
}>): Promise<void> {
  const next = PluginRegistryCommitRecordSchema.parse(input.next);
  const current = await readPluginRegistryCommitRecord(input.paths);
  if (!pluginRegistryCommitRecordsEqual(current, input.expectedCurrent)) {
    throw new PluginRegistryCommitCurrentConflictError(input.expectedCurrent, current);
  }
  const expectedRevision = input.expectedCurrent?.revision ?? null;
  const expectedNextRevision = expectedRevision === null ? 0 : expectedRevision + 1;
  if (next.revision !== expectedNextRevision || next.baseRevision !== expectedRevision) {
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
