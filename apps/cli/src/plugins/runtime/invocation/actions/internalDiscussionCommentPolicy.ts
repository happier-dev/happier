import { isExternalTaskDiscussionId } from '@happier-dev/protocol/discussions/references';
import { SessionInputSourceSessionV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';

export const INTERNAL_DISCUSSION_REPLY_REQUIRED = 'discussion_internal_reply_required';
export const INTERNAL_DISCUSSION_REPLY_MESSAGE = 'Reply in the Internal Discussion.';

/** Caller-supplied Action operands never establish the Discussion origin. */
export function readActionSourceDiscussionId(source: unknown): string | undefined {
  if (source == null) return undefined;
  const parsed = SessionInputSourceSessionV1Schema.safeParse(source);
  return parsed.success ? parsed.data.discussionAddressing?.discussionId : undefined;
}

export async function blocksPublicProviderComment(
  discussionId: string | undefined,
  action: PluginContributionIdentityV1 | null,
): Promise<boolean> {
  return !!discussionId && isExternalTaskDiscussionId(discussionId) && action !== null
    && await isPublicProviderCommentAction(action);
}

/** Use the provider-owned Action identities, including routes that publish review replies. */
async function isPublicProviderCommentAction(action: PluginContributionIdentityV1): Promise<boolean> {
  const [github, gitlab, bitbucket, azure, linear, jira] = await Promise.all([
    import('@happier-dev/plugins-scm-github/manifest'),
    import('@happier-dev/plugins-scm-gitlab'),
    import('@happier-dev/plugins-scm-bitbucket'),
    import('@happier-dev/plugins-scm-azure-devops'),
    import('@happier-dev/plugins-linear'),
    import('@happier-dev/plugins-jira'),
  ]);
  const localId = action.localId;
  switch (action.pluginId) {
    case github.PLUGIN_MANIFEST.id: {
      const ids = github.GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1;
      return localId === ids.commentCreate || localId === ids.commentEdit || localId === ids.issueComment
        || localId === ids.pullRequestReviewCommentCreate || localId === ids.pullRequestThreadReply
        || localId === ids.pullRequestSubmitReview || localId === ids.pendingReviewCreate || localId === ids.pendingReviewSubmit;
    }
    case gitlab.PLUGIN_MANIFEST.id: {
      const ids = gitlab.GITLAB_TRIAGE_MUTATION_ACTION_IDS;
      return localId === ids.issueComment || localId === ids.mergeRequestSubmitReview
        || localId === ids.mergeRequestReviewCommentCreate || localId === ids.mergeRequestThreadReply;
    }
    case bitbucket.PLUGIN_MANIFEST.id: {
      const ids = bitbucket.BITBUCKET_TRIAGE_MUTATION_ACTION_IDS;
      return localId === ids.submitReview || localId === ids.createReviewComment || localId === ids.replyToReviewComment;
    }
    case azure.PLUGIN_MANIFEST.id: {
      const ids = azure.AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS;
      return localId === ids.submitReview || localId === ids.threadCommentCreate || localId === ids.threadReply;
    }
    case linear.LINEAR_PLUGIN_ID: return localId === linear.LINEAR_ACTIONS.comment;
    case jira.JIRA_PLUGIN_ID: return localId === jira.JIRA_ACTIONS.comment;
    default: return false;
  }
}
