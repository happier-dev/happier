import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { readWebServerUrlOverrideFromLocation } from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';

export async function resolveBootCredentials(platformOs: string): Promise<AuthCredentials | null> {
    const webServerOverride = platformOs === 'web' ? readWebServerUrlOverrideFromLocation() : null;
    return webServerOverride?.serverUrl
        ? await TokenStorage.getCredentialsForServerUrl(webServerOverride.serverUrl)
        : await TokenStorage.getCredentials();
}
