import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { lazySchema, LocalHistoryItemsSchema, type LocalHistoryRpcRequest, type LocalHistoryRpcResponse } from '@happier-dev/protocol';
import { z } from 'zod';

import { configuration } from '@/configuration';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { readOrWriteClaudeLocalHistoryRetention } from '../settings/claudeLocalHistory';
import { resolveConfiguredClaudeConfigDir } from '../utils/resolveConfiguredClaudeConfigDir';
import { readClaudeSessionLogFacts } from './listClaudeSessionCandidates';
import { resolveClaudeConfigDirForDirectSessions } from './resolveClaudeConfigDir';
import { resolveClaudeDirectSessionFile } from './resolveClaudeDirectSessionFile';

const DAY_MS = 86_400_000;
const NOTICE_MS = 7 * DAY_MS;
const KeptSchema = lazySchema(() => z.array(LocalHistoryItemsSchema.element.extend({
  projectId: LocalHistoryItemsSchema.element.shape.remoteSessionId,
  agentId: z.literal('claude').optional(),
  sourceKey: z.string().optional(),
  activityMs: z.number(),
  keptMs: z.number().optional(),
  touchedMtimeMs: z.number(),
})));
type Kept = z.infer<typeof KeptSchema>[number];

let pendingRecordOperation: Promise<unknown> = Promise.resolve();

