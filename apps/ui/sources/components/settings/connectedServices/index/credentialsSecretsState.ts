import type { SavedSecretCatalogProjection } from '@/components/secrets/useSavedSecretCatalog';

/** What Credentials says about your Secrets: the rail and the overview read this one state together. */
export type CredentialsSecretsState = 'loading' | 'failed' | 'empty' | 'ready';

/**
 * Known secrets stay listed while they refresh or a refresh fails. With none known, only a current,
 * settled read may say there are none; until then it is loading, and a failed read says so.
 */
export function presentCredentialsSecretsState(input: Readonly<{
    status: SavedSecretCatalogProjection['status'];
    stale: boolean;
    ownedCount: number;
}>): CredentialsSecretsState {
    if (input.ownedCount > 0) return 'ready';
    if (input.status === 'error') return 'failed';
    return input.status === 'ready' && !input.stale ? 'empty' : 'loading';
}
