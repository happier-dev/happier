import { RPC_METHODS, SESSION_RPC_METHODS } from '../../../../rpc.js';

export type MachineRpcGovernanceClassification = 'action_spec_bound' | 'internal_only' | 'advisory_unclassified';

export type MachineRpcGovernanceMetadataV1 = Readonly<{
  rpcClassification: MachineRpcGovernanceClassification;
  actionSpecId?: string;
}>;

const ACTION_SPEC_RPC_METHOD_IDS = Object.freeze({
  [RPC_METHODS.SPAWN_HAPPY_SESSION]: 'session.spawn_new',
  [RPC_METHODS.STOP_SESSION]: 'session.stop',
  [RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY]: 'session.continue_with_replay',
  [RPC_METHODS.SESSION_FORK]: 'session.fork',
  [SESSION_RPC_METHODS.SESSION_ROLLBACK]: 'session.rollback',
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_START]: 'session.handoff',
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET]: 'session.handoff.prepare_target',
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT]: 'session.handoff.commit',
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT]: 'session.handoff.abort',
  [RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET]: 'session.handoff.status.get',
  [SESSION_RPC_METHODS.EXECUTION_RUN_START]: 'execution.run.start',
  [SESSION_RPC_METHODS.EXECUTION_RUN_LIST]: 'execution.run.list',
  [SESSION_RPC_METHODS.EXECUTION_RUN_GET]: 'execution.run.get',
  [SESSION_RPC_METHODS.EXECUTION_RUN_SEND]: 'execution.run.send',
  [SESSION_RPC_METHODS.EXECUTION_RUN_STOP]: 'execution.run.stop',
  [SESSION_RPC_METHODS.EXECUTION_RUN_ACTION]: 'execution.run.action',
  [RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST]: 'sessions.external.candidates.list',
  [RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE]: 'sessions.external.link.ensure',
  [RPC_METHODS.DAEMON_DIRECT_SESSION_ATTACH]: 'sessions.external.attach',
  [RPC_METHODS.DAEMON_DIRECT_SESSION_DETACH]: 'sessions.external.detach',
  [RPC_METHODS.DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET]: 'sessions.external.followPolicy.set',
  [RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET]: 'sessions.external.status.get',
  [RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE]: 'sessions.external.transcript.page',
  [RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER]: 'sessions.external.transcript.readAfter',
  [RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER]: 'sessions.external.takeover',
  [RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST]: 'sessions.external.takeover',
  [RPC_METHODS.SCM_PULL_REQUEST_LIST]: 'scm.pullRequest.list',
  [RPC_METHODS.SCM_PULL_REQUEST_GET]: 'scm.pullRequest.get',
  [RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE]: 'scm.pullRequest.openOrReuse',
  [RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE]: 'scm.pullRequest.openCompose',
  [RPC_METHODS.SCM_PULL_REQUEST_CHECKOUT]: 'scm.pullRequest.checkout',
  [RPC_METHODS.SCM_PULL_REQUEST_PREPARE_WORKTREE]: 'scm.pullRequest.prepareWorktree',
  [RPC_METHODS.SCM_PULL_REQUEST_RUN_STACKED]: 'scm.pullRequest.runStacked',
  [RPC_METHODS.SCM_REPOSITORY_INIT]: 'scm.repository.init',
  [RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK]: 'scm.repository.removeIndexLock',
  [RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS]: 'scm.hostingRepository.describePublishTargets',
  [RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH]: 'scm.hostingRepository.publish',
} satisfies Readonly<Record<string, string>>);

const PMS5_DIRECT_INTERNAL_METHODS = new Set<string>([
  RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST,
  RPC_METHODS.DAEMON_MEMORY_STATUS,
  RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST,
  RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS,
  RPC_METHODS.DAEMON_EXTENSIONS_RELOAD_STATUS,
  RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
  RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES,
  RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS,
  RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_SOURCES,
  RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_GET,
  RPC_METHODS.SCM_BACKEND_DESCRIBE,
  RPC_METHODS.CAPABILITIES_DESCRIBE,
]);

const A12_EXECUTION_RUN_INTERNAL_METHODS = new Set<string>([
  SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
  SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
  SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
  SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ,
  SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
]);

export function resolveMachineRpcGovernance(method: string): MachineRpcGovernanceMetadataV1 {
  const actionSpecId = ACTION_SPEC_RPC_METHOD_IDS[method as keyof typeof ACTION_SPEC_RPC_METHOD_IDS];
  if (actionSpecId) {
    return { rpcClassification: 'action_spec_bound', actionSpecId };
  }
  if (
    method === RPC_METHODS.STOP_DAEMON
    || PMS5_DIRECT_INTERNAL_METHODS.has(method)
    || A12_EXECUTION_RUN_INTERNAL_METHODS.has(method)
  ) {
    return { rpcClassification: 'internal_only' };
  }
  return { rpcClassification: 'advisory_unclassified' };
}
