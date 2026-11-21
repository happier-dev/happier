const entryDetail = 'happier.triage/actions/entries/read-detail-v1';
const reobserve = 'happier.triage/actions/entries/reobserve-v1';

const locatorDescription = 'Use the exact entry locator from happier.triage/actions/entries/resolve-resource-v1 (GitHub URL), or the matching connection’s observation.outcome.locator from happier.triage/actions/entries/list-v1. You can refresh it with ' + reobserve + ' by passing it as lastKnownLocator.';

const entryFields = [
    { path: 'instance', title: 'Configured source instance', widget: 'json', required: true,
        description: 'Call ' + entryDetail + ' with v:1, entryRef and sourceInstanceId from the selected entry. Copy the entire result.instance unchanged, including its non-secret configuration token.' },
    { path: 'localRef', title: 'Source entry reference', widget: 'json', required: true,
        description: 'Copy kindId, collisionScope and entryId from the selected entryRef into localRef.' },
] as const;

const locatorFields = {
    routingToken: { path: 'routingToken', title: 'Source routing token', widget: 'text', required: true,
        description: locatorDescription + ' Copy the locator’s routingToken unchanged.' },
    lastKnownLocator: { path: 'lastKnownLocator', title: 'Source entry locator', widget: 'json', required: true,
        description: locatorDescription + ' Copy the entire locator unchanged.' },
} as const;

type FieldHint = Readonly<{
    path: string;
    title: string;
    widget: 'text' | 'json';
    required: true;
    description: string;
}>;

export const triageReviewedHeadInputDescriptionV1 =
    `Call ${reobserve} with entryRef, sourceInstanceId and lastKnownLocator. Use observation.outcome.snapshot.reviewRevision.headSha for the current source commit and confirm it is the head you reviewed.`;

export const triageReviewPublicationPlanInputDescriptionV1 =
    'Use the reviewed baseSha and headSha from observation.outcome.snapshot.reviewRevision in entries/reobserve-v1. '
    + 'Build target from localRef, the configured instance’s source (pluginId/localId) and account, and the provider named by this Action. '
    + 'Use reviews.list to identify the review and reviews.comments.list or reviews.comments.get for the selected proposals. '
    + 'Each entry uses the proposal id as happierCommentId and serverRevision as expectedServerRevision, with its anchor, snapshot and publication body. '
    + 'Set the verdict to the requested review decision.';

/** The public read-to-write handoff for Actions that target a configured source entry. */
export function triageEntryActionInputHintsV1(locator: keyof typeof locatorFields, ...fields: FieldHint[]) {
    return { fields: [...entryFields, locatorFields[locator], ...fields] };
}
