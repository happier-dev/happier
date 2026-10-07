import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { resolveStoredContentKindForSessionEncryptionMode } from '@happier-dev/protocol/encryption/storagePolicyDecisions';
import type { StrictJsonValue, StrictSessionStoredMessageContentEnvelope } from '@happier-dev/protocol';

const SessionStoredMessageContentReadSchema = createStoredReadSchema(StrictSessionStoredMessageContentEnvelopeSchema);

export type SessionContentEncryption = Readonly<{
  encryptRaw(payload: unknown): Promise<string>;
  decryptRaw(ciphertext: string): Promise<unknown | null>;
  deriveDiscussionMutationEqualityTagV1?(canonicalIntent: string): string;
}>;
export type SessionStoredContentContext =
  | Readonly<{ mode: 'plain' }>
  | Readonly<{ mode: 'e2ee'; encryption: SessionContentEncryption | null }>;
export type OpenSessionStoredContentResult =
  | Readonly<{ status: 'ready'; value: unknown }>
  | Readonly<{ status: 'locked' | 'mode_mismatch' | 'corrupt_or_unopenable' | 'malformed' }>;
export type ResolvedSessionStoredContentEnvelope =
  | Readonly<{ status: 'ready'; content: StrictSessionStoredMessageContentEnvelope }>
  | Readonly<{ status: 'locked' | 'mode_mismatch' | 'malformed' }>;

/** Shared outer decision for asynchronous clients and synchronous platform adapters. */
export function resolveSessionStoredContentEnvelope(
  context: Readonly<{ mode: 'plain' | 'e2ee' }> | null,
  input: unknown,
): ResolvedSessionStoredContentEnvelope {
  const parsed = SessionStoredMessageContentReadSchema.safeParse(input);
  if (!parsed.success) return { status: 'malformed' };
  if (!context) return { status: 'locked' };
  if (parsed.data.t !== resolveStoredContentKindForSessionEncryptionMode(context.mode)) return { status: 'mode_mismatch' };
  return { status: 'ready', content: parsed.data };
}
export async function openSessionStoredContent(context: SessionStoredContentContext | null, input: unknown): Promise<OpenSessionStoredContentResult> {
  const resolved = resolveSessionStoredContentEnvelope(context, input);
  if (resolved.status !== 'ready') return resolved;
  if (resolved.content.t === 'plain') return { status: 'ready', value: resolved.content.v };
  if (!context || context.mode !== 'e2ee' || !context.encryption) return { status: 'locked' };
  try {
    const value = await context.encryption.decryptRaw(resolved.content.c);
    return value === null || value === undefined ? { status: 'corrupt_or_unopenable' } : { status: 'ready', value };
  } catch { return { status: 'corrupt_or_unopenable' }; }
}
export type SealSessionStoredContentResult =
  | Readonly<{ status: 'ready'; content: StrictSessionStoredMessageContentEnvelope }>
  | Readonly<{ status: 'locked' }>;
export async function sealSessionStoredContent(context: SessionStoredContentContext | null, payload: StrictJsonValue): Promise<SealSessionStoredContentResult> {
  if (!context) return { status: 'locked' };
  if (context.mode === 'plain') return { status: 'ready', content: { t: 'plain', v: payload } };
  if (!context.encryption) return { status: 'locked' };
  return { status: 'ready', content: { t: 'encrypted', c: await context.encryption.encryptRaw(payload) } };
}

/** Session metadata/state fields use raw JSON strings in Plain mode, ciphertext in E2EE. */
export async function openSessionStateValue(context: SessionStoredContentContext, input: string | null): Promise<OpenSessionStoredContentResult> {
  if (input === null) return { status: 'ready', value: null };
  if (context.mode === 'e2ee') return openSessionStoredContent(context, { t: 'encrypted', c: input });
  try { return { status: 'ready', value: JSON.parse(input) }; }
  catch { return { status: 'corrupt_or_unopenable' }; }
}
