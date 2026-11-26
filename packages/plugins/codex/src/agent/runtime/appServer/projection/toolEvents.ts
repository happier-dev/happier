import { formatMcpToolWireNameV1 } from '@happier-dev/plugin-sdk/agents/runtime';
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

const NATIVE_ACTIVITY_INPUT_OMITTED_KEYS = new Set([...TOOL_INPUT_OMITTED_KEYS, 'agentsStates', 'contentItems', 'completedAtMs']);

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

  if (itemType === 'subagentactivity' || itemType === 'collabagenttoolcall' || itemType === 'dynamictoolcall') {
    const callId = readFirstString(item, ['callId', 'call_id', 'id', 'itemId', 'item_id']);
    const name = itemType === 'subagentactivity' ? 'subAgentActivity' : trimStringValue(item.tool);
    if (!callId || !name) return [];
    const input = omitKeys(item, NATIVE_ACTIVITY_INPUT_OMITTED_KEYS);
    const call: CodexAppServerProjectedToolEvent = { type: 'tool-call', callId, name, input, sidechainId: null };
    if (params.method === 'item/started') return [call];
    if (params.method !== 'item/completed') return [];
    // Completion settles this occurrence, never the child thread's lifecycle.
    const output = omitKeys(item, new Set([...TOOL_OUTPUT_OMITTED_KEYS, ...Object.keys(input)]));
    return [call, { type: 'tool-result', callId, output, sidechainId: null,
      ...(typeof item.success === 'boolean' ? { isError: !item.success } : {}) }];
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
      ? { ...event, name: formatMcpToolWireNameV1(wireKeysByNativeKey.get(identity.server)!, identity.tool) }
      : event;
  });
}

type ToolCall = Extract<CodexAppServerProjectedToolEvent, { type: 'tool-call' }>;
type ToolResult = Extract<CodexAppServerProjectedToolEvent, { type: 'tool-result' }>;

type ScriptCell = {
  call: ToolCall;
  cellId?: string;
  output: unknown[];
  result?: ToolResult;
  childCount: number;
  deferred: CodexAppServerProjectedToolEvent[];
  passThrough: boolean;
  published: boolean;
  finished?: boolean;
};

function readScriptStatus(output: unknown): string | undefined {
  // Codex rust-v0.162.1 emits a separate header content item before script output.
  const first = Array.isArray(output) ? asRecord(output[0]) : null;
  const text = typeof output === 'string' ? output : first?.type === 'input_text' ? first.text : null;
  return typeof text === 'string' ? text.split('\n', 1)[0] : undefined;
}

function hasScriptOutput(result: ToolResult): boolean {
  if (result.isError || readScriptStatus(result.output) !== 'Script completed') return true;
  if (Array.isArray(result.output)) return result.output.length > 1;
  return typeof result.output !== 'string' || result.output.trim() !== 'Script completed';
}

// Only elide a bare call with literal arguments. Unrecognized JavaScript keeps
// its Script card so computation, errors and script-authored output stay visible.
const SCRIPT_LITERAL = String.raw`(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|-?\d+(?:\.\d+)?|true|false|null)`;
const SCRIPT_PROPERTY = String.raw`(?:[\w$]+|"[^"]+"|'[^']+')\s*:\s*${SCRIPT_LITERAL}`;
const SINGLE_LITERAL_TOOL_CALL = new RegExp(
  String.raw`^\s*(?:await\s+)?tools(?:\.[\w$]+)+\(\s*(?:\{\s*(?:${SCRIPT_PROPERTY}(?:\s*,\s*${SCRIPT_PROPERTY})*\s*,?)?\s*\})?\s*\)\s*;?\s*$`,
);

