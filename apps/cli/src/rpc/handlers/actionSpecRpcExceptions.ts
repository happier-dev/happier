import type { ActionId } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

export const ACTION_SPEC_RPC_EXCEPTION_REASONS = Object.freeze([
    'legacy_alias',
    'custom_result_envelope',
    'subscription_transport',
    'custom_context_extraction',
    'custom_executor_construction',
    'internal_only_compat',
    'packet_owned_coordination',
] as const);

export type ActionSpecRpcExceptionReason = (typeof ACTION_SPEC_RPC_EXCEPTION_REASONS)[number];

export type ActionSpecRpcException = Readonly<{
    method: string;
    actionId?: ActionId | string;
    reason: ActionSpecRpcExceptionReason;
    ownerPacket: string;
    rationale: string;
    abiProof?: string;
    retirement?: string;
    permanence?: string;
}>;

const SCM_PULL_REQUEST_PACKET_OWNER = 'SCM pull-request packet chain';
const SCM_REPOSITORY_PACKET_OWNER = 'SCM repository coordination lane';
const SCM_HOSTING_PACKET_OWNER = 'SCM hosting-provider packet chain';
const SCM_DIFF_SUMMARY_PACKET_OWNER = 'SCM diff-summary packet chain';

const SCM_PULL_REQUEST_RETIREMENT =
    'Retire when the first SCM pull-request implementation packet registers this ActionSpec RPC method through the generic registrar.';
const SCM_REPOSITORY_RETIREMENT =
    'Retire when the SCM repository packet exposes this action through the generic registrar.';
const SCM_HOSTING_RETIREMENT =
    'Retire when SCM hosting-provider write flows land and register this ActionSpec RPC method through the generic registrar.';
const SCM_DIFF_SUMMARY_RETIREMENT =
    'Retire when the SCM diff-summary implementation packet registers this ActionSpec RPC method through the generic registrar.';

