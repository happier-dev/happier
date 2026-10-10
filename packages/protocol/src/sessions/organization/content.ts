import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';

import { SessionOrganizationContentEnvelopeSchema, type SessionOrganizationContentEnvelope } from './contentSchemas.js';
export {
  SessionOrganizationContentEnvelopeSchema,
  SessionOrganizationContentEnvelopeStoredSchema,
  SessionOrganizationDisplayStateSchema,
  type SessionOrganizationContentEnvelope,
  type SessionOrganizationDisplayState,
} from './contentSchemas.js';

export class SessionOrganizationContentUnavailableError extends Error {
  readonly code = 'account_key_unavailable';
  constructor() { super('account_key_unavailable'); }
}

/** Shared display owner; hosts resolve persisted Account mode and key custody. */
export function prepareSessionOrganizationDisplayEnvelopeForAccountModeV1(params: Readonly<{
  envelope: SessionOrganizationContentEnvelope | null | undefined;
  accountMode: 'plain' | 'e2ee';
  material?: AccountScopedCryptoMaterial | null;
  randomBytes: (length: number) => Uint8Array;
}>): SessionOrganizationContentEnvelope | null {
  if (!params.envelope) return null;
  if (params.envelope.t === 'encrypted' || params.accountMode === 'plain') return params.envelope;
  if (!params.material) throw new SessionOrganizationContentUnavailableError();
  return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'session_organization_display',
    material: params.material, payload: params.envelope.v, randomBytes: params.randomBytes }) };
}

export function openSessionOrganizationDisplayEnvelopeV1(params: Readonly<{
  envelope: SessionOrganizationContentEnvelope | null | undefined;
  material?: AccountScopedCryptoMaterial | null;
}>): Readonly<{ status: 'available'; value: unknown | null } | {
  status: 'locked'; reason: 'account_key_unavailable' | 'content_unreadable';
}> {
  if (!params.envelope) return { status: 'available', value: null };
  if (params.envelope.t === 'plain') return { status: 'available', value: params.envelope.v };
  if (!params.material) return { status: 'locked', reason: 'account_key_unavailable' };
  const opened = openAccountScopedBlobCiphertext({ kind: 'session_organization_display',
    material: params.material, ciphertext: params.envelope.c });
  return opened ? { status: 'available', value: opened.value }
    : { status: 'locked', reason: 'content_unreadable' };
}

/** Action responses may disclose opened labels, never local key material. */
export function projectSessionOrganizationDisplayEnvelopeForReadV1(params: Parameters<typeof openSessionOrganizationDisplayEnvelopeV1>[0]): SessionOrganizationContentEnvelope | null {
  const opened = openSessionOrganizationDisplayEnvelopeV1(params);
  if (!params.envelope || opened.status !== 'available') return params.envelope ?? null;
  return SessionOrganizationContentEnvelopeSchema.parse({ t: 'plain', v: opened.value });
}
