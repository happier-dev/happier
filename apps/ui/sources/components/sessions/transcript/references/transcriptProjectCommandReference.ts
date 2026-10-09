import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { WaitActionInputV1Schema } from '@happier-dev/protocol/actions/specs/wait';
import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';
import type { ToolCall } from '@happier-dev/session-core/messages';

import {
  createHappierActionToolNameIndex,
  isRecord,
  readHappierActionExecuteActionId,
  readHappierActionId,
  readHappierActionToolResultCandidates,
} from './happierActionToolResult';

/**
 * The one projection from a transcript tool call to the finite Project command it started or waits on
 * (plan 21 §8: "Tool calls · N", an Accepted result with its actual target, then the existing `wait`
 * observation). It reads nothing heuristically: the tool is matched against the Action spec's canonical
 * binding and the result is parsed by the Protocol's own finite-output schema, so the row and every other
 * surface (Work tab, Scripts, Activity) address the same qualified operation.
 */

const PROJECT_COMMAND_ACTION_IDS = [
  'projects.script.run',
  'projects.compute.exec',
  'projects.prepare',
] as const;
type ProjectCommandActionId = (typeof PROJECT_COMMAND_ACTION_IDS)[number];
const PROJECT_COMMAND_TOOLS =
  createHappierActionToolNameIndex<ProjectCommandActionId>(
    PROJECT_COMMAND_ACTION_IDS,
  );
const WAIT_TOOLS = createHappierActionToolNameIndex<'wait'>(['wait']);

function isProjectCommandActionId(
  actionId: string,
): actionId is ProjectCommandActionId {
  return (PROJECT_COMMAND_ACTION_IDS as readonly string[]).includes(actionId);
}
function isWaitActionId(actionId: string): actionId is 'wait' {
  return actionId === 'wait';
}

export type TranscriptProjectCommandCall =
  | Readonly<{
      kind: 'start';
      actionId: ProjectCommandActionId;
      input: unknown;
    }>
  | Readonly<{ kind: 'wait'; operationId: string }>;

/** What a first-party tool call is in Project-command terms, from its name and input alone. */
export function readTranscriptProjectCommandCall(
  tool: Pick<ToolCall, 'name' | 'input'>,
): TranscriptProjectCommandCall | null {
  const actionId =
    readHappierActionId(tool.name, PROJECT_COMMAND_TOOLS) ??
    readHappierActionExecuteActionId(
      tool.name,
      tool.input,
      isProjectCommandActionId,
    );
  if (actionId)
    return {
      kind: 'start',
      actionId,
      input: readActionInput(tool.name, tool.input),
    };
  const waitId =
    readHappierActionId(tool.name, WAIT_TOOLS) ??
    readHappierActionExecuteActionId(tool.name, tool.input, isWaitActionId);
  if (!waitId) return null;
  const wait = WaitActionInputV1Schema.safeParse(
    readActionInput(tool.name, tool.input),
  );
  return wait.success && wait.data.target.kind === 'action_operation'
    ? { kind: 'wait', operationId: wait.data.target.operationId }
    : null;
}

/** The accepted operation a completed start call acknowledged; a refusal, approval or prose names none. */
export function readTranscriptProjectCommandAcceptance(
  tool: Pick<ToolCall, 'name' | 'input' | 'state' | 'result'>,
): ActionOperationSnapshotV1 | null {
  if (
    tool.state !== 'completed' ||
    readTranscriptProjectCommandCall(tool)?.kind !== 'start'
  )
    return null;
  for (const candidate of readHappierActionToolResultCandidates(tool.result)) {
    for (const value of [
      candidate,
      isRecord(candidate) && candidate.ok === true
        ? candidate.result
        : undefined,
    ]) {
      const parsed = ProjectCommandActionOutputV1Schema.safeParse(value);
      if (
        parsed.success &&
        parsed.data.operation.domainRef?.kind === 'projectCommand'
      )
        return parsed.data.operation;
    }
  }
  return null;
}

/** The generic `action_execute` tool nests the Action's input; a dedicated tool's input is the input. */
function readActionInput(toolName: string, input: unknown): unknown {
  const parsed = maybeParseJson(input);
  return readHappierActionExecuteActionId(
    toolName,
    parsed,
    (id): id is string => true,
  ) && isRecord(parsed)
    ? parsed.input
    : parsed;
}
