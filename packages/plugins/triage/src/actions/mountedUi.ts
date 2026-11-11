import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import { TRIAGE_SOURCE_PANEL_REVEAL_ACTION_V1, TRIAGE_SOURCE_PANEL_INSERT_ACTION_V1 } from '@happier-dev/triage-sources/runtime';
import { invokeTriageMountedUiAction } from '../ui/mountedActions.js';
import { TRIAGE_TASKS_OPEN_CREATE_ACTION_LOCAL_ID_V1, TriageTaskDraftV1Schema,
  TRIAGE_TASKS_CHECK_WRITE_ACTION_LOCAL_ID_V1, TriageCheckTaskWriteInputV1Schema } from './tasksProtocol.js';
import { checkTriageTaskWrite } from '../ui/detail/taskWrite.js';
import { TRIAGE_TASK_DETAIL_DESTINATION_V1 } from '../composer/openEntryDetails.js';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { TRIAGE_RESOURCE_DETAILS_LOCAL_ID_V1 } from '../ui/contributions.js';

/** The Session's own details tab (container `detailsTab`, target Session): a draft from a message opens beside it. */
const TRIAGE_SESSION_DETAILS_DESTINATION_V1 = Object.freeze({
  pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: TRIAGE_RESOURCE_DETAILS_LOCAL_ID_V1,
});
import { stageTriageTaskDraft } from '../ui/taskDraftHandoff.js';
import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, TriageMountedUiInputV1Schema, TriageMountedSourceRevealInputV1Schema, TriageMountedSourceInsertInputV1Schema, type TriageMountedUiInputV1, type TriageMountedUiResultV1 } from './mountedUiProtocol.js';

function proposeMessageTaskTitle(quote: string | null | undefined): string | undefined {
  const firstLine = quote?.split(/\r?\n/u).find(line => line.trim().length > 0)?.trim();
  if (firstLine === undefined) return undefined;
  // A sentence terminal proposes the title; unpunctuated text stays intact in every host.
  return firstLine.match(/^.*?(?:[.!?](?=\s|$)|[。！？])/u)?.[0].trim() ?? firstLine;
}

export function createTriageMountedUiActionHandler(): PluginClientActionHandler<TriageMountedUiInputV1, TriageMountedUiResultV1> {
  return async (input, context) => {
    const parsed = TriageMountedUiInputV1Schema.parse(input);
    if (context.ephemeralSharedScope === null || context.signal.aborted) return { status: 'unavailable' };
    return await invokeTriageMountedUiAction(context.ephemeralSharedScope, parsed.mountId, parsed.operation, context.signal);
  };
}

export function createTriageMountedSourceRevealActionHandler(): PluginClientActionHandler<ReturnType<typeof TriageMountedSourceRevealInputV1Schema.parse>, TriageMountedUiResultV1> {
  return async (input, context) => {
    const parsed = TriageMountedSourceRevealInputV1Schema.parse(input);
    if (context.ephemeralSharedScope === null || context.signal.aborted) return { status: 'unavailable' };
    return await invokeTriageMountedUiAction(context.ephemeralSharedScope, parsed.mountId, parsed.operation, context.signal);
  };
}

export function createTriageMountedSourceInsertActionHandler(): PluginClientActionHandler<ReturnType<typeof TriageMountedSourceInsertInputV1Schema.parse>, TriageMountedUiResultV1> {
  return async (input, context) => {
    const parsed = TriageMountedSourceInsertInputV1Schema.parse(input);
    if (context.ephemeralSharedScope === null || context.signal.aborted) return { status: 'unavailable' };
    return await invokeTriageMountedUiAction(context.ephemeralSharedScope, parsed.mountId, parsed.operation, context.signal);
  };
}

export function activate(api: PluginClientApi): void {
  api.actions.register(TRIAGE_TASKS_CHECK_WRITE_ACTION_LOCAL_ID_V1, async (input, context) => {
    const parsed = TriageCheckTaskWriteInputV1Schema.parse(input);
    const resolved = await checkTriageTaskWrite(context.ephemeralSharedScope, parsed.entryRef, context.ui, context.signal);
    return { status: resolved ? 'applied' : 'unavailable' };
  });
  api.actions.register(TRIAGE_TASKS_OPEN_CREATE_ACTION_LOCAL_ID_V1, async (input, context) => {
    const draft = TriageTaskDraftV1Schema.parse(input);
    if (context.signal.aborted || context.ephemeralSharedScope === null) return { status: 'unavailable' };
    const message = context.messageAction;
    const quote = message?.visibleText ?? message?.structuredPresentationSummary;
    const proposedTitle = proposeMessageTaskTitle(quote);
    // This exact read supplies display/Where context, never a guessed Home or repository.
    const session = message === undefined ? null : await context.ui.readSession(message.sessionId,
      { signal: context.signal }).catch(() => null);
    if (context.signal.aborted) return { status: 'unavailable' };
    const matchingSession = session?.sessionId === message?.sessionId ? session : null;
    const fields = {
      ...draft,
      ...(draft.title === undefined && proposedTitle !== undefined ? { title: proposedTitle } : {}),
      ...(message === undefined ? {} : { origin: {
        sessionId: message.sessionId, messageId: message.messageId, observedRevision: message.observedRevision,
        role: message.role, ...(quote == null ? {} : { quote }),
        ...(matchingSession?.serverId === undefined ? {} : { serverId: matchingSession.serverId }),
        ...(matchingSession?.title === undefined ? {} : { sessionTitle: matchingSession.title }),
        ...(matchingSession?.acceptedWorkspace?.repository === undefined ? {} : { repository: matchingSession.acceptedWorkspace.repository }),
      } }),
    };
    const handoff = stageTriageTaskDraft(context.ephemeralSharedScope, fields);
    if (handoff === null) return { status: 'unavailable' };
    try {
      // From a message the draft opens in the Session's details pane and the Session stays where it is (owner
      // 2026-11-11); without a Session it opens the Tasks page. The host's destination owner decides the placement.
      if (message !== undefined) await context.ui.openSurface(TRIAGE_SESSION_DETAILS_DESTINATION_V1, handoff.input,
        { instanceKey: handoff.input.draftId, signal: context.signal });
      else await context.ui.openSurface(TRIAGE_TASK_DETAIL_DESTINATION_V1, handoff.input,
        { subPath: 'tasks,mine', signal: context.signal });
      return { status: 'applied' };
    } catch {
      handoff.discard();
      return { status: 'unavailable' };
    }
  });
  api.actions.register(TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, createTriageMountedUiActionHandler());
  api.actions.register(TRIAGE_SOURCE_PANEL_REVEAL_ACTION_V1, createTriageMountedSourceRevealActionHandler());
  api.actions.register(TRIAGE_SOURCE_PANEL_INSERT_ACTION_V1, createTriageMountedSourceInsertActionHandler());
}
