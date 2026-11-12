import {
    type ForgeReleaseActionInputByOperationV1, type ForgeReleaseActionResultByOperationV1,
    type ForgeReleaseMutationResultV1, type ForgeReleaseV1,
} from '@happier-dev/triage-protocol/releases/v1';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import { decodeGithubJsonResponse } from '../observations/githubApiClient.js';
import { classifyGithubResponseFailure, classifyGithubTransportFailure } from '../observations/githubResponseFailure.js';
import { hasCompleteReleaseAssetsV1, mapGithubReleaseV1, releaseRecord, sameReleaseReviewAssetsV1, sameReleaseReviewFieldsV1 } from './mapping.js';
import { readReleaseResource, releaseFailure, type AdmittedReleaseInvocation } from './nativeReads.js';

type Mutation = 'createReleaseDraft' | 'editReleaseDraft' | 'publishReleaseDraft';
function mutationBody(input: ForgeReleaseActionInputByOperationV1['createReleaseDraft']
    | ForgeReleaseActionInputByOperationV1['editReleaseDraft'], current: ForgeReleaseV1 | undefined) {
    const fields = 'changes' in input ? input.changes : input;
    // GitHub drops a draft's pending tag (answering `untagged-…`) when an edit omits tag_name, so an edit always
    // names the tag: the person's change, else the fresh exact draft's own tag.
    const tagName = fields.tagName ?? current?.tagName;
    return {
        ...(tagName === undefined ? {} : { tag_name: tagName }),
        ...(fields.targetCommitish === undefined ? {} : { target_commitish: fields.targetCommitish }),
        ...(fields.name === undefined ? {} : { name: fields.name }),
        ...(fields.body === undefined ? {} : { body: fields.body }),
        ...(fields.prerelease === undefined ? {} : { prerelease: fields.prerelease }),
        draft: true,
    };
}
export async function generateReleaseNotes(admitted: AdmittedReleaseInvocation,
    input: ForgeReleaseActionInputByOperationV1['generateReleaseNotes']): Promise<ForgeReleaseActionResultByOperationV1['generateReleaseNotes']> {
    try {
        const response = await admitted.client.request({ url: `${admitted.baseUrl}/generate-notes`, method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({
                tag_name: input.tagName,
                ...(input.targetCommitish === undefined ? {} : { target_commitish: input.targetCommitish }),
                ...(input.previousTagName === undefined ? {} : { previous_tag_name: input.previousTagName }),
                ...(input.configurationFilePath === undefined ? {} : { configuration_file_path: input.configurationFilePath }),
            })) });
        if (response.status !== 200) return { kind: 'unavailable', failure: classifyGithubResponseFailure(response, Date.now()) };
        const body = releaseRecord(decodeGithubJsonResponse(response));
        return typeof body?.name === 'string' && typeof body.body === 'string'
            ? { kind: 'value', value: { name: body.name, body: body.body } }
            : { kind: 'unavailable', failure: releaseFailure('github_release_notes_invalid') };
    } catch (error) { return { kind: 'unavailable', failure: classifyGithubTransportFailure(error) }; }
}

