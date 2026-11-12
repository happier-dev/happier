import type { GithubHttpInvocationContextV1 } from '../observations/githubHttpInvocation.js';
import { normalizeScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import {
    decodeTriagePagingTokenV1, encodeTriagePagingTokenV1, readTriageResponseHeaderV1,
    type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
import {
    type ForgeReleaseActionInputByOperationV1, type ForgeReleaseActionResultByOperationV1, type ForgeReleaseV1,
} from '@happier-dev/triage-protocol/releases/v1';
import { createGithubNativeApiClient, decodeGithubJsonResponse, type GithubApiMediaClientV1, type GithubApiResponseV1 } from '../observations/githubApiClient.js';
import { classifyGithubResponseFailure, classifyGithubTransportFailure } from '../observations/githubResponseFailure.js';
import { buildGithubApiUrl, buildGithubRepositoryKey, parseGithubRoutingToken } from '../triage/locator.js';
import { decodeGithubRepositoryMetadata } from '../triage/repositories.js';
import { readValidatedGithubFollowUpPage } from '../triage/scan/link.js';
import { mapGithubReleaseAssetV1, mapGithubReleaseV1, mapGithubLatestStableReleaseV1, releaseRecord } from './mapping.js';
import type { ReleaseReadOperationV1 } from './reads.js';

export const releaseFailure = (code: string): TriageSourceFailureV1 => ({ class: 'unsupportedContract', code });
export type ReleaseTarget = ForgeReleaseActionInputByOperationV1['readLatestRelease'];
export type AdmittedReleaseInvocation = Readonly<{
    client: GithubApiMediaClientV1; target: Pick<ForgeReleaseV1, 'repository' | 'repositoryId' | 'repositoryVisibility'>; baseUrl: string;
}>;
type ReadOperation = ReleaseReadOperationV1;
type Unavailable = Extract<ForgeReleaseActionResultByOperationV1['readRelease'], { kind: 'unavailable' }>;
const unavailable = (failure: TriageSourceFailureV1): Unavailable => ({ kind: 'unavailable', failure });

/** The shared client rematerializes the host-selected account; no release auth owner. */
export async function admitReleaseInvocation(input: ReleaseTarget, context: GithubHttpInvocationContextV1): Promise<AdmittedReleaseInvocation | Unavailable> {
    const repository = normalizeScmHostingRepositoryIdentity(input.repository);
    const route = repository && repository.kind === 'github' && repository.deployment === 'https://github.com'
        ? parseGithubRoutingToken(repository.repository) : null;
    if (!repository || !route) return unavailable(releaseFailure('github_release_repository_invalid'));
    try {
        const client = await createGithubNativeApiClient(context);
        const response = await client.request({ url: buildGithubApiUrl(['repos', route.owner, route.name]) });
        if (response.status !== 200) return unavailable(classifyGithubResponseFailure(response, Date.now()));
        const body = decodeGithubJsonResponse(response);
        const metadata = decodeGithubRepositoryMetadata(body);
        if (!metadata || (input.repositoryId !== undefined && metadata.repositoryId !== input.repositoryId) || metadata.repositoryKey !== buildGithubRepositoryKey(route))
            return unavailable(releaseFailure('github_release_repository_changed'));
        const isPrivate = releaseRecord(body)?.private;
        return { client, target: { repository, repositoryId: metadata.repositoryId,
            repositoryVisibility: isPrivate === true ? 'private' : isPrivate === false ? 'public' : 'unknown' },
            baseUrl: buildGithubApiUrl(['repos', route.owner, route.name, 'releases']) };
    } catch (error) { return unavailable(classifyGithubTransportFailure(error)); }
}

function pageUrl(admitted: AdmittedReleaseInvocation, operation: 'listReleases' | 'listAssets', releaseId: string | undefined, cursor: string | undefined) {
    const base = operation === 'listAssets' ? `${admitted.baseUrl}/${releaseId}/assets` : admitted.baseUrl;
    const first = `${base}?per_page=30&page=1`; // GitHub's documented default, without an app history cap.
    if (cursor === undefined) return first;
    const decoded = decodeTriagePagingTokenV1(cursor);
    // Cursor binds current exact repository and resource. Host admission supplies credential/currentness.
    return decoded?.repositoryId === admitted.target.repositoryId && decoded.resource === base && typeof decoded.url === 'string'
        && readValidatedGithubFollowUpPage({ link: `<${decoded.url}>; rel="next"` }, first, admitted.target.repositoryId).kind === 'next'
        ? decoded.url : null;
}

/** One provider request per demanded page/id. Semantic reconciliation belongs to the receiver below. */
export async function readReleaseResource<K extends ReadOperation>(admitted: AdmittedReleaseInvocation, operation: K,
    input: ForgeReleaseActionInputByOperationV1[K]): Promise<ForgeReleaseActionResultByOperationV1[K]> {
    const releaseId = 'releaseId' in input ? input.releaseId : undefined;
    const cursor = 'cursor' in input ? input.cursor : undefined;
    const url = operation === 'listReleases' || operation === 'listAssets' ? pageUrl(admitted, operation, releaseId, cursor)
        : operation === 'readLatestRelease' ? `${admitted.baseUrl}/latest` : `${admitted.baseUrl}/${releaseId}`;
    // Each branch constructs exactly the schema in this operation's public map; parse once at the Action/transport consumer.
    const result = await (async () => {
        if (url === null) return unavailable(releaseFailure('github_release_cursor_invalid'));
        let response: GithubApiResponseV1;
        try { response = await admitted.client.request({ url, ...(input.validator === undefined ? {} : { headers: { 'If-None-Match': input.validator } }) }); }
        catch (error) { return unavailable(classifyGithubTransportFailure(error)); }
        const etag = readTriageResponseHeaderV1(response.headers, 'etag');
        const validator = etag === null ? {} : { validator: etag };
        if (response.status === 304) return { kind: 'notModified' as const, ...validator };
        // Admission already proved readability with this same exact credential and immutable id.
        if (response.status === 404 && operation === 'readLatestRelease') return { kind: 'value' as const, value: null, ...validator };
        if (response.status !== 200) return unavailable(classifyGithubResponseFailure(response, Date.now()));
        let body: unknown;
        try { body = decodeGithubJsonResponse(response); }
        catch { return unavailable(releaseFailure('github_release_response_invalid')); }
        if (operation === 'listReleases' || operation === 'listAssets') {
            if (!Array.isArray(body)) return unavailable(releaseFailure('github_release_page_invalid'));
            const rows = operation === 'listAssets' ? body.map(mapGithubReleaseAssetV1).filter(row => row !== null)
                : body.map(row => mapGithubReleaseV1(row, admitted.target)).filter(row => row !== null);
            const next = readValidatedGithubFollowUpPage(response.headers, url, admitted.target.repositoryId);
            const continuation = next.kind === 'next' ? encodeTriagePagingTokenV1({
                repositoryId: admitted.target.repositoryId, resource: operation === 'listAssets' ? `${admitted.baseUrl}/${releaseId}/assets` : admitted.baseUrl, url: next.url,
            }) : null;
            return { kind: 'value' as const, ...validator, value: { rows, omittedRowCount: body.length - rows.length,
                projectionTruncated: false, continuation, incomplete: next.kind === 'invalid' || (next.kind === 'next' && continuation === null) ? 'pagination' as const : null } };
        }
        const release = operation === 'readLatestRelease' ? mapGithubLatestStableReleaseV1(body, admitted.target) : mapGithubReleaseV1(body, admitted.target);
        if (!release || (operation === 'readRelease' && release.releaseId !== releaseId)) return unavailable(releaseFailure('github_release_response_invalid'));
        return { kind: 'value' as const, value: release, ...validator };
    })();
    // The operation-indexed schema preserves the correlated public result type.
    return result as ForgeReleaseActionResultByOperationV1[K];
}

