import type { ActionId } from '@happier-dev/protocol';

import type { CompiledActionCliCommand } from './compiledCommands';

/**
 * The stable JSON envelope kind a compiled friendly command uses. Released
 * spellings such as `session_send` and `machines_list` are exactly the command
 * path in snake case, so the derivation preserves them without a table.
 */
export function actionCliEnvelopeKind(path: readonly string[]): string {
  return path.join('_').replace(/-/g, '_');
}

export type ActionCliPresentationContext = Readonly<{
  command: CompiledActionCliCommand;
  json: boolean;
  /** The canonical Action input this invocation used, after binding. */
  input: Readonly<Record<string, unknown>>;
  /** Validated friendly caller input, including presentation-only fields. */
  callerInput: Readonly<Record<string, unknown>>;
}>; 

export type ActionCliFailure = Readonly<{
  errorCode: string;
  errorMessage?: string;
  candidates?: readonly string[];
  details?: unknown;
}>;

/**
 * Command-owned presentation over an already executed canonical result.
 *
 * A presenter may not parse argv, change Action input, choose a target or invoke
 * another Action: by the time it runs, the invocation is finished. It exists so
 * migrating a command's *input* grammar to the compiler does not regress its
 * human output or its released JSON shape.
 */
export type ActionCliPresentation = Readonly<{
  /** Overrides the derived envelope kind, for a compatibility spelling. */
  envelopeKind?: (command: CompiledActionCliCommand) => string;
  /**
   * Demotes a canonical success whose payload says the operation did not take
   * effect. An Action may declare its whole outcome union as successful output
   * (typed consumers read the status); the CLI must not print success or exit
   * zero for such a payload. Return `null` to present the payload as success.
   * The returned failure flows through `failureFields` and `describeFailure`.
   */
  classifyResult?: (
    payload: unknown,
    context: ActionCliPresentationContext,
  ) => ActionCliFailure | null;
  /** Returns true when it fully presented the payload. */
  presentSuccess?: (
    payload: unknown,
    context: ActionCliPresentationContext,
  ) => boolean | Promise<boolean>;
  /** Extra JSON error fields, such as a retry identity. */
  failureFields?: (
    failure: ActionCliFailure,
    context: ActionCliPresentationContext,
  ) => Readonly<Record<string, unknown>> | null;
  /** Extra human guidance appended to the failure message. */
  describeFailure?: (
    failure: ActionCliFailure,
    context: ActionCliPresentationContext,
  ) => string | null;
}>;

/**
 * One bounded CLI-local presentation map keyed by canonical Action ID. It holds
 * no paths, input fields, validation, authorization, routing or execution: an
 * Action without an entry uses the generic presenter, so this is composition
 * rather than a second command registry. Entries load lazily for the same reason
 * command handlers do — presenting one Action must not pull every other Action's
 * output module into a cold CLI start.
 */
