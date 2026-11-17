/** @moduleRealm daemon */
import type { AccessProviderRefV1 } from './accessProviders.js';

/**
 * Invocation-bound connector sink; the host captures the controller, receiver
 * and operation. Token bytes never become public Action operands or results.
 * @realm cli
 */
export interface MachineConnectorSecretsService {
    write(input: Readonly<{
        token: Uint8Array;
        subject: Readonly<{ provider: AccessProviderRefV1; connectorId: string }>;
    }>): Promise<Readonly<{
        grants: readonly Readonly<{ machineId: string; installationId: string; grantRef: string }>[];
    }>>;
}

/** @realm any */
export { SecretStringV1Schema } from '@happier-dev/protocol/crypto/settingsSecretStringSchemasV1';

export type SecretStatus = Readonly<{
    state: 'configured' | 'missing' | 'denied' | 'unavailable';
    revision: string;
}>;

export type SecretMutationResult = Readonly<{ revision: string }>;

/** Existing Saved Secret grant fields; the parent Action admits the exact audience. */
export type SharedSecretAudience = Readonly<{
    accountGrants?: string[] | undefined;
    teamGrants?: string[] | undefined;
    groupGrants?: string[] | undefined;
}>;

export type SharedSecretSaveInput = Readonly<{
    label: string;
    bytes: Uint8Array;
    audience: SharedSecretAudience;
}>;
export type SharedSecretSaveResult = Readonly<{ ref: string; resourceRevision: number }>;

export interface SecretsService {
    /** Save under the exact id, purpose and audience reviewed by the parent Action. */
    saveShared(id: string, input: SharedSecretSaveInput, options?: { signal?: AbortSignal }): Promise<SharedSecretSaveResult>;
    /** Read a Saved Secret reference through this invocation's captured Account custody. */
    readSavedSecret(ref: string, options?: { resourceRevision?: number; signal?: AbortSignal }): Promise<string>;
    /**
     * Host-captured data-role credential for the admitted managed operation.
     * The default reads its dedicated read password; write requires an admitted
     * write operation. Callers cannot select a link or Saved Secret reference.
     */
    readDataRole?(options?: { role?: 'readOnlyPassword' | 'write'; signal?: AbortSignal }): Promise<string>;
    status(id: string): Promise<SecretStatus>;
    get(id: string, options?: { reason?: string; signal?: AbortSignal; sourceKind?: 'inline' }): Promise<string>;
    set(
        id: string,
        value: string,
        options?: { expectedRevision?: string; signal?: AbortSignal },
    ): Promise<SecretMutationResult>;
    delete(
        id: string,
        options?: { expectedRevision?: string; signal?: AbortSignal },
    ): Promise<SecretMutationResult>;
}
