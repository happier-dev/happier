import {
    openSessionOwnerMetadataEnvelopeV1,
    projectSessionOwnerCompatibilityViewV1,
    validateSessionOwnerMetadataEnvelopeForAccountModeV1,
    type AccountEncryptionCurrentnessResponse,
    type SessionOwnerMetadataEnvelopeV1,
    type SessionOwnerMetadataV1,
    type SessionSharedMetadataV1,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { MetadataSchema, type Metadata } from '@/sync/domains/state/storageTypes';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';

export type SessionLayout1OwnerProjection =
    | Readonly<{ kind: 'recipient' }>
    | Readonly<{
        kind: 'owner';
        ownerMetadataEnvelope: SessionOwnerMetadataEnvelopeV1;
        ownerMetadata: SessionOwnerMetadataV1;
        ownerMetadataView: Metadata;
      }>
    | Readonly<{
        kind: 'unavailable';
        reason:
            | 'invalid_envelope'
            | 'account_mode_mismatch'
            | 'account_currentness_unavailable'
            | 'material_unavailable'
            | 'invalid_ciphertext';
      }>;

export type SessionLayout1OwnerMetadataRead =
    | Readonly<{ kind: 'recipient' }>
    | Readonly<{
        kind: 'owner';
        ownerMetadataEnvelope: SessionOwnerMetadataEnvelopeV1;
        ownerMetadata: SessionOwnerMetadataV1;
      }>
    | Extract<SessionLayout1OwnerProjection, { kind: 'unavailable' }>;

export function hasSessionShareRecipientAuthority(share: unknown): boolean {
    return share !== null && share !== undefined;
}

export function readSessionLayout1OwnerMetadata(params: Readonly<{
    share: unknown;
    accountMode?: AccountEncryptionCurrentnessResponse['mode'];
    ownerMetadataEnvelope: unknown;
    credentials: AuthCredentials;
}>): SessionLayout1OwnerMetadataRead {
    if (hasSessionShareRecipientAuthority(params.share)) {
        return { kind: 'recipient' };
    }
    if (params.ownerMetadataEnvelope === null || params.ownerMetadataEnvelope === undefined) {
        return { kind: 'recipient' };
    }
    if (!params.accountMode) {
        return {
            kind: 'unavailable',
            reason: 'account_currentness_unavailable',
        };
    }

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
                return resolveAccountScopedCryptoMaterialFromCredentials(params.credentials);
            } catch {
                return null;
            }
        })()
        : null;
    if (validated.envelope.t === 'encrypted' && !material) {
        return { kind: 'unavailable', reason: 'material_unavailable' };
    }
    const opened = openSessionOwnerMetadataEnvelopeV1({
        accountMode: params.accountMode,
        envelope: validated.envelope,
        material,
    });
    if (!opened.ok) {
        return { kind: 'unavailable', reason: opened.reason };
    }
    return {
        kind: 'owner',
        ownerMetadataEnvelope: validated.envelope,
        ownerMetadata: opened.ownerMetadata,
    };
}

export function projectSessionLayout1OwnerMetadata(params: Readonly<{
    sharedMetadata: SessionSharedMetadataV1;
    ownerMetadataRead: SessionLayout1OwnerMetadataRead;
}>): SessionLayout1OwnerProjection {
    if (params.ownerMetadataRead.kind !== 'owner') {
        return params.ownerMetadataRead;
    }
    const ownerMetadataView = MetadataSchema.safeParse(
        projectSessionOwnerCompatibilityViewV1({
            sharedMetadata: params.sharedMetadata,
            ownerMetadata: params.ownerMetadataRead.ownerMetadata,
        }),
    );
    if (!ownerMetadataView.success) {
        return { kind: 'unavailable', reason: 'invalid_envelope' };
    }
    return {
        kind: 'owner',
        ownerMetadataEnvelope: params.ownerMetadataRead.ownerMetadataEnvelope,
        ownerMetadata: params.ownerMetadataRead.ownerMetadata,
        ownerMetadataView: ownerMetadataView.data,
    };
}

export function readSessionLayout1OwnerProjection(params: Readonly<{
    share: unknown;
    accountMode?: AccountEncryptionCurrentnessResponse['mode'];
    sharedMetadata: SessionSharedMetadataV1;
    ownerMetadataEnvelope: unknown;
    credentials: AuthCredentials;
}>): SessionLayout1OwnerProjection {
    return projectSessionLayout1OwnerMetadata({
        sharedMetadata: params.sharedMetadata,
        ownerMetadataRead: readSessionLayout1OwnerMetadata(params),
    });
}
