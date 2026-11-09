import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isCanonicalAbsolutePathInsideRoot, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import type { AgentExternalSessionSource, AgentExternalSessionsFailureCode } from '@happier-dev/plugin-sdk/sessions/external';

export class FxSourceError extends Error {
  constructor(readonly code: AgentExternalSessionsFailureCode) { super(`FX native history: ${code}`); }
}

export function isFxRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function fxSessionsRoot(source: AgentExternalSessionSource, env: NodeJS.ProcessEnv): string {
  if (source.kind !== 'fxHome' || Object.keys(source).some(key => key !== 'kind')) throw new FxSourceError('source_invalid');
  return join(resolveHomeDirFromEnvironment(env), '.fx', 'sessions');
}

export function isFxSessionId(id: string): boolean {
  // Vendor session_layout.zig:20–34. v2 is a separate opt-in store, not a v1 id.
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..' && id.toLowerCase() !== 'v2' && id.length <= 255;
}

export async function fxSessionDir(root: string, id: string): Promise<string> {
  if (!isFxSessionId(id)) throw new FxSourceError('invalid_request');
  const canonicalRoot = await realpath(root);
  const target = join(canonicalRoot, id);
  const info = await lstat(target);
  const physical = await realpath(target);
  if (!info.isDirectory() || info.isSymbolicLink() || !isCanonicalAbsolutePathInsideRoot(canonicalRoot, physical)) {
    throw new FxSourceError('source_invalid');
  }
  return physical;
}

export async function fxFile(dir: string, ...parts: string[]): Promise<string> {
  const target = join(dir, ...parts);
  const physical = await realpath(target);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || !isCanonicalAbsolutePathInsideRoot(dir, physical)) {
    throw new FxSourceError('source_invalid');
  }
  return physical;
}

export async function fxSidecarFiles(dir: string, kind: 'tool-results' | 'images'): Promise<Readonly<{ directory: string; files: readonly string[] }>> {
  const directory = join(dir, kind);
  let info;
  try { info = await lstat(directory); }
  catch (error) {
    if (isFxRecord(error) && error.code === 'ENOENT') return { directory, files: [] };
    throw error;
  }
  const physical = await realpath(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !isCanonicalAbsolutePathInsideRoot(dir, physical)) throw new FxSourceError('source_invalid');
  const entries = await readdir(physical, { withFileTypes: true });
  return { directory: physical, files: entries.filter(entry => entry.isFile() && !entry.isSymbolicLink()).map(entry => join(physical, entry.name)) };
}

export async function readFxJson(dir: string, name: string): Promise<unknown> {
  const bytes = await readFile(await fxFile(dir, name));
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new FxSourceError('unsupported'); }
}

export type FxSessionMetadata = Readonly<{
  id: string; title?: string; cwd: string; createdAtMs: number; updatedAtMs: number; child: boolean;
}>;

const METADATA_FIELDS = new Set(['schema_version', 'id', 'origin_workspace_root', 'workspace_root', 'created_at_ms',
  'updated_at_ms', 'conversation_language', 'provider', 'model', 'effort', 'fast_mode', 'ultrafast_mode', 'title', 'subagent_child']);

export async function readFxMetadata(root: string, id: string): Promise<FxSessionMetadata> {
  const metadata = await readFxJson(await fxSessionDir(root, id), 'session.json');
  if (!isFxRecord(metadata) || metadata.schema_version !== 4 || Object.keys(metadata).some(key => !METADATA_FIELDS.has(key))) {
    throw new FxSourceError('unsupported');
  }
  if (metadata.id !== id || typeof metadata.workspace_root !== 'string'
    || typeof metadata.created_at_ms !== 'number' || !Number.isSafeInteger(metadata.created_at_ms)
    || typeof metadata.updated_at_ms !== 'number' || !Number.isSafeInteger(metadata.updated_at_ms)
    || typeof metadata.subagent_child !== 'boolean') throw new FxSourceError('unsupported');
  return { id, ...(typeof metadata.title === 'string' ? { title: metadata.title } : {}), cwd: metadata.workspace_root,
    createdAtMs: metadata.created_at_ms, updatedAtMs: metadata.updated_at_ms, child: metadata.subagent_child };
}

export async function listFxSessionIds(root: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const entries = await readdir(root, { withFileTypes: true });
  signal.throwIfAborted();
  return { ids: entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && isFxSessionId(entry.name))
    .map(entry => entry.name).sort(), unsupported: entries.some(entry => entry.name.toLowerCase() === 'v2') };
}

export function fxFailureCode(error: unknown): AgentExternalSessionsFailureCode {
  if (error instanceof FxSourceError) return error.code;
  if (isFxRecord(error) && error.code === 'ENOENT') return 'candidate_not_found';
  return 'source_unreachable';
}
