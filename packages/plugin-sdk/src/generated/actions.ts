import type {
  ApprovalRequestV1,
  ScmHostingRepositoryDescribePublishTargetsRequest,
  ScmHostingRepositoryDescribePublishTargetsResponse,
  ScmHostingRepositoryPublishRequest,
  ScmHostingRepositoryPublishResponse,
  ScmRepositoryCloneInput,
  ScmRepositoryCloneOutput,
  ScmDiffSummaryGenerateInput,
  ScmDiffSummaryGenerateOutput,
  ScmPullRequestCheckoutRequest,
  ScmPullRequestCheckoutResponse,
  ScmPullRequestGetRequest,
  ScmPullRequestGetResponse,
  ScmPullRequestListRequest,
  ScmPullRequestListResponse,
  ScmPullRequestOpenComposeRequest,
  ScmPullRequestOpenComposeResponse,
  ScmPullRequestOpenOrReuseRequest,
  ScmPullRequestOpenOrReuseResponse,
  ScmPullRequestPrepareWorktreeRequest,
  ScmPullRequestPrepareWorktreeResponse,
  ScmPullRequestRunStackedRequest,
  ScmPullRequestRunStackedResponse,
  ScmRepositoryInitRequest,
  ScmRepositoryInitResponse,
  ScmRepositoryRemoveIndexLockRequest,
  ScmRepositoryRemoveIndexLockResponse,
} from '@happier-dev/protocol';
import type { ApprovalQueueListResultV1 } from '@happier-dev/protocol/actions';

export type PluginSdkActionMethodV1<Input = unknown, Output = unknown> = (input: Input) => Promise<Output>;

export type PluginActionApprovalRequestInputV1 = Readonly<{
  actionId: string;
  args?: unknown;
  summary?: string;
  surface?: string;
}>;

export type PluginActionApprovalRequestResultV1 = Readonly<{
  approvalRequestId: string;
}>;

export type PluginActionApprovalsServiceV1 = Readonly<{
  request: PluginSdkActionMethodV1<PluginActionApprovalRequestInputV1, PluginActionApprovalRequestResultV1>;
  get: PluginSdkActionMethodV1<string, ApprovalRequestV1 | null>;
  list: PluginSdkActionMethodV1<
    Readonly<{ status?: ApprovalRequestV1['status'] | null; limit?: number | null }> | undefined,
    ApprovalQueueListResultV1
  >;
}>;

export type PluginActionsV1 = Readonly<{
  approvals: PluginActionApprovalsServiceV1;
  scm: Readonly<{
    pullRequest: Readonly<{
      list: PluginSdkActionMethodV1<ScmPullRequestListRequest, ScmPullRequestListResponse>;
      get: PluginSdkActionMethodV1<ScmPullRequestGetRequest, ScmPullRequestGetResponse>;
      openOrReuse: PluginSdkActionMethodV1<
        ScmPullRequestOpenOrReuseRequest,
        ScmPullRequestOpenOrReuseResponse
      >;
      openCompose: PluginSdkActionMethodV1<
        ScmPullRequestOpenComposeRequest,
        ScmPullRequestOpenComposeResponse
      >;
      checkout: PluginSdkActionMethodV1<ScmPullRequestCheckoutRequest, ScmPullRequestCheckoutResponse>;
      prepareWorktree: PluginSdkActionMethodV1<
        ScmPullRequestPrepareWorktreeRequest,
        ScmPullRequestPrepareWorktreeResponse
      >;
      runStacked: PluginSdkActionMethodV1<
        ScmPullRequestRunStackedRequest,
        ScmPullRequestRunStackedResponse
      >;
    }>;
    repository: Readonly<{
      /** `ctx.actions.scm.repository.clone(...)`. */
      clone: PluginSdkActionMethodV1<ScmRepositoryCloneInput, ScmRepositoryCloneOutput>;
      /** `ctx.actions.scm.repository.init(...)`. */
      init: PluginSdkActionMethodV1<ScmRepositoryInitRequest, ScmRepositoryInitResponse>;
      /** `ctx.actions.scm.repository.removeIndexLock(...)`. */
      removeIndexLock: PluginSdkActionMethodV1<
        ScmRepositoryRemoveIndexLockRequest,
        ScmRepositoryRemoveIndexLockResponse
      >;
    }>;
    hostingRepository: Readonly<{
      /** `ctx.actions.scm.hostingRepository.describePublishTargets(...)`. */
      describePublishTargets: PluginSdkActionMethodV1<
        ScmHostingRepositoryDescribePublishTargetsRequest,
        ScmHostingRepositoryDescribePublishTargetsResponse
      >;
      /** `ctx.actions.scm.hostingRepository.publish(...)`. */
      publish: PluginSdkActionMethodV1<
        ScmHostingRepositoryPublishRequest,
        ScmHostingRepositoryPublishResponse
      >;
    }>;
    diffSummary: Readonly<{
      /** `ctx.actions.scm.diffSummary.generate(...)`. */
      generate: PluginSdkActionMethodV1<
        ScmDiffSummaryGenerateInput,
        ScmDiffSummaryGenerateOutput
      >;
    }>;
  }>;
}>;
export type PluginActionsServiceV1 = PluginActionsV1;
