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

const ALLOWED_TITLE_TOOL_INFERENCES = new Set(
  [
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
    'change_title',
  ].map(normalizeInferenceKey)
);

const TOOL_INFERENCE_RISK: Record<string, number> = {
  // Read-ish
  read: 1,
  search: 1,
  glob: 1,
  grep: 1,
  fetch: 1,
  websearch: 1,
  webfetch: 1,
  change_title: 1,

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

function normalizeInferenceKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function inferenceSpecificity(toolLower: string): number {
  if (!toolLower || toolLower === 'unknown' || toolLower === 'unknowntool' || toolLower === 'other') return 0;
  if (toolLower === 'webfetch' || toolLower === 'websearch') return 2;
  return 1;
}

function inferToolTokenFromLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*)\b/);
  const inferred = match?.[1] ?? null;
  if (!inferred) return null;
  return ALLOWED_TITLE_TOOL_INFERENCES.has(normalizeInferenceKey(inferred)) ? inferred : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isMetadataOnlyRecord(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (keys.length === 0) return true;

  return keys.every((key) => key === 'title' || key === 'description' || key === '_acp' || key === 'locations');
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

function extractCommandHintFromContentItems(value: unknown): string | null {
  if (!Array.isArray(value)) return null;

  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const content = asRecord(record.content);
    const text = typeof content?.text === 'string' ? content.text : typeof record.text === 'string' ? record.text : null;
    const candidate = extractCommandHintFromLabel(text);
    if (candidate) return candidate;
  }

  return null;
}

function normalizePermissionInputCandidate(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    const argv: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        argv.push(item);
        continue;
      }
      argv.length = 0;
      break;
    }
    if (argv.length > 0) return { command: argv };

    const contentCommand = extractCommandHintFromContentItems(value);
    if (contentCommand) return { command: contentCommand };
    return null;
  }

  if (typeof value === 'string') {
    const command = value.trim();
    if (command.length > 0) return { command };
    return null;
  }

  const record = asRecord(value);
  if (!record) return null;

  if ('content' in record) {
    const nestedContent = normalizePermissionInputCandidate(record.content);
    if (nestedContent) return nestedContent;
  }

  if ('items' in record) {
    const nestedItems = normalizePermissionInputCandidate(record.items);
    if (nestedItems) return nestedItems;
  }

  if (Object.keys(record).length > 0 && !isMetadataOnlyRecord(record)) {
    return record;
  }

  const titleCommand = extractCommandHintFromLabel(record.title);
  if (titleCommand) return { command: titleCommand };

  const acp = asRecord(record._acp);
  const acpTitleCommand = extractCommandHintFromLabel(acp?.title);
  if (acpTitleCommand) return { command: acpTitleCommand };

  return null;
}

