import { asRecord, normalizeString } from './openCodeParsing.js';

const OMO_INTERNAL_INITIATOR_PATTERN = /<!--\s*OMO_INTERNAL_INITIATOR\s*-->/i;
const OMO_BACKGROUND_MARKER_PATTERN =
  /\[(?:BACKGROUND TASK (?:COMPLETED|ERROR|CANCELLED|CANCELED|INTERRUPTED)|ALL BACKGROUND TASKS (?:COMPLETE|FINISHED\b[^\]]*))\]/i;
const OMO_BACKGROUND_OUTPUT_REFERENCE_PATTERN =
  /\bbackground_output\s*\([^)]*task_id\s*=\s*["']?bg[_-][a-z0-9_-]+/i;
const OMO_BACKGROUND_TASK_ID_PATTERN = /\bbg[_-][a-z0-9_-]+\b/i;
const NATIVE_BACKGROUND_TASK_TAG_PATTERN = /<task\b[^>]*>/gi;
const NATIVE_BACKGROUND_TASK_ID_ATTR_PATTERN = /\bid\s*=\s*["'][^"']+["']/i;
const NATIVE_BACKGROUND_TASK_STATE_ATTR_PATTERN = /\bstate\s*=\s*["']([^"']+)["']/i;
const NATIVE_BACKGROUND_TASK_WAKE_STATES = new Set(['completed', 'error', 'cancelled', 'canceled']);

export type OpenCodeBackgroundTaskWakeSource = 'native-background-task' | 'oh-my-openagent-background-task';

function readBooleanFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === 'true' ||
    normalized === '1' ||
    normalized === 'yes' ||
    normalized === 'on'
  );
}

function hasBackgroundTaskId(value: unknown): boolean {
  return OMO_BACKGROUND_TASK_ID_PATTERN.test(normalizeString(value));
}

function isOpenCodeBackgroundOutputToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === 'background_output' || normalized === 'mcp_background_output';
}

function findNativeBackgroundTaskState(text: string): string | null {
  for (const match of text.matchAll(NATIVE_BACKGROUND_TASK_TAG_PATTERN)) {
    const tag = match[0] ?? '';
    if (!NATIVE_BACKGROUND_TASK_ID_ATTR_PATTERN.test(tag)) continue;
    const state = normalizeString(NATIVE_BACKGROUND_TASK_STATE_ATTR_PATTERN.exec(tag)?.[1]).toLowerCase();
    if (state) return state;
  }
  return null;
}

export function readOpenCodeBackgroundTaskWakeSource(text: string): OpenCodeBackgroundTaskWakeSource | null {
  const normalized = text.trim();
  if (!normalized) return null;
  const nativeState = findNativeBackgroundTaskState(normalized);
  if (nativeState && NATIVE_BACKGROUND_TASK_WAKE_STATES.has(nativeState)) return 'native-background-task';
  if (!OMO_BACKGROUND_MARKER_PATTERN.test(normalized)) return null;
  const looksLikeOmoWake = (
    OMO_INTERNAL_INITIATOR_PATTERN.test(normalized) ||
    OMO_BACKGROUND_OUTPUT_REFERENCE_PATTERN.test(normalized) ||
    OMO_BACKGROUND_TASK_ID_PATTERN.test(normalized)
  );
  return looksLikeOmoWake ? 'oh-my-openagent-background-task' : null;
}

export function openCodeTextLooksLikeBackgroundTaskWake(text: string): boolean {
  return readOpenCodeBackgroundTaskWakeSource(text) !== null;
}

export function openCodeToolPartLooksLikeBackgroundTaskLaunch(part: Readonly<{
  tool: string;
  state: Readonly<{
    input?: unknown;
    output?: unknown;
    metadata?: unknown;
  }>;
}>): boolean {
  const toolName = part.tool.trim().toLowerCase();
  if (toolName !== 'task' && toolName !== 'call_omo_agent') return false;

  const metadata = asRecord(part.state.metadata);
  if (readBooleanFlag(metadata?.background)) return true;

  const input = asRecord(part.state.input);
  if (
    readBooleanFlag(input?.background) ||
    readBooleanFlag(input?.run_in_background) ||
    readBooleanFlag(input?.runInBackground)
  ) {
    return true;
  }

  const output = normalizeString(part.state.output);
  if (findNativeBackgroundTaskState(output) === 'running') return true;
  return (
    /Background task launched successfully/i.test(output) &&
    (OMO_BACKGROUND_TASK_ID_PATTERN.test(output) ||
      OMO_BACKGROUND_OUTPUT_REFERENCE_PATTERN.test(output))
  );
}

export function openCodeToolPartLooksLikeBackgroundOutputContinuation(part: Readonly<{
  tool: string;
  state: Readonly<{
    input?: unknown;
    output?: unknown;
    metadata?: unknown;
  }>;
}>): boolean {
  if (!isOpenCodeBackgroundOutputToolName(part.tool)) return false;
  const input = asRecord(part.state.input);
  const metadata = asRecord(part.state.metadata);
  return (
    hasBackgroundTaskId(input?.task_id) ||
    hasBackgroundTaskId(input?.taskId) ||
    hasBackgroundTaskId(metadata?.backgroundTaskId) ||
    hasBackgroundTaskId(part.state.output)
  );
}
