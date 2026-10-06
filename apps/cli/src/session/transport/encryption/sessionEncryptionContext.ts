import { deriveSessionMutationEqualityTagV1, SESSION_INPUT_EQUALITY_HKDF_LABEL_V1 } from '@happier-dev/protocol/sessions/mutations/sessionMutationEqualityV1';
import { ENCRYPTED_DATA_KEY_V1_BYTES } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeFormatV1';
import { openSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { projectSessionOwnerCompatibilityViewV1, SESSION_METADATA_LAYOUT_VERSION_V1, SessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { serializeSessionInputRequestEqualityIntentV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { PendingRequestedActionV1, AccountRecipientEnvelopeReadiness, SessionContentAvailabilityInputV1, SessionOwnerMetadataV1 } from '@happier-dev/protocol';
import type { Credentials, StoredCredentials } from '../../../persistence';
import type { SessionMessageContent } from '../../../api/types';
import {
  decodeBase64,
  decrypt,
  decryptResult,
  encodeBase64,
  encrypt,
} from '../../../api/encryption';
import { openSessionDataEncryptionKey } from '../../../api/client/openSessionDataEncryptionKey';
import { tryParseJsonRecord } from '../../../utils/tryParseJsonRecord';
import {
  readSessionMetadataLayoutVersion,
  tryReadSessionMetadataRecordForLayout,
} from '../../metadata/sessionMetadataLayout';
import {
  decryptSessionPayload,
  encryptSessionPayload,
  openSessionStoredContent,
  sealSessionStoredContent,
  SessionStoredContentError,
  type SessionEncryptionContext,
  type SessionStoredContentCryptoContext,
  type SessionStoredContentEncryptionMode,
} from './sessionStoredContentCodec';

export {
  decryptSessionPayload,
  encryptSessionPayload,
  openSessionStoredContent,
  sealSessionStoredContent,
  SessionStoredContentError,
};
export type {
  SessionEncryptionContext,
  SessionStoredContentCryptoContext,
  SessionStoredContentEncryptionMode,
};

type AccountEncryptionMode = 'e2ee' | 'plain';

// The transcript-facing name remains an alias of the one stored-content error
// owner while its callers migrate independently.
export { SessionStoredContentError as SessionMessageContentError };

/** Opens an already parsed envelope only under its established Session mode. */
export function openSessionMessageContent(
  params: SessionStoredContentCryptoContext & Readonly<{ content: SessionMessageContent }>,
): unknown {
  return openSessionStoredContent(params);
}

export type SessionTransportEncryptionMaterial =
  | Readonly<{ mode: 'plain' }>
  | Readonly<{ mode: 'e2ee'; dataEncryptionKey: Uint8Array }>;

export type ResolveSessionTransportContextFromMaterialResult =
  | (Readonly<{ ok: true }> & SessionStoredContentCryptoContext)
  | Readonly<{ ok: false; code: 'encryption_material_unavailable' }>;

type SessionEncryptionContextSource = Readonly<{
  encryptionMode?: unknown;
  dataEncryptionKey?: unknown;
  effectiveAccess?: unknown;
  share?: unknown;
  metadataLayoutVersion?: unknown;
}>;

type SessionMetadataSource = SessionEncryptionContextSource & Readonly<{
  metadata?: unknown;
  metadataLayoutVersion?: unknown;
  ownerMetadata?: unknown;
}>;

export type SessionPresentationContent = Readonly<{
  metadata: Record<string, unknown> | null;
  content: SessionContentAvailabilityInputV1;
}>;

export type SessionPresentationContentInput = Readonly<{
  credentials: StoredCredentials;
  accountEncryptionMode: AccountEncryptionMode;
  recipientEnvelopeReadiness?: AccountRecipientEnvelopeReadiness;
  rawSession: SessionMetadataSource;
}>;

type SessionEncryptionContextResolution =
  | Readonly<{ ctx: SessionEncryptionContext }>
  | Readonly<{ ctx: null; failure: 'missing_envelope' | 'unopenable_envelope' | 'unknown' }>;

export function resolveSessionStoredContentEncryptionMode(rawSession?: Readonly<{ encryptionMode?: unknown }>): SessionStoredContentEncryptionMode {
  if (rawSession && Object.prototype.hasOwnProperty.call(rawSession, 'encryptionMode')
    && rawSession.encryptionMode !== undefined
    && rawSession.encryptionMode !== 'plain'
    && rawSession.encryptionMode !== 'e2ee') {
    throw new SessionStoredContentError('session_content_mode_mismatch');
  }
  return rawSession?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
}

function createSessionDataKeyEncryptionContext(dataEncryptionKey: Uint8Array): SessionEncryptionContext | null {
  if (!(dataEncryptionKey instanceof Uint8Array) || dataEncryptionKey.length !== ENCRYPTED_DATA_KEY_V1_BYTES) return null;
  return { encryptionKey: new Uint8Array(dataEncryptionKey), encryptionVariant: 'dataKey' };
}

/**
 * Material only: the caller owns authenticated fetch/admission and the returned
 * context's lifetime. Possession of this key supplies no resource authority.
 * No Account credentials, owner-private metadata, currentness or cache is used.
 */
export function resolveSessionTransportContextFromMaterial(params: Readonly<{
  rawSession: Readonly<{ encryptionMode?: unknown }>;
  material: SessionTransportEncryptionMaterial;
}>): ResolveSessionTransportContextFromMaterialResult {
  const failure = { ok: false, code: 'encryption_material_unavailable' } as const;
  let mode: SessionStoredContentEncryptionMode;
  try {
    mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  } catch (error) {
    if (error instanceof SessionStoredContentError) return failure;
    throw error;
  }
  if (params.material.mode !== mode) return failure;
  if (params.material.mode === 'plain') {
    if ('dataEncryptionKey' in params.material) return failure;
    return { ok: true, mode: 'plain', ctx: null };
  }
  const ctx = createSessionDataKeyEncryptionContext(params.material.dataEncryptionKey);
  return ctx ? { ok: true, mode: 'e2ee', ctx } : failure;
}

/**
 * The one stored-content decision for an Action serving an exact Session.
 *
 * Two routes reach the same answer and must not drift apart. A composition that
 * already holds this exact Session's material — a Runner, whose Session-scoped
 * runtime principal carries no Account encryption material at all — supplies it
 * and that material decides. Every other caller keeps the released
 * Account-credential resolution. `null` is the fail-closed answer for both; a
 * missing or mode-mismatched key never degrades to plaintext.
 */
export function resolveExactSessionOrCredentialCryptoContext(
  options: Readonly<{
    credentials: StoredCredentials;
    resolveExactSessionEncryptionMaterial?: (sessionId: string) => SessionTransportEncryptionMaterial | null;
  }>,
  sessionId: string,
  rawSession: SessionEncryptionContextSource | undefined,
): SessionStoredContentCryptoContext | null {
  const material = options.resolveExactSessionEncryptionMaterial?.(sessionId) ?? null;
  if (material) {
    const resolved = resolveSessionTransportContextFromMaterial({ rawSession: rawSession ?? {}, material });
    if (!resolved.ok) return null;
    return resolved.mode === 'e2ee' ? { mode: 'e2ee', ctx: resolved.ctx } : { mode: 'plain', ctx: null };
  }
  let mode: SessionStoredContentEncryptionMode;
  try {
    mode = resolveSessionStoredContentEncryptionMode(rawSession ?? {});
  } catch (error) {
    if (error instanceof SessionStoredContentError) return null;
    throw error;
  }
  const ctx = mode === 'e2ee' ? resolveSessionEncryptionContextFromCredentials(options.credentials, rawSession) : null;
  if (mode === 'e2ee' && !ctx) return null;
  return ctx ? { mode: 'e2ee', ctx } : { mode: 'plain', ctx: null };
}

export function resolveSessionEncryptionContextFromCredentials(
  credentials: Credentials,
): SessionEncryptionContext;
export function resolveSessionEncryptionContextFromCredentials(
  credentials: StoredCredentials,
  rawSession?: SessionEncryptionContextSource,
): SessionEncryptionContext | null;
export function resolveSessionEncryptionContextFromCredentials(
  credentials: StoredCredentials,
  rawSession?: SessionEncryptionContextSource,
): SessionEncryptionContext | null {
  return resolveSessionEncryptionContext(credentials, rawSession).ctx;
}

function resolveSessionEncryptionContext(
  credentials: StoredCredentials,
  rawSession?: SessionEncryptionContextSource,
): SessionEncryptionContextResolution {
  const published = rawSession?.dataEncryptionKey;
  if (published !== null && published !== undefined) {
    if (!credentials.encryption) return { ctx: null, failure: 'unknown' };
    const opened = openSessionDataEncryptionKey({
      credential: credentials,
      encryptedDataEncryptionKeyBase64: published,
    });
    const ctx = opened ? createSessionDataKeyEncryptionContext(opened) : null;
    return ctx
      ? { ctx }
      : { ctx: null, failure: 'unopenable_envelope' };
  }

  // Current access is authoritative. Only a valid owner projection or the
  // released owner marker may use historical Account-key material.
  const accessRole = readSessionAccessProjectionRoleV1(rawSession ?? {});
  if (accessRole === 'unavailable') return { ctx: null, failure: 'unknown' };
  if (accessRole === 'recipient') {
    return { ctx: null, failure: 'missing_envelope' };
  }

  if (!credentials.encryption) return { ctx: null, failure: 'unknown' };

  // Retain the cli-v0.2.11 owner-only absent-envelope readers. These Account
  // keys are historical content material, never transferable Session DEKs.
  return { ctx: credentials.encryption.type === 'legacy'
    ? { encryptionKey: credentials.encryption.secret, encryptionVariant: 'legacy' }
    : { encryptionKey: credentials.encryption.machineKey, encryptionVariant: 'dataKey' } };
}

export function tryDecryptSessionMetadata(params: Readonly<{
  credentials: StoredCredentials;
  rawSession: SessionMetadataSource;
}>): Record<string, unknown> | null {
  return readSessionMetadataContent(params).metadata;
}

function readSessionMetadataContent(params: Readonly<{
  credentials: StoredCredentials;
  recipientEnvelopeReadiness?: AccountRecipientEnvelopeReadiness;
  rawSession: SessionMetadataSource;
}>): SessionPresentationContent {
  const encodedMetadata =
    typeof params.rawSession.metadata === 'string' ? String(params.rawSession.metadata).trim() : '';
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  if (mode === 'plain') {
    return {
      metadata: tryReadSessionMetadataRecordForLayout(
        tryParseJsonRecord(encodedMetadata),
        params.rawSession.metadataLayoutVersion,
      ),
      content: { mode },
    };
  }

  const resolved = resolveSessionEncryptionContext(
    params.credentials,
    params.rawSession,
  );
  if (!resolved.ctx) {
    const readiness = params.recipientEnvelopeReadiness;
    let keyState: Extract<SessionContentAvailabilityInputV1, { mode: 'e2ee' }>['keyState'] = 'unknown';
    if (resolved.failure === 'unopenable_envelope') {
      keyState = 'inconsistent';
    } else if (resolved.failure === 'missing_envelope') {
      if (readiness?.status === 'available') keyState = 'access_pending';
      else if (readiness?.status === 'unavailable') {
        if (readiness.reason === 'encryption_inconsistent') keyState = 'inconsistent';
        else if (readiness.reason === 'plain_account' || readiness.reason === 'encryption_setup_required') keyState = 'setup_required';
      }
    }
    return { metadata: null, content: { mode, keyState } };
  }

  const unknown: SessionPresentationContent = { metadata: null, content: { mode, keyState: 'unknown' } };
  if (!encodedMetadata) return unknown;

  try {
    const decrypted = decryptResult(
      resolved.ctx.encryptionKey,
      resolved.ctx.encryptionVariant,
      decodeBase64(encodedMetadata, 'base64'),
    );
    if (decrypted.status === 'authentication_failed') {
      return { metadata: null, content: { mode, keyState: 'content_unavailable' } };
    }
    if (decrypted.status !== 'authenticated') return unknown;
    const metadata = tryReadSessionMetadataRecordForLayout(
      decrypted.value,
      params.rawSession.metadataLayoutVersion,
    );
    return metadata ? { metadata, content: { mode, keyState: 'opened' } } : unknown;
  } catch {
    return unknown;
  }
}

export function tryDecryptSessionOwnerMetadata(params: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionMode: 'plain' | 'e2ee';
  rawSession: Readonly<{
    metadataLayoutVersion?: unknown;
    ownerMetadata?: unknown;
  }>;
}>): SessionOwnerMetadataV1 | null {
  if (params.rawSession.metadataLayoutVersion !== 1) return null;
  const material = !params.credentials.encryption
    ? null
    : params.credentials.encryption.type === 'legacy'
      ? {
          type: 'legacy' as const,
          secret: params.credentials.encryption.secret,
        }
      : {
          type: 'dataKey' as const,
          machineKey: params.credentials.encryption.machineKey,
        };
  const opened = openSessionOwnerMetadataEnvelopeV1({
    accountMode: params.accountEncryptionMode,
    envelope: params.rawSession.ownerMetadata,
    material,
  });
  return opened.ok ? opened.ownerMetadata : null;
}

export function tryDecryptSessionOwnerMetadataView(params: SessionPresentationContentInput): Record<string, unknown> | null {
  return projectSessionOwnerMetadataView(params, tryDecryptSessionMetadata(params));
}

function projectSessionOwnerMetadataView(
  params: SessionPresentationContentInput,
  sharedOrLegacyMetadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!sharedOrLegacyMetadata) return null;

  const metadataLayoutVersion = readSessionMetadataLayoutVersion(
    params.rawSession.metadataLayoutVersion,
  );
  if (metadataLayoutVersion === 0) return sharedOrLegacyMetadata;
  if (metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1) return null;

  const sharedMetadata = SessionSharedMetadataV1Schema.safeParse(
    sharedOrLegacyMetadata,
  );
  const ownerMetadata = tryDecryptSessionOwnerMetadata(params);
  if (!sharedMetadata.success || !ownerMetadata) return null;

  return projectSessionOwnerCompatibilityViewV1({
    sharedMetadata: sharedMetadata.data,
    ownerMetadata,
  });
}

export function readSessionPresentationContent(params: SessionPresentationContentInput): SessionPresentationContent {
  const result = readSessionMetadataContent(params);
  return {
    ...result,
    // Owner-private metadata is independent Account content. Its absence or
    // failure cannot invalidate successfully authenticated shared metadata.
    metadata: projectSessionOwnerMetadataView(params, result.metadata) ?? result.metadata,
  };
}

/** Opens shared Session presentation metadata from already-authorized material. */
export function readSessionPresentationContentFromMaterial(params: Readonly<{
  rawSession: SessionMetadataSource;
  material: SessionTransportEncryptionMaterial;
}>): SessionPresentationContent {
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  if (mode === 'plain') {
    const encodedMetadata = typeof params.rawSession.metadata === 'string' ? params.rawSession.metadata.trim() : '';
    return {
      metadata: tryReadSessionMetadataRecordForLayout(
        tryParseJsonRecord(encodedMetadata),
        params.rawSession.metadataLayoutVersion,
      ),
      content: { mode: 'plain' },
    };
  }
  const resolved = resolveSessionTransportContextFromMaterial({ rawSession: params.rawSession, material: params.material });
  if (!resolved.ok || resolved.mode !== 'e2ee') {
    return { metadata: null, content: { mode: 'e2ee', keyState: 'unknown' } };
  }
  const encodedMetadata = typeof params.rawSession.metadata === 'string' ? params.rawSession.metadata.trim() : '';
  if (!encodedMetadata) return { metadata: null, content: { mode: 'e2ee', keyState: 'unknown' } };
  try {
    const decrypted = decryptResult(
      resolved.ctx.encryptionKey,
      resolved.ctx.encryptionVariant,
      decodeBase64(encodedMetadata, 'base64'),
    );
    if (decrypted.status === 'authentication_failed') {
      return { metadata: null, content: { mode: 'e2ee', keyState: 'content_unavailable' } };
    }
    if (decrypted.status !== 'authenticated') {
      return { metadata: null, content: { mode: 'e2ee', keyState: 'unknown' } };
    }
    const metadata = tryReadSessionMetadataRecordForLayout(decrypted.value, params.rawSession.metadataLayoutVersion);
    return metadata
      ? { metadata, content: { mode: 'e2ee', keyState: 'opened' } }
      : { metadata: null, content: { mode: 'e2ee', keyState: 'unknown' } };
  } catch {
    return { metadata: null, content: { mode: 'e2ee', keyState: 'unknown' } };
  }
}

export function tryDecryptSessionPresentationMetadataView(params: SessionPresentationContentInput): Record<string, unknown> | null {
  return readSessionPresentationContent(params).metadata;
}

export function encryptStoredSessionPayload(
  params: SessionStoredContentCryptoContext & Readonly<{ payload: unknown }>,
): string {
  if (params.mode === 'plain') {
    return JSON.stringify(params.payload);
  }
  return encodeBase64(encrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, params.payload), 'base64');
}

