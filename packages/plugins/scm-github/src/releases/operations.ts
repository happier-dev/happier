import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { GithubHttpInvocationContextV1 } from '../observations/githubHttpInvocation.js';
import { ForgeReleaseActionInputSchemasV1, type ForgeReleaseOperationIdV1, type ForgeReleaseActionInputByOperationV1, type ForgeReleaseActionResultByOperationV1 } from '@happier-dev/triage-protocol/releases/v1';
import { admitReleaseInvocation, readReleaseResource, type AdmittedReleaseInvocation } from './nativeReads.js';
import { generateReleaseNotes, mutateReleaseDraft, readReleaseNotesContext } from './drafts.js';

const handlers: { readonly [K in ForgeReleaseOperationIdV1]: (admitted: AdmittedReleaseInvocation,
    input: ForgeReleaseActionInputByOperationV1[K], context: GithubHttpInvocationContextV1) => Promise<ForgeReleaseActionResultByOperationV1[K]> } = {
    listReleases: (admitted, input) => readReleaseResource(admitted, 'listReleases', input),
    readLatestRelease: (admitted, input) => readReleaseResource(admitted, 'readLatestRelease', input),
    readRelease: (admitted, input) => readReleaseResource(admitted, 'readRelease', input),
    listAssets: (admitted, input) => readReleaseResource(admitted, 'listAssets', input),
    generateReleaseNotes,
    createReleaseDraft: (admitted, input) => mutateReleaseDraft(admitted, 'createReleaseDraft', input),
    editReleaseDraft: (admitted, input) => mutateReleaseDraft(admitted, 'editReleaseDraft', input),
    publishReleaseDraft: (admitted, input) => mutateReleaseDraft(admitted, 'publishReleaseDraft', input),
    readNotesContext: readReleaseNotesContext,
    // Only the download operation's public context requires native destination services.
    downloadAsset: async (admitted, input, context) => (await import('./assets.js')).downloadReleaseAssetV1(admitted, input, context as PluginInvocationContext),
};

export type GithubReleaseInvocationContextV1<K extends ForgeReleaseOperationIdV1> =
    K extends 'downloadAsset' ? PluginInvocationContext : GithubHttpInvocationContextV1;

/** Every provider entry consumes the canonical closed input and exact-account client. */
export async function executeGithubReleaseOperationV1<K extends ForgeReleaseOperationIdV1>(operation: K, input: unknown,
    context: GithubReleaseInvocationContextV1<K>): Promise<ForgeReleaseActionResultByOperationV1[K]> {
    // The operation-indexed executable map establishes this exact input/result correlation.
    const parsed = ForgeReleaseActionInputSchemasV1[operation].parse(input) as ForgeReleaseActionInputByOperationV1[K];
    const admitted = await admitReleaseInvocation(parsed, context);
    if ('kind' in admitted) {
        if (operation === 'downloadAsset') return { success: false, status: context.signal.aborted ? 'cancelled' : 'failed',
            error: 'The release asset repository could not be admitted.', errorCode: admitted.failure.code } as ForgeReleaseActionResultByOperationV1[K];
        return (['createReleaseDraft', 'editReleaseDraft', 'publishReleaseDraft'].includes(operation)
            ? { kind: 'rejected', failure: admitted.failure } : admitted) as ForgeReleaseActionResultByOperationV1[K];
    }
    return handlers[operation](admitted, parsed, context);
}
