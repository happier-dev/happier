import { mapCodexRolloutEventToActions } from '../../../rollout/projection/actions.js';
import {
  formatCodexMcpToolSource,
  readCodexMcpToolSource,
} from '../../../rollout/projection/mcpToolSource.js';
import { projectCodexRolloutActions } from '../../../rollout/projection/messages.js';
import { normalizeCodexRolloutToolInput } from '../../../rollout/projection/toolInvocation.js';
import {
  readProviderEventItemRecord,
  readNormalizedProviderEventItemType,
  trimStringValue,
} from '../wire/fields.js';

export type CodexAppServerProjectedToolEvent =
  | Readonly<{
      type: 'tool-call';
      callId: string;
      name: string;
      input: unknown;
      sidechainId: string | null;
    }>
  | Readonly<{
      type: 'tool-result';
      callId: string;
      output: unknown;
      sidechainId: string | null;
      isError?: boolean;
    }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readFirstString(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = trimStringValue(record[key]);
    if (value) return value;
  }
  return null;
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function omitKeys(record: Readonly<Record<string, unknown>>, keys: ReadonlySet<string>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.has(key)) next[key] = value;
  }
  return next;
}

function projectResponseItemToolEvents(item: Readonly<Record<string, unknown>>): CodexAppServerProjectedToolEvent[] {
  const projected = projectCodexRolloutActions(
    mapCodexRolloutEventToActions({ type: 'response_item', payload: item }, { debug: false }),
    { sidechainId: null },
  );
  return projected.filter((event): event is CodexAppServerProjectedToolEvent => (
    event.type === 'tool-call' || event.type === 'tool-result'
  ));
}

function projectRawResponseToolEvents(notificationParams: unknown): CodexAppServerProjectedToolEvent[] {
  const item = readProviderEventItemRecord(notificationParams);
  return item ? projectResponseItemToolEvents(item) : [];
}

function isFunctionToolItemType(itemType: string | null): boolean {
  return itemType === 'functioncall' || itemType === 'functioncalloutput';
}

function readCommandExecutionToolInput(
  item: Readonly<Record<string, unknown>>,
  command: string | null,
): Record<string, unknown> {
  const input = omitKeys(item, TOOL_INPUT_OMITTED_KEYS);
  if (command) input.cmd = command;
  return input;
}

function readCommandExecutionToolCall(item: Readonly<Record<string, unknown>>): CodexAppServerProjectedToolEvent | null {
  const callId = readFirstString(item, ['callId', 'call_id', 'id', 'itemId', 'item_id']);
  if (!callId) return null;
  const command = readFirstString(item, ['command', 'cmd', 'shellCommand', 'shell_command']);
  return {
    type: 'tool-call',
    callId,
    name: 'Bash',
    input: readCommandExecutionToolInput(item, command),
    sidechainId: null,
  };
}

function readCommandExecutionToolResult(item: Readonly<Record<string, unknown>>): CodexAppServerProjectedToolEvent | null {
  const callId = readFirstString(item, ['callId', 'call_id', 'id', 'itemId', 'item_id']);
  if (!callId) return null;
  const output = item.output ?? item.result ?? item;
  const outputRecord = asRecord(output);
  const isError = typeof outputRecord?.exitCode === 'number'
    ? outputRecord.exitCode !== 0
    : typeof outputRecord?.exit_code === 'number'
      ? outputRecord.exit_code !== 0
      : undefined;
  return {
    type: 'tool-result',
    callId,
    output,
    sidechainId: null,
    ...(isError === undefined ? {} : { isError }),
  };
}

function readMcpToolCallName(item: Readonly<Record<string, unknown>>): string | null {
  const name = readFirstString(item, ['tool', 'toolName', 'tool_name', 'name']);
  if (!name) return null;
  const source = readCodexMcpToolSource(item, name);
  return source ? formatCodexMcpToolSource(source) : name;
}

function readMcpToolCallToolCall(item: Readonly<Record<string, unknown>>): CodexAppServerProjectedToolEvent | null {
  const callId = readFirstString(item, ['callId', 'call_id', 'id', 'itemId', 'item_id']);
  if (!callId) return null;
  const name = readMcpToolCallName(item);
  if (!name) return null;

  return {
    type: 'tool-call',
    callId,
    name,
    input: normalizeCodexRolloutToolInput(name, item.arguments ?? item.input ?? {}),
    sidechainId: null,
  };
}

function unwrapMcpToolCallResultOutput(result: unknown): unknown {
  const record = asRecord(result);
  if (!record) return result;
  if (hasOwn(record, 'Ok')) return record.Ok;
  if (hasOwn(record, 'Err')) return record.Err;
  if (hasOwn(record, 'output')) return record.output;
  if (hasOwn(record, 'result')) return record.result;
  return result;
}