export function decryptStoredSessionPayload(
  params: SessionStoredContentCryptoContext & Readonly<{ value: string }>,
): unknown {
  const raw = params.value.trim();
  if (params.mode === 'plain') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return decrypt(
    params.ctx.encryptionKey,
    params.ctx.encryptionVariant,
    decodeBase64(raw, 'base64'),
  );
}

/**
 * Derives the server-opaque equality fact used only to reconcile an E2EE
 * Session input after its randomized request ciphertext has been replaced.
 *
 * The derivation itself belongs to the shared Protocol Session-mutation
 * equality primitive, which the UI owner consumes through the same purpose
 * label; this remains the CLI-side convenience that knows the Session cipher.
 */
export function deriveSessionInputEqualityTagV1(params: Readonly<{
  ctx: SessionEncryptionContext;
  sessionId: string;
  requestEnvelope: unknown;
  requestedAction: PendingRequestedActionV1;
}>): string {
  return deriveSessionMutationEqualityTagV1({
    keyMaterial: params.ctx.encryptionKey,
    sessionId: params.sessionId,
    purpose: SESSION_INPUT_EQUALITY_HKDF_LABEL_V1,
    canonicalIntent: serializeSessionInputRequestEqualityIntentV1({
      requestEnvelope: params.requestEnvelope,
      requestedAction: params.requestedAction,
    }),
  });
}
