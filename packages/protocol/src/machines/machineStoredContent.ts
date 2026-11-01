import { z } from 'zod';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { lazySchema } from '../lazySchema.js';

// Shared with 0.3: the existing key carrier distinguishes plain Machines from
// released legacy rows whose absent key means account-key encryption.
const MachinePlainStoredContentEnvelopeSchema = lazySchema(() => z.object({
  t: z.literal('plain'),
  v: z.json(),
}).strict());

function parsePlainEnvelope(value: string | Uint8Array): z.infer<typeof MachinePlainStoredContentEnvelopeSchema> | null {
  try {
    const bytes = typeof value === 'string' ? decodeBase64(value) : value;
    const parsed = MachinePlainStoredContentEnvelopeSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function encodePlainMachineStoredContent(value: unknown): string {
  let document: unknown;
  try {
    document = JSON.parse(JSON.stringify({ t: 'plain', v: value }));
  } catch {
    throw new Error('Invalid plaintext machine content');
  }
  const envelope = MachinePlainStoredContentEnvelopeSchema.safeParse(document);
  if (!envelope.success) throw new Error('Invalid plaintext machine content');
  return encodeBase64(new TextEncoder().encode(JSON.stringify(envelope.data)));
}

export const MACHINE_PLAIN_DATA_KEY_MARKER = encodePlainMachineStoredContent(null);

export function isPlainMachineDataKeyMarker(value: string | Uint8Array | null | undefined): boolean {
  return value !== null && value !== undefined && parsePlainEnvelope(value)?.v === null;
}

export function decodePlainMachineStoredContent(value: string): unknown {
  const envelope = parsePlainEnvelope(value);
  if (!envelope) throw new Error('Invalid plaintext machine content');
  return envelope.v;
}

function isPlainMachineStoredContent(value: string): boolean {
  return parsePlainEnvelope(value) !== null;
}

export function machineStoredContentMatchesAccountMode(params: Readonly<{
  mode: 'plain' | 'e2ee';
  metadata: string;
  daemonState?: string;
  dataEncryptionKey?: string | Uint8Array | null;
}>): boolean {
  const plain = isPlainMachineDataKeyMarker(params.dataEncryptionKey);
  if (params.mode === 'plain') {
    return plain && isPlainMachineStoredContent(params.metadata)
      && (params.daemonState === undefined || isPlainMachineStoredContent(params.daemonState));
  }
  return !plain && !isPlainMachineStoredContent(params.metadata)
    && (params.daemonState === undefined || !isPlainMachineStoredContent(params.daemonState));
}

/** A write follows the persisted row, including released encrypted history. */
export function machineUpdateMatchesStoredMode(params: Readonly<{
  dataEncryptionKey?: string | Uint8Array | null;
  metadata?: string;
  daemonState?: string;
}>): boolean {
  const plain = isPlainMachineDataKeyMarker(params.dataEncryptionKey);
  return (params.metadata === undefined || isPlainMachineStoredContent(params.metadata) === plain)
    && (params.daemonState === undefined || isPlainMachineStoredContent(params.daemonState) === plain);
}
