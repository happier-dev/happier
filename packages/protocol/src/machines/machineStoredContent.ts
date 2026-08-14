import { z } from 'zod';

import { decodeBase64, encodeBase64 } from '../crypto/base64.js';

const MachinePlainStoredContentEnvelopeSchema = z.object({
  t: z.literal('plain'),
  v: z.json(),
}).strict();

function encodeMachinePlainEnvelope(value: unknown): string {
  let envelope: ReturnType<typeof MachinePlainStoredContentEnvelopeSchema.safeParse>;
  try {
    envelope = MachinePlainStoredContentEnvelopeSchema.safeParse(
      JSON.parse(JSON.stringify({ t: 'plain', v: value })),
    );
  } catch {
    throw new Error('Invalid plaintext machine content');
  }
  if (!envelope.success) {
    throw new Error('Invalid plaintext machine content');
  }
  return encodeBase64(
    new TextEncoder().encode(JSON.stringify(envelope.data)),
    'base64',
  );
}

function parseMachinePlainEnvelopeBytes(value: Uint8Array): z.infer<
  typeof MachinePlainStoredContentEnvelopeSchema
> | null {
  try {
    const parsed = MachinePlainStoredContentEnvelopeSchema.safeParse(
      JSON.parse(new TextDecoder().decode(value)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseEncodedMachinePlainEnvelope(value: string): z.infer<
  typeof MachinePlainStoredContentEnvelopeSchema
> | null {
  try {
    return parseMachinePlainEnvelopeBytes(decodeBase64(value, 'base64'));
  } catch {
    return null;
  }
}

export const MACHINE_PLAIN_DATA_KEY_MARKER = encodeMachinePlainEnvelope(null);

export function isPlainMachineDataKeyMarker(
  value: string | Uint8Array | null | undefined,
): boolean {
  const envelope = typeof value === 'string'
    ? parseEncodedMachinePlainEnvelope(value)
    : value instanceof Uint8Array
      ? parseMachinePlainEnvelopeBytes(value)
      : null;
  return envelope?.v === null;
}

export function encodePlainMachineStoredContent(value: unknown): string {
  return encodeMachinePlainEnvelope(value);
}

function isPlainMachineStoredContent(value: unknown): boolean {
  return typeof value === 'string' && parseEncodedMachinePlainEnvelope(value) !== null;
}

export function decodePlainMachineStoredContent(value: string): unknown {
  const envelope = parseEncodedMachinePlainEnvelope(value);
  if (!envelope) {
    throw new Error('Invalid plaintext machine content');
  }
  return envelope.v;
}

export function machineStoredContentMatchesAccountMode(params: Readonly<{
  mode: 'plain' | 'e2ee';
  metadata: string;
  daemonState?: string;
  dataEncryptionKey?: string | Uint8Array | null;
}>): boolean {
  const hasPlainMarker = isPlainMachineDataKeyMarker(params.dataEncryptionKey);
  if (params.mode === 'plain') {
    return (
      hasPlainMarker
      && isPlainMachineStoredContent(params.metadata)
      && (
        params.daemonState === undefined
        || isPlainMachineStoredContent(params.daemonState)
      )
    );
  }
  return (
    !hasPlainMarker
    && !isPlainMachineStoredContent(params.metadata)
    && (
      params.daemonState === undefined
      || !isPlainMachineStoredContent(params.daemonState)
    )
  );
}

export function machineUpdateMatchesStoredMode(params: Readonly<{
  dataEncryptionKey?: string | Uint8Array | null;
  metadata?: string;
  daemonState?: string;
}>): boolean {
  const plain = isPlainMachineDataKeyMarker(params.dataEncryptionKey);
  if (plain) {
    return (
      (params.metadata === undefined || isPlainMachineStoredContent(params.metadata))
      && (params.daemonState === undefined || isPlainMachineStoredContent(params.daemonState))
    );
  }
  return (
    (params.metadata === undefined || !isPlainMachineStoredContent(params.metadata))
    && (params.daemonState === undefined || !isPlainMachineStoredContent(params.daemonState))
  );
}
