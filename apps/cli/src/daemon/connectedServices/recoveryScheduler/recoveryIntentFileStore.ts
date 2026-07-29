import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';

import type { DurableBackoffRecoveryStore } from './DurableBackoffRecoveryScheduler';

export type RecoveryIntentFileStore<TIntent> = DurableBackoffRecoveryStore<TIntent> & Readonly<{
  readKeysAuthoritative: (
    sessionIds: readonly string[],
  ) => ReadonlyMap<string, unknown | null>;
  /**
   * Reads the declared physical keys plus a read-only view of every physical
   * entry from one fresh snapshot, then applies declared-key mutations while
   * the existing owner-file lock remains held.
   */
  transactKeys: <TResult>(
    sessionIds: readonly string[],
    transaction: (
      currentBySessionId: ReadonlyMap<string, Readonly<{
        intent: TIntent | null;
        effectClaimToken: string | null;
      }>>,
      allCurrentBySessionId: ReadonlyMap<string, Readonly<{
        intent: TIntent | null;
        effectClaimToken: string | null;
      }>>,
    ) => Readonly<{
      mutations: ReadonlyArray<Readonly<{
        sessionId: string;
        intent: TIntent | null;
        effectClaimToken: string | null;
      }>>;
      result: TResult;
    }>,
  ) => Promise<TResult>;
}>;

type RecoveryIntentFilePayload = Readonly<{
  v: 1;
  intentsBySessionId: Readonly<Record<string, unknown>>;
  effectClaimsByRecoveryKey?: Readonly<Record<string, string>>;
}>;

type RecoveryIntentFileState = {
  v: 1;
  intentsBySessionId: Record<string, unknown>;
  effectClaimsByRecoveryKey: Record<string, string>;
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
    const effectClaimsByRecoveryKey = record.effectClaimsByRecoveryKey
      && typeof record.effectClaimsByRecoveryKey === 'object'
      && !Array.isArray(record.effectClaimsByRecoveryKey)
      ? Object.fromEntries(Object.entries(record.effectClaimsByRecoveryKey).filter(
        (entry): entry is [string, string] => entry[0].trim().length > 0
          && typeof entry[1] === 'string'
          && entry[1].trim().length > 0,
      ))
      : {};
    return {
      v: 1,
      intentsBySessionId: record.intentsBySessionId,
      ...(Object.keys(effectClaimsByRecoveryKey).length > 0 ? { effectClaimsByRecoveryKey } : {}),
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
    effectClaimsByRecoveryKey: {
      ...payload.effectClaimsByRecoveryKey,
    },
  };
}

function createPayloadSnapshot(state: RecoveryIntentFileState): RecoveryIntentFilePayload {
  const effectClaimsByRecoveryKey = Object.fromEntries(
    Object.entries(state.effectClaimsByRecoveryKey).filter(([sessionId]) => (
      sessionId in state.intentsBySessionId
    )),
  );
  return {
    v: 1,
    intentsBySessionId: {
      ...state.intentsBySessionId,
    },
    ...(Object.keys(effectClaimsByRecoveryKey).length > 0 ? { effectClaimsByRecoveryKey } : {}),
  };
}

function applyEntryMutation<TIntent>(
  state: RecoveryIntentFileState,
  mutation: Readonly<{
    sessionId: string;
    intent: TIntent | null;
    effectClaimToken: string | null;
  }>,
): void {
  if (mutation.intent === null) {
    delete state.intentsBySessionId[mutation.sessionId];
    delete state.effectClaimsByRecoveryKey[mutation.sessionId];
    return;
  }
  state.intentsBySessionId[mutation.sessionId] = mutation.intent;
  if (mutation.effectClaimToken === null) {
    delete state.effectClaimsByRecoveryKey[mutation.sessionId];
  } else {
    state.effectClaimsByRecoveryKey[mutation.sessionId] = mutation.effectClaimToken;
  }
}