async function readKept(path: string): Promise<Kept[]> {
  try {
    return KeptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function logPath(projects: string, projectId: string, remoteSessionId: string): string {
  return join(projects, projectId, `${remoteSessionId}.jsonl`);
}

async function statRealLog(path: string) {
  try {
    const info = await lstat(path);
    return info.isFile() && await realpath(path) === path ? info : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

type KeptOperation = Extract<LocalHistoryRpcRequest, { operation: 'keep' | 'letGo' | 'due.list' }>;

async function processKept(
  request: KeptOperation,
  configDir: string,
  readPeriodDays: () => Promise<number | null>,
  reconcile: boolean = request.operation === 'due.list',
): Promise<LocalHistoryRpcResponse> {
  const path = join(configuration.activeServerDir, 'daemon', 'agent-sessions-kept.json');
  const previous = await readKept(path);
  const kept: Kept[] = [];
  const now = Date.now();
  let changed = 0;
  const due: { remoteSessionId: string; projectId: string; activityMs: number; leavesAt: number }[] = [];
  let keptDueAtMs: number | null = null;
  const save = (records: Kept[]) => writeJsonAtomic(path, records);
  if (!previous.length && request.operation !== 'keep') return { ok: true, due, changed, keptDueAtMs };
  const periodDays = await readPeriodDays();
  if (request.operation === 'keep' && periodDays === null) return { ok: false, errorCode: 'retention_unwritable' };
  const projectsPath = join(configDir, 'projects');
  const projects = await realpath(projectsPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return projectsPath;
    throw error;
  });
  const sourceKey = createHash('sha256').update(configDir).digest('hex');
  const belongsToSource = (record: Kept) => record.sourceKey === undefined || record.sourceKey === sourceKey;

  for (const record of previous) {
    if (!belongsToSource(record)) {
      kept.push(record);
      continue;
    }
    if (request.operation === 'letGo' && request.items.some((item) =>
      item.remoteSessionId === record.remoteSessionId && (item.projectId === undefined || item.projectId === record.projectId)
    )) {
      changed++;
      continue;
    }
    if (reconcile && periodDays !== null) {
      const info = await statRealLog(logPath(projects, record.projectId, record.remoteSessionId));
      if (info?.mtimeMs !== record.touchedMtimeMs) continue;
    }
    kept.push(record);
  }

  try {
    if (request.operation === 'keep' && periodDays !== null) {
      for (const item of request.items) {
        const projectId = item.projectId ?? (await resolveClaudeDirectSessionFile({ source: request.source, remoteSessionId: item.remoteSessionId }))?.projectId;
        if (!projectId || !LocalHistoryItemsSchema.element.shape.remoteSessionId.safeParse(projectId).success) {
          return { ok: false, errorCode: 'session_not_found' };
        }
        const log = logPath(projects, projectId, item.remoteSessionId);
        const resolvedLog = await realpath(log).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (resolvedLog !== log) return { ok: false, errorCode: 'session_not_found' };
        const handle = await open(log, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const info = await handle.stat();
          if (!info.isFile()) return { ok: false, errorCode: 'session_not_found' };
          const existing = kept.findIndex((record) => belongsToSource(record)
            && record.projectId === projectId && record.remoteSessionId === item.remoteSessionId);
          const previousRecord = kept[existing];
          await handle.utimes(info.atime, new Date(Math.max(now, info.mtimeMs)));
          const { mtimeMs } = await handle.stat();
          const record = {
            remoteSessionId: item.remoteSessionId,
            projectId,
            agentId: 'claude' as const,
            sourceKey,
            activityMs: previousRecord?.touchedMtimeMs === info.mtimeMs ? previousRecord.activityMs : info.mtimeMs,
            keptMs: now,
            touchedMtimeMs: mtimeMs,
          };
          if (existing >= 0) kept[existing] = record;
          else kept.push(record);
          changed++;
        } finally {
          await handle.close();
        }
      }
    }
  } finally {
    if (changed > 0 || kept.length !== previous.length) await save(kept);
  }

  if (periodDays !== null) {
    for (const record of kept) {
      if (!belongsToSource(record)) continue;
      const leavesAt = record.touchedMtimeMs + periodDays * DAY_MS;
      const dueAt = leavesAt - NOTICE_MS;
      keptDueAtMs = Math.min(keptDueAtMs ?? dueAt, dueAt);
      if (dueAt <= now) due.push({ remoteSessionId: record.remoteSessionId, projectId: record.projectId, activityMs: record.activityMs, leavesAt });
    }
  }
  return { ok: true, due: due.sort((left, right) => left.leavesAt - right.leavesAt), changed, keptDueAtMs, retentionDays: periodDays };
}

function queueRecordOperation(run: () => Promise<LocalHistoryRpcResponse>): Promise<LocalHistoryRpcResponse> {
  const operation = pendingRecordOperation.then(run);
  pendingRecordOperation = operation.catch(() => {});
  return operation;
}

export async function runClaudeLocalHistory(request: LocalHistoryRpcRequest): Promise<LocalHistoryRpcResponse> {
  const source = { providerId: request.providerId, source: request.source };
  const configDir = resolveClaudeConfigDirForDirectSessions({ source: request.source, env: process.env });
  if (request.operation === 'retention.set') {
    return await queueRecordOperation(async () => {
      const { changedSincePreview, ...retention } = await readOrWriteClaudeLocalHistoryRetention(
        { ...source, operation: 'write', days: request.days }, request.expectedCurrentDays,
      );
      if (changedSincePreview) return { ok: false, errorCode: 'retention_changed' };
      if (!retention.writable) return { ok: false, errorCode: 'retention_unwritable' };
      const notice = await processKept({ ...source, operation: 'due.list' }, configDir,
        async () => retention.never ? null : (retention.currentDays ?? retention.defaultDays), false);
      return notice.ok ? { ok: true, retention, keptDueAtMs: notice.keptDueAtMs } : notice;
    });
  }
  if (request.operation !== 'status.get' && request.operation !== 'retention.preview') {
    return await queueRecordOperation(() => processKept(request, configDir, () => readRetentionPeriod(source)));
  }
  const retention = await readOrWriteClaudeLocalHistoryRetention({ ...source, operation: 'read' });
  if (request.operation === 'status.get') return { ok: true, retention };

  const period = retention.currentDays ?? retention.defaultDays;
  if (!retention.writable) return { ok: false, errorCode: 'retention_unwritable' };
  const days = request.days;
  const shortening = typeof days === 'number' && days < period;
  let affectedCount = 0;
  if (shortening) {
    const now = Date.now();
    const oldest = retention.never ? -Infinity : now - period * DAY_MS;
    const cutoff = now - days * DAY_MS;
    const logs = await readClaudeSessionLogFacts(configDir);
    affectedCount = logs.filter(({ updatedAtMs }) => updatedAtMs >= oldest && updatedAtMs < cutoff).length;
  }
  return { ok: true, preview: { currentDays: retention.currentDays, affectedCount, shortening } };
}

async function readRetentionPeriod(source: Pick<LocalHistoryRpcRequest, 'providerId' | 'source'>): Promise<number | null> {
  const current = await readOrWriteClaudeLocalHistoryRetention({ ...source, operation: 'read' });
  return current.never ? null : (current.currentDays ?? current.defaultDays);
}

export async function readClaudeLocalHistoryKeptDueAtMs(configDir?: string): Promise<number | null> {
  const activeConfigDir = configDir ?? resolveConfiguredClaudeConfigDir({ env: process.env });
  const canonicalConfigDir = await realpath(activeConfigDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return activeConfigDir;
    throw error;
  });
  const source = { providerId: 'claude', source: { kind: 'claudeConfig', configDir: canonicalConfigDir } } as const;
  const notice = await queueRecordOperation(() => processKept({ ...source, operation: 'due.list' }, canonicalConfigDir,
    () => readRetentionPeriod(source), false));
  return notice.ok ? notice.keptDueAtMs ?? null : null;
}
