import { parseMcpToolWireNameV1 } from '@happier-dev/plugin-sdk/agents/runtime';

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
    mapCodexRolloutEventToActions({ type: 'response_item', payload: item }, { debug: false, localControl: false }),
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
  const output = item.output ?? item.result ?? (typeof item.aggregatedOutput === 'string'
    ? { ...item, stdout: item.aggregatedOutput } : item);
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
  'aggregatedOutput',
  'aggregated_output',
  'durationMs',
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

function projectNativeCodexAppServerToolEvents(params: Readonly<{
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

  // Native ThreadItem shapes from codex-cli 0.162.1. History and live
  // notifications share this projection; scoped publication owns deduplication.
  if (itemType === 'websearch' || itemType === 'imageview' || itemType === 'sleep') {
    const callId = readFirstString(item, ['callId', 'call_id', 'id', 'itemId', 'item_id']);
    if (!callId) return [];
    const name = itemType === 'websearch' ? 'WebSearch' : itemType === 'imageview' ? 'view_image' : 'sleep';
    const input = itemType === 'websearch' ? { query: item.query, action: item.action }
      : itemType === 'imageview' ? { path: item.path } : { durationMs: item.durationMs };
    const call: CodexAppServerProjectedToolEvent = { type: 'tool-call', callId, name, input, sidechainId: null };
    if (params.method === 'item/started') {
      // Web search starts with an empty query. Publish the immutable input once it completes.
      return itemType === 'websearch' ? [] : [call];
    }
    if (params.method === 'item/completed') {
      return [call, { type: 'tool-result', callId,
        output: itemType === 'websearch' ? { results: item.results } : {}, sidechainId: null }];
    }
    return [];
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

export function projectCodexAppServerToolEventsFromNotification(params: Readonly<{
  method: string;
  notificationParams: unknown;
  /** Original SDK record key → native injected key, from the launch owner. */
  mcpServerKeys?: ReadonlyMap<string, string>;
}>): CodexAppServerProjectedToolEvent[] {
  const events = projectNativeCodexAppServerToolEvents(params);
  if (!params.mcpServerKeys?.size || !events.some(event => event.type === 'tool-call' && event.name.startsWith('mcp__'))) return events;
  const wireKeysByNativeKey = new Map([...params.mcpServerKeys].map(([wireKey, nativeKey]) => [nativeKey, wireKey]));
  const nativeKeys = new Set(wireKeysByNativeKey.keys());
  return events.map(event => {
    if (event.type !== 'tool-call' || !event.name.startsWith('mcp__')) return event;
    // The shared parser resolves the longest admitted key and excludes the
    // built-in bridge, whose name is also every injected key's prefix.
    const identity = parseMcpToolWireNameV1(event.name, nativeKeys);
    return identity
      ? { ...event, name: `mcp__${wireKeysByNativeKey.get(identity.server)!}__${identity.tool}` }
      : event;
  });
}

function isYieldedCodeModeOutput(output: unknown): boolean {
  // Codex rust-v0.162.1 CodeModeToolOutput prepends this native status to
  // either a string or input_text content. Script-authored output follows it.
  const first = Array.isArray(output) ? asRecord(output[0]) : null;
  const status = typeof output === 'string' ? output : first?.type === 'input_text' ? first.text : null;
  return typeof status === 'string' && status.startsWith('Script running with cell ID ');
}

/** One admitted turn's typed and raw views describe the same native tools. */
export function createCodexAppServerToolEventProjector() {
  const published = new Set<string>();
  const scripts = new Map<string, {
    scopeId: string;
    call: CodexAppServerProjectedToolEvent;
    result?: Extract<CodexAppServerProjectedToolEvent, { type: 'tool-result' }>;
    hasNativeTools: boolean;
  }>();
  const eventKey = (scopeId: string, type: string, callId: string) => JSON.stringify([scopeId, type, callId]);
  const admit = (scopeId: string, events: CodexAppServerProjectedToolEvent[], raw = false) => events.filter(event => {
    const key = eventKey(scopeId, event.type, event.callId);
    if (published.has(key)) return false;
    if (raw && event.type === 'tool-result' && !published.has(eventKey(scopeId, 'tool-call', event.callId))) return false;
    published.add(key);
    return true;
  });
  return {
    clear: () => { published.clear(); scripts.clear(); },
    project(params: Parameters<typeof projectCodexAppServerToolEventsFromNotification>[0] & Readonly<{
      scopeId: string;
      /** A settled turn can finish an already published tool, never introduce a new call. */
      lateResultOnly?: boolean;
    }>): CodexAppServerProjectedToolEvent[] {
      if (params.method === 'turn/completed' || params.method === 'turn/interrupted') {
        const fallback: CodexAppServerProjectedToolEvent[] = [];
        for (const [key, script] of scripts) {
          if (script.scopeId !== params.scopeId) continue;
          scripts.delete(key);
          // Code-mode exec is an envelope, not a second command. Retain it
          // only when native origin is unaccounted for (including ambiguous
          // yielded cells). Never parse its JavaScript or match command text.
          if (!script.hasNativeTools) fallback.push(script.call, ...(script.result ? [script.result] : []));
        }
        return admit(params.scopeId, fallback);
      }
      const events = projectCodexAppServerToolEventsFromNotification(params);
      if (params.lateResultOnly) {
        return admit(params.scopeId, events.filter(event => event.type === 'tool-result'), true);
      }
      const native: CodexAppServerProjectedToolEvent[] = [];
      for (const event of events) {
        const key = eventKey(params.scopeId, 'script', event.callId);
        if (event.type === 'tool-call' && event.name === 'exec') {
          if (!scripts.has(key) && !published.has(eventKey(params.scopeId, 'tool-call', event.callId))) {
            scripts.set(key, { scopeId: params.scopeId, call: event, hasNativeTools: false });
          }
          continue;
        }
        const script = scripts.get(key);
        if (script && event.type === 'tool-result') {
          script.result = event;
          continue;
        }
        if (event.type === 'tool-call' && !published.has(eventKey(params.scopeId, event.type, event.callId))) {
          // A yielded response does not finish the cell. Without an originating
          // exec id, only a single eligible envelope accounts for a native call.
          // Typed/raw echoes of that same native identity cannot reattribute it.
          const candidates = [...scripts.values()].filter(pending =>
            pending.scopeId === params.scopeId && (!pending.result || isYieldedCodeModeOutput(pending.result.output)));
          if (candidates.length === 1) candidates[0]!.hasNativeTools = true;
        }
        native.push(event);
      }
      return admit(params.scopeId, native, params.method === 'rawResponseItem/completed');
    },
  };
}