/** One admitted turn's typed and raw views describe the same native tools. */
export function createCodexAppServerToolEventProjector() {
  const published = new Set<string>();
  const scopes = new Map<string, {
    scripts: Map<string, ScriptCell>;
    open: Set<ScriptCell>;
    cells: Map<string, ScriptCell>;
    waits: Map<string, ScriptCell>;
    children: Map<string, ScriptCell>;
  }>();
  const publishedChildParents = new Map<string, string>();
  const eventKey = (scopeId: string, type: string, callId: string) => JSON.stringify([scopeId, type, callId]);
  const admit = (scopeId: string, events: CodexAppServerProjectedToolEvent[], raw = false) => events.filter(event => {
    const key = eventKey(scopeId, event.type, event.callId);
    if (published.has(key)) return false;
    if (raw && event.type === 'tool-result' && !published.has(eventKey(scopeId, 'tool-call', event.callId))) return false;
    if (event.type === 'tool-result') publishedChildParents.delete(eventKey(scopeId, 'tool-call', event.callId));
    published.add(key);
    return true;
  });
  const publishScript = (script: ScriptCell, events: CodexAppServerProjectedToolEvent[]) => {
    if (script.published) return;
    script.published = true;
    events.push({
      ...script.call, name: 'Script',
      input: { code: script.call.input, language: 'javascript', origin: 'native', ...(script.cellId ? { cellId: script.cellId } : {}) },
    }, ...script.deferred.map(event => ({ ...event, sidechainId: script.call.callId })));
    script.deferred.length = 0;
  };
  const finishScript = (script: ScriptCell, events: CodexAppServerProjectedToolEvent[]) => {
    if (script.finished) return;
    script.finished = true;
    if (script.passThrough && script.childCount === 1 && script.result && !hasScriptOutput(script.result)
      && script.output.length === 1 && !script.published) {
      events.push(...script.deferred);
      script.deferred.length = 0;
      return;
    }
    publishScript(script, events);
    if (script.result) {
      events.push({ ...script.result, callId: script.call.callId,
        output: { output: script.output.length <= 1 ? script.output[0] ?? script.result.output : script.output } });
    }
  };
  return {
    clear: () => { published.clear(); scopes.clear(); publishedChildParents.clear(); },
    project(params: Parameters<typeof projectCodexAppServerToolEventsFromNotification>[0] & Readonly<{
      scopeId: string;
      codeModeOnly?: boolean;
      /** A settled turn can finish an already published tool, never introduce a new call. */
      lateResultOnly?: boolean;
    }>): CodexAppServerProjectedToolEvent[] {
      const { scopeId } = params;
      const projected: CodexAppServerProjectedToolEvent[] = [];
      const scope = scopes.get(scopeId);
      if (params.method === 'turn/completed' || params.method === 'turn/interrupted') {
        if (scope) {
          for (const script of scope.scripts.values()) finishScript(script, projected);
          for (const [callId, script] of scope.children) {
            if (script.published && !published.has(eventKey(scopeId, 'tool-result', callId))) {
              publishedChildParents.set(eventKey(scopeId, 'tool-call', callId), script.call.callId);
            }
          }
          scopes.delete(scopeId);
        }
        return admit(scopeId, projected);
      }

      const raw = params.method === 'rawResponseItem/completed';
      const item = raw ? readProviderEventItemRecord(params.notificationParams) : null;
      const id = item ? trimStringValue(item.call_id) : null;
      if (!params.lateResultOnly && id && item) {
        if (item.type === 'custom_tool_call' && item.name === 'exec' && typeof item.input === 'string' && !item.namespace) {
          const active = scope ?? { scripts: new Map(), open: new Set(), cells: new Map(), waits: new Map(), children: new Map() };
          if (!active.scripts.has(id) && !published.has(eventKey(scopeId, 'tool-call', id))) {
            const script: ScriptCell = {
              call: { type: 'tool-call', callId: id, name: 'exec', input: item.input, sidechainId: null },
              output: [], childCount: 0, deferred: [], published: false,
              passThrough: params.codeModeOnly === true && SINGLE_LITERAL_TOOL_CALL.test(item.input),
            };
            active.scripts.set(id, script);
            active.open.add(script);
            scopes.set(scopeId, active);
          }
          return [];
        }
        if (scope && item.type === 'function_call' && item.name === 'wait' && !item.namespace) {
          let cellId: string | null = null;
          if (typeof item.arguments === 'string') {
            try { cellId = trimStringValue(asRecord(JSON.parse(item.arguments))?.cell_id); } catch { /* Uncorrelated function. */ }
          }
          const script = cellId ? scope.cells.get(cellId) : undefined;
          if (script) {
            scope.waits.set(id, script);
            return [];
          }
        }
        const script = item.type === 'custom_tool_call_output' ? scope?.scripts.get(id)
          : item.type === 'function_call_output' ? scope?.waits.get(id) : undefined;
        if (scope && script && !published.has(eventKey(scopeId, 'script-output', id))) {
          published.add(eventKey(scopeId, 'script-output', id));
          const status = readScriptStatus(item.output);
          script.result = { type: 'tool-result', callId: id, sidechainId: null, output: item.output,
            ...(status?.startsWith('Script failed') || status === 'Script terminated' ? { isError: true } : {}) };
          const cellId = /^Script running with cell ID (\S+)$/.exec(status ?? '')?.[1];
          if (cellId) {
            script.cellId = cellId;
            scope.cells.set(cellId, script);
            // Keep yielded output if the host reported more than a status header.
            if (Array.isArray(item.output) ? item.output.length > 1 : status !== item.output) script.output.push(item.output);
            if (!script.passThrough || script.output.length) publishScript(script, projected);
          } else {
            scope.open.delete(script);
            script.output.push(item.output);
            finishScript(script, projected);
          }
          return admit(scopeId, projected);
        }
        if (script) return [];
      }

      for (const event of projectCodexAppServerToolEventsFromNotification(params)) {
        const key = eventKey(scopeId, event.type, event.callId);
        if (published.has(key) || (params.lateResultOnly && event.type === 'tool-call')) continue;
        const childKey = eventKey(scopeId, 'tool-call', event.callId);
        let script = scope?.children.get(event.callId);
        if (event.type === 'tool-call') {
          if (script) continue;
          if (scope?.open.size === 1) {
            script = scope.open.values().next().value;
            if (script) {
              scope.children.set(event.callId, script);
              script.childCount += 1;
            }
          }
        }
        if (!script) {
          const parent = publishedChildParents.get(childKey);
          projected.push(parent ? { ...event, sidechainId: parent } : event);
        } else if (script.passThrough && !script.published && script.childCount === 1 && scopes.has(scopeId)) {
          projected.push(event);
        } else {
          publishScript(script, projected);
          projected.push({ ...event, sidechainId: script.call.callId });
        }
      }
      return admit(scopeId, projected, raw);
    },
  };
}
