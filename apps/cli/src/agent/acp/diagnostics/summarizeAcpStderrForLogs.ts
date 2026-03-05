import { redactBugReportSensitiveText } from '@happier-dev/protocol';

const MAX_DEBUG_CHARS = 500;

const SENSITIVE_MARKERS: ReadonlyArray<string> = [
  '<permissions instructions',
  '</permissions instructions>',
  '<app-context',
  '</app-context>',
  '<INSTRUCTIONS>',
  '</INSTRUCTIONS>',
];

export function summarizeAcpStderrForLogs(raw: string): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;

  if (SENSITIVE_MARKERS.some((marker) => trimmed.includes(marker))) {
    return '[redacted harness context]';
  }

  const redacted = redactBugReportSensitiveText(trimmed);
  if (redacted.length <= MAX_DEBUG_CHARS) return redacted;
  return `${redacted.slice(0, MAX_DEBUG_CHARS)}…`;
}

