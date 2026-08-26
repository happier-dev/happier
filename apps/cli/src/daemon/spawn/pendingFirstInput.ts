import { buildSpawnedFirstTurnLocalId } from '@happier-dev/protocol';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import { buildAgentRuntimeFirstInputAdmissionV1 } from '@/session/services/sessionInputAdmissionIdentity';

export const HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY = 'HAPPIER_DAEMON_PENDING_FIRST_INPUT';

export type PendingFirstInput = Readonly<{
  text: string;
  localId: string;
}>;

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
  const spawnNonce = requireNonBlank(params.spawnNonce, 'spawn nonce');
  const localId = buildSpawnedFirstTurnLocalId(spawnNonce);
  if (!localId) {
    throw new Error('Pending first input spawn nonce must not be blank');
  }
  return Object.freeze({ text, localId });
}

export function serializePendingFirstInputForEnv(input: PendingFirstInput): string {
  return JSON.stringify({
    text: requireNonBlank(input.text, 'text'),
    localId: requireNonBlank(input.localId, 'localId'),
  });
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Pending first input handoff is malformed');
  }
  const value = parsed as Record<string, unknown>;
  return Object.freeze({
    text: requireNonBlank(value.text, 'text'),
    localId: requireNonBlank(value.localId, 'localId'),
  });
}

export function clearPendingFirstInputFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  delete env[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY];
}

export type PendingFirstInputCommitter = Readonly<{
  hasPendingInput: boolean;
  commit(session: Pick<ApiSessionClient, 'enqueueSessionUserMessage'>): Promise<void>;
}>;

export function createPendingFirstInputCommitter(
  params: Readonly<{ env?: NodeJS.ProcessEnv }> = {},
): PendingFirstInputCommitter {
  const env = params.env ?? process.env;
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
        await session.enqueueSessionUserMessage({
          text: pendingFirstInput.text,
          localId: pendingFirstInput.localId,
          meta: { source: 'ui', sentFrom: 'cli' },
          inputAdmission: buildAgentRuntimeFirstInputAdmissionV1(),
        });
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
