import { readArtifactPublicLinkHttpFailureV1, type ArtifactPublicLinkRequestV1 } from '@happier-dev/protocol/actions/executor/artifactPublicLinkActions';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ServerFetch } from '@/sync/http/client';
import { readTransientAvailabilityFailure } from '@/utils/errors/transientAvailability';

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
            // Only closed codes become the cause; the Home's own availability codes keep their retry copy.
            const transient = readTransientAvailabilityFailure(payload && typeof payload === 'object' ? Reflect.get(payload, 'error') : undefined);
            const failure = transient ? { code: transient.code } : readArtifactPublicLinkHttpFailureV1({ path, status: response.status, payload });
            throw Object.assign(new Error(failure.code), failure);
        }
        const result: unknown = await response.json();
        account.assertCurrent();
        signal?.throwIfAborted();
        return result;
    };
}
