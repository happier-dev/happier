export function describeStackRuntimeCleanupFailure(actions) {
  const reason = String(actions.finalization?.reason ?? actions.stopAuthorization?.reason ?? 'unknown');
  const details = (actions.errors ?? []).map(failure => failure.error).filter(Boolean).join('; ');
  return details ? `${reason}: ${details}` : reason;
}

export function createStackRuntimeCleanupIncompleteError(actions, { stackName = actions.stackName ?? 'stack', restart = false } = {}) {
  const sessionsRemain = actions.finalization?.reason === 'session_cleanup_incomplete'
    || actions.daemonSessionsStopped?.ok === false;
  const recovery = actions.stopAuthorization?.authorized === false || actions.finalization?.reason === 'successor_state'
    ? null
    : `hstack stack stop ${stackName} --yes --no-docker`
      + (sessionsRemain ? ` --preserve-daemon && hstack stack daemon ${stackName} stop --json` : '')
      + (restart ? ` && hstack stack start ${stackName} --restart --reuse-source-runtime` : '');
  return Object.assign(new Error(
    `[stack] ${stackName} stop cleanup is incomplete (${describeStackRuntimeCleanupFailure(actions)})`
      + (recovery ? `. Recovery: ${recovery}` : ''),
  ), {
    code: 'ESTACKRUNTIMECLEANUPINCOMPLETE', phase: 'stop', retryable: false, recovery, actions,
  });
}
