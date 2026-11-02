import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

/** Released JSON spellings, shared by execution presenters and static help. */
export const ACTION_CLI_ENVELOPE_KINDS = Object.freeze({
  'session.list': 'session_list',
  'session.status.get': 'session_status',
  'session.title.set': 'session_set_title',
  'session.permission_mode.set': 'session_set_permission_mode',
  'session.model.set': 'session_set_model',
  'session.archive': 'session_archive',
  'session.unarchive': 'session_unarchive',
  'session.stop': 'session_stop',
  'session.wait.idle': 'session_wait',
  'execution.run.list': 'session_run_list',
  'execution.run.get': 'session_run_get',
  'execution.run.start': 'session_run_start',
  'execution.run.stop': 'session_run_stop',
  'execution.run.wait': 'session_run_wait',
  'execution.run.stream.start': 'session_run_stream_start',
  'execution.run.stream.read': 'session_run_stream_read',
  'execution.run.stream.cancel': 'session_run_stream_cancel',
} as const satisfies Partial<Record<ActionId, string>>);

/** Generic commands retain their path-derived envelope spelling. */
export function actionCliEnvelopeKind(path: readonly string[]): string {
  return path.join('_').replace(/-/g, '_');
}

/** Data-only projection: never imports a presenter or command implementation. */
export function readActionCliPresentationEnvelopeKind(command: Readonly<{
  actionId: ActionId;
  path: readonly string[];
}>): string | undefined {
  if (command.actionId === 'session.message.send') {
    return command.path.join(' ') === 'session run send' ? 'session_run_send' : 'session_send';
  }
  const kinds: Readonly<Partial<Record<ActionId, string>>> = ACTION_CLI_ENVELOPE_KINDS;
  return kinds[command.actionId];
}

/** Actions whose CLI invocation can wait for a finite settlement (`--wait`). */
export function supportsFiniteActionOutcome(actionId: string): boolean {
  return actionId === 'deployments.deploy' || actionId === 'deployments.rollback'
    || actionId === 'deployments.promote' || actionId === 'deployments.teardown'
    || actionId === 'action.operations.get';
}
