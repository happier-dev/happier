import { redactBugReportSensitiveText } from '@happier-dev/protocol';

export function redactHarnessLogText(raw: string): string {
  const value = String(raw ?? '');
  if (!value) return '';
  return redactBugReportSensitiveText(value);
}
