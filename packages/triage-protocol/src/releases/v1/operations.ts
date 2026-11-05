import {
    defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion,
    FileDownloadDestinationV1ProtocolSchema, FileDownloadResultV1ProtocolSchema,
    ScmHostingRepositoryIdentityV1ProtocolSchema,
} from '@happier-dev/plugin-sdk/protocol';
import { defineTriageConditionalReadV1, defineTriageValueResultV1, TriageSourceFailureV1Schema } from '../../v1/diagnostics.js';
import {
    ForgeReleaseAssetPageV1Schema, ForgeReleaseBooleanV1Schema, ForgeReleaseGeneratedNotesV1Schema,
    ForgeReleaseIdV1Schema, ForgeReleasePageV1Schema, ForgeReleaseV1Schema,
} from './releases.js';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString();
const nonempty = defineProtocolString({ minLength: 1 });
// Initial Project entry resolves the native id at the provider boundary. Subsequent exact invocations may pin that admitted id.
const target = { repository: ScmHostingRepositoryIdentityV1ProtocolSchema, repositoryId: ForgeReleaseIdV1Schema.optional() };
const conditional = { validator: text.optional() };
const fields = { tagName: nonempty, targetCommitish: nonempty, name: text, body: text, prerelease: ForgeReleaseBooleanV1Schema };
export const ForgeReleaseMakeLatestV1Schema = defineProtocolUnion([defineProtocolLiteral('true'), defineProtocolLiteral('false'), defineProtocolLiteral('legacy')]);
export const ForgeReleasesListInputV1Schema = defineProtocolObject({ ...target, cursor: nonempty.optional(), ...conditional }, closed);
export const ForgeReleaseLatestReadInputV1Schema = defineProtocolObject({ ...target, ...conditional }, closed);
export const ForgeReleaseReadInputV1Schema = defineProtocolObject({ ...target, releaseId: ForgeReleaseIdV1Schema, ...conditional }, closed);
export const ForgeReleaseAssetsListInputV1Schema = defineProtocolObject({ ...target, releaseId: ForgeReleaseIdV1Schema, cursor: nonempty.optional(), ...conditional }, closed);
export const ForgeReleaseAssetDownloadInputV1Schema = defineProtocolObject({ ...target, releaseId: ForgeReleaseIdV1Schema, assetId: ForgeReleaseIdV1Schema, destination: FileDownloadDestinationV1ProtocolSchema }, closed);
export const ForgeReleaseNotesGenerateInputV1Schema = defineProtocolObject({ ...target, tagName: nonempty,
    targetCommitish: nonempty.optional(), previousTagName: nonempty.optional(), configurationFilePath: nonempty.optional() }, closed);
export const ForgeReleaseDraftCreateInputV1Schema = defineProtocolObject({ ...target, ...fields }, closed);
export const ForgeReleaseDraftEditInputV1Schema = defineProtocolObject({ ...target, releaseId: ForgeReleaseIdV1Schema,
    observedUpdatedAt: nonempty, changes: defineProtocolObject({ tagName: fields.tagName.optional(), targetCommitish: fields.targetCommitish.optional(),
        name: text.optional(), body: text.optional(), prerelease: ForgeReleaseBooleanV1Schema.optional() }, closed) }, closed);
export const ForgeReleaseDraftPublishInputV1Schema = defineProtocolObject({ ...target, releaseId: ForgeReleaseIdV1Schema,
    reviewed: ForgeReleaseV1Schema, makeLatest: ForgeReleaseMakeLatestV1Schema }, closed);
export const ForgeReleaseNotesSelectorV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('existingDraft'), releaseId: ForgeReleaseIdV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('proposed'), tagName: nonempty, targetCommitish: nonempty, previousTagName: nonempty.optional() }, closed),
]);
export const ForgeReleaseNotesContextReadInputV1Schema = defineProtocolObject({ ...target, selector: ForgeReleaseNotesSelectorV1Schema }, closed);
export const ForgeReleaseNotesContextV1Schema = defineProtocolObject({
    kind: defineProtocolLiteral('releaseNotes'), repository: ScmHostingRepositoryIdentityV1ProtocolSchema,
    selector: ForgeReleaseNotesSelectorV1Schema, contextText: text, proposedNotes: text.optional(),
}, closed);
export const ForgeReleaseMutationResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('confirmed'), release: ForgeReleaseV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('conflict'), release: ForgeReleaseV1Schema,
        reason: defineProtocolLiteral('changedSinceReview').optional() }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('rejected'), failure: TriageSourceFailureV1Schema }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('outcome_unknown'), releaseId: ForgeReleaseIdV1Schema.optional(),
        webUrl: nonempty.optional(), failure: TriageSourceFailureV1Schema.optional() }, closed),
]);
export type ForgeReleaseMutationResultV1 = ReturnType<typeof ForgeReleaseMutationResultV1Schema.parse>;
export const ForgeReleaseActionInputSchemasV1 = Object.freeze({
    listReleases: ForgeReleasesListInputV1Schema, readLatestRelease: ForgeReleaseLatestReadInputV1Schema,
    readRelease: ForgeReleaseReadInputV1Schema, listAssets: ForgeReleaseAssetsListInputV1Schema,
    downloadAsset: ForgeReleaseAssetDownloadInputV1Schema, generateReleaseNotes: ForgeReleaseNotesGenerateInputV1Schema,
    createReleaseDraft: ForgeReleaseDraftCreateInputV1Schema, editReleaseDraft: ForgeReleaseDraftEditInputV1Schema,
    publishReleaseDraft: ForgeReleaseDraftPublishInputV1Schema, readNotesContext: ForgeReleaseNotesContextReadInputV1Schema,
});
export const ForgeReleaseActionResultSchemasV1 = Object.freeze({
    listReleases: defineTriageConditionalReadV1(ForgeReleasePageV1Schema),
    readLatestRelease: defineTriageConditionalReadV1(ForgeReleaseV1Schema.nullable()),
    readRelease: defineTriageConditionalReadV1(ForgeReleaseV1Schema),
    listAssets: defineTriageConditionalReadV1(ForgeReleaseAssetPageV1Schema), downloadAsset: FileDownloadResultV1ProtocolSchema,
    generateReleaseNotes: defineTriageValueResultV1(ForgeReleaseGeneratedNotesV1Schema),
    createReleaseDraft: ForgeReleaseMutationResultV1Schema, editReleaseDraft: ForgeReleaseMutationResultV1Schema,
    publishReleaseDraft: ForgeReleaseMutationResultV1Schema, readNotesContext: defineTriageValueResultV1(ForgeReleaseNotesContextV1Schema),
});
export type ForgeReleaseOperationIdV1 = keyof typeof ForgeReleaseActionInputSchemasV1;
export type ForgeReleaseActionInputByOperationV1 = { readonly [K in ForgeReleaseOperationIdV1]: ReturnType<typeof ForgeReleaseActionInputSchemasV1[K]['parse']> };
export type ForgeReleaseActionResultByOperationV1 = { readonly [K in ForgeReleaseOperationIdV1]: ReturnType<typeof ForgeReleaseActionResultSchemasV1[K]['parse']> };