export const ACTION_SPEC_RPC_EXCEPTIONS = Object.freeze([
    {
        method: RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY,
        actionId: 'sessions.external.takeover',
        reason: 'custom_result_envelope',
        ownerPacket: 'A.12.0-addendum-rpc-action-registrar',
        rationale: 'Direct-session takeover preserves shipped direct-session request parsing and response envelopes that differ from generic ActionSpec result unwrapping.',
        abiProof: 'daemon.directSessions.takeover accepts { machineId, sessionId, forceStop? } and returns DirectSessionTakeoverResponse; daemon.directSessions.takeoverPersist accepts { machineId, sessionId, forceStop? } and returns DirectSessionTakeoverPersistResponse with converted persistence metadata. Generic ActionSpec input/result use linkedSessionId, targetRuntimeMode, storageMode, and ExternalSessionTakeoverResultV1.',
        retirement: 'Retire when direct-session takeover ABI is folded into generic ActionSpec RPC result unwrapping without changing wire compatibility.',
    },
    {
        method: RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY,
        actionId: 'sessions.external.takeover',
        reason: 'legacy_alias',
        ownerPacket: 'A.12.0-addendum-rpc-action-registrar',
        rationale: 'Compatibility alias for the shipped direct-session takeoverPersist wire method.',
        retirement: 'Retire only in a dedicated wire-compat packet that removes the shipped takeoverPersist alias.',
    },
    {
        method: RPC_METHODS.SCM_PULL_REQUEST_LIST,
        actionId: 'scm.pullRequest.list',
        reason: 'packet_owned_coordination',
        ownerPacket: SCM_PULL_REQUEST_PACKET_OWNER,
        rationale: 'SCM pull-request RPC implementation is owned by the SCM pull-request packet chain during registrar convergence.',
        retirement: SCM_PULL_REQUEST_RETIREMENT,
    },
    {
        method: RPC_METHODS.SCM_PULL_REQUEST_GET,
        actionId: 'scm.pullRequest.get',
        reason: 'packet_owned_coordination',
        ownerPacket: SCM_PULL_REQUEST_PACKET_OWNER,
        rationale: 'SCM pull-request RPC implementation is owned by the SCM pull-request packet chain during registrar convergence.',
        retirement: SCM_PULL_REQUEST_RETIREMENT,
    },
    {
        method: RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
        actionId: 'scm.pullRequest.openOrReuse',
        reason: 'packet_owned_coordination',
        ownerPacket: SCM_PULL_REQUEST_PACKET_OWNER,
        rationale: 'SCM pull-request RPC implementation is owned by the SCM pull-request packet chain during registrar convergence.',
        retirement: SCM_PULL_REQUEST_RETIREMENT,
    },
    {
        method: RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
        actionId: 'scm.pullRequest.openCompose',
        reason: 'packet_owned_coordination',
        ownerPacket: SCM_PULL_REQUEST_PACKET_OWNER,
        rationale: 'SCM pull-request RPC implementation is owned by the SCM pull-request packet chain during registrar convergence.',
        retirement: SCM_PULL_REQUEST_RETIREMENT,
    },
    {
        method: RPC_METHODS.SCM_PULL_REQUEST_CHECKOUT,
        actionId: 'scm.pullRequest.checkout',
        reason: 'packet_owned_coordination',
        ownerPacket: SCM_PULL_REQUEST_PACKET_OWNER,
        rationale: 'SCM pull-request RPC implementation is owned by the SCM pull-request packet chain during registrar convergence.',
        retirement: SCM_PULL_REQUEST_RETIREMENT,
    },
    {
        method: RPC_METHODS.SCM_PULL_REQUEST_PREPARE_WORKTREE,
        actionId: 'scm.pullRequest.prepareWorktree',
        reason: 'packet_owned_coordination',
        ownerPacket: SCM_PULL_REQUEST_PACKET_OWNER,
        rationale: 'SCM pull-request RPC implementation is owned by the SCM pull-request packet chain during registrar convergence.',
        retirement: SCM_PULL_REQUEST_RETIREMENT,
    },
    {
        method: RPC_METHODS.SCM_PULL_REQUEST_RUN_STACKED,
        actionId: 'scm.pullRequest.runStacked',
        reason: 'packet_owned_coordination',
        ownerPacket: SCM_PULL_REQUEST_PACKET_OWNER,
        rationale: 'SCM pull-request RPC implementation is owned by the SCM pull-request packet chain during registrar convergence.',
        retirement: SCM_PULL_REQUEST_RETIREMENT,
    },
    {
        method: RPC_METHODS.SCM_REPOSITORY_INIT,
        actionId: 'scm.repository.init',
        reason: 'packet_owned_coordination',
        ownerPacket: SCM_REPOSITORY_PACKET_OWNER,
        rationale: 'SCM repository RPC implementation is owned by the repository packet chain during registrar convergence.',
        retirement: SCM_REPOSITORY_RETIREMENT,
    },
    {
        method: RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
        actionId: 'scm.repository.removeIndexLock',
        reason: 'packet_owned_coordination',
        ownerPacket: SCM_REPOSITORY_PACKET_OWNER,
        rationale: 'SCM repository RPC implementation is owned by the repository packet chain during registrar convergence.',
        retirement: SCM_REPOSITORY_RETIREMENT,
    },
    {
        method: RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
        actionId: 'scm.hostingRepository.describePublishTargets',
        reason: 'packet_owned_coordination',
        ownerPacket: SCM_HOSTING_PACKET_OWNER,
        rationale: 'SCM hosting-provider RPC implementation is owned by the SCM hosting-provider packet chain during registrar convergence.',
        retirement: SCM_HOSTING_RETIREMENT,
    },
    {
        method: RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
        actionId: 'scm.hostingRepository.publish',
        reason: 'packet_owned_coordination',
        ownerPacket: SCM_HOSTING_PACKET_OWNER,
        rationale: 'SCM hosting-provider RPC implementation is owned by the SCM hosting-provider packet chain during registrar convergence.',
        retirement: SCM_HOSTING_RETIREMENT,
    },
    {
        method: RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE,
        actionId: 'scm.diffSummary.generate',
        reason: 'packet_owned_coordination',
        ownerPacket: SCM_DIFF_SUMMARY_PACKET_OWNER,
        rationale: 'SCM diff-summary RPC implementation is not present in the CLI handler tree yet and is owned by the SCM diff-summary implementation packet.',
        retirement: SCM_DIFF_SUMMARY_RETIREMENT,
    },
] satisfies readonly ActionSpecRpcException[]);
