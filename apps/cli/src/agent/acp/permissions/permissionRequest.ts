export type PermissionToolCallLike = {
  kind?: unknown;
  toolName?: unknown;
  title?: unknown;
  rawInput?: unknown;
  input?: unknown;
  arguments?: unknown;
  content?: unknown;
};

export type PermissionRequestLike = {
  toolCall?: PermissionToolCallLike | null;
  kind?: unknown;
  rawInput?: unknown;
  input?: unknown;
  arguments?: unknown;
  content?: unknown;
  options?: unknown;
};

const ALLOWED_TITLE_TOOL_INFERENCES = new Set([
  'read',
  'write',
  'edit',
  'delete',
  'search',
  'execute',
  'bash',
  'glob',
  'grep',
  'fetch',
  'task',
  'websearch',
  'webfetch',
]);

const TOOL_INFERENCE_RISK: Record<string, number> = {
  // Read-ish
  read: 1,
  search: 1,
  glob: 1,
  grep: 1,
  fetch: 1,
  websearch: 1,
  webfetch: 1,

  // Mutations
  edit: 2,
  write: 2,
  delete: 3,

  // Execution
  execute: 4,
  bash: 4,

  // Task can encompass arbitrary actions depending on provider.
  task: 5,
};

function inferenceRisk(toolLower: string): number | null {
  const v = TOOL_INFERENCE_RISK[toolLower];
  return typeof v === 'number' ? v : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractCommandHintFromLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim().replace(/\s+/g, ' ');
  if (!label) return null;

  const codeBlockMatch = label.match(/`([^`]+)`/);
  if (codeBlockMatch && typeof codeBlockMatch[1] === 'string' && codeBlockMatch[1].trim().length > 0) {
    return codeBlockMatch[1].trim();
  }

  const stripped = label.replace(/^(?:always\s+allow|allow|run|execute)\s+/i, '').trim();
  if (stripped && stripped !== label) return stripped;

  if (/^(?:bash|zsh|sh)\b/i.test(label)) return label;
  return null;
}

function extractCommandHintFromOptions(options: unknown): string | null {
  if (!Array.isArray(options)) return null;

  let fallbackCandidate: string | null = null;
  for (const option of options) {
    const record = asRecord(option);
    if (!record) continue;
    const kind = typeof record.kind === 'string' ? record.kind.trim().toLowerCase() : '';
    const candidate = extractCommandHintFromLabel(record.name) ?? extractCommandHintFromLabel(record.title);
    if (!candidate) continue;
    if (kind.includes('allow')) return candidate;
    if (!fallbackCandidate) fallbackCandidate = candidate;
  }

  return fallbackCandidate;
}

export function extractPermissionInput(params: PermissionRequestLike): Record<string, unknown> {
  const toolCall = params.toolCall ?? undefined;
  const input =
    (toolCall && (toolCall.rawInput ?? toolCall.input ?? toolCall.arguments ?? toolCall.content))
    ?? params.rawInput
    ?? params.input
    ?? params.arguments
    ?? params.content;

  // Some ACP agents (notably Gemini) can send raw argv arrays or stringified commands instead of objects.
  // Normalize these to a stable object shape so UI renderers can extract a command consistently.
  if (Array.isArray(input)) {
    const argv: string[] = [];
    for (const item of input) {
      if (typeof item !== 'string') {
        argv.length = 0;
        break;
      }
      argv.push(item);
    }
    if (argv.length > 0) return { command: argv };
  }
  if (typeof input === 'string') {
    const command = input.trim();
    if (command.length > 0) return { command };
  }

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const inputRecord = input as Record<string, unknown>;
    if (Object.keys(inputRecord).length > 0) {
      return inputRecord;
    }
  }

  // Some ACP providers (notably Gemini) send command hints only in permission option labels.
  const optionCommandHint = extractCommandHintFromOptions(params.options);
  if (optionCommandHint) {
    return { command: optionCommandHint };
  }

  return {};
}

export function extractPermissionInputWithFallback(
  params: PermissionRequestLike,
  toolCallId: string,
  toolCallIdToInputMap?: Map<string, Record<string, unknown>>
): Record<string, unknown> {
  const extracted = extractPermissionInput(params);
  if (Object.keys(extracted).length > 0) return extracted;

  const fallback = toolCallIdToInputMap?.get(toolCallId);
  if (fallback && typeof fallback === 'object' && !Array.isArray(fallback) && Object.keys(fallback).length > 0) {
    return fallback;
  }
  return {};
}

export function extractPermissionToolNameHint(params: PermissionRequestLike): string {
  const toolCall = params.toolCall ?? undefined;
  const kind = typeof toolCall?.kind === 'string' ? toolCall.kind.trim() : '';
  const toolName = typeof toolCall?.toolName === 'string' ? toolCall.toolName.trim() : '';
  const title = typeof toolCall?.title === 'string' ? toolCall.title.trim() : '';
  const paramsKind = typeof params.kind === 'string' ? params.kind.trim() : '';

  // ACP agents may send `kind: other` for permission prompts while also providing a more specific `toolName`.
  // Prefer the more specific name when kind is generic.
  const genericKind = kind.toLowerCase();
  if (kind && genericKind !== 'other' && genericKind !== 'unknown') return kind;

  if (genericKind === 'other' || genericKind === 'unknown') {
    if (title) {
      const match = title.match(/^([A-Za-z][A-Za-z0-9_-]*)\b/);
      const inferred = match ? match[1] : null;
      const inferredLower = inferred?.toLowerCase() ?? '';
      const toolLower = toolName.toLowerCase();
      const inferredRisk = inferenceRisk(inferredLower);
      const toolRisk = toolLower ? inferenceRisk(toolLower) : null;

      // Only override a real toolName when it cannot make permissions less strict.
      // If toolName is unknown/generic, allow inference from the title (used for many ACP permission prompts).
      const toolNameIsGeneric =
        toolLower === '' ||
        toolLower === 'unknown' ||
        toolLower === 'unknown tool' ||
        toolLower === 'other';
      const canOverride =
        toolNameIsGeneric ||
        (inferredRisk !== null && toolRisk !== null && inferredRisk >= toolRisk);

      if (inferred && ALLOWED_TITLE_TOOL_INFERENCES.has(inferredLower) && inferredLower !== toolLower && canOverride) {
        return inferred;
      }
    }
  }

  if (toolName) return toolName;
  if (paramsKind) return paramsKind;
  return 'Unknown tool';
}

export function resolvePermissionToolName(opts: {
  toolNameHint: string;
  toolCallId: string;
  toolCallIdToNameMap?: Map<string, string>;
}): string {
  const mapped = opts.toolCallIdToNameMap?.get(opts.toolCallId);
  if (typeof mapped === 'string' && mapped.trim().length > 0) {
    return mapped.trim();
  }
  return opts.toolNameHint;
}
