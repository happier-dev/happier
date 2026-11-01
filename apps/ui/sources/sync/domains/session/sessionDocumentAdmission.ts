import type { AccountEncryptionIdentity } from '@happier-dev/sync-client';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { isSessionContentReadable, readSessionContentAvailability, type SessionContentAvailabilitySubject } from './encryptedContentAvailability';
import { SESSION_OWNER_METADATA_PROJECTION, type SessionOwnerMetadataProjection } from './readSessionOwnerMetadataView';
import { compareSessionMetadataRevisions, readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';

/** Memory-only custody of decrypted Session/display documents. Never serialized as authority. */
export const SESSION_LIST_DOCUMENT_ADMISSION = Symbol('sessionListDocumentAdmission');

export type SessionListDocumentAdmission = Readonly<{
    scope: string;
    encryptionMode: 'plain' | 'e2ee';
    metadataLayoutVersion: number;
    dataEncryptionKey: string | null;
    metadataAudience: 'owner' | 'shared';
    /** Actual opened display revision, never the compact list's observed descriptor. */
    openedMetadataVersion?: number;
    openedAgentStateVersion?: number;
    observedMetadataVersion?: number;
    observedMetadataLayoutVersion?: number;
    observedAgentStateVersion?: number;
}>;

const DISPLAY_ADMISSION_FINGERPRINT = Symbol('displayAdmissionFingerprint');
type FingerprintedAdmission = SessionListDocumentAdmission & { [DISPLAY_ADMISSION_FINGERPRINT]?: string };
type DisplayMetadata = Readonly<{
    metadata: unknown;
    metadataVersion: number;
    metadataLayoutVersion?: number;
    [SESSION_LIST_DOCUMENT_ADMISSION]?: SessionListDocumentAdmission;
    [SESSION_OWNER_METADATA_PROJECTION]?: SessionOwnerMetadataProjection | null;
}> & SessionContentAvailabilitySubject;

function isOpenedOwnerMetadataCurrent(value: DisplayMetadata, admission: SessionListDocumentAdmission): boolean {
    if (admission.metadataLayoutVersion !== 1 || admission.metadataAudience !== 'owner') return true;
    const owner = value[SESSION_OWNER_METADATA_PROJECTION];
    return !!owner?.ownerMetadataView && owner.admittedMetadataVersion === value.metadataVersion;
}

/** A current display does not establish full Session or owner-control readiness. */
export function hasCurrentSessionListDisplayMetadata(value: DisplayMetadata): boolean {
    const admission = value[SESSION_LIST_DOCUMENT_ADMISSION];
    const owner = value[SESSION_OWNER_METADATA_PROJECTION];
    return !!admission && value.metadata != null
        && isSessionContentReadable(readSessionContentAvailability(value))
        && admission.encryptionMode === value.encryptionMode
        && admission.metadataLayoutVersion === readSessionMetadataLayoutVersion(value.metadataLayoutVersion)
        && admission.openedMetadataVersion === value.metadataVersion
        && (owner == null || isOpenedOwnerMetadataCurrent(value, admission));
}

function withOpenedSessionListDisplayVersion(
    admission: SessionListDocumentAdmission, openedMetadataVersion: number,
): SessionListDocumentAdmission {
    const opened: FingerprintedAdmission = { ...admission, openedMetadataVersion };
    // The fingerprint is derived once per admitted document, not per unchanged cache save.
    // Non-enumerability prevents copying it onto a changed scope/key/audience by object spread.
    Object.defineProperty(opened, DISPLAY_ADMISSION_FINGERPRINT, { value: fingerprintSessionListDisplayAdmission(admission) });
    return Object.freeze(opened);
}

/** Issued only after all audience-required sidecar leaves were successfully opened. */
export function admitOpenedSessionListDisplayProjection(
    admission: SessionListDocumentAdmission, sourceMetadataVersion: number,
): SessionListDocumentAdmission {
    return withOpenedSessionListDisplayVersion(admission, sourceMetadataVersion);
}

/** Called only after the warm-cache owner has matched its persisted proof to fresh admission. */
export function restoreSessionListCachedDisplayAdmission(
    admission: SessionListDocumentAdmission, openedMetadataVersion: number,
): SessionListDocumentAdmission {
    return withOpenedSessionListDisplayVersion(admission, openedMetadataVersion);
}

/** Issued only after the canonical state opener reports success, including a real null clear. */
export function admitOpenedSessionListAgentState(admission: SessionListDocumentAdmission, openedAgentStateVersion: number): SessionListDocumentAdmission {
    const opened = { ...admission, openedAgentStateVersion,
        observedAgentStateVersion: Math.max(admission.observedAgentStateVersion ?? openedAgentStateVersion, openedAgentStateVersion) };
    return admission.openedMetadataVersion === undefined ? Object.freeze(opened)
        : restoreSessionListCachedDisplayAdmission(opened, admission.openedMetadataVersion);
}

/** Observed descriptors are demand, not proof that either document was opened. */
export function mergeSessionListDocumentObservations(admission: SessionListDocumentAdmission,
    previous: SessionListDocumentAdmission | undefined): SessionListDocumentAdmission {
    if (!previous || !areSessionListDocumentAdmissionsEqual(previous, admission)) return admission;
    const usePreviousMetadata = compareSessionMetadataRevisions({
        incomingLayoutVersion: previous.observedMetadataLayoutVersion ?? previous.metadataLayoutVersion,
        incomingMetadataVersion: previous.observedMetadataVersion,
        storedLayoutVersion: admission.observedMetadataLayoutVersion ?? admission.metadataLayoutVersion,
        storedMetadataVersion: admission.observedMetadataVersion,
    }) > 0;
    const observedMetadataVersion = usePreviousMetadata ? previous.observedMetadataVersion : admission.observedMetadataVersion;
    const observedMetadataLayoutVersion = usePreviousMetadata
        ? previous.observedMetadataLayoutVersion : admission.observedMetadataLayoutVersion;
    const observedAgentStateVersion = Math.max(previous.observedAgentStateVersion ?? 0, admission.observedAgentStateVersion ?? 0);
    if (observedMetadataVersion === admission.observedMetadataVersion
        && observedMetadataLayoutVersion === admission.observedMetadataLayoutVersion
        && observedAgentStateVersion === admission.observedAgentStateVersion) return admission;
    const merged = { ...admission, observedMetadataVersion, observedMetadataLayoutVersion, observedAgentStateVersion };
    return admission.openedMetadataVersion === undefined ? Object.freeze(merged)
        : restoreSessionListCachedDisplayAdmission(merged, admission.openedMetadataVersion);
}

export function observeSessionListDocumentVersions(admission: SessionListDocumentAdmission | undefined,
    descriptor: Readonly<{ metadataVersion?: number; metadataLayoutVersion?: number; agentStateVersion?: number }>): SessionListDocumentAdmission | undefined {
    if (!admission) return undefined;
    return mergeSessionListDocumentObservations(admission, { ...admission,
        observedMetadataVersion: descriptor.metadataVersion ?? admission.observedMetadataVersion,
        observedMetadataLayoutVersion: descriptor.metadataVersion === undefined ? admission.observedMetadataLayoutVersion
            : descriptor.metadataLayoutVersion ?? admission.metadataLayoutVersion,
        observedAgentStateVersion: descriptor.agentStateVersion ?? admission.observedAgentStateVersion });
}

/** Layout transitions can reset the numeric revision; neither observation opens a document. */
export function hasNewerObservedSessionMetadata(value: Readonly<{
    metadataVersion?: number; metadataLayoutVersion?: number;
    [SESSION_LIST_DOCUMENT_ADMISSION]?: SessionListDocumentAdmission;
}>): boolean {
    const admission = value[SESSION_LIST_DOCUMENT_ADMISSION];
    return !!admission && compareSessionMetadataRevisions({
        incomingLayoutVersion: admission.observedMetadataLayoutVersion ?? admission.metadataLayoutVersion,
        incomingMetadataVersion: admission.observedMetadataVersion,
        storedLayoutVersion: value.metadataLayoutVersion,
        storedMetadataVersion: value.metadataVersion,
    }) > 0;
}

/** Only a successful readable open can issue actual display-version custody. */
export function admitOpenedSessionListDisplayMetadata(
    admission: SessionListDocumentAdmission, value: DisplayMetadata,
): SessionListDocumentAdmission {
    return value.metadata != null && isSessionContentReadable(readSessionContentAvailability(value))
        && admission.encryptionMode === value.encryptionMode
        && admission.metadataLayoutVersion === readSessionMetadataLayoutVersion(value.metadataLayoutVersion)
        && isOpenedOwnerMetadataCurrent(value, admission)
        ? withOpenedSessionListDisplayVersion(admission, value.metadataVersion) : admission;
}

export function resolveSessionListDocumentAdmissionScope(serverId: string | null | undefined, credentials: AuthCredentials,
    accountCurrentness: AccountEncryptionIdentity | undefined): string {
    return JSON.stringify([serverId ?? null, resolveAuthCredentialsScopeKey(credentials),
        accountCurrentness?.mode ?? null, accountCurrentness?.signingKeyFingerprint ?? null,
        accountCurrentness?.contentKeyFingerprint ?? null, accountCurrentness?.updatedAt ?? null]);
}

/** Nonsecret comparison material for a device-local display derivation, never document authority. */
export function fingerprintSessionListDisplayAdmission(admission: SessionListDocumentAdmission): string {
    const fingerprint = (admission as FingerprintedAdmission)[DISPLAY_ADMISSION_FINGERPRINT];
    if (fingerprint) return fingerprint;
    return bytesToHex(sha256(utf8ToBytes(JSON.stringify([admission.scope, admission.encryptionMode,
        admission.metadataLayoutVersion, admission.dataEncryptionKey, admission.metadataAudience]))));
}

export function areSessionListDocumentAdmissionsEqual(
    a: SessionListDocumentAdmission | undefined,
    b: SessionListDocumentAdmission | undefined,
): boolean {
    return a === b || (!!a && !!b && a.scope === b.scope && a.encryptionMode === b.encryptionMode
        && a.metadataLayoutVersion === b.metadataLayoutVersion && a.dataEncryptionKey === b.dataEncryptionKey
        && a.metadataAudience === b.metadataAudience);
}
