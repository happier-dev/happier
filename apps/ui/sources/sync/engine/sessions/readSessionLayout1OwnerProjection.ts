import { openSessionOwnerMetadataEnvelopeV1, openSessionOwnerMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { projectAdmittedSessionOwnerCompatibilityViewV1, validateSessionOwnerMetadataEnvelopeForAccountModeV1, type SessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { projectAccountEncryptionIdentity, sameAccountEncryptionIdentity } from '@happier-dev/sync-client';

import { isSessionAccessOwner, type NormalizedSessionAccessProjection } from './normalizeSessionAccessProjection';
import { ComposerOptionsInputV1Schema, projectComposerOptionsInputV1, type ComposerOptionsInputV1 } from '@happier-dev/protocol/embed';

import { isDataKeyAuthCredentials, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { MetadataSchema, type Metadata } from '@happier-dev/session-core/state';
import { resolveCurrentAccountScopedCryptoMaterialSnapshot } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { isSessionContentReadable, type SessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { readSessionMetadataLayoutVersion } from './parsePlainSessionPayload';
import { SESSION_OWNER_METADATA_PROJECTION, type SessionOwnerMetadataAuthority, type SessionOwnerMetadataProjection } from '@/sync/domains/session/readSessionOwnerMetadataView';

/** Full AgentState is owner-private in layout 1, including presentation commands. */
export function isSessionAgentStateVisible(params: Readonly<{
    metadataLayoutVersion?: unknown;
    access?: NormalizedSessionAccessProjection | null;
    accessLevel?: unknown;
    /** Established by the owner-envelope reader or its retained opened projection. */
    ownerMetadataAvailable: boolean;
    contentAvailability: SessionContentAvailability | null;
}>): boolean {
    const layout = readSessionMetadataLayoutVersion(params.metadataLayoutVersion);
    if (layout === 0) return true;
    return layout === 1
        && isSessionAccessOwner(params.access, params.accessLevel)
        && params.ownerMetadataAvailable
        && isSessionContentReadable(params.contentAvailability);
}

/** One safe outcome when the layout-1 owner view cannot be opened or projected. */
export function buildSessionOwnerMetadataUnavailableShell<T extends Readonly<{
    metadata: unknown;
    ownerMetadataView?: unknown;
    composerOptionsInput?: unknown;
    agentState: unknown;
    encryptedContentAvailability?: SessionContentAvailability | null;
    [SESSION_OWNER_METADATA_PROJECTION]?: unknown;
}>>(session: T): Omit<T, 'metadata' | 'ownerMetadataView' | 'composerOptionsInput' | 'agentState' | 'encryptedContentAvailability' | typeof SESSION_OWNER_METADATA_PROJECTION> & Readonly<{
    [SESSION_OWNER_METADATA_PROJECTION]: null;
    metadata: null;
    ownerMetadataView: null;
    composerOptionsInput: null;
    agentState: null;
    encryptedContentAvailability: 'encrypted_content_unavailable';
}> {
    const {
        metadata: _metadata,
        ownerMetadataView: _ownerMetadataView,
        composerOptionsInput: _composerOptionsInput,
        agentState: _agentState,
        encryptedContentAvailability: _contentAvailability,
        [SESSION_OWNER_METADATA_PROJECTION]: _ownerMetadataProjection,
        ...safeSession
    } = session;
    return {
        ...safeSession,
        [SESSION_OWNER_METADATA_PROJECTION]: null,
        metadata: null,
        ownerMetadataView: null,
        composerOptionsInput: null,
        agentState: null,
        encryptedContentAvailability: 'encrypted_content_unavailable',
    };
}

export type SessionLayout1OwnerProjection =
    | Readonly<{ kind: 'recipient' }>
    | Readonly<{ kind: 'composer'; ownerMetadataView: null; composerOptionsInput: ComposerOptionsInputV1 | null }>
    | Readonly<SessionOwnerMetadataProjection & {
        ownerMetadataView: Metadata;
        composerOptionsInput: ComposerOptionsInputV1;
      }>
    | Readonly<{
        kind: 'unavailable';
        reason:
            | 'access_unavailable'
            | 'invalid_envelope'
            | 'account_mode_mismatch'
            | 'account_currentness_unavailable'
            | 'material_unavailable'
            | 'invalid_ciphertext';
      }>;

export type SessionLayout1OwnerMetadataRead =
    | Readonly<{ kind: 'recipient' }>
    | Extract<SessionLayout1OwnerProjection, { kind: 'composer' }>
    | SessionOwnerMetadataProjection
    | Extract<SessionLayout1OwnerProjection, { kind: 'unavailable' }>;

/**
 * Owner-private identity/visibility that remains usable when the Session DEK is unavailable.
 *
 * `systemSessionV1` lives in the Account-encrypted owner envelope, not in Session-encrypted shared
 * metadata. An authenticated owner can therefore still classify a locked Session without making
 * the fact Home-readable or publishing it to recipients. Absence in a successfully opened strict
 * owner envelope proves this is not a hidden system Session. Its explicit name has the same
 * Account custody: displaying it does not require opening Session-encrypted shared content.
 * Other private workspace/runtime fields stay out of this locked projection.
 */
export function projectSessionLayout1LockedOwnerVisibility(
    ownerMetadataRead: SessionLayout1OwnerMetadataRead | null,
): Metadata | null {
    if (ownerMetadataRead?.kind !== 'owner') return null;
    const systemSessionV1 = ownerMetadataRead.ownerMetadata.system?.systemSessionV1;
    const name = ownerMetadataRead.ownerMetadata.workspace?.name;
    const parsed = MetadataSchema.safeParse(
        { ...(systemSessionV1 ? { systemSessionV1 } : {}), ...(name === undefined ? {} : { name }) },
    );
    return parsed.success ? parsed.data : null;
}

export function readSessionLayout1OwnerMetadata(params: Readonly<{
    access: NormalizedSessionAccessProjection | null;
    accountMode?: AccountEncryptionCurrentnessResponse['mode'];
    accountCurrentness?: AccountEncryptionCurrentnessResponse;
    /** The containing finite Account read has already bound this material to its identity. */
    readAccountMaterial?: () => AccountScopedCryptoMaterial | null;
    ownerMetadataEnvelope: unknown;
    credentials: AuthCredentials;
    composerOptionsInput?: ComposerOptionsInputV1 | null;
    previousProjection?: SessionOwnerMetadataProjection | null;
}>): SessionLayout1OwnerMetadataRead {
    if (!params.access) return { kind: 'unavailable', reason: 'access_unavailable' };
    if (params.composerOptionsInput !== undefined) {
        if (params.composerOptionsInput !== null) {
            const parsed = ComposerOptionsInputV1Schema.safeParse(params.composerOptionsInput);
            return parsed.success
                ? { kind: 'composer', ownerMetadataView: null, composerOptionsInput: parsed.data }
                : { kind: 'unavailable', reason: 'invalid_envelope' };
        }
        // Plain owner content may only be interpreted using persisted Account mode, never Session mode.
        if (params.accountMode !== 'plain' || params.access.role === 'recipient' || params.ownerMetadataEnvelope == null) {
            return { kind: 'composer', ownerMetadataView: null, composerOptionsInput: null };
        }
        const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: 'plain', envelope: params.ownerMetadataEnvelope, material: null });
        if (!opened.ok) return { kind: 'unavailable', reason: opened.reason };
        return { kind: 'composer', ownerMetadataView: null, composerOptionsInput: projectComposerOptionsInputV1(opened.ownerMetadata.runtime) };
    }
    if (params.access.role === 'recipient') {
        return { kind: 'recipient' };
    }
    if (params.ownerMetadataEnvelope === null || params.ownerMetadataEnvelope === undefined) {
        return { kind: 'unavailable', reason: 'invalid_envelope' };
    }
    if (!params.accountMode) {
        return {
            kind: 'unavailable',
            reason: 'account_currentness_unavailable',
        };
    }

    if (params.previousProjection?.canReuse?.(params)) return params.previousProjection;

    const validated = validateSessionOwnerMetadataEnvelopeForAccountModeV1({
        accountMode: params.accountMode,
        envelope: params.ownerMetadataEnvelope,
    });
    if (!validated.ok) {
        return { kind: 'unavailable', reason: validated.reason };
    }
    const material = validated.envelope.t === 'encrypted'
        ? (() => {
            try {
                if (params.readAccountMaterial) return params.readAccountMaterial();
                return params.accountCurrentness
                    ? resolveCurrentAccountScopedCryptoMaterialSnapshot({ credentials: params.credentials, accountCurrentness: params.accountCurrentness })?.material ?? null
                    : null;
            } catch {
                return null;
            }
        })()
        : null;
    if (validated.envelope.t === 'encrypted' && !material) {
        return { kind: 'unavailable', reason: 'material_unavailable' };
    }
    // The envelope and persisted mode were admitted above. Use the same canonical
    // ciphertext codec without sending that parsed envelope through the raw-input reader again.
    const ownerMetadata = validated.envelope.t === 'plain'
        ? validated.envelope.v
        : material ? openSessionOwnerMetadataV1({ material, ciphertext: validated.envelope.c }) : null;
    if (!ownerMetadata) return { kind: 'unavailable', reason: 'invalid_ciphertext' };
    // Plain inputs still pass the strict envelope/owner reader every time. Retain
    // equal admitted facts afterwards; encrypted ciphertext reuse remains separate.
    if (validated.envelope.t === 'plain' && params.previousProjection?.ownerMetadataEnvelope.t === 'plain'
        && params.previousProjection.isCurrentAuthority?.(params)
        && JSON.stringify(params.previousProjection.ownerMetadata) === JSON.stringify(ownerMetadata)) return params.previousProjection;
    const { credentials, accountMode } = params;
    const ciphertext = validated.envelope.t === 'encrypted' ? validated.envelope.c : null;
    const token = credentials.token;
    const secret = 'secret' in credentials ? credentials.secret : undefined;
    const machineKey = isDataKeyAuthCredentials(credentials) ? credentials.encryption.machineKey : undefined;
    const publicKey = isDataKeyAuthCredentials(credentials) ? credentials.encryption.publicKey : undefined;
    const accountEncryptionIdentity = params.accountCurrentness ? projectAccountEncryptionIdentity(params.accountCurrentness) : undefined;
    const matchesCredentials = (candidate: AuthCredentials) => candidate.token === token
        && ('secret' in candidate ? candidate.secret : undefined) === secret
        && (isDataKeyAuthCredentials(candidate) ? candidate.encryption.machineKey : undefined) === machineKey
        && (isDataKeyAuthCredentials(candidate) ? candidate.encryption.publicKey : undefined) === publicKey;
    const isCurrentAuthority = (next: SessionOwnerMetadataAuthority) => (next.accountMode ?? next.accountCurrentness?.mode) === accountMode
        && matchesCredentials(credentials) && matchesCredentials(next.credentials)
        && (accountEncryptionIdentity
            ? Boolean(next.accountCurrentness && sameAccountEncryptionIdentity(accountEncryptionIdentity, next.accountCurrentness))
            : next.accountCurrentness === undefined);
    return {
        kind: 'owner',
        ownerMetadataEnvelope: validated.envelope,
        ownerMetadata,
        isCurrentAuthority,
        accountEncryptionIdentity,
        ...(ciphertext === null ? {} : { canReuse: (next: Parameters<NonNullable<SessionOwnerMetadataProjection['canReuse']>>[0]) => {
            if (!isCurrentAuthority(next)) return false;
            const envelope = next.ownerMetadataEnvelope;
            // Identity comparison only: unknown extensions still take the canonical strict reader.
            return envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope)
                && Object.keys(envelope).length === 2
                && Object.keys(envelope).every(key => key === 't' || key === 'c')
                && 't' in envelope && envelope.t === 'encrypted'
                && 'c' in envelope && envelope.c === ciphertext;
        } }),
    };
}

function hasProjectedOwnerMetadata(read: SessionOwnerMetadataProjection): read is Extract<SessionLayout1OwnerProjection, { kind: 'owner' }> {
    return read.ownerMetadataView !== undefined && read.composerOptionsInput !== undefined;
}

export function projectSessionLayout1OwnerMetadata(params: Readonly<{
    sharedMetadata: SessionSharedMetadataV1;
    ownerMetadataRead: SessionLayout1OwnerMetadataRead;
    metadataVersion?: number;
}>): SessionLayout1OwnerProjection {
    if (params.ownerMetadataRead.kind !== 'owner') {
        return params.ownerMetadataRead;
    }
    const sharedMetadataSignature = JSON.stringify(params.sharedMetadata);
    // The existing owner read already admitted this envelope under current access,
    // mode and credentials. Reuse its full projection only for the same shared
    // content and tuple, not merely the presence of its Symbol.
    if (hasProjectedOwnerMetadata(params.ownerMetadataRead)
        && params.ownerMetadataRead.admittedMetadataVersion === params.metadataVersion
        && params.ownerMetadataRead.sharedMetadataSignature === sharedMetadataSignature) return params.ownerMetadataRead;
    const ownerMetadataView = MetadataSchema.safeParse(
        projectAdmittedSessionOwnerCompatibilityViewV1({
            sharedMetadata: params.sharedMetadata,
            ownerMetadata: params.ownerMetadataRead.ownerMetadata,
        }),
    );
    if (!ownerMetadataView.success) {
        return { kind: 'unavailable', reason: 'invalid_envelope' };
    }
    return {
        ...params.ownerMetadataRead,
        sharedMetadataSignature,
        admittedMetadataVersion: params.metadataVersion,
        ownerMetadataView: ownerMetadataView.data,
        composerOptionsInput: projectComposerOptionsInputV1(ownerMetadataView.data),
    };
}
