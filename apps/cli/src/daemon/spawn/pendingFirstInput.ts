import { createHash } from 'node:crypto';
import {
  PendingFirstInputV1Schema,
  type PendingFirstInputV1,
} from '@happier-dev/protocol';

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
