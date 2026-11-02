import type { ConversationProviderDescriptorV1 } from '@happier-dev/channels-protocol/v1';

/** GitHub-native facts consumed by the generic Channels relation and Watch owners. */
export const GITHUB_CHANNEL_PULL_REQUESTS = {
    repositoryKind: 'github',
    deployment: 'https://github.com',
    urlTemplate: 'https://github.com/{repository}/pull/{number}',
    repositoryConnectionKeyPrefix: 'github:repository:',
    publicationInstructions: 'Resolve the current Session’s composed source links with '
      + 'happier.triage/actions/sessions/read-source-links-v1 {v:1,sessionId}, then use '
      + 'happier.triage/actions/entries/read-detail-v1 {v:1,entryRef,sourceInstanceId} on the uniquely matched admitted bound PR. '
      + 'Use the source-provided locator and native detail/reobserve Action to confirm that exact target; do not parse a display URL into authority. '
      + 'Preserve its source-presented reply operands and canonical publication plan. If the admitted PR/source match is unavailable or ambiguous, retain the draft and report target-unavailable. '
      + 'For replies, use the selected source’s admitted marked publication Actions: '
      + 'happier.scm.forge.github/actions/github/pull-request/thread-reply for an exact review thread; '
      + 'github/pull-request/review-comment-create for anchored feedback; '
      + 'github/pull-request/submit-review with the comment verdict for a conversation reply, quoting its original conversation URL. '
      + 'Prepare the canonical Reviews publication plan from the selected detail and current base/head before invoking. '
      + 'If the exact admitted target, plan, Action or approval is unavailable, retain the draft and ask or await approval. '
      + 'Do not derive targets from display URLs or fall back to shell gh, raw REST/GraphQL or an unmarked post.',
} as const satisfies NonNullable<ConversationProviderDescriptorV1['pullRequests']>;