export function extractPermissionInput(params: PermissionRequestLike): Record<string, unknown> {
  const toolCall = params.toolCall ?? undefined;
  const candidates = [
    toolCall?.rawInput,
    toolCall?.input,
    toolCall?.arguments,
    toolCall?.content,
    params.rawInput,
    params.input,
    params.arguments,
    params.content,
  ];

  for (const candidate of candidates) {
    const normalized = normalizePermissionInputCandidate(candidate);
    if (normalized) {
      return normalized;
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
  const metadataCandidates = [
    title,
    typeof asRecord(toolCall?.rawInput)?.title === 'string' ? String(asRecord(toolCall?.rawInput)?.title).trim() : '',
    typeof asRecord(toolCall?.input)?.title === 'string' ? String(asRecord(toolCall?.input)?.title).trim() : '',
    typeof asRecord(toolCall?.arguments)?.title === 'string' ? String(asRecord(toolCall?.arguments)?.title).trim() : '',
    typeof asRecord(toolCall?.content)?.title === 'string' ? String(asRecord(toolCall?.content)?.title).trim() : '',
    typeof asRecord(asRecord(toolCall?.rawInput)?._acp)?.title === 'string'
      ? String(asRecord(asRecord(toolCall?.rawInput)?._acp)?.title).trim()
      : '',
    typeof asRecord(asRecord(toolCall?.input)?._acp)?.title === 'string'
      ? String(asRecord(asRecord(toolCall?.input)?._acp)?.title).trim()
      : '',
    typeof asRecord(asRecord(toolCall?.arguments)?._acp)?.title === 'string'
      ? String(asRecord(asRecord(toolCall?.arguments)?._acp)?.title).trim()
      : '',
    typeof asRecord(params.rawInput)?.title === 'string' ? String(asRecord(params.rawInput)?.title).trim() : '',
    typeof asRecord(asRecord(params.rawInput)?._acp)?.title === 'string'
      ? String(asRecord(asRecord(params.rawInput)?._acp)?.title).trim()
      : '',
  ].filter((value) => value.length > 0);

  const inferredFromMetadata = (() => {
    for (const candidate of metadataCandidates) {
      const inferred = inferToolTokenFromLabel(candidate);
      if (!inferred) continue;
      return inferred;
    }
    return null;
  })();

  // ACP agents may send `kind: other` for permission prompts while also providing a more specific `toolName`.
  // Prefer the more specific name when kind is generic.
  const genericKind = kind.toLowerCase();
  if (kind && genericKind !== 'other' && genericKind !== 'unknown') {
    if (inferredFromMetadata && shouldReplaceCachedPermissionToolName(kind, inferredFromMetadata)) {
      return inferredFromMetadata;
    }
    return kind;
  }

  if (genericKind === 'other' || genericKind === 'unknown') {
    for (const candidate of metadataCandidates) {
      const inferred = inferToolTokenFromLabel(candidate);
      const inferredLower = normalizeInferenceKey(inferred ?? '');
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

      if (inferred && inferredLower !== normalizeInferenceKey(toolLower) && canOverride) {
        return inferred;
      }
    }
  }

  if (toolName) return toolName;
  if (paramsKind) return paramsKind;
  return 'Unknown tool';
}

export function shouldReplaceCachedPermissionToolName(currentToolName: string, nextToolName: string): boolean {
  const currentTrimmed = currentToolName.trim();
  const nextTrimmed = nextToolName.trim();
  if (!nextTrimmed) return false;
  if (!currentTrimmed) return true;

  const currentKey = normalizeInferenceKey(currentTrimmed);
  const nextKey = normalizeInferenceKey(nextTrimmed);
  if (currentKey === nextKey) return false;

  const currentRisk = inferenceRisk(currentKey);
  const nextRisk = inferenceRisk(nextKey);
  if (currentRisk !== null && nextRisk !== null && nextRisk < currentRisk) return false;

  // Always promote to a higher-risk classification, even if it isn't "more specific" by name.
  if (
    (currentRisk === null && nextRisk !== null)
    || (currentRisk !== null && nextRisk !== null && nextRisk > currentRisk)
  ) {
    return true;
  }

  return inferenceSpecificity(nextKey) > inferenceSpecificity(currentKey);
}

export function resolvePermissionToolName(opts: {
  toolNameHint: string;
  toolCallId: string;
  toolCallIdToNameMap?: Map<string, string>;
}): string {
  const mapped = opts.toolCallIdToNameMap?.get(opts.toolCallId);
  if (typeof mapped === 'string' && mapped.trim().length > 0) {
    if (shouldReplaceCachedPermissionToolName(mapped, opts.toolNameHint)) {
      return opts.toolNameHint;
    }
    return mapped.trim();
  }
  return opts.toolNameHint;
}

export function refinePermissionToolNameWithInput(toolNameHint: string, input: unknown): string {
  if (!toolNameHint.trim()) return toolNameHint;
  const inputDerivedHint = extractPermissionToolNameHint({
    toolCall: {
      kind: toolNameHint,
      rawInput: input,
    },
  });

  if (shouldReplaceCachedPermissionToolName(toolNameHint, inputDerivedHint)) {
    return inputDerivedHint;
  }

  return toolNameHint;
}
