import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentExternalSessionSource, AgentExternalSessionsFailureCode } from '@happier-dev/plugin-sdk/sessions/external';
import { resolveKimiSessionDirectory } from '../sessionDirectory.js';

export class KimiStoreError extends Error {
  constructor(readonly code: AgentExternalSessionsFailureCode) { super(`Kimi Code history: ${code}.`); }
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}
export function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
export function decode(raw: string): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString()); return record(value) ? value : null; }
  catch { return null; }
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}
export async function admittedPath(root: string, path: string): Promise<string> {
  const physical = await realpath(path);
  if (!inside(root, physical)) throw new KimiStoreError('source_invalid');
  return physical;
}
export type KimiStore = Readonly<{ root: string; source: AgentExternalSessionSource }>;
export async function resolveKimiStore(source: AgentExternalSessionSource): Promise<KimiStore> {
  if (source.kind !== 'kimiCodeHome') throw new KimiStoreError('source_invalid');
  const configured = resolve(process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code'));
  const root = await realpath(configured).catch((error: unknown) => {
    if (record(error) && error.code === 'ENOENT') return configured;
    throw new KimiStoreError('unavailable');
  });
  // The resolved carrier is not permission to select another native home.
  if (source.homeDir !== undefined && source.homeDir !== configured && source.homeDir !== root) throw new KimiStoreError('source_invalid');
  return { root, source: { kind: 'kimiCodeHome', homeDir: root } };
}
export type KimiSession = Readonly<{
  id: string; directory: string; statePath: string; wirePath: string;
  title?: string; cwd?: string; createdAtMs?: number; updatedAtMs: number; archived?: boolean;
}>;
async function directories(path: string, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => join(path, entry.name)).sort(); }
  catch (error) { if (record(error) && error.code === 'ENOENT') return []; throw new KimiStoreError('unavailable'); }
}
function time(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** State/index joins are invocation-local. Neither embedded homedir nor index paths grant reads. */
export async function listKimiSessions(store: KimiStore, signal: AbortSignal): Promise<Readonly<{
  sessions: KimiSession[]; files: string[]; partial: boolean;
}>> {
  const sessions: KimiSession[] = [];
  const files = new Set<string>();
  const index = new Map<string, { directory: string; cwd: string }>();
  let partial = false;
  const indexPath = join(store.root, 'session_index.jsonl');
  try {
    const path = await admittedPath(store.root, indexPath);
    files.add(path);
    const lines = (await readFile(path, { encoding: 'utf8', signal })).split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry: unknown = JSON.parse(line);
        if (!record(entry) || typeof entry.sessionId !== 'string' || typeof entry.sessionDir !== 'string'
          || typeof entry.workDir !== 'string' || !isAbsolute(entry.sessionDir) || !isAbsolute(entry.workDir)) { partial = true; continue; }
        index.set(entry.sessionId, { directory: resolveKimiSessionDirectory(store.root, entry.sessionDir, entry.sessionId), cwd: entry.workDir });
      } catch { partial = true; }
    }
  } catch (error) { if (!record(error) || error.code !== 'ENOENT') throw error; }
  for (const workDir of await directories(join(store.root, 'sessions'), signal)) {
    for (const directory of await directories(workDir, signal)) {
      signal.throwIfAborted();
      const id = basename(directory);
      try {
        const sessionDir = await admittedPath(store.root, directory);
        const statePath = await admittedPath(sessionDir, join(sessionDir, 'state.json'));
        files.add(statePath);
        const state: unknown = JSON.parse(await readFile(statePath, { encoding: 'utf8', signal }));
        if (!record(state) || !record(state.agents)) { partial = true; continue; }
        const mains = Object.entries(state.agents).filter(([, agent]) => record(agent) && agent.type === 'main');
        if (mains.length !== 1) { partial = true; continue; }
        const agentId = mains[0]![0];
        if (!agentId || /[\\/]/.test(agentId) || agentId === '.' || agentId === '..') { partial = true; continue; }
        const wirePath = await admittedPath(sessionDir, join(sessionDir, 'agents', agentId, 'wire.jsonl'));
        files.add(wirePath);
        const info = await stat(wirePath);
        if (!info.isFile()) { partial = true; continue; }
        const indexed = index.get(id);
        sessions.push({ id, directory: sessionDir, statePath, wirePath,
          ...(typeof state.title === 'string' ? { title: state.title } : {}),
          ...(indexed?.directory === directory ? { cwd: indexed.cwd } : {}),
          ...(time(state.createdAt) !== undefined ? { createdAtMs: time(state.createdAt) } : {}),
          updatedAtMs: Math.trunc(Math.max(time(state.updatedAt) ?? 0, info.mtimeMs)),
          ...(typeof state.archived === 'boolean' ? { archived: state.archived } : {}),
        });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof KimiStoreError && error.code === 'source_invalid') throw error;
        partial = true;
      }
    }
  }
  return { sessions: sessions.sort((a, b) => a.id.localeCompare(b.id)), files: [...files], partial };
}
export async function findKimiSession(store: KimiStore, id: string, signal: AbortSignal): Promise<KimiSession> {
  const inventory = await listKimiSessions(store, signal);
  const session = inventory.sessions.find(candidate => candidate.id === id);
  if (!session) throw new KimiStoreError(inventory.partial ? 'unavailable' : 'candidate_not_found');
  return session;
}
