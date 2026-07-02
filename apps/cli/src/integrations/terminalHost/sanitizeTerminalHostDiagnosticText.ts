import { redactBugReportSensitiveText } from '@happier-dev/protocol';

const SECRET_KEY_FRAGMENT_PATTERN = '(?:api[_-]?key|auth[_-]?token|token|secret|password|credentials?|private[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token)';
const SECRET_EQUALS_ASSIGNMENT_PATTERN = new RegExp(
  `^(\\s*[^\\r\\n=]*${SECRET_KEY_FRAGMENT_PATTERN}[^\\r\\n=]*)=\\s*([^\\r\\n]*)`,
  'gim',
);
const SECRET_COLON_ASSIGNMENT_PATTERN = new RegExp(
  `^(\\s*[^\\r\\n:=]*${SECRET_KEY_FRAGMENT_PATTERN}[^\\r\\n:=]*):\\s*([^\\r\\n]*)`,
  'gim',
);

function redactSecretAssignmentValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  return /^\[(?:REDACTED|redacted-token)\]$/i.test(trimmed) ? trimmed : '[redacted-token]';
}

function redactSecretAssignments(value: string): string {
  return value
    .replace(
      SECRET_EQUALS_ASSIGNMENT_PATTERN,
      (_match, key: string, rawValue: string) => `${key}=${redactSecretAssignmentValue(rawValue)}`,
    )
    .replace(
      SECRET_COLON_ASSIGNMENT_PATTERN,
      (_match, key: string, rawValue: string) => `${key}: ${redactSecretAssignmentValue(rawValue)}`,
    );
}

export function sanitizeTerminalHostDiagnosticText(value: string): string {
  return redactSecretAssignments(redactBugReportSensitiveText(value))
    .replace(/\b(sk-ant-[A-Za-z0-9_\-]{8,})\b/g, '[redacted-token]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted-token]');
}
