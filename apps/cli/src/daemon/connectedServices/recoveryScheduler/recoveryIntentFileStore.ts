import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { DurableBackoffRecoveryStore } from './DurableBackoffRecoveryScheduler';

type RecoveryIntentFilePayload = Readonly<{
  v: 1;
  intentsBySessionId: Readonly<Record<string, unknown>>;
}>;

type RecoveryIntentFileState = {
  v: 1;
  intentsBySessionId: Record<string, unknown>;
};

function readPayload(filePath: string): RecoveryIntentFilePayload {
  if (!existsSync(filePath)) return { v: 1, intentsBySessionId: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { v: 1, intentsBySessionId: {} };
    }
    const record = parsed as Partial<RecoveryIntentFilePayload>;
    if (record.v !== 1 || !record.intentsBySessionId || typeof record.intentsBySessionId !== 'object') {
      return { v: 1, intentsBySessionId: {} };
    }
    return {
      v: 1,
      intentsBySessionId: record.intentsBySessionId,
    };
  } catch {
    return { v: 1, intentsBySessionId: {} };
  }
}

async function writePayload(filePath: string, payload: RecoveryIntentFilePayload): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700).catch(() => undefined);
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  await rename(tmpPath, filePath).catch(async (error: unknown) => {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  });
  await chmod(filePath, 0o600).catch(() => undefined);
}

function createState(payload: RecoveryIntentFilePayload): RecoveryIntentFileState {
  return {
    v: 1,
    intentsBySessionId: {
      ...payload.intentsBySessionId,
    },
  };
}

function createPayloadSnapshot(state: RecoveryIntentFileState): RecoveryIntentFilePayload {
  return {
    v: 1,
    intentsBySessionId: {
      ...state.intentsBySessionId,
    },
  };
}

export function createRecoveryIntentFileStore<TIntent>(
  filePath: string,
): DurableBackoffRecoveryStore<TIntent> {
  let state: RecoveryIntentFileState | null = null;
  let writeQueue: Promise<void> = Promise.resolve();

  function ensureState(): RecoveryIntentFileState {
    state ??= createState(readPayload(filePath));
    return state;
  }

  function persistState(): Promise<void> {
    const write = writeQueue
      .catch(() => undefined)
      .then(() => writePayload(filePath, createPayloadSnapshot(ensureState())));
    writeQueue = write;
    return write;
  }

  return {
    read: (sessionId) => ensureState().intentsBySessionId[sessionId] ?? null,
    readAll: () => Object.entries(ensureState().intentsBySessionId),
    write: async (sessionId, intent) => {
      ensureState().intentsBySessionId[sessionId] = intent;
      await persistState();
    },
    remove: async (sessionId) => {
      delete ensureState().intentsBySessionId[sessionId];
      await persistState();
    },
    prune: async (predicate) => {
      const state = ensureState();
      const prunedSessionIds: string[] = [];
      for (const [sessionId, value] of Object.entries(state.intentsBySessionId)) {
        if (!predicate({ sessionId, value })) continue;
        delete state.intentsBySessionId[sessionId];
        prunedSessionIds.push(sessionId);
      }
      if (prunedSessionIds.length > 0) {
        await persistState();
      }
      return prunedSessionIds;
    },
  };
}
