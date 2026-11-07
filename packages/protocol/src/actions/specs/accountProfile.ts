import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { z } from 'zod/mini';
import {
  AccountNameUpdateRequestV1Schema, AccountNameUpdateResponseV1Schema,
  AccountUsernameUpdateRequestV1Schema, AccountUsernameUpdateResponseV1Schema,
  AccountUsernameCheckRequestV1Schema, AccountUsernameCheckResponseV1Schema,
  AccountUsernameReleaseRequestV1Schema, AccountUsernameReleaseResponseV1Schema,
  AccountSelfProfileV1Schema,
} from '../../account/profile.js';
import { homeDomainActionRow, homeDomainApprovalField } from './homeDomainRow.js';
import { PublicProfileOwnerReadV1Schema, PublicProfileMutationResultV1Schema,
  PublicProfileReportRequestV1Schema, PublicProfileReportResultV1Schema } from '../../account/publicProfilePublication.js';
import { PublicProfilePreviewIntentV1Schema, PublicProfilePublishIntentV1Schema, PublicProfileUpdateIntentV1Schema,
  PublicProfilePreviewResultV1Schema, PublicProfileUpdateResultV1Schema } from '../../account/publicProfileIntents.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { PublicEmbedInputV1Schema, PublicEmbedResultV1Schema } from '../../account/publicProfileEmbeds.js';
import type { PublicProfilePreparedRequestV1 } from '../../account/publicProfilePublication.js';
import { redactObservationInputPaths } from './observationRedaction.js';
import { readRecord } from '../../inputs/inputRecords.js';

// Unapplied metadata choices, computed facts and pixels stay with the live invocation.
// The prepared review already carries the resolved, consented metadata, not the private candidate selection.
const projectPublicProfilePublicReviewInput = redactObservationInputPaths('metadataSelection', 'snapshot', 'appearance.atmosphere.picture.content');
const projectPublicProfilePrivateReviewInput = redactObservationInputPaths('metadataSelection', 'snapshot', 'appearance.atmosphere.picture.content', 'layout');
const projectPublicProfileReviewInput = (input: unknown) => 'surface' in readRecord(readRecord(input).layout)
  ? projectPublicProfilePrivateReviewInput(input) : projectPublicProfilePublicReviewInput(input);
export function projectPublicProfilePreparedReview(request: PublicProfilePreparedRequestV1): Readonly<{
  operation: PublicProfilePreparedRequestV1['operation']; body: unknown;
}> {
  return { operation: request.operation, body: projectPublicProfileReviewInput(request.body) };
}

