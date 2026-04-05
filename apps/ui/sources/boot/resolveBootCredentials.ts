import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { bootstrapActiveServerFromWebLocation } from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';

export async function resolveBootCredentials(platformOs: string): Promise<AuthCredentials | null> {
    const webServerOverride = platformOs === 'web'
        ? bootstrapActiveServerFromWebLocation({ scope: 'device' })
        : null;
    return webServerOverride?.serverUrl
        ? await TokenStorage.getCredentialsForServerUrl(webServerOverride.serverUrl)
        : await TokenStorage.getCredentials();
}
