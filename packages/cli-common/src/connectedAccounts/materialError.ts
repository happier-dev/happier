/** Closed owner-issued causes; no credential, Account identity or payload text. */
export const QUALIFIED_CONNECTED_ACCOUNT_MATERIAL_FAILURE_CODES = [
    'credential_snapshot_unavailable', 'credential_snapshot_identity_mismatch',
    'configuration_snapshot_identity_mismatch', 'credential_snapshot_unfenced',
    'configuration_snapshot_unfenced', 'credential_authentication_mode_unavailable',
    'account_encryption_mode_unavailable', 'credential_content_unavailable',
    'configuration_content_unavailable', 'credential_snapshot_revision_mismatch',
    'configuration_secret_unavailable', 'connected_account_runtime_not_current',
] as const;

export type QualifiedConnectedAccountMaterialFailureCode = typeof QUALIFIED_CONNECTED_ACCOUNT_MATERIAL_FAILURE_CODES[number];

export class QualifiedConnectedAccountMaterialError extends Error {
    constructor(readonly code: QualifiedConnectedAccountMaterialFailureCode, message: string) {
        super(message);
        this.name = 'QualifiedConnectedAccountMaterialError';
    }
}