/** Self-only profile intents; the answering Home owns policy and the authenticated Account. */
function createAccountProfileActionSpecsV1() {
  return Object.freeze([
  homeDomainActionRow({
    id: 'account.profile.get', approval: {result: 'required'}, title: 'Read your profile',
    description: 'Read your own name, username and avatar on this Home.',
    safety: 'safe', sideEffectClass: 'read', cliPath: ['account', 'profile', 'get'],
    method: 'GET', path: '/v1/account/profile', inputSchema: z.strictObject({}),
    outputSchema: AccountSelfProfileV1Schema,
  }),
  homeDomainActionRow({
    id: 'account.name.set', approval: { result: 'required', flow: 'deferred' }, title: 'Set your name',
    approvalPolicy: { uiConfirmation: 'direct' },
    description: 'Set what people should call you on this Home. Empty clears the name.',
    safety: 'danger', sideEffectClass: 'write', cliPath: ['account', 'name', 'set'],
    path: '/v1/account/profile', inputSchema: AccountNameUpdateRequestV1Schema,
    outputSchema: AccountNameUpdateResponseV1Schema,
    inputHints: { fields: [homeDomainApprovalField('name', 'Name', { required: true })] },
  }),
  homeDomainActionRow({
    id: 'account.username.set', approval: { result: 'required', flow: 'deferred' }, title: 'Set your username',
    approvalPolicy: { uiConfirmation: 'direct' },
    description: 'Set your own username when this Home supports public profiles or its Friends policy permits it.',
    safety: 'danger', sideEffectClass: 'write', cliPath: ['account', 'username', 'set'],
    path: '/v1/account/username', inputSchema: AccountUsernameUpdateRequestV1Schema,
    outputSchema: AccountUsernameUpdateResponseV1Schema,
    inputHints: { fields: [homeDomainApprovalField('username', 'Username', { required: true })] },
  }),
  homeDomainActionRow({
    id: 'account.username.check', approval: { result: 'required' }, title: 'Check your username',
    description: 'Check a username and available suggestions on this Home. A check does not reserve a name.',
    safety: 'safe', sideEffectClass: 'read', cliPath: ['account', 'username', 'check'],
    path: '/v1/account/username/check', inputSchema: AccountUsernameCheckRequestV1Schema,
    outputSchema: AccountUsernameCheckResponseV1Schema,
    inputHints: { fields: [homeDomainApprovalField('username', 'Username', { required: true })] },
  }),
  homeDomainActionRow({
    id: 'account.username.release', approval: { result: 'required', flow: 'deferred' }, title: 'Release your username',
    description: 'Clear your username on this Home and make the released name immediately available.',
    safety: 'danger', sideEffectClass: 'write', cliPath: ['account', 'username', 'release'],
    path: '/v1/account/username/release', inputSchema: AccountUsernameReleaseRequestV1Schema,
    outputSchema: AccountUsernameReleaseResponseV1Schema,
  }),
  homeDomainActionRow({
    id: 'account.public_profile.get', approval: { result: 'required' }, title: 'Read your public profile',
    description: 'Read the applied public edition, its consent and canonical service destination.',
    safety: 'safe', sideEffectClass: 'read', cliPath: ['account', 'public-profile', 'get'],
    method: 'GET', path: '/v1/account/public-profile', inputSchema: z.strictObject({}), outputSchema: PublicProfileOwnerReadV1Schema,
  }),
  {
    id: 'account.public_profile.preview', approval: { result: 'required', flow: 'blocking' }, title: 'Preview your public profile',
    approvalInputCustody: 'live_only', approvalResultCustody: 'live_only', projectObservationInput: projectPublicProfileReviewInput,
    projectObservationOutput: value => { const kind = readRecord(value).kind;
      return kind === 'ready' || kind === 'unavailable' ? { kind } : {}; },
    description: 'Preview a Public profile draft before publishing: choose visible fields with policy, bio and links with metadataSelection, the period with query, blocks with layout and the visitor theme or background with appearance. Prepare the exact allowed disclosure locally without uploading a public snapshot or image. This accepts draft values; it does not edit an open form.',
    safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation', executionPlacement: 'account',
    placements: [], surfaces: { ui: true, voice: false, agent: true, mcp: false, cli: true, rpc: false },
    cli: { commands: [{ path: ['account', 'public-profile', 'preview'], visibility: 'canonical' }], acceptsServerId: true, requiresServerId: true },
    inputHints: { fields: [] }, inputSchema: PublicProfilePreviewIntentV1Schema, outputSchema: PublicProfilePreviewResultV1Schema,
  } as const satisfies PreNormalizedActionSpec,
  homeDomainActionRow({
    id: 'account.public_profile.publish', approval: { result: 'required', flow: 'blocking' }, title: 'Publish your public profile',
    irreversible: true,
    approvalInputCustody: 'live_only', projectObservationInput: projectPublicProfileReviewInput,
    description: 'Publish a Public profile draft as reviewed plaintext facts and presentation on this Account service. Supply policy for visible fields, metadataSelection for bio, links and repositories, query for the period, layout for blocks and appearance for the visitor theme or background. Unsubmitted form edits are not read automatically. Publishing includes daily facts refresh while a device runs Happier, subject to explicit Action Off or Ask settings.',
    safety: 'danger', sideEffectClass: 'external', cliPath: ['account', 'public-profile', 'publish'],
    method: 'POST', path: '/v1/account/public-profile/publish', inputSchema: PublicProfilePublishIntentV1Schema, outputSchema: PublicProfileMutationResultV1Schema,
  }),
  homeDomainActionRow({
    id: 'account.public_profile.resume', approval: { result: 'required', flow: 'blocking' }, title: 'Resume your public profile',
    approvalPolicy: { uiConfirmation: 'direct' },
    approvalInputCustody: 'live_only', projectObservationInput: projectPublicProfileReviewInput,
    approvalPresentation: { summary: () => 'Your page comes back with fresh numbers. What it shares stays the same' },
    description: 'Refresh and resume the existing applied public edition without applying a draft or changing consent.',
    safety: 'danger', sideEffectClass: 'external', cliPath: ['account', 'public-profile', 'resume'],
    path: '/v1/account/public-profile/resume', inputSchema: z.strictObject({}), outputSchema: PublicProfileMutationResultV1Schema,
  }),
  homeDomainActionRow({
    id: 'account.public_profile.update', approval: { result: 'required', flow: 'blocking' }, title: 'Update your public profile',
    approvalInputCustody: 'live_only', projectObservationInput: projectPublicProfileReviewInput,
    approvalPolicy: { uiConfirmation: 'direct' },
    description: 'Apply Public profile changes: hide or show a field such as tokens through policy.fields, edit bio, links or repositories through metadataSelection, change the period through query, blocks through layout, or visitor theme and background through appearance. Submit the chosen draft values explicitly; this does not edit an open form. New facts for wider fields or a changed query are prepared and applied in the same update.',
    safety: 'danger', sideEffectClass: 'external', cliPath: ['account', 'public-profile', 'update'],
    method: 'PUT', path: '/v1/account/public-profile/policy', inputSchema: PublicProfileUpdateIntentV1Schema, outputSchema: PublicProfileUpdateResultV1Schema,
  }),
  homeDomainActionRow({
    id: 'account.public_profile.refresh', approval: { result: 'required', flow: 'blocking' }, title: 'Refresh your public profile',
    approvalPolicy: { uiConfirmation: 'direct' },
    approvalInputCustody: 'live_only', projectObservationInput: projectPublicProfileReviewInput,
    approvalPresentation: { summary: () => 'Your page gets fresh numbers. What it shares stays the same' },
    description: 'Replace facts under the existing consent and prune previously selected project links. Never publish, resume or apply a private draft.',
    safety: 'safe', sideEffectClass: 'external', cliPath: ['account', 'public-profile', 'refresh'],
    method: 'PUT', path: '/v1/account/public-profile/snapshot', inputSchema: z.strictObject({}), outputSchema: PublicProfileMutationResultV1Schema,
  }),
  homeDomainActionRow({
    id: 'account.public_profile.pause', approval: { result: 'required', flow: 'deferred' }, title: 'Pause your public profile',
    approvalPolicy: { uiConfirmation: 'direct' },
    description: 'Hide public facts while retaining the applied edition for an explicit resume.',
    safety: 'danger', sideEffectClass: 'write', cliPath: ['account', 'public-profile', 'pause'],
    path: '/v1/account/public-profile/pause', inputSchema: z.strictObject({}), outputSchema: PublicProfileMutationResultV1Schema,
  }),
  homeDomainActionRow({
    id: 'account.public_profile.unpublish', approval: { result: 'required', flow: 'deferred' }, title: 'Unpublish your public profile',
    confirmVerb: { key: 'publicIdentity.profile.unpublishTitle', fallback: 'Unpublish' }, irreversible: true,
    approvalPresentation: { summary: () => 'Your page, its JSON and badges stop working. Your handle stays yours' },
    description: 'Withdraw and erase the public edition, keeping your Account username and private layouts.',
    safety: 'danger', sideEffectClass: 'write', cliPath: ['account', 'public-profile', 'unpublish'],
    method: 'DELETE', path: '/v1/account/public-profile', inputSchema: z.strictObject({}), outputSchema: PublicProfileMutationResultV1Schema,
  }),
  homeDomainActionRow({
    id: 'account.public_profile.report.get', approval: { result: 'required' }, title: 'Read the public-profile report destination',
    description: 'Read this service operator’s configured report link without sending a report.',
    safety: 'safe', sideEffectClass: 'read', cliPath: ['account', 'public-profile', 'report', 'get'],
    method: 'GET', path: '/v1/account/public-profile/report', inputSchema: PublicProfileReportRequestV1Schema,
    outputSchema: PublicProfileReportResultV1Schema,
  }),
  homeDomainActionRow({
    id: 'account.public_profile.embed.get', approval: { result: 'required' }, title: 'Read a public-profile embed',
    description: 'Format a currently admitted public link, badge or server card. This does not copy, save or share it.',
    safety: 'safe', sideEffectClass: 'read', cliPath: ['account', 'public-profile', 'embed', 'get'],
    method: 'GET', path: '/v1/account/public-profile/embed', inputSchema: PublicEmbedInputV1Schema,
    outputSchema: PublicEmbedResultV1Schema,
  }),
]);
}

export const ACCOUNT_PROFILE_ACTION_SPECS_V1: ReturnType<typeof createAccountProfileActionSpecsV1> = lazyActionSpecArray(createAccountProfileActionSpecsV1);
