import {
  ScriptToolInputV2Schema,
  ScriptToolResultV2Schema,
  type ScriptToolResultV2,
} from '@happier-dev/protocol/tools/v2';
import type {
  Message,
  ToolCall,
  ToolCallMessage,
} from '@happier-dev/session-core/messages';

import { t } from '@/text';

import {
  toolTextBlock,
  type ToolDisplayTextProjector,
} from '../core/toolDisplayTextTypes';

type ScriptCallRecord = NonNullable<ScriptToolResultV2['calls']>[number];

/** One `Script` call as its card, details page and find text read it. */
export type ScriptDisplay = Readonly<{
  title: string | null;
  code: string;
  language: 'javascript' | 'typescript';
  /** The script's returned value, as text; null when it returned nothing. */
  returned: string | null;
  stdout: string | null;
  stderr: string | null;
  error: string | null;
  /** Inner calls in call order: the transcript's child tool calls, else the runner's own call records. */
  calls: readonly ToolCallMessage[];
}>;

const EMPTY_CALLS: readonly ToolCallMessage[] = Object.freeze([]);

function nonEmpty(value: string | undefined | null): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function formatReturned(output: unknown): string | null {
  if (output === undefined || output === null) return null;
  if (typeof output === 'string') return nonEmpty(output);
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

const CALL_STATE: Readonly<
  Record<ScriptCallRecord['status'], ToolCall['state']>
> = {
  running: 'running',
  completed: 'completed',
  error: 'error',
  denied: 'error',
};

/**
 * A runner that executes outside the agent's transcript (`happier tools run`) reports its inner calls as
 * records, not as child tool calls. They become the same tool-call rows, so the card has one row owner;
 * a typed refusal cause rides as the call's result, where the row's refusal reader looks for it.
 */
function callRecordsAsMessages(
  owner: ToolCall,
  records: readonly ScriptCallRecord[],
): readonly ToolCallMessage[] {
  return records.map((record, index) => {
    const id = record.id ?? `${owner.id ?? 'script'}:call:${index}`;
    const result = record.refusalCause ?? record.summary;
    return {
      kind: 'tool-call',
      id,
      localId: null,
      createdAt: owner.createdAt + index,
      children: [],
      tool: {
        id,
        name: record.tool,
        state: CALL_STATE[record.status],
        input: {},
        createdAt: owner.createdAt + index,
        startedAt: null,
        completedAt:
          record.durationMs !== undefined && owner.startedAt !== null
            ? owner.startedAt + record.durationMs
            : null,
        description: record.summary ?? null,
        ...(result !== undefined ? { result } : {}),
      },
    } satisfies ToolCallMessage;
  });
}

function childCalls(messages: readonly Message[]): ToolCallMessage[] {
  const calls: ToolCallMessage[] = [];
  for (const message of messages) {
    if (message.kind === 'tool-call') calls.push(message);
  }
  return calls;
}

export function readScriptDisplay(
  tool: ToolCall,
  messages: readonly Message[],
): ScriptDisplay {
  const input = ScriptToolInputV2Schema.safeParse(tool.input);
  const parsedResult = ScriptToolResultV2Schema.safeParse(tool.result);
  const result = parsedResult.success ? parsedResult.data : null;
  // A provider that reports failure as plain text (not the typed envelope) still reads as the script's error.
  const plainError =
    tool.state === 'error' && typeof tool.result === 'string'
      ? tool.result
      : null;
  const children = childCalls(messages);
  return {
    title: input.success ? nonEmpty(input.data.title) : null,
    code: input.success
      ? input.data.code
      : typeof tool.input?.code === 'string'
        ? tool.input.code
        : '',
    language:
      input.success && input.data.language ? input.data.language : 'javascript',
    returned: formatReturned(result?.output),
    stdout: nonEmpty(result?.stdout),
    stderr: nonEmpty(result?.stderr),
    error: nonEmpty(result?.error) ?? nonEmpty(plainError),
    calls:
      children.length > 0
        ? children
        : result?.calls?.length
          ? callRecordsAsMessages(tool, result.calls)
          : EMPTY_CALLS,
  };
}

/** The header subtitle: how many calls the runner reported, then how long it took once it finished. */
/**
 * How many inner calls the script made: the transcript's child tool calls (native code mode), else the
 * runner's own call records (`happier tools run`). The one counting rule for the header and the body.
 */
export function countScriptCalls(tool: ToolCall, messages: readonly Message[] | undefined): number {
  const children = messages ? childCalls(messages).length : 0;
  if (children > 0) return children;
  const parsed = ScriptToolResultV2Schema.safeParse(tool.result);
  return parsed.success ? (parsed.data.calls?.length ?? 0) : 0;
}

export function formatScriptSubtitle(tool: ToolCall, messages?: readonly Message[]): string | null {
  const count = countScriptCalls(tool, messages);
  const parts: string[] = [];
  if (count > 0) parts.push(t('tools.script.toolCallsCount', { count }));
  if (
    tool.state !== 'running' &&
    tool.startedAt !== null &&
    tool.completedAt !== null &&
    tool.completedAt >= tool.startedAt
  ) {
    parts.push(
      t('tools.common.elapsedSeconds', {
        seconds: ((tool.completedAt - tool.startedAt) / 1000).toFixed(1),
      }),
    );
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export const projectScriptDisplayText: ToolDisplayTextProjector = (
  tool,
  _metadata,
  context,
) => {
  const display = readScriptDisplay(tool, context?.messages ?? []);
  return [
    ...toolTextBlock('tool-script-code', display.code),
    ...toolTextBlock('tool-script-returned', display.returned),
    ...toolTextBlock('tool-stdout', display.stdout),
    ...toolTextBlock('tool-stderr', display.stderr),
    ...toolTextBlock('tool-error', display.error),
  ];
};
