import axios from '@/api/client/credentialAxios';
import { HttpStatusError } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { ArtifactAccessErrorCodeV1Schema, ArtifactTemplateAcceptedVersionResponseV1Schema,
    type ArtifactTemplateAcceptedVersionInputV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';

export const artifactAccessUrl = (artifactId: string, leaf: string): string =>
    `${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(artifactId)}/access/${leaf}`;

export function requireArtifactAccessResponse(response: Readonly<{ status: number; data: unknown }>): unknown {
    if (response.status >= 200 && response.status < 300) return response.data;
    const value = response.data && typeof response.data === 'object' ? response.data as Record<string, unknown> : {};
    const known = ArtifactAccessErrorCodeV1Schema.safeParse(value.error);
    const code = known.success ? known.data
        : response.status === 404 || response.status === 405 ? 'artifact_access_unavailable' : 'artifact_access_failed';
    throw Object.assign(new HttpStatusError(response.status, code), { code, status: response.status });
}

/** Both admitted Actions and resumed requester launches use this one report transport. */
export async function reportArtifactTemplateAcceptedVersion(input: ArtifactTemplateAcceptedVersionInputV1,
    options: Readonly<{ headers: Readonly<Record<string, string>>; signal?: AbortSignal }>,
): Promise<void> {
    options.signal?.throwIfAborted();
    const response = await axios.put(artifactAccessUrl(input.artifactId, 'accepted-version'), input, {
        headers: { ...options.headers }, ...(options.signal ? { signal: options.signal } : {}), validateStatus: () => true,
    });
    ArtifactTemplateAcceptedVersionResponseV1Schema.parse(requireArtifactAccessResponse(response));
}