export function createRecoveryIntentFileStore<TIntent>(
  filePath: string,
): RecoveryIntentFileStore<TIntent> {
  let state: RecoveryIntentFileState | null = null;
  let writeQueue: Promise<void> = Promise.resolve();

  function ensureState(): RecoveryIntentFileState {
    state ??= createState(readPayload(filePath));
    return state;
  }

  async function enqueueMutation<TResult>(
    mutation: (freshState: RecoveryIntentFileState) => Promise<TResult>,
  ): Promise<TResult> {
    let result!: TResult;
    const run = writeQueue
      .catch(() => undefined)
      .then(async () => {
        result = await withJsonOwnerFileLock({
          lockPath: `${filePath}.lock`,
          timeoutMs: 10_000,
          staleAfterMs: 30_000,
          errorCode: 'recovery_intent_file_store_lock_timeout',
        }, async () => {
          state = createState(readPayload(filePath));
          return await mutation(state);
        });
      });
    writeQueue = run.catch(() => undefined);
    await run;
    return result;
  }

  return {
    read: (sessionId) => ensureState().intentsBySessionId[sessionId] ?? null,
    readAuthoritative: (sessionId) => {
      state = createState(readPayload(filePath));
      return state.intentsBySessionId[sessionId] ?? null;
    },
    readKeysAuthoritative: (sessionIds) => {
      state = createState(readPayload(filePath));
      return new Map(sessionIds.map((sessionId) => [
        sessionId,
        state?.intentsBySessionId[sessionId] ?? null,
      ] as const));
    },
    readAll: () => Object.entries(ensureState().intentsBySessionId),
    write: async (sessionId, intent) => {
      await enqueueMutation(async (freshState) => {
        freshState.intentsBySessionId[sessionId] = intent;
        await writePayload(filePath, createPayloadSnapshot(freshState));
      });
    },
    remove: async (sessionId) => {
      await enqueueMutation(async (freshState) => {
        delete freshState.intentsBySessionId[sessionId];
        delete freshState.effectClaimsByRecoveryKey[sessionId];
        await writePayload(filePath, createPayloadSnapshot(freshState));
      });
    },
    prune: async (predicate) => await enqueueMutation(async (freshState) => {
      const prunedSessionIds: string[] = [];
      for (const [sessionId, value] of Object.entries(freshState.intentsBySessionId)) {
        if (!predicate({ sessionId, value })) continue;
        delete freshState.intentsBySessionId[sessionId];
        delete freshState.effectClaimsByRecoveryKey[sessionId];
        prunedSessionIds.push(sessionId);
      }
      if (prunedSessionIds.length > 0) {
        await writePayload(filePath, createPayloadSnapshot(freshState));
      }
      return prunedSessionIds;
    }),
    transact: async (sessionId, transaction) => await enqueueMutation(async (freshState) => {
      const next = transaction({
        intent: (freshState.intentsBySessionId[sessionId] as TIntent | undefined) ?? null,
        effectClaimToken: freshState.effectClaimsByRecoveryKey[sessionId] ?? null,
      });
      applyEntryMutation(freshState, { sessionId, ...next });
      await writePayload(filePath, createPayloadSnapshot(freshState));
      return next.result;
    }),
    transactKeys: async (sessionIds, transaction) => await enqueueMutation(async (freshState) => {
      const uniqueSessionIds = [...new Set(sessionIds)];
      const allowedSessionIds = new Set(uniqueSessionIds);
      const currentBySessionId = new Map(uniqueSessionIds.map((sessionId) => [
        sessionId,
        {
          intent: (freshState.intentsBySessionId[sessionId] as TIntent | undefined) ?? null,
          effectClaimToken: freshState.effectClaimsByRecoveryKey[sessionId] ?? null,
        },
      ] as const));
      const allSessionIds = new Set([
        ...Object.keys(freshState.intentsBySessionId),
        ...Object.keys(freshState.effectClaimsByRecoveryKey),
      ]);
      const allCurrentBySessionId = new Map([...allSessionIds].map((sessionId) => [
        sessionId,
        {
          intent: (freshState.intentsBySessionId[sessionId] as TIntent | undefined) ?? null,
          effectClaimToken: freshState.effectClaimsByRecoveryKey[sessionId] ?? null,
        },
      ] as const));
      const next = transaction(currentBySessionId, allCurrentBySessionId);
      for (const mutation of next.mutations) {
        if (!allowedSessionIds.has(mutation.sessionId)) {
          throw new Error('Recovery intent multi-key transaction mutated an undeclared key');
        }
        applyEntryMutation(freshState, mutation);
      }
      if (next.mutations.length > 0) {
        await writePayload(filePath, createPayloadSnapshot(freshState));
      }
      return next.result;
    }),
  };
}
