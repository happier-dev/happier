/** @moduleRealm daemon */
/** @realm any */
export { SecretStringV1Schema } from '@happier-dev/protocol/runtime';

export type SecretStatus = Readonly<{
    state: 'configured' | 'missing' | 'denied' | 'unavailable';
    revision: string;
}>;

export type SecretMutationResult = Readonly<{ revision: string }>;

export interface SecretsService {
    status(id: string): Promise<SecretStatus>;
    get(id: string, options?: { reason?: string; signal?: AbortSignal }): Promise<string>;
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
