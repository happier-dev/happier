import type { ArtifactPublicLinkRequestV1 } from '@happier-dev/protocol/actions/executor/artifactPublicLinkActions';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ServerFetch } from '@/sync/http/client';

/** Management and exposure admission use the same captured, authenticated transport. */
export function createArtifactPublicLinkRequest(account: Readonly<{
    credentials: AuthCredentials;
    request: ServerFetch;
    assertCurrent: () => void;
}>) {
    return async ({ method, path, body, signal }: ArtifactPublicLinkRequestV1): Promise<unknown> => {
        account.assertCurrent();
        signal?.throwIfAborted();
        const response = await account.request(path, { method, signal,
            headers: { Authorization: `Bearer ${account.credentials.token}`, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        account.assertCurrent();
        signal?.throwIfAborted();
        if (!response.ok) {
            const payload: unknown = await response.json().catch(() => null);
            account.assertCurrent();
            signal?.throwIfAborted();
            const error = payload && typeof payload === 'object' && !Array.isArray(payload) ? Reflect.get(payload, 'error') : null;
            const unsupportedSignedRoute = path.startsWith('/v1/artifact-signed-in-links') && response.status === 404
                && (typeof error !== 'string' || error === 'Not Found');
            const code = unsupportedSignedRoute ? 'unsupported_action' : typeof error === 'string' ? error : 'public_share_request_failed';
            const reason = payload && typeof payload === 'object' && !Array.isArray(payload) ? Reflect.get(payload, 'reason') : undefined;
            throw Object.assign(new Error(code), { code, ...(typeof reason === 'string' ? { reason } : {}) });
        }
        const result: unknown = await response.json();
        account.assertCurrent();
        signal?.throwIfAborted();
        return result;
    };
}