/** Fresh exact evidence is mandatory; the provider offers no atomic compare-and-swap. */
export async function mutateReleaseDraft<K extends Mutation>(admitted: AdmittedReleaseInvocation, operation: K,
    input: ForgeReleaseActionInputByOperationV1[K]): Promise<ForgeReleaseMutationResultV1> {
    let current: ForgeReleaseV1 | undefined;
    const releaseId = 'releaseId' in input ? input.releaseId : undefined;
    if ('releaseId' in input) {
        if ('reviewed' in input && (!sameScmHostingRepositoryIdentity(input.reviewed.repository, admitted.target.repository)
            || input.reviewed.repositoryId !== admitted.target.repositoryId || input.reviewed.releaseId !== input.releaseId
            || !input.reviewed.draft || !hasCompleteReleaseAssetsV1(input.reviewed.assets)))
            return { kind: 'rejected', failure: releaseFailure('github_release_review_invalid') };
        const fresh = await readReleaseResource(admitted, 'readRelease', { ...admitted.target, releaseId: input.releaseId });
        if (fresh.kind !== 'value') return { kind: 'rejected', failure: fresh.kind === 'unavailable' ? fresh.failure : releaseFailure('github_release_fresh_read_required') };
        current = fresh.value;
        if (!current.draft) return { kind: 'rejected', failure: releaseFailure('github_release_not_a_draft') };
        if ('observedUpdatedAt' in input) {
            if (current.updatedAt === undefined || !Number.isFinite(Date.parse(current.updatedAt)))
                return { kind: 'rejected', failure: releaseFailure('github_release_revision_unavailable') };
            if (current.updatedAt !== input.observedUpdatedAt) return { kind: 'conflict', release: current };
        }
        if ('reviewed' in input) {
            if (!sameReleaseReviewFieldsV1(input.reviewed, current))
                return { kind: 'conflict', reason: 'changedSinceReview', release: current };
            // Publication reviews the full current asset metadata, never downloads asset bytes.
            let cursor: string | undefined;
            const rows: ForgeReleaseV1['assets']['rows'][number][] = [];
            do {
                const assets = await readReleaseResource(admitted, 'listAssets', { ...admitted.target, releaseId: input.releaseId,
                    ...(cursor === undefined ? {} : { cursor }) });
                if (assets.kind !== 'value') return { kind: 'rejected', failure: assets.kind === 'unavailable' ? assets.failure : releaseFailure('github_release_assets_review_required') };
                if (assets.value.incomplete !== null || assets.value.omittedRowCount !== 0 || assets.value.projectionTruncated)
                    return { kind: 'rejected', failure: releaseFailure('github_release_assets_incomplete') };
                rows.push(...assets.value.rows);
                cursor = assets.value.continuation ?? undefined;
            } while (cursor !== undefined);
            current = { ...current, assets: { rows, omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null } };
            // GitHub offers no atomic CAS: changes after this fresh comparison remain a provider limitation.
            if (!sameReleaseReviewAssetsV1(input.reviewed.assets, current.assets))
                return { kind: 'conflict', reason: 'changedSinceReview', release: current };
        }
    }
    const body = operation === 'publishReleaseDraft' && 'makeLatest' in input ? { draft: false, make_latest: input.makeLatest }
        : mutationBody(input as ForgeReleaseActionInputByOperationV1['createReleaseDraft'] | ForgeReleaseActionInputByOperationV1['editReleaseDraft'], current);
    const url = releaseId === undefined ? admitted.baseUrl : `${admitted.baseUrl}/${releaseId}`;
    const unknown = (failure: TriageSourceFailureV1): ForgeReleaseMutationResultV1 => ({ kind: 'outcome_unknown',
        ...(releaseId === undefined ? {} : { releaseId }), ...(current === undefined ? {} : { webUrl: current.webUrl }), failure });
    let response;
    try {
        response = await admitted.client.request({ url, method: releaseId === undefined ? 'POST' : 'PATCH',
            headers: { 'Content-Type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) });
    } catch (error) { return unknown(classifyGithubTransportFailure(error)); }
    if (response.status >= 500) return unknown(classifyGithubResponseFailure(response, Date.now()));
    if (response.status !== 200 && response.status !== 201) return { kind: 'rejected', failure: classifyGithubResponseFailure(response, Date.now()) };
    let receipt: ForgeReleaseV1 | null;
    try { receipt = mapGithubReleaseV1(decodeGithubJsonResponse(response), admitted.target); }
    catch { receipt = null; }
    if (!receipt || (releaseId !== undefined && receipt.releaseId !== releaseId)
        || receipt.draft !== (operation !== 'publishReleaseDraft')) return unknown(releaseFailure('github_release_receipt_invalid'));
    if (operation === 'publishReleaseDraft') {
        const exact = await readReleaseResource(admitted, 'readRelease', { ...admitted.target, releaseId: receipt.releaseId });
        // The validated PATCH receipt settles publication. A later observation cannot undo that effect.
        if (exact.kind !== 'value' || exact.value.draft) return { kind: 'confirmed', release: receipt,
            observationWarning: exact.kind === 'unavailable' ? exact.failure : releaseFailure('github_release_readback_unconfirmed') };
    }
    return { kind: 'confirmed', release: receipt };
}

/** Only selected facts; framing and Session choice are exclusively L05A's handoff owner. */
export async function readReleaseNotesContext(admitted: AdmittedReleaseInvocation,
    input: ForgeReleaseActionInputByOperationV1['readNotesContext']): Promise<ForgeReleaseActionResultByOperationV1['readNotesContext']> {
    if (input.selector.kind === 'proposed') return { kind: 'value', value: { kind: 'releaseNotes', repository: admitted.target.repository,
        selector: input.selector, contextText: JSON.stringify({ tagName: input.selector.tagName, targetCommitish: input.selector.targetCommitish,
            ...(input.selector.previousTagName === undefined ? {} : { previousTagName: input.selector.previousTagName }) }) } };
    const read = await readReleaseResource(admitted, 'readRelease', { ...admitted.target, releaseId: input.selector.releaseId });
    if (read.kind !== 'value') return read.kind === 'unavailable' ? read : { kind: 'unavailable', failure: releaseFailure('github_release_context_missing') };
    if (!read.value.draft) return { kind: 'unavailable', failure: releaseFailure('github_release_not_a_draft') };
    return { kind: 'value', value: { kind: 'releaseNotes', repository: admitted.target.repository, selector: input.selector,
        contextText: JSON.stringify({ tagName: read.value.tagName, targetCommitish: read.value.targetCommitish,
            name: read.value.name, body: read.value.body, author: read.value.author ?? null, url: read.value.webUrl }),
        ...(read.value.body === null ? {} : { proposedNotes: read.value.body }) } };
}
