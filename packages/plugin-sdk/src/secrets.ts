import type { AccessProviderRefV1 } from './accessProviders.js';
/** @moduleRealm daemon */
/** @realm any */
export { SecretStringV1Schema } from '@happier-dev/protocol/crypto/settingsSecretStringSchemasV1';

export type SecretStatus = Readonly<{
    state: 'configured' | 'missing' | 'denied' | 'unavailable';
    revision: string;
}>;

export type SecretMutationResult = Readonly<{ revision: string }>;

export interface SecretsService {
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

export type SharedSecretAudience = Readonly<{
    accountGrants?: string[] | undefined;
    teamGrants?: string[] | undefined;
    groupGrants?: string[] | undefined;
}>;

export type SharedSecretSaveResult = Readonly<{ ref: string; resourceRevision: number }>;

export interface MachineConnectorSecretsService {
    write(input: Readonly<{
        token: Uint8Array;
        subject: Readonly<{ provider: AccessProviderRefV1; connectorId: string }>;
    }>): Promise<Readonly<{
        grants: readonly Readonly<{ machineId: string; installationId: string; grantRef: string }>[];
    }>>;
}
