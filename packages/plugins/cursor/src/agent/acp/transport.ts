const OLD_FILE_HEADER = /^-{2,3} (?:\/dev\/null|[ab]\/[^\n]*|\/[^\n]*)(?:\n|$)/;
const NEW_FILE_HEADER = /^\+{2,3} (?:\/dev\/null|[ab]\/[^\n]*|\/[^\n]*)(?:\n|$)/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveCursorAcpToolName(request: Readonly<{
  toolName: string;
  input: Readonly<Record<string, unknown>>;
}>): string {
  const proprietaryToolName = readTrimmedString(request.input._toolName);
  if (proprietaryToolName === 'task') return 'Task';
  if (proprietaryToolName === 'createPlan') return 'ExitPlanMode';
  if (proprietaryToolName !== null) return request.toolName;

  const acp = isRecord(request.input._acp) ? request.input._acp : null;
  const title = readTrimmedString(request.input.title)
    ?? readTrimmedString(request.input.description)
    ?? readTrimmedString(acp?.title);
  const normalizedTitle = title?.toLocaleLowerCase('en-US');
  if (
    normalizedTitle === 'task'
    || normalizedTitle?.startsWith('task ')
    || normalizedTitle?.startsWith('task:')
  ) return 'Task';
  if (normalizedTitle === 'create plan') return 'ExitPlanMode';
  return request.toolName;
}

function stripUnifiedDiffHeaderLine(text: string, headerRe: RegExp): string {
  const match = headerRe.exec(text);
  const stripped = match ? text.slice(match[0].length) : text;
  return stripped.trim() === '/dev/null' ? '' : stripped;
}

export function sanitizeCursorDiffContent<T extends { content?: unknown }>(update: T): T {
  const content = update.content;
  if (!Array.isArray(content)) {
    return update;
  }

  let changed = false;
  const nextContent = content.map((entry) => {
    if (!isRecord(entry) || entry.type !== 'diff') {
      return entry;
    }
    const oldText = typeof entry.oldText === 'string'
      ? stripUnifiedDiffHeaderLine(entry.oldText, OLD_FILE_HEADER)
      : entry.oldText;
    const newText = typeof entry.newText === 'string'
      ? stripUnifiedDiffHeaderLine(entry.newText, NEW_FILE_HEADER)
      : entry.newText;
    if (oldText === entry.oldText && newText === entry.newText) {
      return entry;
    }
    changed = true;
    return { ...entry, oldText, newText };
  });

  return changed ? { ...update, content: nextContent } : update;
}
