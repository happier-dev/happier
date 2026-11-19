import type { ReviewHumanActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { createActionExecuteFailureError, parseActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ReviewHumanErrorCodeV1Schema, type ReviewHumanActionStateV1 } from '@happier-dev/protocol/reviews/reviewHumanV1';
import { createReviewHumanActionExecutorV1 } from '@happier-dev/protocol/reviews/reviewHumanTransportV1';
import { createCredentialedAccountArtifactStore,
    type ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';

/** Bind the domain transport to this invocation's Home and admitted Artifact codec. */
export async function executeCliReviewHumanAction(args: Readonly<{
    actionId: ReviewHumanActionIdV1;
    input: unknown;
    accountId: string;
    credentials: StoredCredentials;
    serverHttpBaseUrl: string;
    request: (method: string, path: string, body?: unknown) => Promise<unknown>;
    authorizationHeaders: ArtifactRequestAuthorizationHeaders;
    signal?: AbortSignal;
}>): Promise<ReviewHumanActionStateV1> {
    const execute = createReviewHumanActionExecutorV1({ accountId: args.accountId, request: args.request,
        resolveResource: async reviewId => {
            const artifacts = createCredentialedAccountArtifactStore(args.credentials);
            const resource = await runWithServerHttpBaseUrl(args.serverHttpBaseUrl, () => artifacts.readForUpdate(reviewId, {
                prepareRecipients: false, includeSharedAudience: false,
                authorizationHeaders: args.authorizationHeaders, ...(args.signal ? { signal: args.signal } : {}),
            }));
            if (!resource) throw createActionExecuteFailureError({ ok: false,
                errorCode: 'review_verdict_content_unavailable', error: 'review_verdict_content_unavailable' });
            const binding = { artifactId: reviewId, expectedRevision: resource.artifact.revision };
            return { mode: resource.storageMode,
                open: async content => resource.openAssociatedContent({ ...binding, content }),
                seal: async value => resource.sealAssociatedContent({ ...binding, value }),
            };
        },
    });
    try {
        return await execute(args.actionId, args.input);
    } catch (error) {
        if (parseActionExecuteFailure(error) || parseActionExecuteFailure(error instanceof Error ? error.cause : undefined)) throw error;
        // The codec and domain own refusal classification; retain their typed Action outcome.
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
        const domainError = ReviewHumanErrorCodeV1Schema.safeParse(code);
        if (domainError.success) throw createActionExecuteFailureError({ ok: false,
            errorCode: domainError.data, error: domainError.data });
        throw error;
    }
}
