import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { backoff } from '@/utils/timing/time';
import { Artifact, ArtifactCreateRequest, ArtifactUpdateRequest, ArtifactUpdateResponse } from '@/sync/domains/artifacts/artifactTypes';
import { HappyError } from '@/utils/errors/errors';
import { serverFetch } from '@/sync/http/client';

/**
 * Fetch all artifacts for the account
 */
export async function fetchArtifacts(
    credentials: AuthCredentials,
    opts: Readonly<{ retry?: 'default' | 'none' }> = {},
): Promise<Artifact[]> {
    const run = async () => {
        const response = await serverFetch('/v1/artifacts', {
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            }
        }, { includeAuth: false });

        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to fetch artifacts';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false);
            }
            throw new Error(`Failed to fetch artifacts: ${response.status}`);
        }

        const data = await response.json() as Artifact[];
        return data;
    };

    if (opts.retry === 'none') {
        return await run();
    }

    return await backoff(run);
}

/**
 * Fetch a single artifact with full body
 */
export async function fetchArtifact(
    credentials: AuthCredentials,
    artifactId: string,
    opts: Readonly<{ retry?: 'default' | 'none' }> = {},
): Promise<Artifact> {
    const run = async () => {
        const response = await serverFetch(`/v1/artifacts/${artifactId}`, {
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            }
        }, { includeAuth: false });

        if (!response.ok) {
            if (response.status === 404) {
                throw new HappyError('Artifact not found', false);
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to fetch artifact';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false);
            }
            throw new Error(`Failed to fetch artifact: ${response.status}`);
        }

        const data = await response.json() as Artifact;
        return data;
    };

    if (opts.retry === 'none') {
        return await run();
    }

    return await backoff(run);
}

/**
 * Create a new artifact
 */
export async function createArtifact(
    credentials: AuthCredentials, 
    request: ArtifactCreateRequest,
    opts: Readonly<{ retry?: 'default' | 'none' }> = {},
): Promise<Artifact> {
    const run = async () => {
        const response = await serverFetch('/v1/artifacts', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        }, { includeAuth: false });

        if (!response.ok) {
            if (response.status === 409) {
                throw new HappyError('Artifact ID already exists', false);
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to create artifact';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false);
            }
            throw new Error(`Failed to create artifact: ${response.status}`);
        }

        const data = await response.json() as Artifact;
        return data;
    };

    if (opts.retry === 'none') {
        return await run();
    }

    return await backoff(run);
}

/**
 * Update an existing artifact
 */
export async function updateArtifact(
    credentials: AuthCredentials,
    artifactId: string,
    request: ArtifactUpdateRequest,
    opts: Readonly<{ retry?: 'default' | 'none' }> = {},
): Promise<ArtifactUpdateResponse> {
    const run = async () => {
        const response = await serverFetch(`/v1/artifacts/${artifactId}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        }, { includeAuth: false });

        if (!response.ok) {
            if (response.status === 404) {
                throw new HappyError('Artifact not found', false);
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to update artifact';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false);
            }
            throw new Error(`Failed to update artifact: ${response.status}`);
        }

        const data = await response.json() as ArtifactUpdateResponse;
        return data;
    };

    if (opts.retry === 'none') {
        return await run();
    }

    return await backoff(run);
}

/**
 * Delete an artifact
 */
export async function deleteArtifact(
    credentials: AuthCredentials,
    artifactId: string,
    opts: Readonly<{ retry?: 'default' | 'none' }> = {},
): Promise<void> {
    const run = async () => {
        const response = await serverFetch(`/v1/artifacts/${artifactId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${credentials.token}`
            }
        }, { includeAuth: false });

        if (!response.ok) {
            if (response.status === 404) {
                throw new HappyError('Artifact not found', false);
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to delete artifact';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false);
            }
            throw new Error(`Failed to delete artifact: ${response.status}`);
        }
    };

    if (opts.retry === 'none') {
        await run();
        return;
    }

    await backoff(run);
}
