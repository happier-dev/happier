import { createHash } from 'node:crypto';
import {
  PendingFirstInputV1Schema,
  type PendingFirstInputV1,
} from '@happier-dev/protocol';

import type { ApiSessionClient } from '@/api/session/sessionClient';

export const HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY = 'HAPPIER_DAEMON_PENDING_FIRST_INPUT';

export type PendingFirstInput = Readonly<PendingFirstInputV1>;

function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Pending first input ${field} must not be blank`);
  }
  return value;
}

export function createPendingFirstInput(params: Readonly<{
  text: string;
  spawnNonce: string;
}>): PendingFirstInput {
  const text = requireNonBlank(params.text, 'text');
  const spawnNonce = requireNonBlank(params.spawnNonce, 'spawn nonce').trim();
  const identity = createHash('sha256')
    .update('happier:pending-first-input:v1\0', 'utf8')
    .update(spawnNonce, 'utf8')
    .digest('hex');
  return Object.freeze({ text, localId: `spawn-first:${identity}` });
}

export function serializePendingFirstInputForEnv(input: PendingFirstInput): string {
  return JSON.stringify(PendingFirstInputV1Schema.parse(input));
}

export function readPendingFirstInputFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PendingFirstInput | null {
  const raw = env[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY];
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Pending first input handoff is malformed');
  }
  const result = PendingFirstInputV1Schema.safeParse(parsed);
  if (!result.success) {
    throw new Error('Pending first input handoff is malformed');
  }
  return Object.freeze(result.data);
}

export function clearPendingFirstInputFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  delete env[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY];
}

export type PendingFirstInputCommitter = Readonly<{
  hasPendingInput: boolean;
  commit(session: Pick<ApiSessionClient, 'enqueueSessionUserMessage'>): Promise<void>;
}>;

export function createPendingFirstInputCommitter(
  env: NodeJS.ProcessEnv = process.env,
): PendingFirstInputCommitter {
  const pendingFirstInput = readPendingFirstInputFromEnv(env);
  let committed = pendingFirstInput === null;
  let inFlight: Promise<void> | null = null;

  return Object.freeze({
    get hasPendingInput() {
      return !committed;
    },
    commit: (session) => {
      if (committed || pendingFirstInput === null) return Promise.resolve();
      if (inFlight) return inFlight;

      const attempt = (async () => {
        const result = await session.enqueueSessionUserMessage({
          text: pendingFirstInput.text,
          localId: pendingFirstInput.localId,
          meta: { ...pendingFirstInput.meta, source: 'ui', sentFrom: 'cli' },
        });
        if (result?.recoveryBlocked) {
          throw new Error(`Pending first input was blocked: ${result.recoveryBlocked.status}`);
        }
        committed = true;
        clearPendingFirstInputFromEnv(env);
      })();
      const tracked = attempt.finally(() => {
        if (inFlight === tracked) inFlight = null;
      });
      inFlight = tracked;
      return tracked;
    },
  });
}