function readMcpToolCallToolResult(item: Readonly<Record<string, unknown>>): CodexAppServerProjectedToolEvent | null {
  const callId = readFirstString(item, ['callId', 'call_id', 'id', 'itemId', 'item_id']);
  if (!callId) return null;
  const resultRecord = hasOwn(item, 'result') ? asRecord(item.result) : null;
  const isError = resultRecord && hasOwn(resultRecord, 'Err') ? true : undefined;
  return {
    type: 'tool-result',
    callId,
    output: hasOwn(item, 'result') ? unwrapMcpToolCallResultOutput(item.result) : omitKeys(item, TOOL_OUTPUT_OMITTED_KEYS),
    sidechainId: null,
    ...(isError === undefined ? {} : { isError }),
  };
}

const TOOL_INPUT_OMITTED_KEYS = new Set([
  'id',
  'itemId',
  'item_id',
  'callId',
  'call_id',
  'type',
  'itemType',
  'item_type',
  'stderr',
  'stdout',
  'exitCode',
  'exit_code',
  'status',
  'success',
  'error',
  'result',
  'output',
  'command',
  'cmd',
  'shellCommand',
  'shell_command',
]);

const TOOL_OUTPUT_OMITTED_KEYS = new Set([
  'id',
  'itemId',
  'item_id',
  'callId',
  'call_id',
  'type',
  'itemType',
  'item_type',
  'auto_approved',
  'changes',
  'arguments',
  'input',
]);

function readFileChangeToolCall(item: Readonly<Record<string, unknown>>): CodexAppServerProjectedToolEvent | null {
  const callId = readFirstString(item, ['callId', 'call_id', 'id', 'itemId', 'item_id']);
  if (!callId || !hasOwn(item, 'changes')) return null;
  return {
    type: 'tool-call',
    callId,
    name: 'Patch',
    input: omitKeys(item, TOOL_INPUT_OMITTED_KEYS),
    sidechainId: null,
  };
}

function readFileChangeToolResult(item: Readonly<Record<string, unknown>>): CodexAppServerProjectedToolEvent | null {
  const callId = readFirstString(item, ['callId', 'call_id', 'id', 'itemId', 'item_id']);
  if (!callId) return null;
  const output = hasOwn(item, 'output') || hasOwn(item, 'result')
    ? item.output ?? item.result
    : omitKeys(item, TOOL_OUTPUT_OMITTED_KEYS);
  return {
    type: 'tool-result',
    callId,
    output,
    sidechainId: null,
  };
}

export function projectCodexAppServerToolEventsFromNotification(params: Readonly<{
  method: string;
  notificationParams: unknown;
}>): CodexAppServerProjectedToolEvent[] {
  if (params.method === 'rawResponseItem/completed') {
    return projectRawResponseToolEvents(params.notificationParams);
  }

  const itemType = readNormalizedProviderEventItemType(params.notificationParams);
  const item = readProviderEventItemRecord(params.notificationParams);
  if (!item) return [];

  if (isFunctionToolItemType(itemType) && (params.method === 'item/started' || params.method === 'item/completed')) {
    return projectResponseItemToolEvents(item);
  }

  if (itemType === 'mcptoolcall') {
    if (params.method === 'item/started') {
      const event = readMcpToolCallToolCall(item);
      return event ? [event] : [];
    }

    if (params.method === 'item/completed') {
      const call = readMcpToolCallToolCall(item);
      const result = readMcpToolCallToolResult(item);
      return [call, result].filter((event): event is CodexAppServerProjectedToolEvent => event !== null);
    }

    return [];
  }

  if (itemType === 'filechange') {
    if (params.method === 'item/started') {
      const event = readFileChangeToolCall(item);
      return event ? [event] : [];
    }

    if (params.method === 'item/completed') {
      const call = readFileChangeToolCall(item);
      const result = readFileChangeToolResult(item);
      return [call, result].filter((event): event is CodexAppServerProjectedToolEvent => event !== null);
    }

    return [];
  }

  if (itemType !== 'commandexecution') return [];

  if (params.method === 'item/started') {
    const event = readCommandExecutionToolCall(item);
    return event ? [event] : [];
  }

  if (params.method === 'item/completed') {
    const call = readCommandExecutionToolCall(item);
    const result = readCommandExecutionToolResult(item);
    return [call, result].filter((event): event is CodexAppServerProjectedToolEvent => event !== null);
  }

  return [];
}