const PRESENTATION_LOADERS: Partial<Record<ActionId, () => Promise<ActionCliPresentation>>> = {
  'localServices.inventory.list': async () => (await import('./localServicesPresentation')).LOCAL_SERVICES_PRESENTATION,
  'localServices.inventory.refresh': async () => (await import('./localServicesPresentation')).LOCAL_SERVICES_PRESENTATION,
  'localServices.launcher.snapshot': async () => (await import('./localServicesPresentation')).LOCAL_SERVICES_PRESENTATION,
  'localServices.launcher.start': async () => (await import('./localServicesPresentation')).LOCAL_SERVICES_PRESENTATION,
  'localServices.launcher.registerPreview': async () => (await import('./localServicesPresentation')).LOCAL_SERVICES_PRESENTATION,
  'localServices.launcher.history.clear': async () => (await import('./localServicesPresentation')).LOCAL_SERVICES_PRESENTATION,
  'localServices.preview.openOrCreate': async () => (await import('./localServicesPresentation')).LOCAL_SERVICES_PRESENTATION,
  'localServices.preview.status': async () => (await import('./localServicesPresentation')).LOCAL_SERVICES_PRESENTATION,
  'localServices.preview.revoke': async () => (await import('./localServicesPresentation')).LOCAL_SERVICES_PRESENTATION,
  'localServices.publicPreview.create': async () => (await import('./localServicesPresentation')).LOCAL_SERVICES_PRESENTATION,
  'localServices.publicPreview.status': async () => (await import('./localServicesPresentation')).LOCAL_SERVICES_PRESENTATION,
  'localServices.publicPreview.revoke': async () => (await import('./localServicesPresentation')).LOCAL_SERVICES_PRESENTATION,
  'localServices.actions.forget': async () => (await import('./localServicesPresentation')).LOCAL_SERVICES_PRESENTATION,
  'localServices.actions.stopManaged': async () => (await import('./localServicesPresentation')).LOCAL_SERVICES_PRESENTATION,
  'localServices.actions.restartManaged': async () => (await import('./localServicesPresentation')).LOCAL_SERVICES_PRESENTATION,
  'localServices.actions.terminateDetected': async () => (await import('./localServicesPresentation')).LOCAL_SERVICES_PRESENTATION,
  'projects.execution.output.read': async () => (
    await import('./outputPresentation')
  ).PROJECT_EXECUTION_OUTPUT_READ_PRESENTATION,
  'projects.execution.output.copy': async () => (
    await import('./outputPresentation')
  ).PROJECT_EXECUTION_OUTPUT_COPY_PRESENTATION,
  'session.list': async () => (
    await import('@/cli/commands/session/sessionListPresentation')
  ).SESSION_LIST_PRESENTATION,
  'action.spec.search': async () => (
    await import('@/cli/commands/actionsPresentation')
  ).ACTION_SPEC_SEARCH_PRESENTATION,
  'action.spec.get': async () => (
    await import('@/cli/commands/actionsPresentation')
  ).ACTION_SPEC_GET_PRESENTATION,
  'session.message.send': async () => (
    await import('@/cli/commands/session/sendPresentation')
  ).SESSION_SEND_PRESENTATION,
  'machines.list': async () => (
    await import('@/cli/commands/machinesPresentation')
  ).MACHINES_LIST_PRESENTATION,
  'session.status.get': async () => (
    await import('@/cli/commands/session/sessionLeafPresentation')
  ).SESSION_STATUS_PRESENTATION,
  'session.title.set': async () => (
    await import('@/cli/commands/session/sessionLeafPresentation')
  ).SESSION_SET_TITLE_PRESENTATION,
  'session.permission_mode.set': async () => (
    await import('@/cli/commands/session/sessionLeafPresentation')
  ).SESSION_SET_PERMISSION_MODE_PRESENTATION,
  'session.model.set': async () => (
    await import('@/cli/commands/session/sessionLeafPresentation')
  ).SESSION_SET_MODEL_PRESENTATION,
  'session.archive': async () => (
    await import('@/cli/commands/session/sessionLeafPresentation')
  ).SESSION_ARCHIVE_PRESENTATION,
  'session.unarchive': async () => (
    await import('@/cli/commands/session/sessionLeafPresentation')
  ).SESSION_UNARCHIVE_PRESENTATION,
  'session.stop': async () => (
    await import('@/cli/commands/session/sessionLeafPresentation')
  ).SESSION_STOP_PRESENTATION,
  wait: async () => (
    await import('./waitPresentation')
  ).WAIT_PRESENTATION,
  'session.wait.idle': async () => (
    await import('@/cli/commands/session/sessionLeafPresentation')
  ).SESSION_WAIT_PRESENTATION,
  'execution.run.list': async () => (
    await import('@/cli/commands/session/run/executionRunPresentation')
  ).EXECUTION_RUN_LIST_PRESENTATION,
  'execution.run.get': async () => (
    await import('@/cli/commands/session/run/executionRunPresentation')
  ).EXECUTION_RUN_GET_PRESENTATION,
  'execution.run.start': async () => (
    await import('@/cli/commands/session/run/executionRunPresentation')
  ).EXECUTION_RUN_START_PRESENTATION,
  'execution.run.stop': async () => (
    await import('@/cli/commands/session/run/executionRunPresentation')
  ).EXECUTION_RUN_STOP_PRESENTATION,
  'execution.run.wait': async () => (
    await import('@/cli/commands/session/run/executionRunPresentation')
  ).EXECUTION_RUN_WAIT_PRESENTATION,
  'execution.run.stream.start': async () => (
    await import('@/cli/commands/session/run/executionRunPresentation')
  ).EXECUTION_RUN_STREAM_START_PRESENTATION,
  'execution.run.stream.read': async () => (
    await import('@/cli/commands/session/run/executionRunPresentation')
  ).EXECUTION_RUN_STREAM_READ_PRESENTATION,
  'execution.run.stream.cancel': async () => (
    await import('@/cli/commands/session/run/executionRunPresentation')
  ).EXECUTION_RUN_STREAM_CANCEL_PRESENTATION,
  'session.discussion.list': async () => (
    await import('@/cli/commands/session/discussionPresentation')
  ).SESSION_DISCUSSION_LIST_PRESENTATION,
  'session.discussion.get': async () => (
    await import('@/cli/commands/session/discussionPresentation')
  ).SESSION_DISCUSSION_DETAILS_PRESENTATION,
  'session.discussion.read': async () => (
    await import('@/cli/commands/session/discussionPresentation')
  ).SESSION_DISCUSSION_READ_PRESENTATION,
  'session.discussion.create': async () => (
    await import('@/cli/commands/session/discussionPresentation')
  ).SESSION_DISCUSSION_CREATE_PRESENTATION,
  'session.discussion.post': async () => (
    await import('@/cli/commands/session/discussionPresentation')
  ).SESSION_DISCUSSION_POST_PRESENTATION,
  'session.discussion.rename': async () => (
    await import('@/cli/commands/session/discussionPresentation')
  ).SESSION_DISCUSSION_RENAME_PRESENTATION,
  'session.discussion.archive': async () => (
    await import('@/cli/commands/session/discussionPresentation')
  ).SESSION_DISCUSSION_ARCHIVE_PRESENTATION,
  'session.discussion.restore': async () => (
    await import('@/cli/commands/session/discussionPresentation')
  ).SESSION_DISCUSSION_RESTORE_PRESENTATION,
  'session.discussion.read_state.set': async () => (
    await import('@/cli/commands/session/discussionPresentation')
  ).SESSION_DISCUSSION_READ_STATE_PRESENTATION,
};

export function listActionCliPresentationActionIds(): readonly ActionId[] {
  return Object.freeze(Object.keys(PRESENTATION_LOADERS) as ActionId[]);
}

export async function loadActionCliPresentation(
  actionId: ActionId,
): Promise<ActionCliPresentation | null> {
  const loader = PRESENTATION_LOADERS[actionId];
  return loader ? await loader() : null;
}
