import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { PluginStorePaths } from '../paths';
import type { PluginRegistryCommitRecord } from './commitRecord';
import { createPluginRegistryCommitRecordSchema, isRegistryObject, type PluginRegistryGenerationReference } from './commitRecordSchema';

export class PluginRegistryCommitRecordInvalidError extends Error {
  readonly filePath: string;
  readonly issues: readonly string[];

  constructor(filePath: string, issues: readonly string[], cause?: unknown) {
    super(`Invalid plugin registry commit record '${filePath}': ${
      issues.length > 0 ? issues.join('; ') : 'record did not match the current schema'
    }`, cause === undefined ? undefined : { cause });
    this.name = 'PluginRegistryCommitRecordInvalidError';
    this.filePath = filePath;
    this.issues = Object.freeze([...issues]);
  }
}

export function invalidCommitRecord(filePath: string, issues: readonly string[], cause?: unknown): PluginRegistryCommitRecordInvalidError {
  return new PluginRegistryCommitRecordInvalidError(filePath, issues, cause);
}

const AdmittedPluginRegistryCommitRecordSchema = createStoredReadSchema(createPluginRegistryCommitRecordSchema(
  z.custom<Record<string, PluginRegistryGenerationReference>>(isRegistryObject),
));

/**
 * Read-only framing of a writer-admitted commit. Occurrence bodies are not
 * re-admitted here; executable readers additionally apply their strict schema.
 */
export function parsePluginRegistryCommitRecordEnvelope(filePath: string, value: unknown): PluginRegistryCommitRecord {
  const parsed = AdmittedPluginRegistryCommitRecordSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw invalidCommitRecord(filePath, parsed.error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  }), parsed.error);
}

export async function readPluginRegistryCommitRecordFile<T>(
  paths: PluginStorePaths,
  parse: (filePath: string, value: unknown) => T,
): Promise<T | null> {
  try {
    const raw = await readFile(paths.registryCurrentFilePath, 'utf8');
    return parse(paths.registryCurrentFilePath, JSON.parse(raw) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw invalidCommitRecord(paths.registryCurrentFilePath, [`file is not valid JSON: ${error.message}`], error);
    }
    throw error;
  }
}

export function readAdmittedPluginRegistryCommitRecord(paths: PluginStorePaths): Promise<PluginRegistryCommitRecord | null> {
  return readPluginRegistryCommitRecordFile(paths, parsePluginRegistryCommitRecordEnvelope);
}

/** Cold synchronous declaration readers use the same admitted framing parser. */
export function readAdmittedPluginRegistryCommitRecordSync(paths: PluginStorePaths): PluginRegistryCommitRecord | null {
  try {
    return parsePluginRegistryCommitRecordEnvelope(paths.registryCurrentFilePath,
      JSON.parse(readFileSync(paths.registryCurrentFilePath, 'utf8')) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw invalidCommitRecord(paths.registryCurrentFilePath, [`file is not valid JSON: ${error.message}`], error);
    }
    throw error;
  }
}
