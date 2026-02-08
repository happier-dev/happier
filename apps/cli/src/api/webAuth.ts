import { encodeBase64 } from './encryption';
import { configuration } from '@/configuration';
import { buildTerminalConnectLinks } from '@happier-dev/cli-common/links';

/**
 * Generate a URL for web authentication
 * @param publicKey - The ephemeral public key to include in the URL
 * @returns The web authentication URL
 */
export function generateWebAuthUrl(publicKey: Uint8Array): string {
    const publicKeyB64Url = encodeBase64(publicKey, 'base64url');
    return buildTerminalConnectLinks({
        webappUrl: configuration.webappUrl,
        serverUrl: configuration.publicServerUrl,
        publicKeyB64Url,
    }).webUrl;
}
